# 转告主人反馈（shangxue-tell-owner）

群里 / 私聊有人托话，机器人记成一张「工单」送到主人私聊；主人处理完，机器人回到原会话，**引用原消息 @ 当事人**回复。
转述由主模型（有人格、有记忆）用自然口吻完成，不是代码拼模板。

## 怎么用

1. 群里有人说：「替我告诉主人，语音模块坏了。」
2. 机器人用自然口吻把「谁 / 在哪 / 想让你知道什么」发给主人私聊。
3. 主人在私聊说：「修好了。」
4. 机器人找回对应工单，回原群引用那条消息、@ 他：「主人说已经修好了，可以再试试。」

## 工具

由主模型在合适的时候自己调用，不是关键词触发。

| 工具 | 谁用 | 作用 |
| --- | --- | --- |
| `shangxue_tell_owner` | 任何人 | 建工单并送达主人。必填 `summary`、`hasMedia`；`hasMedia: true` 时 `mediaPaths` 必填 |
| `shangxue_tell_owner_tickets_list` | 只有主人 | 查看工单；`includeDone` 可连已处理的一起列 |
| `shangxue_tell_owner_back` | 只有主人 | 回话。给 `replyText` 即可，`ticketId` 可选（默认最新待处理）；插件自动引用原消息 @ 当事人并标记完成 |
| `shangxue_tell_owner_delete` | 主人 / 工单发起人 | 按 `ids` 数组删除工单；发起人只能删自己的，不支持全部清空 |

附件可以给网址、本机路径或文件名，插件自己识别真实类型并补正确后缀；发送失败会自动兜底，不受「发文件」白名单限制。

## 配置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | 开 | 总开关 |
| `perUserPerDay` | 2 | 每人每天上限（按用户跨群累计），面板滑块 1~10 |
| `privateEnabled` | 开 | 别人私聊也能托话 |
| `ownerPrivateEnabled` | 关 | 主人自己私聊也能用（测试用） |
| `forwardMode` | `natural-sign` | `natural` 纯转述；`natural-sign` 额外补一行来源署名 |

面板里还有「反馈次数看板」，按发起人查看次数、重置今日额度。

## 安装

把整个模块目录放进 AuraBot 的模块目录，面板里填好主人 QQ（`config.ownerQQ`），启用即可。

数据都在 `data/`：`tickets.json`（工单）、`tickets.md`（可读镜像）、`media/`（附件）。

## 问题反馈

到 [aureth-labs/dsh-aurabot-qq-mods](https://github.com/aureth-labs/dsh-aurabot-qq-mods/issues) 提 Issue，
正文里 `@shangxueink` 并把 **shangxueink** assign 为负责人。请附上复现步骤和相关日志。

## 开发

```bash
npm install
npm run build   # 同步 module.json，清空 lib/ 后编译 src/**/*.ts
npm test        # 先 build，再跑 node --test
npm run check   # 只做类型检查
```

- `src/` 只放 TypeScript；`lib/` 是编译产物，不手改
- 根目录 `index.mjs` 只负责加载 `lib/index.js`
- `panel.js` 是手写的面板组件，留在模块根目录
- `package.json` 是模块配置的唯一来源，`module.json` 每次 build 自动生成，不要手改
- `build.out` 是 `lib`：发布包由 CI 构建，`lib/` 不进仓库

```
├── index.mjs            # 入口，加载 lib/index.js
├── panel.js             # 反馈次数看板
├── src/
│   ├── index.ts
│   ├── tickets/         # 工单存储与类型
│   ├── media/           # 附件识别与落盘
│   └── utils/           # 时间工具
├── lib/                 # 编译产物
├── build.mjs            # 构建：生成 module.json、编译 src/ → lib/
└── test/index.test.mjs
```

## 许可

MIT © 2026 shangxue
