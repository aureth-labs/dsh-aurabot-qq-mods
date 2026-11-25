# 跨聊天近况 · 设计说明

## 根因

插件内置 `src/features/memory.js` 里有一段 `crossHint()`，给主人私聊补「别的聊天最近说过什么」。
它开头是这个判断：

```js
if (getConfig().memory.crossContext !== true || !owner
    || chat?.kind !== 'private' || String(chat.userId) !== owner) return ''
```

写死了「只有主人私聊」。配 `memory.crossContext = true` 也只对主人私聊生效，别人的私聊照样空。
同函数里 `onlyAbout` / `requireAbout` 又限制非主人私聊只能召回「和这个人有关」的记忆。

结果：换个聊天就像失忆。这就是「你跟小椿聊完，别人问起来你答不上」的由来。

## 为什么做成模块

改插件本体也能修，但插件升级会覆盖。写成模块（`plugins-data/aurabot/modules/<id>/`）
插件升级不动它，而且能独立发版。

## 分层

```
index.mjs      入口：定义 + 接线（api.context / api.tool / api.route / api.every）
lib/nearby.mjs 实现：读流水 → 分拣 → 渲染
```

分拣逻辑集中在 `visibleToAuto()`（自动注入）和 `visibleToRecall()`（手动查询）两个函数里。
两者条件不同，这是故意的：

- 自动注入窄——别人那儿的默认值是「什么都不给」。
- 手动查询宽——被当面问可以答，但主人的私事仍然过滤。

**改隐私规则只该改这两个函数**，别散到别处去。

## 踩过的坑

### 1. `hub.groupName()` 是 async

同步拼接里直接调，渲染出来是 `[object Promise]`。
做法：渲染只读缓存，另开 `ensureGroupNames()` 用 Promise 异步拉，拉到写缓存，下一轮就对了。
兜底显示 `群123456` / `QQ123456`，不会出现 `undefined`。

### 2. 缓存初始为空时不能靠「遍历缓存」去刷新

一开始什么都没缓存，拿缓存当待刷新列表就是空转。
改成用「本轮可见的 chatId 列表」去拉。

### 3. 按聊天分组渲染

群聊里同一批消息会连续出现。分组渲染比逐条铺开省一半字数，也更像对话：

```
在「🦀🐖螃蟹猪猪养殖场🐖🦀」
  00:40 TA们：换个浏览器
  00:41 TA们：我把防火墙和杀毒软件全关了，也不让我安装
和七海铃
  00:14 你：好，那我等着
  00:21 对方：怎么样，妹妹和你说什么了吗
```

### 4. `api.context` 是同步的，拿不到异步实例

入口里第一次调用时实例还没建好，那一轮就返回空串。加了预热（`prewarm()` + `api.later`），
正常情况下一轮之内就建好了，实际感受不到。

## 数据流

```
chatlog/*.jsonl  ──collect()──▶  [{chatId, who, uid, t, text}]
                                      │
                                      ├─ visibleToAuto(chat) ──▶ 分组 ▸ 取 quota 条 ▸ 渲染 ▸ api.context
                                      │
                                      └─ visibleToRecall(chat) ──▶ 排序 ▸ 取 30 条 ▸ 渲染 ▸ 工具返回
```
