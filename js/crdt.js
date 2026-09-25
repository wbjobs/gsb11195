/*
 * 简化版 CRDT：以物品名（归一化后小写）为 key 的 LWW-Map，
 * 每个字段（name/qty/done/deleted）是独立的 LWW-Register。
 * 时间戳 = 混合逻辑时钟 (max(Date.now(), last+1))，并列时用 tabId 字典序决胜。
 * 合并满足交换律、结合律、幂等 => 消息乱序、重复投递、并发操作最终一致。
 */
(function (global) {
  'use strict';

  function compareStamp(a, b) {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.tab === b.tab) return 0;
    return a.tab < b.tab ? -1 : 1;
  }

  function reg(value, ts, tab) {
    return { value: value, ts: ts, tab: tab };
  }

  function normalizeName(name) {
    return String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  }

  function keyOf(name) {
    return normalizeName(name).toLowerCase();
  }

  // 混合逻辑时钟：保证单标签页内时间戳严格单调递增
  class Clock {
    constructor(tabId) {
      this.tabId = tabId;
      this.last = 0;
    }
    now() {
      var t = Date.now();
      this.last = t > this.last ? t : this.last + 1;
      return this.last;
    }
    observe(ts) {
      if (ts > this.last) this.last = ts;
    }
    stamp() {
      return { ts: this.now(), tab: this.tabId };
    }
  }

  class ShoppingList {
    constructor(tabId) {
      this.tabId = tabId;
      this.clock = new Clock(tabId);
      this.items = new Map(); // key -> { key, name, qty, done, deleted, created }
    }

    _ensure(key, name, stamp) {
      var item = this.items.get(key);
      if (!item) {
        item = {
          key: key,
          name: reg(name, stamp.ts, stamp.tab),
          qty: reg(1, stamp.ts, stamp.tab),
          done: reg(false, stamp.ts, stamp.tab),
          deleted: reg(false, stamp.ts, stamp.tab),
          created: { ts: stamp.ts, tab: stamp.tab }
        };
        this.items.set(key, item);
      }
      return item;
    }

    _setField(item, field, value, stamp) {
      var cur = item[field];
      if (compareStamp(stamp, cur) > 0) {
        item[field] = reg(value, stamp.ts, stamp.tab);
        return true;
      }
      return false;
    }

    // ---------- 本地操作：应用到本地并返回可广播的 op ----------
    add(name, qty) {
      name = normalizeName(name);
      if (!name) return null;
      qty = sanitizeQty(qty);
      var stamp = this.clock.stamp();
      var op = { type: 'add', key: keyOf(name), name: name, qty: qty, ts: stamp.ts, tab: stamp.tab };
      this.apply(op);
      return op;
    }

    setQty(key, qty) {
      qty = sanitizeQty(qty);
      var stamp = this.clock.stamp();
      var op = { type: 'qty', key: key, qty: qty, ts: stamp.ts, tab: stamp.tab };
      this.apply(op);
      return op;
    }

    setDone(key, done) {
      var stamp = this.clock.stamp();
      var op = { type: 'done', key: key, done: !!done, ts: stamp.ts, tab: stamp.tab };
      this.apply(op);
      return op;
    }

    remove(key) {
      var stamp = this.clock.stamp();
      var op = { type: 'del', key: key, ts: stamp.ts, tab: stamp.tab };
      this.apply(op);
      return op;
    }

    // ---------- 合并远端/本地 op（幂等、顺序无关） ----------
    apply(op) {
      if (!op || !op.key) return false;
      this.clock.observe(op.ts || 0);
      var stamp = { ts: op.ts, tab: op.tab };
      switch (op.type) {
        case 'add': {
          var existed = this.items.has(op.key);
          var item = this._ensure(op.key, op.name, stamp);
          if (!existed) {
            // 新建：采用 add 携带的数量（_ensure 的默认值时间戳相同，需直接覆盖）
            item.qty = reg(sanitizeQty(op.qty), stamp.ts, stamp.tab);
          } else {
            // 已存在（含并发重复添加、删除后重新添加）：
            // 每个字段独立按 LWW 裁决 —— 时间戳更新的 add 才生效，
            // 乱序到达的旧 add 不会覆盖任何字段，也不会复活已删除物品。
            this._setField(item, 'name', op.name, stamp);
            this._setField(item, 'qty', sanitizeQty(op.qty), stamp);
            this._setField(item, 'done', false, stamp);
            this._setField(item, 'deleted', false, stamp);
          }
          // created 取最早，保证排序稳定且各端一致
          if (compareStamp(stamp, item.created) < 0) {
            item.created = { ts: stamp.ts, tab: stamp.tab };
          }
          return true;
        }
        case 'qty': {
          var it1 = this._ensure(op.key, op.key, stamp);
          return this._setField(it1, 'qty', sanitizeQty(op.qty), stamp);
        }
        case 'done': {
          var it2 = this._ensure(op.key, op.key, stamp);
          return this._setField(it2, 'done', !!op.done, stamp);
        }
        case 'del': {
          // 即使 item 尚不存在也建立墓碑，防止乱序到达的旧 add 复活它
          var it3 = this._ensure(op.key, op.key, stamp);
          return this._setField(it3, 'deleted', true, stamp);
        }
        default:
          return false;
      }
    }

    // ---------- 快照（用于反熵全量同步 / 持久化） ----------
    snapshot() {
      var out = [];
      this.items.forEach(function (item) { out.push(item); });
      return JSON.parse(JSON.stringify(out));
    }

    mergeSnapshot(items) {
      var changed = false;
      var self = this;
      (items || []).forEach(function (remote) {
        if (!remote || !remote.key) return;
        self.clock.observe(Math.max(remote.name.ts, remote.qty.ts, remote.done.ts, remote.deleted.ts));
        var local = self.items.get(remote.key);
        if (!local) {
          self.items.set(remote.key, JSON.parse(JSON.stringify(remote)));
          changed = true;
          return;
        }
        ['name', 'qty', 'done', 'deleted'].forEach(function (f) {
          if (compareStamp(remote[f], local[f]) > 0) {
            local[f] = remote[f];
            changed = true;
          }
        });
        if (compareStamp(remote.created, local.created) < 0) {
          local.created = remote.created;
          changed = true;
        }
      });
      return changed;
    }

    // ---------- 视图 ----------
    visibleItems() {
      var out = [];
      this.items.forEach(function (item) {
        if (!item.deleted.value) {
          out.push({
            key: item.key,
            name: item.name.value,
            qty: item.qty.value,
            done: item.done.value,
            created: item.created
          });
        }
      });
      return out;
    }
  }

  function sanitizeQty(qty) {
    var n = Math.floor(Number(qty));
    if (!isFinite(n) || n < 1) return 1;
    return n;
  }

  var api = { ShoppingList: ShoppingList, keyOf: keyOf, normalizeName: normalizeName, compareStamp: compareStamp };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.ShoppingCRDT = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
