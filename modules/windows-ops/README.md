# 逛电脑（windows-ops）

经 PowerShell 操作主人这台 Windows 电脑：窗口枚举/激活/关闭、全屏截图、剪贴板读写、键鼠模拟（移动/点击/打字/按键），
以及 **UIA 元素定位**（读无障碍树，按选择器精确操作控件）。

## 怎么用

- 面板打开「总开关」后，主人对她说「帮我截个屏」「把微信窗口切到前台」「读一下剪贴板」等，她会用 `windows_ops` 工具去做。
- 主人也可以在 QQ 里发 `/wops`：
  - `/wops ops` 看全部操作与风险等级
  - `/wops status` 看开关/待确认项
  - `/wops shot` 试一张全屏截图（图落在模块数据目录 `shots/`）
  - `/wops confirm 批准|拒绝 <尾号>` 批准/拒绝危险操作
- 键鼠类操作（激活窗口/移动/点击/打字/按键，以及 uia.click / uia.setValue / uia.invoke）要再打开面板的「允许键鼠模拟」。

## 元素定位（UIA）：能用树就别用坐标

同样是点按钮、填输入框，有两种动法：

| 动法 | 操作 | 适用 | 弱点 |
| --- | --- | --- | --- |
| 坐标点击 | `mouse.move` / `mouse.click`（x、y 像素） | 什么界面都能点，Canvas/游戏/自绘界面只能靠它 | 窗口一挪、改大小、换主题/DPI 就全点偏；她不知道自己点到了什么 |
| 元素定位 | `uia.tree` / `uia.click` / `uia.setValue` / `uia.getText` / `uia.invoke`（pid + sel） | 普通程序的按钮、输入框、菜单、勾选框 | 界面不暴露无障碍树时读不到 |

默认优先元素定位（面板「元素定位（UIA）」卡的「优先用元素定位」开关，配置键 `preferUia`，默认 `true`）：
先 `uia.tree` 读树看界面 → 用选择器点名操作 → 实在读不到树才退回 `screenshot` + 坐标。

### 选择器语法（`sel` 参数）

格式「键=值」，多个条件用 `&&` 连起来（全部满足才算命中）。可用的键只有四个，
值按**前缀**匹配，不支持通配符：

| 键 | 含义 | 例 |
| --- | --- | --- |
| `AutomationId` | 程序给的唯一标识（最稳，优先用） | `AutomationId=submitBtn` |
| `Name` | 用户看得见的文字 | `Name=提交` |
| `ControlType` | 控件类型 | `ControlType=Button` / `Edit` / `MenuItem` |
| `ClassName` | Win32 类名 | `ClassName=Edit` |

```
AutomationId=submitBtn                    // 最稳：程序员给的唯一标识
Name=提交                                  // 用户看得见的文字
Name=提交&&ControlType=Button              // 多个条件一起钉死
ControlType=Edit&&AutomationId=username    // 输入框常见写法
```

每次操作都要带 `pid`（目标窗口进程号，先 `window.list` 认准）。元素**不跨调用有效**——
不要缓存元素，每次重新「pid + 选择器」去找；找不到元素时先读树核对字段名，别急着换坐标。

### 为什么填输入框要用 `uia.setValue`

`uia.setValue` 走 ValuePattern 直接把值写进控件，等价于程序内部赋值：**不受中文输入法影响**
（`key.text` 在中文输入法挂着时会把字母吃掉转成拼音，真机实测 `wops` 变成「我平时」）、
不用先点焦点、不受光标位置影响。而 `key.text` 只用短英文/数字，且作为 `setValue` 不被支持时的兜底。

## 指引体系（总纲常驻 + 手册按需，仿手机逛逛的分层设计）

- **主流程总纲 `main`**：经规则常驻注入（只挂主人私聊），总章程：怎么排任务、安全红线。第一原则是
  「动之前先观察——能读无障碍树就先读树，别盲点坐标」。面板独立一卡，只能编辑/还原，不能删。
- **单类手册**：`uia` 元素定位 / `input` 键鼠 / `window` 窗口 / `clipboard` 剪贴板 / `screenshot` 截屏 / `generic` 通用兜底；她按当前操作用 `windows_ops_guide` 工具现取（省 token），`uia.*` 操作自动取 `uia` 手册。面板「Windows 自动化指引」卡里像人格页那样分节编辑；自定义指引（`guides/<key>.md`，落数据目录）可覆盖内置、可删除（两道确认）。

## 安全

- 默认总开关关闭；工具只在**主人会话**放行（群友/别人不可用），`/wops` 命令本来就只认主人。
- 操作白名单：面板可挑操作加入，不在名单的一律拒绝（留空 = 按 builtin 规则放行）。
- 危险操作确认门槛：关窗口、键鼠动作第一次执行只进确认队列（面板「危险确认队列」卡批准/拒绝，或 `/wops confirm 批准 <尾号>`），**一次性**放行（10 分钟内有效）；可在面板关掉这个门槛（不建议）。
- 试运行：只过闸门不真动，用来安全试配置；另有每分钟操作上限。
- 所有参数不直接拼进 PowerShell 命令行（经 base64 传给脚本内解码），SendKeys 按键只接受白名单键名；UIA 选择器在 JS 侧解析成 PropertyCondition，不进脚本拼串。

## 会访问哪里

- 不联网。本机执行 `System32\WindowsPowerShell\v1.0\powershell.exe`（路径可在面板改）；
- 截图、日志、自定义指引写在本模块数据目录（`modules-data/windows-ops/` 下的 `shots/`、`logs/`、`guides/`），不写模块源码目录。

## 能力声明

`filesystem`（写截图/日志/自定义指引到数据目录）、`process`（启动 powershell.exe）、`plugin-internals`（用 `api.core.hub` / `api.core.http`）。
