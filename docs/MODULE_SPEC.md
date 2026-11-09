# 模块规范

模块的写法看插件的扩展接口文档 [API.md](https://github.com/aureth-labs/dsh-aurabot-qq/blob/main/src/modules/API.md)。这里只规定模块怎么进本仓库、怎么发布、插件怎么安装。

## 目录

```
modules/<id>/
├── module.json     # 必填：发布信息
├── index.mjs       # 必填：入口（或 index.js），和插件的用户模块写法一样
├── README.md       # 必填：做什么、怎么配置、会访问哪里
├── LICENSE         # 必填：这个模块自己的许可证
├── panel.js        # 可选：自定义面板
├── lib/            # 可选：实现文件，入口只放定义和接线
├── assets/         # 可选：模块自带的数据文件
├── docs/           # 可选：更长的说明
├── test/           # 可选：测试，不进发布包
└── package.json    # 可选：有 npm 依赖、构建或测试时才要
```

文件夹不按分类分层：永远是 `modules/<id>/`，分类写在 `module.json` 里。换分类不用搬目录，发布 tag 和安装路径也不变。

文件夹名就是模块 id。`_` 和 `.` 开头的文件夹不发布。测试文件（`*.test.*`、`test/`、`tests/`、`fixtures/`）、`node_modules` 和 `package-lock.json` 不进发布包。

## module.json

```json
{
  "id": "weather",
  "name": "查天气",
  "version": "1.0.0",
  "description": "一句话说明",
  "category": "tool",
  "tags": ["天气"],
  "author": "作者",
  "license": "MIT",
  "api": 1,
  "minPluginVersion": "1.1.24",
  "requires": [],
  "capabilities": ["network"],
  "homepage": "https://example.com",
  "build": { "out": ".build" }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 和文件夹名一样；规则同插件：小写字母开头，只有小写字母、数字和 `-`，2~40 个字 |
| `name`、`description`、`author`、`license` | 是 | 显示在模块市场 |
| `category` | 是 | 分类，见下表 |
| `tags` | 否 | 搜索用的关键词，最多 5 个 |
| `version` | 是 | `主.次.修`，和入口文件里的 `version` 一样 |
| `api` | 是 | 按哪一版扩展接口写的，和入口文件里的 `api` 一样 |
| `minPluginVersion` | 是 | 最低插件版本 |
| `requires` | 是 | 依赖的模块 id：内置模块或本仓库的模块，没有写 `[]` |
| `capabilities` | 是 | 用到的能力，见下表，没有写 `[]` |
| `replacesBuiltin` | 替换内置模块时 | 模块 id 和内置模块相同时必须写 `true` |
| `homepage` | 否 | 主页 |
| `build` | 有构建时 | 配了就在发布时运行 `npm ci --ignore-scripts` 和 `npm run build`，只打包 `out` 文件夹 |

有 npm 依赖的模块必须用 `build` 打成独立运行包，用户机器上不运行 `npm install`。

## 分类

| 值 | 含义 |
|---|---|
| `platform` | 逛平台：抖音、小黑盒这类 |
| `social` | 聊天互动：群里的玩法、聊天增强 |
| `creative` | 创作：画图、音乐、写作 |
| `desktop` | 桌面：桌宠、电脑上的事 |
| `manage` | 管理：群管、权限 |
| `tool` | 工具：查东西、提醒 |

## 能力

| 值 | 含义 |
|---|---|
| `network` | 联网 |
| `filesystem` | 读写本机文件 |
| `process` | 启动其他程序 |
| `dynamic-code` | 动态执行代码 |
| `plugin-config` | 读写插件配置，包括账号 Cookie |
| `plugin-internals` | 使用 `api.core`、`api.lib`、`api.dsh` 等内部对象，插件升级后可能失效 |

CI 会扫描源码，用到却没声明就不通过。**能力声明不是沙箱**：模块和插件在同一进程运行，声明只帮助审核者和用户判断，拦不住恶意代码。

## 发布

1. PR 合并到 `main` 后，`Release` 工作流检查所有模块。
2. 还没发布过的版本打成 zip，在隔离的只读 job 里完成。
3. 发布 Release，tag 为 `<id>-v<version>`，资源为 `<id>-v<version>.zip`。
4. 更新 `registry` 分支的 `index.json`。

已发布的版本不可修改，改了模块就要升 `version`。zip 的文件顺序和时间都固定，同样的内容得到同样的 sha256。

- **下架：** 删掉 `modules/<id>/`，索引里的条目随之消失，已发布的 Release 保留。
- **撤回：** 在 `revoked.json` 里加一条，插件应提示已安装的用户：

```json
[{ "id": "weather", "versions": ["1.0.0"], "reason": "原因" }]
```

## 索引

地址：`https://raw.githubusercontent.com/aureth-labs/dsh-aurabot-qq-mods/registry/index.json`

```json
{
  "schema": 1,
  "assetsBase": "https://github.com/aureth-labs/dsh-aurabot-qq-mods/releases/download/",
  "generatedAt": "2026-10-30T12:00:00.000Z",
  "modules": [
    {
      "id": "weather",
      "name": "查天气",
      "version": "1.0.0",
      "description": "一句话说明",
      "author": "作者",
      "license": "MIT",
      "api": 1,
      "minPluginVersion": "1.1.24",
      "requires": [],
      "capabilities": ["network"],
      "replacesBuiltin": false,
      "tag": "weather-v1.0.0",
      "file": "weather-v1.0.0.zip",
      "path": "weather-v1.0.0/weather-v1.0.0.zip",
      "size": 1234,
      "sha256": "…",
      "commit": "…",
      "publishedAt": "2026-10-30T12:00:00.000Z"
    }
  ],
  "revoked": []
}
```

下载地址是 `assetsBase + path`。镜像只要保持 `path` 不变，插件换一个 `assetsBase` 即可。

## 插件端要遵守的约定

社区模块页按这里实现（插件 `src/core/community.js`）：

- **兼容：** `schema` 不认识就停用；`api`、`minPluginVersion`、`requires` 不满足就不让装，并说明原因。
- **确认：** 安装前显示来源、版本和能力清单，并说明能力声明不是沙箱。更新同样要用户确认，不自动更新。
- **搬走的内置模块：** 唯一的例外。`pet`、`douyin`、`heybox`、`group-admin` 原是内置模块，插件升级时会替正在用它们的老用户自动安装一次，并在配置里记下，卸载后不再安装。这个名单写死在插件里，索引不能扩大它，其他模块一律要用户确认。
- **校验：** 下载后先核对 `sha256`，不一致就丢弃。zip 里的文件都在根目录，解压时拒绝绝对路径和 `..`。
- **落位：** 解压到 `modules/.<id>.installing/`，校验通过后再改名成 `modules/<id>/`。`.` 开头的文件夹不会被加载，插件 3 秒一次的扫描读不到半成品。
- **来源：** 在模块文件夹写 `.aurabot-source.json`，记录 id、版本、sha256。没有这个文件的同名文件夹是用户自己写的，不能覆盖。
- **替换内置：** `replacesBuiltin` 的模块要单独提醒。
- **卸载：** 默认保留 `modules-data/<id>/` 和设置，由用户选择是否清除。
- **撤回：** 已安装的版本出现在 `revoked` 里时提示用户，并建议关闭或卸载。
