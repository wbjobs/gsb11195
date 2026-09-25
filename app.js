'use strict';

/* ---------- Hybrid Logical Clock ---------- */

function tsCompare(a, b) {
  if (a.millis !== b.millis) return a.millis < b.millis ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

function tsEqual(a, b) { return a.millis === b.millis && a.counter === b.counter && a.node === b.node; }

function createClock() {
  const node = (
    (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  ).replace(/-/g, '');
  const clock = { node, millis: 0, counter: 0 };

  function nowMillis() { return Date.now(); }

  function tick() {
    const wall = nowMillis();
    if (wall > clock.millis) {
      clock.millis = wall;
      clock.counter = 0;
    } else {
      clock.counter += 1;
    }
    return stamp();
  }

  function observe(ts) {
    if (!ts) return;
    const wall = nowMillis();
    if (wall > clock.millis && wall >= ts.millis) {
      clock.millis = wall;
      clock.counter = 0;
    } else if (ts.millis > clock.millis) {
      clock.millis = ts.millis;
      clock.counter = ts.counter + 1;
    } else if (clock.millis === ts.millis) {
      clock.counter = Math.max(clock.counter, ts.counter) + 1;
    }
  }

  function stamp() { return { millis: clock.millis, counter: clock.counter, node: clock.node }; }

  return { tick, observe, stamp, node, state: () => ({ millis: clock.millis, counter: clock.counter }) };
}

/* ---------- Field-level LWW helpers ---------- */

function regSet(reg, value, ts) {
  if (!reg || tsCompare(ts, reg.ts) > 0) return { value, ts };
  return reg;
}

function mergeField(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return tsCompare(b.ts, a.ts) > 0 ? b : a;
}

function normalizeName(name) {
  return String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function makeItem(id, name, qty, clock) {
  const now = clock.tick();
  return {
    id,
    name: { value: name, ts: now },
    qty: { value: qty, ts: now },
    checked: { value: false, ts: now },
    deleted: null,
    created: now
  };
}

function mergeItem(existing, incoming) {
  if (!existing) return incoming;
  return {
    id: existing.id,
    name: mergeField(existing.name, incoming.name),
    qty: mergeField(existing.qty, incoming.qty),
    checked: mergeField(existing.checked, incoming.checked),
    deleted: mergeField(existing.deleted, incoming.deleted),
    created: tsCompare(existing.created, incoming.created) < 0 ? existing.created : incoming.created
  };
}

/* ---------- IndexedDB storage ---------- */

const DB_NAME = 'shared-shopping-list';
const STORE = 'kv';
const ITEMS_KEY = 'items';
const CLOCK_KEY = 'clock';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- Application ---------- */

const CHANNEL_NAME = 'shared-shopping-list-v1';

async function boot() {
  const db = await openDB();
  const clock = createClock();

  const savedClock = await dbGet(db, CLOCK_KEY);
  if (savedClock && typeof savedClock.millis === 'number') {
    clock.observe({ millis: savedClock.millis, counter: savedClock.counter, node: clock.node });
    clock.observe({ millis: savedClock.millis, counter: savedClock.counter, node: savedClock.node || clock.node });
  }

  let items = new Map();
  const saved = await dbGet(db, ITEMS_KEY);
  if (saved && typeof saved === 'object') {
    for (const item of Object.values(saved)) items.set(item.id, item);
  }

  let sortMode = 'created';
  try {
    sortMode = localStorage.getItem('shopping-list-sort') || 'created';
  } catch (e) { /* ignore */ }

  let online = typeof navigator === 'undefined' || !navigator.onLine ? false : true;
  let forceOffline = false;
  const pending = [];
  const peers = new Set();
  let lastFullSend = 0;

  let channel = null;
  let saveTimer = null;
  let renderQueued = false;
  let dirty = false;
  let flashId = null;
  const changeListeners = new Set();

  function isOnline() { return online && !forceOffline; }

  function persistSoon() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 120);
  }

  async function saveNow() {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      await dbPut(db, ITEMS_KEY, Object.fromEntries(items));
      const cs = clock.state();
      await dbPut(db, CLOCK_KEY, { millis: cs.millis, counter: cs.counter, node: clock.node });
    } catch (err) {
      dirty = true;
    }
  }

  function activeItems() {
    const out = [];
    for (const item of items.values()) {
      if (!item.deleted || item.deleted.value !== true) out.push(item);
    }
    return out;
  }

  function applyIncomingItem(incoming, fromRemote) {
    const existing = items.get(incoming.id);
    const merged = mergeItem(existing || null, incoming);
    if (fromRemote) {
      for (const reg of [incoming.name, incoming.qty, incoming.checked, incoming.deleted]) {
        if (reg) clock.observe(reg.ts);
      }
      clock.observe(incoming.created);
    }
    items.set(incoming.id, merged);
    persistSoon();
    scheduleRender();
    for (const fn of changeListeners) {
      try { fn(incoming.id, incoming); } catch (e) { /* listener errors are non-fatal */ }
    }
  }

  function broadcast(msg) {
    if (!channel) return;
    if (isOnline()) {
      channel.postMessage(msg);
    } else {
      pending.push(msg);
    }
  }

  function sendItem(item) {
    broadcast({ type: 'item', from: clock.node, item });
  }

  /* ---------- User operations ---------- */

  function addItem(rawName, rawQty) {
    const name = String(rawName || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!name) return null;
    const id = 'i:' + normalizeName(name);
    let qty = Math.max(1, Math.floor(Number(rawQty) || 1));
    if (!Number.isFinite(qty) || qty < 1) qty = 1;

    let item = items.get(id);
    const isReAdd = item && item.deleted && item.deleted.value === true;

    if (!item) {
      item = makeItem(id, name, qty, clock);
    } else if (isReAdd) {
      const ts = clock.tick();
      item = mergeItem(item, {
        id,
        name: { value: name, ts },
        qty: { value: qty, ts },
        checked: { value: false, ts },
        deleted: { value: false, ts },
        created: ts
      });
      item.created = item.created;
    } else {
      flashId = id;
      scheduleRender();
      return item;
    }

    items.set(id, item);
    persistSoon();
    sendItem(item);
    scheduleRender();
    return item;
  }

  function setChecked(id, checked) {
    const item = items.get(id);
    if (!item) return;
    const reg = item.checked;
    if (reg && reg.value === checked) return;
    const ts = clock.tick();
    const updated = mergeItem(item, { id, checked: { value: !!checked, ts } });
    items.set(id, updated);
    persistSoon();
    sendItem(updated);
    scheduleRender();
  }

  function setQty(id, qty) {
    qty = Math.floor(Number(qty));
    if (!Number.isFinite(qty) || qty < 1) return false;
    const item = items.get(id);
    if (!item) return false;
    if (item.qty && item.qty.value === qty) return true;
    const ts = clock.tick();
    const updated = mergeItem(item, { id, qty: { value: qty, ts } });
    items.set(id, updated);
    persistSoon();
    sendItem(updated);
    scheduleRender();
    return true;
  }

  function deleteItem(id) {
    const item = items.get(id);
    if (!item) return;
    const ts = clock.tick();
    const updated = mergeItem(item, { id, deleted: { value: true, ts } });
    items.set(id, updated);
    persistSoon();
    sendItem(updated);
    scheduleRender();
  }

  /* ---------- Sync ---------- */

  function sendHello() {
    broadcast({ type: 'hello', from: clock.node });
  }

  function sendFull(target) {
    const msg = { type: 'full', from: clock.node, items: Array.from(items.values()) };
    lastFullSend = Date.now();
    if (target) {
      if (isOnline()) channel.postMessage(msg);
      else pending.push(msg);
    } else {
      broadcast(msg);
    }
  }

  function handleMessage(event) {
    const msg = event && event.data;
    if (!msg || typeof msg !== 'object' || msg.from === clock.node) return;

    if (window.__shoppingTestCapture) {
      window.__shoppingTestCapture(msg);
    }
    if (window.__shoppingTestHold && window.__shoppingTestHold(msg)) return;

    peers.add(msg.from);
    updateStatus();

    if (msg.type === 'hello') {
      sendFull(msg.from);
      return;
    }
    if (msg.type === 'bye') {
      peers.delete(msg.from);
      updateStatus();
      return;
    }
    if (msg.type === 'item') {
      applyIncomingItem(msg.item, true);
      return;
    }
    if (msg.type === 'full') {
      const list = Array.isArray(msg.items) ? msg.items : [];
      for (const incoming of list) applyIncomingItem(incoming, true);
      return;
    }
  }

  function flushPending() {
    if (!channel || !isOnline() || pending.length === 0) return;
    const queued = pending.splice(0, pending.length);
    for (const msg of queued) channel.postMessage(msg);
    sendHello();
  }

  /* ---------- Rendering ---------- */

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const countsEl = document.getElementById('counts');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  function sortedItems() {
    const list = activeItems();
    if (sortMode === 'name') {
      list.sort((a, b) => a.name.value.localeCompare(b.name.value, 'zh-Hans-CN'));
    } else if (sortMode === 'active') {
      list.sort((a, b) => {
        const av = a.checked && a.checked.value ? 1 : 0;
        const bv = b.checked && b.checked.value ? 1 : 0;
        if (av !== bv) return av - bv;
        return tsCompare(a.created, b.created);
      });
    } else {
      list.sort((a, b) => tsCompare(a.created, b.created));
    }
    return list;
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    const list = sortedItems();
    emptyEl.style.display = list.length === 0 ? 'block' : 'none';

    const existing = new Map();
    for (const node of listEl.children) existing.set(node.dataset.id, node);
    const wanted = new Set();

    for (const item of list) {
      wanted.add(item.id);
      let node = existing.get(item.id);
      const checked = !!(item.checked && item.checked.value);
      const qty = item.qty ? item.qty.value : 1;
      const name = item.name ? item.name.value : item.id;

      if (!node) {
        node = document.createElement('li');
        node.className = 'item';
        node.dataset.id = item.id;
        node.innerHTML =
          '<input type="checkbox" class="item-toggle" aria-label="勾选">' +
          '<span class="item-name"></span>' +
          '<span class="qty-editor">' +
          '<button type="button" class="qty-btn qty-minus" aria-label="减少数量">−</button>' +
          '<input type="number" class="qty-value" min="1" max="9999" step="1" aria-label="数量">' +
          '<button type="button" class="qty-btn qty-plus" aria-label="增加数量">+</button>' +
          '</span>' +
          '<button type="button" class="delete-btn" aria-label="删除">🗑</button>';
        listEl.appendChild(node);
        if (item.id === flashId) node.classList.add('flash');
      } else if (item.id === flashId) {
        node.classList.remove('flash');
        void node.offsetWidth;
        node.classList.add('flash');
      }
      flashId = null;

      node.classList.toggle('checked', checked);
      const toggle = node.querySelector('.item-toggle');
      if (toggle.checked !== checked) toggle.checked = checked;

      const nameEl = node.querySelector('.item-name');
      if (nameEl.textContent !== name) nameEl.textContent = name;

      const qtyInput = node.querySelector('.qty-value');
      if (document.activeElement !== qtyInput && String(qtyInput.value) !== String(qty)) {
        qtyInput.value = qty;
      }
    }

    for (const [id, node] of existing) {
      if (!wanted.has(id)) node.remove();
    }

    const done = list.filter((i) => i.checked && i.checked.value).length;
    countsEl.textContent = list.length ? `共 ${list.length} 项，已勾选 ${done} 项` : '';
  }

  function updateStatus() {
    if (!isOnline()) {
      statusDot.className = 'status-dot offline';
      statusText.textContent = '离线（恢复后自动同步）';
    } else if (peers.size > 0) {
      statusDot.className = 'status-dot online';
      statusText.textContent = `已同步 · ${peers.size + 1} 个标签页`;
    } else {
      statusDot.className = 'status-dot';
      statusText.textContent = '已连接（当前唯一标签页）';
    }
  }

  /* ---------- DOM events ---------- */

  const addForm = document.getElementById('addForm');
  const nameInput = document.getElementById('nameInput');
  const qtyInput = document.getElementById('qtyInput');

  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const item = addItem(nameInput.value, qtyInput.value);
    if (item) {
      nameInput.value = '';
      qtyInput.value = '1';
      nameInput.focus();
    }
  });

  listEl.addEventListener('click', (event) => {
    const node = event.target.closest('.item');
    if (!node) return;
    const id = node.dataset.id;
    const item = items.get(id);
    if (!item) return;
    const current = item.qty ? item.qty.value : 1;
    if (event.target.classList.contains('delete-btn')) {
      deleteItem(id);
    } else if (event.target.classList.contains('qty-minus')) {
      setQty(id, current - 1 < 1 ? 1 : current - 1);
    } else if (event.target.classList.contains('qty-plus')) {
      setQty(id, current + 1);
    }
  });

  listEl.addEventListener('change', (event) => {
    const node = event.target.closest('.item');
    if (!node) return;
    const id = node.dataset.id;
    if (event.target.classList.contains('item-toggle')) {
      setChecked(id, event.target.checked);
    } else if (event.target.classList.contains('qty-value')) {
      if (!setQty(id, event.target.value)) event.target.value = (items.get(id) || {}).qty?.value ?? 1;
    }
  });

  document.querySelectorAll('.sort-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.sort === sortMode);
    btn.addEventListener('click', () => {
      sortMode = btn.dataset.sort;
      try { localStorage.setItem('shopping-list-sort', sortMode); } catch (e) { /* ignore */ }
      document.querySelectorAll('.sort-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      render();
    });
  });

  window.addEventListener('online', () => {
    online = true;
    updateStatus();
    flushPending();
  });
  window.addEventListener('offline', () => {
    online = false;
    updateStatus();
  });
  window.addEventListener('pagehide', () => {
    if (channel && isOnline()) {
      try { channel.postMessage({ type: 'bye', from: clock.node }); } catch (e) { /* ignore */ }
    }
    if (dirty) {
      try { saveNow(); } catch (e) { /* ignore */ }
    }
  });

  /* ---------- Channel setup ---------- */

  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = handleMessage;
  updateStatus();
  render();
  sendHello();

  // Safety net: a newly opened or rejoining tab cannot miss data,
  // and reconnecting peers re-converge without relying on a single hello.
  setInterval(() => {
    if (!isOnline() || Date.now() - lastFullSend < 25000) return;
    sendHello();
  }, 5000);

  /* ---------- Test / automation API ---------- */

  window.shoppingList = {
    node: clock.node,
    add: (name, qty) => addItem(name, qty),
    check: (id) => setChecked(id, true),
    uncheck: (id) => setChecked(id, false),
    remove: (id) => deleteItem(id),
    setQty: (id, qty) => setQty(id, qty),
    items: () => activeItems().map((item) => ({
      id: item.id,
      name: item.name.value,
      qty: item.qty.value,
      checked: !!(item.checked && item.checked.value),
      deleted: !!(item.deleted && item.deleted.value)
    })),
    raw: () => Array.from(items.values()),
    state: () => ({
      online: isOnline(),
      peers: Array.from(peers),
      pending: pending.length
    }),
    setForceOffline: (value) => {
      forceOffline = !!value;
      if (!forceOffline) {
        updateStatus();
        flushPending();
      } else {
        updateStatus();
      }
    },
    onChange: (fn) => {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },
    waitForConverge: async function (expected, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 5000);
      while (Date.now() < deadline) {
        const current = this.items().map((i) => i.id);
        if (current.length === expected.length && expected.every((id) => current.includes(id))) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    },
    // Replay arbitrary serialized messages in an arbitrary order.
    ingest: (msg) => handleMessage({ data: msg }),
    setCapture: (fn) => { window.__shoppingTestCapture = fn || null; },
    setHold: (fn) => { window.__shoppingTestHold = fn || null; },
    _mergeItem: mergeItem,
    _tsCompare: tsCompare,
    _clock: clock
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
