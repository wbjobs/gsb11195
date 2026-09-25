'use strict';
/*
 * 用 Node 模拟多个标签页并发操作，验证 CRDT 的最终一致性。
 * 每个 Tab = 一个 ShoppingList 实例；网络 = 可乱序/可重复/可延迟的 op 投递器。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShoppingList, keyOf } = require('../js/crdt.js');

// 收集各 tab 的 op，flush 时（可乱序、可重复）投递给所有其他 tab
class Network {
  constructor() {
    this.pending = [];
  }
  send(fromIdx, op, tabs) {
    this.pending.push({ fromIdx, op });
  }
  // shuffle: 乱序投递；dup: 每条消息重复投递一次（模拟重复到达）
  flush(tabs, { shuffle = false, dup = false } = {}) {
    let msgs = this.pending.splice(0);
    if (dup) msgs = msgs.flatMap((m) => [m, m]);
    if (shuffle) {
      for (let i = msgs.length - 1; i > 0; i--) {
        const j = (i * 7 + 3) % (i + 1); // 确定性伪随机
        [msgs[i], msgs[j]] = [msgs[j], msgs[i]];
      }
    }
    for (const { fromIdx, op } of msgs) {
      tabs.forEach((tab, idx) => {
        if (idx !== fromIdx) tab.apply(op);
      });
    }
  }
}

function makeTabs(n) {
  return Array.from({ length: n }, (_, i) => new ShoppingList('tab-' + i));
}

function stateOf(tab) {
  return JSON.stringify(tab.snapshot().sort((a, b) => (a.key < b.key ? -1 : 1)));
}

function assertConverged(tabs) {
  const first = stateOf(tabs[0]);
  tabs.forEach((tab, i) => assert.equal(stateOf(tab), first, `tab ${i} 未收敛`));
}

test('4 个标签页各添加 50 项：全部 200 项、无重复、各 tab 收敛', () => {
  const tabs = makeTabs(4);
  const net = new Network();
  tabs.forEach((tab, i) => {
    for (let n = 0; n < 50; n++) {
      const op = tab.add(`物品-${i}-${n}`, n + 1);
      net.send(i, op, tabs);
    }
  });
  net.flush(tabs, { shuffle: true, dup: true });
  tabs.forEach((tab) => {
    const items = tab.visibleItems();
    assert.equal(items.length, 200);
    assert.equal(new Set(items.map((it) => it.key)).size, 200, '存在重复项');
  });
  assertConverged(tabs);
});

test('两个标签页同时添加同一物品：合并为一项，不重复', () => {
  const tabs = makeTabs(2);
  const net = new Network();
  const opA = tabs[0].add('牛奶', 1);
  const opB = tabs[1].add('  牛奶 ', 5); // 归一化后同 key
  net.send(0, opA, tabs);
  net.send(1, opB, tabs);
  net.flush(tabs, { shuffle: true });
  tabs.forEach((tab) => {
    const items = tab.visibleItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].name, '牛奶');
  });
  assertConverged(tabs);
});

test('并发重复添加不同数量：收敛到最新那次 add，且只有一项', () => {
  const tabs = makeTabs(2);
  // 两个 tab 并发添加同一物品，opB 时间戳更晚
  const opA = { type: 'add', key: '鸡蛋', name: '鸡蛋', qty: 2, ts: 1000, tab: 'tab-0' };
  const opB = { type: 'add', key: '鸡蛋', name: '鸡蛋', qty: 5, ts: 2000, tab: 'tab-1' };
  // 两个 tab 以相反顺序收到（乱序）
  tabs[0].apply(opA);
  tabs[0].apply(opB);
  tabs[1].apply(opB);
  tabs[1].apply(opA);
  tabs.forEach((tab) => {
    const items = tab.visibleItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].qty, 5, '未收敛到最新的 add');
  });
  assertConverged(tabs);
});

test('重复添加不触碰勾选状态（done 是独立寄存器）', () => {
  const tabs = makeTabs(2);
  const net = new Network();
  net.send(0, tabs[0].add('鸡蛋', 2), tabs);
  net.flush(tabs);
  net.send(1, tabs[1].setDone('鸡蛋', true), tabs);
  net.flush(tabs);
  // 一个时间戳早于 done 的重复 add 乱序到达：不得重置勾选
  const staleAdd = { type: 'add', key: '鸡蛋', name: '鸡蛋', qty: 1, ts: 1, tab: 'tab-9' };
  tabs.forEach((tab) => tab.apply(staleAdd));
  tabs.forEach((tab) => {
    const [item] = tab.visibleItems();
    assert.equal(item.done, true, '勾选状态被乱序 add 重置');
    assert.equal(item.qty, 2, '数量被乱序 add 重置');
  });
  assertConverged(tabs);
});

test('同时勾选与删除：所有 tab 收敛到同一状态', () => {
  const tabs = makeTabs(3);
  const net = new Network();
  net.send(0, tabs[0].add('面包', 1), tabs);
  net.flush(tabs);
  // 三个 tab 并发：勾选 / 取消勾选 / 删除
  net.send(0, tabs[0].setDone('面包', true), tabs);
  net.send(1, tabs[1].setDone('面包', false), tabs);
  net.send(2, tabs[2].remove('面包'), tabs);
  net.flush(tabs, { shuffle: true, dup: true });
  assertConverged(tabs);
  // 无论 LWW 裁定结果如何，所有 tab 的可见性一致
  const visibilities = tabs.map((t) => t.visibleItems().length);
  assert.ok(visibilities.every((v) => v === visibilities[0]));
});

test('删除后乱序到达的旧 add 不会复活物品（墓碑）', () => {
  const tabs = makeTabs(2);
  const addOp = tabs[0].add('苹果', 1);
  // tab1 先收到 add，再删除
  tabs[1].apply(addOp);
  const delOp = tabs[1].remove('苹果');
  // tab0 乱序：先收到 del，再收到自己发出的 add 的回声/旧 add
  tabs[0].apply(delOp);
  tabs[0].apply(addOp);
  assert.equal(tabs[0].visibleItems().length, 0);
  assert.equal(tabs[1].visibleItems().length, 0);
  assertConverged(tabs);
});

test('同时编辑数量：最后写入获胜，且不丢其他字段', () => {
  const tabs = makeTabs(2);
  // 全部用确定性时间戳的 op：add(ts100) -> done(ts500) -> qty 并发(ts1000 vs ts2000)
  const add = { type: 'add', key: '酸奶', name: '酸奶', qty: 1, ts: 100, tab: 'tab-0' };
  const done = { type: 'done', key: '酸奶', done: true, ts: 500, tab: 'tab-1' };
  const early = { type: 'qty', key: '酸奶', qty: 3, ts: 1000, tab: 'tab-0' };
  const late = { type: 'qty', key: '酸奶', qty: 9, ts: 2000, tab: 'tab-1' };
  // 两个 tab 以相反顺序收到这两条 op（乱序）
  [add, done].forEach((op) => tabs.forEach((tab) => tab.apply(op)));
  tabs[0].apply(early); tabs[0].apply(late);
  tabs[1].apply(late); tabs[1].apply(early);

  tabs.forEach((tab) => {
    const [item] = tab.visibleItems();
    assert.equal(item.qty, 9, 'LWW 未选择最后写入');
    assert.equal(item.done, true, '数量编辑覆盖了勾选状态');
    assert.equal(item.name, '酸奶', '数量编辑覆盖了名称');
  });
  assertConverged(tabs);
});

test('离线操作恢复后合并正确', () => {
  const tabs = makeTabs(2);
  const net = new Network();
  net.send(0, tabs[0].add('咖啡', 1), tabs);
  net.flush(tabs);

  // tab1 离线：op 只进本地队列，不投递
  const offlineQueue = [];
  offlineQueue.push(tabs[1].add('茶叶', 2));
  offlineQueue.push(tabs[1].setDone('咖啡', true));
  offlineQueue.push(tabs[1].setQty('咖啡', 4));

  // 离线期间 tab0 继续操作
  net.send(0, tabs[0].add('糖', 1), tabs);
  net.send(0, tabs[0].setQty('咖啡', 99), tabs); // 比 tab1 的 qty 更晚
  net.flush(tabs);

  // tab1 恢复在线：补发队列
  offlineQueue.forEach((op) => net.send(1, op, tabs));
  net.flush(tabs, { shuffle: true });

  assertConverged(tabs);
  const items = tabs[0].visibleItems();
  const names = items.map((i) => i.name).sort();
  assert.deepEqual(names, ['咖啡', '糖', '茶叶'].sort());
  const coffee = items.find((i) => i.name === '咖啡');
  assert.equal(coffee.done, true, '离线勾选丢失');
  // qty 冲突：tab0 的 99 时间更晚，LWW 获胜（具体值不重要，关键是两 tab 一致）
  assert.equal(coffee.qty, tabs[1].visibleItems().find((i) => i.name === '咖啡').qty);
});

test('标签页关闭后重开：从快照恢复并反熵合并，数据不丢', () => {
  const tabs = makeTabs(2);
  const net = new Network();
  net.send(0, tabs[0].add('米', 1), tabs);
  net.send(0, tabs[0].add('面', 2), tabs);
  net.flush(tabs);

  // tab1 关闭：持久化快照
  const persisted = tabs[1].snapshot();
  // 关闭期间 tab0 继续操作（tab1 收不到）
  tabs[0].setDone('米', true);
  tabs[0].remove('面');
  tabs[0].add('油', 1);

  // tab1 重开：从 IndexedDB（快照）恢复
  const reopened = new ShoppingList('tab-1');
  reopened.mergeSnapshot(persisted);
  assert.equal(reopened.visibleItems().length, 2);

  // 反熵：收到 tab0 的全量 state 应答
  reopened.mergeSnapshot(tabs[0].snapshot());
  tabs[0].mergeSnapshot(reopened.snapshot());

  // 米（已勾选）和油可见，面已删除
  const visible = reopened.visibleItems();
  assert.equal(visible.length, 2);
  assert.equal(visible.find((i) => i.name === '米').done, true);
  assert.ok(visible.some((i) => i.name === '油'));
  assertConverged([tabs[0], reopened]);
});

test('消息乱序 + 重复投递不丢操作', () => {
  const tabs = makeTabs(3);
  const net = new Network();
  net.send(0, tabs[0].add('A', 1), tabs);
  net.send(1, tabs[1].add('B', 1), tabs);
  net.send(2, tabs[2].add('C', 1), tabs);
  net.flush(tabs, { shuffle: true, dup: true });
  net.send(0, tabs[0].setDone(keyOf('A'), true), tabs);
  net.send(1, tabs[1].setQty(keyOf('B'), 7), tabs);
  net.send(2, tabs[2].remove(keyOf('C')), tabs);
  net.flush(tabs, { shuffle: true, dup: true });
  assertConverged(tabs);
  const items = tabs[0].visibleItems();
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.name === 'A').done, true);
  assert.equal(items.find((i) => i.name === 'B').qty, 7);
});

test('合并幂等：同一快照合并多次结果不变', () => {
  const tabs = makeTabs(2);
  const net = new Network();
  net.send(0, tabs[0].add('水', 3), tabs);
  net.send(0, tabs[0].setDone('水', true), tabs);
  net.flush(tabs);
  const snap = tabs[0].snapshot();
  const target = tabs[1];
  target.mergeSnapshot(snap);
  const once = stateOf(target);
  target.mergeSnapshot(snap);
  target.mergeSnapshot(snap);
  assert.equal(stateOf(target), once);
});
