/* 应用层：DOM 渲染与交互，把 UI 事件转成 CRDT 操作并交给同步层。 */
(function () {
  'use strict';

  // 同一标签页刷新保持同一身份（sessionStorage 按标签页隔离）
  var tabId = sessionStorage.getItem('shopping-tab-id');
  if (!tabId) {
    tabId = ShoppingSync.uuid();
    sessionStorage.setItem('shopping-tab-id', tabId);
  }

  var list = new ShoppingCRDT.ShoppingList(tabId);
  var sortMode = 'created-asc';

  var els = {
    form: document.getElementById('add-form'),
    name: document.getElementById('name-input'),
    qty: document.getElementById('qty-input'),
    list: document.getElementById('list'),
    empty: document.getElementById('empty'),
    sort: document.getElementById('sort-select'),
    onlineBtn: document.getElementById('online-toggle'),
    status: document.getElementById('status'),
    count: document.getElementById('count')
  };

  var sync = new ShoppingSync.SyncEngine({
    list: list,
    db: ShoppingDB,
    onChange: render,
    onStatus: renderStatus
  });
  var statusInfo = { online: true, queued: 0, lastSyncAt: null };

  // ---------- 事件 ----------
  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = ShoppingCRDT.normalizeName(els.name.value);
    if (!name) return;
    var addQty = Math.max(1, parseInt(els.qty.value, 10) || 1);
    var existing = list.items.get(ShoppingCRDT.keyOf(name));
    var op;
    if (existing && !existing.deleted.value) {
      // 已存在同名物品：不重复添加，数量累加
      op = list.setQty(existing.key, existing.qty.value + addQty);
    } else {
      op = list.add(name, addQty);
    }
    if (op) {
      sync.localOp(op);
      els.name.value = '';
      els.qty.value = '1';
      els.name.focus();
      render();
    }
  });

  els.sort.addEventListener('change', function () {
    sortMode = els.sort.value;
    render();
  });

  els.onlineBtn.addEventListener('click', function () {
    sync.setOnline(!statusInfo.online);
  });

  // ---------- 渲染 ----------
  function sorter(a, b) {
    switch (sortMode) {
      case 'created-desc':
        return cmpCreated(b, a);
      case 'name':
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      case 'todo-first':
        if (a.done !== b.done) return a.done ? 1 : -1;
        return cmpCreated(a, b);
      case 'created-asc':
      default:
        return cmpCreated(a, b);
    }
  }

  function cmpCreated(a, b) {
    if (a.created.ts !== b.created.ts) return a.created.ts - b.created.ts;
    if (a.created.tab !== b.created.tab) return a.created.tab < b.created.tab ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  }

  function render() {
    // 记住焦点，渲染后恢复（避免远端同步打断数量编辑）
    var active = document.activeElement;
    var focusKey = active && active.dataset ? active.dataset.key : null;
    var wasQty = active && active.classList && active.classList.contains('qty-input');

    var items = list.visibleItems().sort(sorter);
    els.list.textContent = '';
    els.empty.hidden = items.length !== 0;
    els.count.textContent = String(items.length);

    items.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'item' + (item.done ? ' done' : '');

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.done;
      checkbox.dataset.key = item.key;
      checkbox.addEventListener('change', function () {
        sync.localOp(list.setDone(item.key, checkbox.checked));
        render();
      });

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;

      var qty = document.createElement('input');
      qty.type = 'number';
      qty.min = '1';
      qty.step = '1';
      qty.value = String(item.qty);
      qty.className = 'qty-input';
      qty.dataset.key = item.key;
      qty.addEventListener('change', function () {
        var v = parseInt(qty.value, 10);
        if (!isFinite(v) || v < 1) v = 1;
        if (v !== item.qty) sync.localOp(list.setQty(item.key, v));
        render();
      });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del-btn';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        sync.localOp(list.remove(item.key));
        render();
      });

      li.appendChild(checkbox);
      li.appendChild(name);
      li.appendChild(qty);
      li.appendChild(del);
      els.list.appendChild(li);
    });

    if (focusKey && wasQty) {
      var again = els.list.querySelector('input.qty-input[data-key="' + cssEscape(focusKey) + '"]');
      if (again) again.focus();
    }
  }

  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
  }

  function renderStatus(s) {
    statusInfo = s;
    var parts = [];
    parts.push(s.online ? '在线' : '离线（操作已本地保存）');
    if (s.queued > 0) parts.push('待同步 ' + s.queued + ' 条');
    if (s.lastSyncAt) parts.push('最近同步 ' + new Date(s.lastSyncAt).toLocaleTimeString());
    parts.push('标签页 ' + tabId.slice(0, 8));
    els.status.textContent = parts.join(' · ');
    els.onlineBtn.textContent = s.online ? '模拟离线' : '恢复在线';
    els.onlineBtn.classList.toggle('offline', !s.online);
  }

  // ---------- 启动 ----------
  sync.start().then(function () {
    renderStatus({ online: true, queued: 0, lastSyncAt: null });
  });
})();
