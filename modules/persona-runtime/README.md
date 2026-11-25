# 人格运行时（persona-runtime）

> 第三方模块，从 aurabot 内置模块「人格运行时」移植而来。

## 做什么

她每条消息里「她是谁」由这一层决定：**自我指向、情感倾向、语气判读、情绪残余**。四段话术按固定顺序追加到每轮用户消息尾部（情感感知 → 情感思想 → 情绪记忆 → 自我意识半段；离生成最近权重最高），稳定半段（自我意识 + 本能附加段）经 rules 通道进 system 提示词。

九个开关分段可关，全关等于「安静日的她」——精确退回「人格卡基线 + 心情模块旧口径」，不是陌生人。

## 与自驱引擎的关系（非必需依赖）

与自驱引擎（autotelic）**协同但非必需**：装了且开着，三个单向出口工作——

- **观察桥**：显著情绪波动 → 引擎观察层（`source:'emotion'`）；主人纠正语气 → `source:'note'`
- **点火转发**：重要对话结束 → `schedule.ignite`（判断权全在引擎）
- **duty 行动申报**：主人委托本机动作 → 编译 `kind:'duty'` 行动票喂 `exec.run` 同一入口（只识别与编译，不自动执行；硬禁区优先、超管/接管只管级别上限与排队）

自驱引擎没装 / 没开时，本模块**独立降级运行**：注入、开关、预算、残余小史全部照常，只是上述三个出口如实显示「未接线」，绝不假装接上。审计通道（`api.core.autotelicAudit`）同理，未接线时只 debug 留痕。

## 怎么用

装到 `modules/persona-runtime/`，面板会出现独立标签页「人格运行时」：

- **运行状态**：管线触点、注入顺序、情绪现状只读镜像
- **总开关 + 九开关 + 5 个 rt\* 预算键**：保存即生效，不用重载模块
- **前缀同源**：双 hash 对照（不一致 = 接线漂移的显性信号）
- **注入预算与试拼**：零副作用试拼「她这轮会看到什么」
- **情绪残余**：近 24h 小史（现场派生，不落盘），可清展示（不动情绪向量）
- **两条单向出口**：观察桥 / 点火的手动试入口与接线自检

## 会访问哪些数据

- **读**：插件配置（`api.config()`：人格 ID、ownerName、`ext.autotelic.*` 镜像只读）；心情模块状态（`api.use('mood').state()`，纯读）；人格卡正文（插件内部 `persona/personas.js`）；自驱引擎技能库 instinct 目录文件（同源公开文件，纯读零副作用）；插件内部 `autotelic/prefix.js`、`autotelic/constraint.js`、`features/mood-emotions.js`（经 `globalThis.aurabot.lib`）
- **写**：只写自己的数据目录一个文件 `modules-data/persona-runtime/runtime.json`（开关快照 + 最近注入摘要，审计用）。情绪向量、观察层、审计账本全部由各自模块持有，本模块不复制任何真相
- **不联网**；没有定时器，全部事件驱动（唯一管线触点 `api.on('prompt')`）

## 测试

```bash
AURABOT_PLUGIN_DIR=<aurabot 插件工作副本> node --import ./scripts/plugin-env.mjs --test "modules/persona-runtime/test/*.test.mjs"
```

## 边界铁线

- 情绪唯一真相是 mood（本模块只读）；前缀唯一实现是 prefix.js；行动唯一通道是 exec.run
- 不建引擎→Runtime 的反向语气注入通道（观察桥只出不进）
- 清「残余小史」只清派生展示，不提供「清情绪向量」——那是对她情绪的篡改

## License

MIT
