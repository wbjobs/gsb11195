# 共享购物清单（多标签页实时同步）

纯前端实现：多个浏览器标签页之间共享同一份购物清单，支持添加、勾选、取消勾选、删除、编辑数量、排序。无构建步骤、无后端。

## 运行

```bash
# 任意静态服务器均可（BroadcastChannel / IndexedDB 需要同源上下文）
python3 -m http.server 8000
# 打开 http://localhost:8000 ，多开几个标签页同时操作
```

## 测试

```bash
node --test test/crdt.test.js   # 或 npm test
```

11 个用例模拟多标签页并发：4 标签页 × 50 项、并发同名添加、并发勾选/删除、并发数量编辑 LWW、离线恢复、消息乱序/重复投递、墓碑防复活、快照反熵、合并幂等。

## 架构

```
index.html      页面结构
style.css       样式
js/crdt.js      CRDT 核心（纯逻辑，可在 Node 中测试）
js/db.js        IndexedDB 持久化（写穿）
js/sync.js      BroadcastChannel 同步 + 离线队列 + 反熵
js/app.js       DOM 渲染与交互
test/crdt.test.js  并发一致性测试（node:test）
```

### 数据模型：简化版 LWW-Map

- 清单是 **key → item** 的 Map，key 为归一化（trim、压缩空白、小写）后的物品名 —— 同名物品天然只有一条记录，并发添加不会重复。
- item 的每个字段（`name` / `qty` / `done` / `deleted`）是独立的 **LWW-Register**，携带 `(ts, tabId)` 时间戳；`ts` 来自混合逻辑时钟 `max(Date.now(), last+1)`，同毫秒时按 `tabId` 字典序决胜，保证全序。
- 字段级独立寄存器 ⇒ 编辑数量只动 `qty`，不会覆盖并发的勾选状态（"不丢其他字段"）。
- 删除是写 `deleted=true` 的**墓碑**：乱序到达的旧 `add` 因时间戳更旧无法复活已删除物品。
- 合并满足交换律、结合律、幂等 ⇒ 消息乱序、重复投递、任意顺序合并都收敛到同一状态。

### 同步协议（BroadcastChannel）

| 消息 | 说明 |
| --- | --- |
| `op` | 单条操作（add/qty/done/del），收到即合并，幂等、乱序安全 |
| `hello` | 启动 / 恢复在线时广播，请求全量状态（反熵） |
| `state` | 对 `hello` 的点对点应答，携带含墓碑的完整快照 |

- **写穿持久化**：每次变更先写 IndexedDB 再广播，标签页关闭/刷新/崩溃不丢数据；刷新后从 IndexedDB 恢复并 `hello` 反熵，清单立即一致。
- **离线**：点"模拟离线"后操作只落 IndexedDB 并进入待发送队列；恢复在线时先补发队列、再 `hello` 拉取他人变更，双向合并。
- **延迟**：BroadcastChannel 为同进程消息投递，本地变更到对端渲染通常在数毫秒内，远低于 200ms。

### 冲突语义

- 同时添加同一物品 → 合并为一项，字段由时间戳最新的那次 add 决定。
- 同时勾选/删除 → 各字段独立 LWW，所有标签页收敛到同一结果。
- 同时编辑数量 → 最后写入获胜（同毫秒按 tabId 决胜），其他字段不受影响。
- 应用层去重：添加已存在的物品时转为数量累加，而不是新建或重置。
