# 语音点歌（shangxue-playmusic）

说「点歌 xxx」，机器人去**哔哩哔哩 / 网易云**搜原唱，下载后抽成 mp3，以**语音条**发回当前会话。
只点原唱，不做翻唱 / 变声；也不需要任何 Cookie——哔哩走星之阁第三方接口，网易云走公开搜索 + Meting 直链。

## 工具

| 工具 | 作用 |
|---|---|
| `shangxue_playmusic_search` | 按歌名搜候选（只搜不下载）。每平台 5 条，「哔哩+网易云」合计最多 10 条，返回 Markdown 表格。 |
| `shangxue_playmusic_sendsong` | 按 `platform`（`bilibili`/`netease`）+ `id`（BV 号 / 歌曲 id）下载、抽音、发语音条。 |

流程：用户点歌 → 主模型调 `search` → 挑最像原唱的一条 → 调 `sendsong`。用户直接给了 BV 号或歌曲 id 时可跳过搜索。
`sendsong` 的 `id` 传整条 B 站链接也能用（自动抠 `BVxxxxxxxxxx`）。

搜索是**四路并行**：哔哩直连 / 哔哩代理 / 网易云直连 / 网易云代理同时发出，每平台取最快的一条**有效**结果；空响应、空列表都算失败。

除了给 AI 调用的工具，还可以注册独立指令（默认 `/music 晴天`，不吃算力、不经 AI）。

## 配置

| 设置 | 默认 | 说明 |
|---|---|---|
| 总开关 | 开 | 关掉后不再提供点歌工具 |
| 搜索来源 | 哔哩+网易云 | 仅哔哩 / 仅网易云 / 两者 |
| 语音条最长时长 | 10 分钟 | 4~30 分钟，超出截断 |
| 代理地址 | 空 | 留空用内置 apifox；填 `direct` 只直连；填其它地址用自定义代理 |
| 仅主人可用 | 关 | 打开后只有主人能点 |
| 注册点歌指令 | 开 | 关掉就只有 AI 工具 |
| 点歌指令名 | `music` | 不带斜杠 |
| 给 AI 的提示词 | 见默认值 | 支持 `{{source}}`、`{{searchTool}}`、`{{sendTool}}`、`{{perLimit}}` |

## 安装

1. 把模块目录（或 CI 构建出的发布包）放到 `.../aurabot/modules/shangxue-playmusic/`。
2. 确认本机有 **ffmpeg**：`PLAYMUSIC_FFMPEG` / `AURABOT_FFMPEG`、常见盘符路径、`PATH` 三选一。
   `/status` 路由能看到 `ffmpegOk`。
3. 面板里按需调配置即可。

## 问题反馈

到 [aureth-labs/dsh-aurabot-qq-mods](https://github.com/aureth-labs/dsh-aurabot-qq-mods/issues) 提 Issue，
正文里 `@shangxueink` 并把 **shangxueink** assign 为负责人。请附上复现步骤和 `/status` 输出。

## 开发

只用 TypeScript 写，`package.json` 是模块配置的唯一来源：

```bash
npm install
npm run build   # 同步 module.json → 编译 src/ 到 lib/ → 删除 PR.md
npm test        # 先 build，再跑 node --test
npm run check   # 只做类型检查
```

```
src/
├─ index.ts            # 插件入口与两个工具
├─ providers/          # bilibili.ts / netease.ts
├─ audio/ffmpeg.ts     # 定位 ffmpeg、抽音
├─ cache/store.ts      # mp3 缓存
└─ utils/fetch-race.ts # 直连 + 代理并行竞速的 fetch
lib/                   # 编译产物，不进仓库，CI 构建
index.mjs              # 只加载 lib/index.js
```

构建产物不带注释（`removeComments`）。`module.json` 由 `package.json` 生成，不要手改。

### 复用到别的插件

`src/utils/fetch-race.ts` 是零依赖的单文件，直接复制过去即可：

```ts
import { fetchRace } from './utils/fetch-race.js'
const data = await (await fetchRace('https://api.example.com/x')).json()
```

留空走内置 apifox；`direct` 只直连；也支持 `timeoutMs`、`channels`、`validate`（业务级判空）、`readBody`。

## License

MIT © 2026 shangxue
