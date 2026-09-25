/*
 * IndexedDB 持久化层。
 * - 数据库 shopping-list-db，对象仓库 items（keyPath = key），保存含墓碑在内的全部 CRDT 状态。
 * - 写穿策略：每次变更立即持久化，标签页关闭/崩溃不丢数据。
 * - 提供 loadAll 用于启动恢复，saveItems 批量写入。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'shopping-list-db';
  var DB_VERSION = 1;
  var STORE = 'items';

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function saveItems(items) {
    if (!items || items.length === 0) return Promise.resolve();
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        items.forEach(function (item) { store.put(item); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function loadAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function clearAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  global.ShoppingDB = { saveItems: saveItems, loadAll: loadAll, clearAll: clearAll };
})(typeof window !== 'undefined' ? window : globalThis);
