/*
 * 同步层：BroadcastChannel 实时广播 + IndexedDB 写穿持久化 + 反熵全量同步。
 *
 * 消息类型：
 *  - op    : 单条 CRDT 操作（add/qty/done/del），收到即合并（幂等、乱序安全）
 *  - hello : 新标签页 / 恢复在线时广播，请求全量状态（反熵）
 *  - state : 对 hello 的应答，携带完整快照（含墓碑），点对点发送
 *
 * 离线：setOnline(false) 后操作只写 IndexedDB 并进入待发送队列；
 *       恢复在线时先补发队列，再发 hello 拉取他人在自己离线期间的变更。
 */
(function (global) {
  'use strict';

  var CHANNEL_NAME = 'shopping-list-v1';

  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  class SyncEngine {
    /**
     * @param {object} opts
     *   list: ShoppingCRDT.ShoppingList 实例
     *   db: ShoppingDB
     *   onChange(): 状态变化后回调（重新渲染）
     *   onStatus(text): 状态栏回调
     */
    constructor(opts) {
      this.list = opts.list;
      this.db = opts.db;
      this.onChange = opts.onChange || function () {};
      this.onStatus = opts.onStatus || function () {};
      this.tabId = this.list.tabId;
      this.online = true;
      this.offlineQueue = [];
      this.channel = null;
      this.lastSyncAt = null;
    }

    start() {
      var self = this;
      // 1. 先从 IndexedDB 恢复（标签页关闭/刷新不丢数据）
      return this.db.loadAll().then(function (items) {
        if (items.length) self.list.mergeSnapshot(items);
        self.onChange();
        // 2. 打开广播通道
        self.channel = new BroadcastChannel(CHANNEL_NAME);
        self.channel.onmessage = function (e) { self._onMessage(e.data); };
        // 3. 反熵：向其他标签页请求全量状态，补齐可能错过的操作
        self._post({ kind: 'hello', from: self.tabId });
        self._status();
      });
    }

    // 本地产生了一条操作：写穿持久化 + 广播（离线则入队）
    localOp(op) {
      if (!op) return;
      this._persistKeys([op.key]);
      if (this.online) {
        this._post({ kind: 'op', from: this.tabId, op: op });
      } else {
        this.offlineQueue.push(op);
        this._status();
      }
    }

    setOnline(online) {
      online = !!online;
      if (this.online === online) return;
      this.online = online;
      if (online) {
        // 补发离线期间的操作，再反熵拉取他人变更
        var queued = this.offlineQueue.splice(0);
        for (var i = 0; i < queued.length; i++) {
          this._post({ kind: 'op', from: this.tabId, op: queued[i] });
        }
        this._post({ kind: 'hello', from: this.tabId });
      }
      this._status();
    }

    _onMessage(msg) {
      if (!msg || msg.from === this.tabId) return;
      switch (msg.kind) {
        case 'op': {
          var changed = this.list.apply(msg.op);
          if (changed) {
            this._persistKeys([msg.op.key]);
            this.lastSyncAt = Date.now();
            this.onChange();
          }
          break;
        }
        case 'hello': {
          // 应答全量快照（含墓碑），点对点
          this._post({ kind: 'state', from: this.tabId, to: msg.from, items: this.list.snapshot() });
          break;
        }
        case 'state': {
          if (msg.to !== this.tabId) break;
          var merged = this.list.mergeSnapshot(msg.items);
          if (merged) {
            this._persistAll();
            this.lastSyncAt = Date.now();
            this.onChange();
          }
          break;
        }
      }
    }

    _persistKeys(keys) {
      var self = this;
      var items = [];
      keys.forEach(function (k) {
        var item = self.list.items.get(k);
        if (item) items.push(item);
      });
      this.db.saveItems(JSON.parse(JSON.stringify(items))).catch(function (err) {
        console.error('persist failed', err);
      });
    }

    _persistAll() {
      this.db.saveItems(this.list.snapshot()).catch(function (err) {
        console.error('persist failed', err);
      });
    }

    _post(msg) {
      if (this.channel) {
        try { this.channel.postMessage(msg); } catch (err) { console.error('broadcast failed', err); }
      }
    }

    _status() {
      this.onStatus({
        online: this.online,
        queued: this.offlineQueue.length,
        lastSyncAt: this.lastSyncAt
      });
    }
  }

  global.ShoppingSync = { SyncEngine: SyncEngine, uuid: uuid };
})(typeof window !== 'undefined' ? window : globalThis);
