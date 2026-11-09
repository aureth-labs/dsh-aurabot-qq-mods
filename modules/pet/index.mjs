// 桌宠模块（内置模块，id='pet'；注册在 src/modules/index.js 的 BUILTINS，全新安装即有）
//
// ⚠ 来源与许可（别误当成自研）：桌宠的客户端形态（Electron 透明置顶窗 + 长轮询 + 气泡）、拖拽物理、
// pet pack 目录约定、以及工作状态六档 / 碎碎念动画的命名约定，都移植自 dsh-pet
// （https://github.com/PC2005-cloud/dsh-pet ，作者 PC2005-cloud，代码 MIT）。
// 本项目做的是把它接进 Aurabot 的模块体系（api.route 长轮询、载体互斥、面板设置、DSH 会话事件联动）。
// 形象/动画素材（「大肥鱼」）是 CC BY-NC-SA 4.0：体积大（50MB+）不进本仓库，由插件**启动时自动下载**落位
// 到数据目录 packs/（用户零操作；下载失败回落客户端内置形象）。默认地址是独立素材仓库
// dsh-aurabot-qq-mods（GitHub archive zip 直链，可在面板设置里换成任意镜像/Gitee 地址），署名见 THIRD-PARTY-NOTICES.md。
//
// 作用：给「主动搭话」提供一个桌面悬浮窗载体。插件侧只做三件事：
//   1. 在 /aurabot/api/* 挂一组 HTTP 长轮询接口（内置模块 route 无前缀；api.route 没有 WebSocket/SSE，R6）；
//   2. 往自己的数据目录写 host.json（baseUrl+token 的桌宠发现契约，见 docs/PET_MODULE_API.md）；
//   3. 暴露 dispatch({text,...})：carrier=pet 且桌宠在线 → 推气泡；离线 → 回落 QQ；永不双发。
// 数据一律写 api.dataDir()（模块文件夹本身不写数据——会被拍快照；api.dataDir 已带模块名 pet）。
// 桌宠 Electron 客户端源码在旁边的 pet-client/ 里，由 POST /client/install 生成到数据目录，Electron 由用户自装。
//
// 载体契约（给 purpose/speakup 模块用，详见 docs/PET_MODULE_API.md）：
//   · 配置：ext.pet.carrier（'qq'|'pet'，默认 qq）、ext.pet.modality（'text'|'voice'）、ext.pet.petFallbackToQQ（默认 true）
//   · api.use('pet').dispatch({ text, modality?, purpose?, force?, anim? }) → { ok, via:'pet'|'qq', ... }
//   · focus.json 开着时自动轮次一律不发（也不回落）；force=true（面板手动测试）可绕过

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync, copyFileSync, cpSync, rmSync } from 'node:fs'
import { join, dirname, sep, basename, extname } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
// 本地语音识别（按住说话）：复用 DSH 自带的 sherpa-onnx + SenseVoice，不另外装东西
import { transcribeWav, resolveModelDir } from './hear.mjs'
// 宠物数值体系 + 说话让路（都上纯函数，可脱离 Electron / fs 单测；见 life.mjs / sayq.mjs 头注释）
import * as Life from './life.mjs'
import { createSayQueue, PRIORITY } from './sayq.mjs'

const ONLINE_TTL = 60_000        // 心跳超时：60 秒内没轮询过 /events 就算离线
const EVENT_LIMIT = 200          // 事件内存队列上限
const WAIT_CAP = 60_000          // 长轮询最长挂起时间（客户端用 25s）
const MIN_MS = 60_000            // 一分钟（碎碎念间隔/静默窗口都用它）

// 设置项声明（从 export default 里提出来，只为了让 setup 内的配置校验能读到 min/max；
// 内容与原来逐行一致，改设置仍然只改这一处）。
const PET_SETTINGS = [
    { key: 'carrier', label: '主动搭话载体', type: 'select', options: [{ value: 'qq', label: 'QQ 私聊' }, { value: 'pet', label: '桌宠气泡' }], hint: 'pet 时桌宠不在线会按下面的开关回落到 QQ；两边永不双发' },
    { key: 'modality', label: '气泡形式', type: 'select', options: [{ value: 'text', label: '文字气泡' }, { value: 'voice', label: '文字 + 语音' }], hint: '语音失败自动降级为纯文字' },
    { key: 'petFallbackToQQ', label: '桌宠离线回落 QQ', type: 'switch' },
    { key: 'petPackUrl', label: '素材包下载地址', type: 'text', hint: '「大肥鱼」形象包 zip 直链（默认走 GitHub 素材仓库 dsh-aurabot-qq-mods；国内网络可换成 Gitee 等镜像直链）。zip 里素材要放文件夹（如 pet-pack/default-animation/），archive 自带的单层仓库目录会自动剥。装完插件后缺包自动下载，也可在面板手动重下' },
    { key: 'electronMirror', label: 'Electron 下载镜像', type: 'text', hint: '装 Electron 时从哪下（末尾带 /）。默认 npmmirror（国内快）；连不上可换 https://github.com/electron/electron/releases/download/ 等。npm 装失败会自动改用 zip 直装' },
    { key: 'whisperEnabled', label: '碎碎念', type: 'switch', hint: '只出现在桌宠气泡里，不会发到 QQ；载体是 QQ 时照常生效' },
    { key: 'whisperSource', label: '碎碎念内容', type: 'select', options: [{ value: 'model', label: '她自己想一句（工作区看得到思考）' }, { value: 'pool', label: '用现成文案' }] },
    { key: 'whisperMinMinutes', label: '碎碎念最短间隔（分钟）', type: 'number', min: 1, max: 9999 },
    { key: 'whisperMaxMinutes', label: '碎碎念最长间隔（分钟）', type: 'number', min: 1, max: 9999 },
    { key: 'whisperMaxPerDay', label: '碎碎念每日上限', type: 'number', min: 0, max: 9999 },
    { key: 'whisperLines', label: '碎碎念文案池', type: 'textarea', hint: '一行一句；留空用内置文案。选了「用现成文案」或模型失败时从这里抽' },
    { key: 'whisperPauseOnPetCarrier', label: '载体是桌宠时暂停碎碎念', type: 'switch', hint: '避免和「主动搭话」的气泡同时出现' },
    { key: 'workStatusEnabled', label: '干活状态动画', type: 'switch', hint: '跟着 DSH 会话切动画：思考中/干活中/等确认/完成/出错' },
    { key: 'workBubble', label: '完工弹一句气泡', type: 'switch' },
    { key: 'workNotify', label: '完工发系统通知', type: 'switch' },
    // 行为大脑（AI 只挑动作，本地执行器按单办事；第三批关窗相关键现在一并声明，骨架预留）
    { key: 'behaviorEnabled', label: '行为大脑', type: 'switch', hint: 'AI 定时挑一个小动作（追鼠标/溜达/打盹…），本地确定性执行；反应层（点击/摸摸）也归它管' },
    { key: 'behaviorMinMinutes', label: '行为最短间隔（分钟）', type: 'number', min: 1, max: 9999 },
    { key: 'behaviorMaxMinutes', label: '行为最长间隔（分钟）', type: 'number', min: 1, max: 9999 },
    { key: 'behaviorMaxPerDay', label: '行为每日上限', type: 'number', min: 0, max: 999999, hint: '默认 99999 约等于不限' },
    { key: 'behaviorIdleCursorMinutes', label: '鼠标闲置凑近（分钟）', type: 'number', min: 1, max: 240, hint: '鼠标停这么久没动，她凑过去戳一下' },
    { key: 'behaviorCloseWindowEnabled', label: '允许 AI 关闭窗口', type: 'switch', hint: '⚠ 高危：会真的关闭程序窗口，未保存的工作可能丢失。只拦 AI 路径，手动「试一下」也要先开这个开关' },
    { key: 'behaviorMoodCloseWindowBelow', label: '关窗心情闸（低于才关）', type: 'number', min: 0, max: 100, hint: '只有她闹脾气（心情低于此值）AI 才可能选关窗动作' },
    { key: 'behaviorIconMischiefEnabled', label: '图标小动作', type: 'switch', hint: '叼着桌面图标拖一拖 / 收走图标（可一键归还）' },
    { key: 'behaviorIconQuarantineDays', label: '图标隔离归还天数', type: 'number', min: 1, max: 365, hint: '被收走的图标超过这么多天自动放回原位' },
    { key: 'behaviorDisabledActions', label: '禁用 AI 动作', type: 'textarea', hint: '这些动作不进入 AI 动作表（手动按钮不受影响）。逗号分隔动作名，如：hide_icon,steal_cursor' },
    { key: 'behaviorWindowWhitelist', label: '窗口操作白名单', type: 'textarea', hint: '一行一个进程/标题关键词；留空 = 只碰普通窗口。DSH 自己的窗口、桌宠、资源管理器永远不碰' },
    // 聊天联动动作（内置形态的写入通道在 host.js /panel/pet/config + 面板「行为与安全」卡）
    { key: 'chatBehaviorEnabled', label: '聊天联动动作', type: 'switch', hint: '主人在生效范围内的聊天说话时，她可能根据聊天内容与心情顺带做个小动作；只读旁观，不影响回复' },
    { key: 'chatBehaviorWhitelist', label: '聊天联动生效范围', type: 'textarea', hint: '一行一个：private:QQ号 或 group:群号；留空 = 只有主人私聊生效' },
    { key: 'chatBehaviorCooldownMinutes', label: '聊天联动冷却（分钟）', type: 'number', min: 1, max: 1440 },
    { key: 'chatBehaviorMaxPerDay', label: '聊天联动每日上限', type: 'number', min: 0, max: 9999 },
    { key: 'petScale', label: '人物大小（倍）', type: 'number', min: 0.5, max: 2, hint: '桌宠整体缩放倍率：0.5 = 一半大，2 = 两倍大，1 = 原始大小。面板「桌宠」卡的大小滑条改的也是这一项' },
    { key: 'petReleaseLand', label: '松手后落地', type: 'switch', hint: '拖动松手后按甩出速度抛出去、落回屏幕底部（带 Q 弹挤压）；关掉则松手停在哪就在哪，不抛也不落' },
    { key: 'petAutoStart', label: '随 DSH 自动启动', type: 'switch', hint: '开：DSH 起来她就自己出来，DSH 关掉她就一起收掉（点「停止桌宠」后，下次启动不会自己出来，直到你再点启动）。关：完全手动，只有点「启动桌宠」才出来' },
    // ---- 上游 1.0.14 的动画节奏与互动开关（物理两键沿用上面已有的「重力/弹性」，不重复开） ----
    { key: 'petAnimRate', label: '动画节奏倍率', type: 'number', min: 0.5, max: 2, hint: '空闲小动作的节奏快慢：1 = 正常，2 = 间隔减半更活泼，0.5 = 更慵懒。只影响动画间隔，不改变物理与移动速度' },
    { key: 'petShowBalance', label: '右键「查看余额」', type: 'switch', hint: '开 = 桌宠右键菜单显示「查看余额」菜单项（点了向插件查询 DeepSeek 账户余额，气泡展示）。默认开；关 = 菜单里不出现这一项' },
    { key: 'petClickChase', label: '点击扑鼠标', type: 'switch', hint: '点击桌宠时扑上来抓鼠标（带冷却）。默认关：关 = 只播点击动画，不追鼠标' },
    { key: 'petTeaseChase', label: '晃鼠标勾引追', type: 'switch', hint: '在桌宠旁边快速晃鼠标时她可能扑上来追（带冷却）。默认关：关 = 晃鼠标不触发追逐' },
    // ---- 小屋（上游 1.0.12，复式场景窗）：素材/布局在数据目录 house/（目录即数据），开关只管入口显隐 ----
    { key: 'petHouseEnabled', label: '小屋', type: 'switch', hint: '右键桌宠「回小屋」打开复式小屋场景窗（移植自开源项目 dsh-pet-home，形象 CC BY-NC-SA 禁商用）。小屋素材（manifest.json 与图片）放数据目录 pet/house/ 里才有画面；没放素材时进屋会提示「素材未就绪」' },
    // ---- 物理手感（从 dsh-pet 的 physics 段搬来，以前写死在包配置里、面板改不了） ----
    { key: 'physicsGravity', label: '重力', type: 'number', min: 100, max: 6000, step: 50, hint: '越大落得越快、越"重"。默认 1400' },
    { key: 'physicsRestitution', label: '弹性', type: 'number', min: 0, max: 1, step: 0.02, hint: '碰地面/侧壁的反弹系数。0 = 不弹，1 = 完全不损失。默认 0.78' },
    { key: 'physicsGroundFriction', label: '地面摩擦', type: 'number', min: 0, max: 20, step: 0.5, hint: '落地后水平速度衰减快慢。默认 2.5' },
    { key: 'physicsCeilingBounce', label: '顶部反弹', type: 'switch', hint: '往上抛撞到屏幕顶部要不要弹；关掉就贴住顶不动' },
    { key: 'physicsThrowPower', label: '总力度', type: 'number', min: 0.1, max: 3, step: 0.1, hint: '抛掷总倍率，同时放大弹簧与初速。默认 1' },
    { key: 'physicsPetCollision', label: '桌宠互撞', type: 'switch', hint: '同时开多只桌宠时，甩出去会互相撞开（动量守恒，质量按体型算）。只有一只时没影响' },
    // ---- 动作频率（2026-11-05 跟进 dsh-pet 新版：权重从「只写死在素材包里」改成面板可调） ----
    // dsh-pet 新版口径（shared/weights.ts）：idle / turn / move 三项可编辑，随机动作（分类动作）是**余量**，
    // 不单独存配置 —— 等于 100 − 三项之和。三项之和超过 100 时夹到 100，绝不产出负数。
    { key: 'animWeightIdle', label: '待机权重', type: 'number', min: -1, max: 100, step: 1, hint: '空闲时演「待机池」动画的占比（%）。−1 = 跟随素材包配置。三项之和不要超过 100' },
    { key: 'animWeightTurn', label: '转向权重', type: 'number', min: -1, max: 100, step: 1, hint: '演完后翻朝向的占比（%）。回合池为空时这一档自动让给随机动作。−1 = 跟随素材包' },
    { key: 'animWeightMove', label: '移动权重', type: 'number', min: -1, max: 100, step: 1, hint: '自己走一小步的占比（%）。正在飞/被拖住时这一档自动让给随机动作。−1 = 跟随素材包' },
    // 随机动作（分类动作）那一档**不单独存**：它恒等于 100 − 上面三项之和（dsh-pet 的 actionPercent）。
    // 所以没有「随机动作权重」这一项可填 —— 想让它变多，就把上面三项调小。
    // ---- 初始位置（从 dsh-pet 的 position 搬来） ----
    { key: 'petCorner', label: '初始位置', type: 'select', options: [{ value: 'bottom-right', label: '右下角' }, { value: 'bottom-left', label: '左下角' }, { value: 'top-right', label: '右上角' }, { value: 'top-left', label: '左上角' }], hint: '启动时和「回到初始位置」把她放到哪个角' },
    { key: 'petMarginX', label: '水平边距（px）', type: 'number', min: 0, max: 2000, step: 2, hint: '离屏幕左右边缘多远。默认 24' },
    { key: 'petMarginY', label: '垂直边距（px）', type: 'number', min: 0, max: 2000, step: 2, hint: '离屏幕上下边缘多远。默认 16' },
    // ---- 以下四项从 dsh-pet（MIT License）搬来 ----
    { key: 'clickSound', label: '点击音效', type: 'switch', hint: '点一下桌宠响一声（素材 app/sound/click-duck.wav；100ms 内连点只响一次）' },
    { key: 'memeBubble', label: '碎碎念配梗图', type: 'switch', hint: '允许她在气泡末尾用 [图:名字] 配一张梗图；图放在 app/memes 里，没有图就不配' },
    { key: 'dreamTalk', label: '说梦话', type: 'switch', hint: '睡觉模块睡着时，隔一阵在气泡里嘟囔一句梦话（不发 QQ、不播动画）' },
    { key: 'customFont', label: '气泡用自定义字体', type: 'switch', hint: '用 app/fonts 里的字体（默认上首软糖体）显示气泡文字' },
    { key: 'fontFamily', label: '字体', type: 'select', options: [
      { value: 'candy', label: '软糖体（内置）' },
      { value: 'yahei', label: '微软雅黑 / 苹方' },
      { value: 'youyuan', label: '幼圆' },
      { value: 'kaiti', label: '楷体' },
      { value: 'simsun', label: '宋体' },
      { value: 'comic', label: '漫画体' },
      { value: 'system', label: '系统默认' },
    ], hint: '软糖体是随包带的；其余是系统字体，机器上没装时自动回退' },
    { key: 'fontSize', label: '字号（px）', type: 'number', min: 4, max: 200, step: 1, hint: '只影响气泡和悬浮提示，默认 21' },
    { key: 'fontFollowPet', label: '字号随人物大小缩放', type: 'switch', hint: '开 = 桌宠调大时字跟着大（默认）；关 = 恒为上面那个字号' },
    // ---- 语音播报（从 dsh-pet 搬来）：总开关 + 三个细分 + 音量 ----
    { key: 'voiceEnabled', label: '语音播报总开关', type: 'switch', hint: '关着的话下面三个细分开关一律不生效（不会突然冒出声）' },
    { key: 'voiceVolume', label: '播放音量', type: 'number', min: 0, max: 1, step: 0.05, hint: '0 = 静音，1 = 满音量。只改响度，不重新合成，不额外花 TTS' },
    { key: 'voiceWhisperEnabled', label: '碎碎念念出来', type: 'switch', hint: '周期碎碎念要不要出声（受总开关约束）。气泡和动画照常' },
    { key: 'voiceChatEnabled', label: '对话回复念出来', type: 'switch', hint: '桌宠对话框的回复要不要出声（受总开关约束）' },
    { key: 'voiceTodoEnabled', label: '待办播报念出来', type: 'switch', hint: '待办/提醒推送要不要出声（受总开关约束）' },
    // 待办面板（独立小窗：桌宠窗口只有 ~460 宽，塞不进可编辑清单，会把人顶走）
    { key: 'petTodoEnabled', label: '待办到点提醒', type: 'switch', hint: '清单里带时间的待办，到点前后会让桌宠弹气泡提醒（到期越近提醒越勤，逾期一周后不再念）。关掉只是不再提醒，清单照旧可记可看' },
    { key: 'petTodoHotkey', label: '待办快捷键', type: 'text', hint: '全局快捷键，按一次开、再按一次关待办小窗（如 Alt+T）。留空 = 不启用，只能用右键菜单「待办」打开' },
    // 按住说话（本地语音识别）
    { key: 'petHearEnabled', label: '按住说话', type: 'switch', hint: '鼠标停在她身上按住 M 说话，松手后本地转成文字（复用 DSH 自带的 SenseVoice 模型，不联网、不额外装东西）' },
    { key: 'petHearModelDir', label: '语音识别模型目录', type: 'text', hint: '留空 = 自动找 DSH 的标准位置（speech-to-text/sensevoice/models/sensevoice-onnx），一般不用填' },
    { key: 'petHearSendToChat', label: '识别后直接发送', type: 'switch', hint: '开：文字直接作为一句发给对话框（她马上回）；关：只把文字填进输入框，自己确认后再发送' },
    // 余额（DeepSeek 官方 /user/balance；金额档位 → 素材里 6 段余额动画）
    { key: 'petBalanceEnabled', label: '余额播报', type: 'switch', hint: '定时查 DeepSeek 余额，按金额挑一段余额动画 + 气泡说一句。要填下面的 API Key 才会真的去查' },
    { key: 'petBalanceKey', label: 'DeepSeek API Key', type: 'password', hint: 'sk- 开头的 API Key（platform.deepseek.com 里建）。只存本机桌宠数据目录，不发 QQ、不上传别处；留空 = 不查' },
    { key: 'petBalanceMinutes', label: '余额刷新间隔（分钟）', type: 'number', min: 5, max: 1440, hint: '多久查一次余额。接口按次计费很低但也不是零，别调太密；默认 60' },
    { key: 'petBalanceCurrency', label: '显示币种', type: 'text', hint: '多币种账户显示哪一种（CNY / USD）。留空 = CNY' },
    { key: 'petExtraCount', label: '再养几只', type: 'number', min: 0, max: 4, hint: '在桌面上再放几只桌宠（0 = 只有一只）。它们会互相碰撞、可以各自拖动和甩出去；每一只的名字 / 形象包 / 大小 / 人格在「桌宠」页的卡片里单独设，不开「自己说话」的那几只就只做动作不出声。重启后按这个数量恢复' },
    // ---- 数值体系（学 Astra Pet 的 design/pet-life：饱腹 / 精力 / 亲密度；陪伴，不制造焦虑）----
    { key: 'petLifeEnabled', label: '宠物数值', type: 'switch', hint: '她会饿、会困，认识你越久越亲近。关掉 = 回到纯观赏（不做数值、不发饿困气泡，随机动画和碎碎念照常）' },
    { key: 'petLifeSpeed', label: '数值变化速度', type: 'select', options: [{ value: 'slow', label: '慢（0.5×）' }, { value: 'normal', label: '标准（1×）' }, { value: 'fast', label: '快（2×）' }], hint: '饿得多快、精力掉得多快。标准大约是 12 小时从饱到饿' },
    { key: 'petLifeHint', label: '饿了 / 困了时', type: 'select', options: [{ value: 'bubble', label: '冒个小气泡' }, { value: 'status', label: '只在状态卡里显示' }, { value: 'off', label: '不提醒' }], hint: '只做动作和冒小气泡，绝不弹系统通知、也不朗读——那是打扰，不是陪伴' },
    { key: 'petFeedEnabled', label: '喂食', type: 'switch', hint: '右键菜单「喂食」子菜单；完成一轮专注会攒一份零食（最多 10 份），零食她能攒着，不会过期' },
    { key: 'petStatusCard', label: '悬停显示状态', type: 'switch', hint: '鼠标在她身上停 1 秒，头顶弹出小卡片：饱腹 / 精力 / 亲密度。拖拽中和说话时不显示' },
    // 对话框（桌宠旁的小窗聊天：快捷键/右键菜单唤出，按碎碎念同款人格+记忆+当下状态回答，永不发 QQ）
    { key: 'petChatEnabled', label: '对话框', type: 'switch', hint: '开桌宠旁的对话小窗：快捷键或右键菜单唤出，只聊在小窗/气泡里，绝不发 QQ' },
    { key: 'petChatHotkey', label: '对话框快捷键', type: 'text', hint: '全局快捷键，按一次开、再按一次关（如 Alt+P）。留空 = 不启用；被别的程序占用时注册失败，桌宠会气泡提醒一次、功能保持关闭，此处的当前注册状态看「状态」卡' },
    { key: 'petChatCloseKeyword', label: '关闭对话框的关键字', type: 'text', hint: '在对话框输入框里发送这句话 → 直接关窗、不请求模型。留空 = 不启用关键字关闭' },
    { key: 'petChatBlurHide', label: '失焦自动收起', type: 'switch', hint: '点别处（对话框失焦）时自动收起小窗' },
    { key: 'petChatMaxEntries', label: '对话历史最多保留条数', type: 'number', min: 10, max: 2000, hint: '本地小窗历史只存桌宠数据目录（不进 QQ、不进聊天记录），超限从头部截断；界面默认显示最近 50 条。注意：对话内容会作为模型请求发出去，模型自己决定记进长期记忆的条目另存，不受这里的条数/天数限制' },
    { key: 'petChatRetentionDays', label: '对话历史保留天数', type: 'number', min: 0, max: 3650, hint: '0 = 永久保留；否则启动时 + 每日清理本地小窗历史（只管小窗历史，管不到模型记下的长期记忆）' },
    // 天气（一期）：进 prompt 的「现在」段，她聊到出门/穿衣/下雨时接得上
    { key: 'petWeatherCity', label: '天气城市', type: 'text', hint: '填城市名（如 上海）才接入天气；留空 = 不接入，所有天气逻辑静默跳过。填了之后插件会向天气接口（默认 wttr.in，可在下方替换地址）请求这个城市的天气，结果只进 prompt 和本地缓存，不会发给聊天对象；天气接口本身会看到城市名' },
    { key: 'petWeatherUrl', label: '天气接口地址', type: 'text', hint: '高级：接口模板，{city} 会被替换成编码后的城市名，返回纯文本即可（如 https://wttr.in/{city}?format=%C+%t）。留空 = 用内置默认（wttr.in，免 key）；请求失败保留上一次缓存、不打扰' },
    { key: 'publicBaseUrl', label: '对外公网地址（远端直连）', type: 'text', hint: '服务器部署（无桌面）时填插件对外地址，如 https://bot.example.com（带 https:// 前缀，末尾斜杠可省）。填了之后：host.json 的 baseUrl 写它，桌宠客户端可在你自己的电脑上直连服务器；面板「桌宠」页会出现「下载客户端包」按钮，服务器上的 Electron 安装/启动按钮自动隐藏。留空 = 同机模式，一切照旧。⚠ 跨机必须 https：明文 http 会被直接阻断（令牌与气泡在公网明文传输等于送人）' },
    { key: 'allowInsecureRemote', label: '允许明文 http 跨机（不推荐）', type: 'switch', hint: '⚠ 仅内网自测：打开后允许 http:// 的非回环地址跨机连接，令牌与气泡内容明文传输，公网上等于把令牌送人。正常部署请用 https 反向代理，别开这个' },
    { key: 'tokenTtlDays', label: '桌宠令牌有效期（天）', type: 'number', min: 0, max: 3650, hint: '0 = 永不过期（默认，老用户零影响）。设了天数后令牌到期即要求重新下发；到期后在面板点「轮换令牌」并重新下载客户端包' },
    { key: 'trustedProxy', label: '可信反向代理地址', type: 'text', hint: '⚠ 只有放在反向代理后面才需要填。填反代自己的地址（如 127.0.0.1 = 本机 nginx，172.17.0.1 = 容器网关），多个用逗号分隔。只有「请求是从这个地址进来的」才会采信 X-Forwarded-For 的最后一跳作为真实来源，用于令牌失败限速与明文判定。留空 = 从不相信任何转发头（最安全）' },
]

export default {
  id: 'pet',
  name: '桌宠',
  version: '1.1.0',
  api: 1,
  description: '把大肥鱼请到桌面上：会冒气泡、做小动作，你在干活时也陪着你。',

  defaults: {
    carrier: 'qq', modality: 'text', petFallbackToQQ: true, pack: 'default',
    // 默认素材包下载地址（「大肥鱼」形象包不进插件仓库，从素材仓库拉；网络不佳可换成任意镜像直链）
    petPackUrl: 'https://github.com/aureth-labs/dsh-aurabot-qq-mods/archive/refs/heads/main.zip',
    // Electron 下载镜像（末尾带 /；留空 = 用内置默认）。npm 与 zip 直装两条路都读它
    electronMirror: 'https://npmmirror.com/mirrors/electron/',
    // 碎碎念（桌宠自己的气泡流，与「主动搭话」完全独立：载体选 QQ 时她也会在桌面上自己嘟囔）
    whisperEnabled: true,
    whisperSource: 'model',       // 'model' = 现想一句（失败回落本地池）/ 'pool' = 只用文案池
    whisperMinMinutes: 45,
    whisperMaxMinutes: 120,
    whisperMaxPerDay: 6,
    whisperLines: '',             // 自定义文案（一行一句；留空用内置池）
    whisperPauseOnPetCarrier: true, // 主动搭话已经走桌宠气泡时，碎碎念暂停（不同时冒两个气泡）
    // DSH 干活状态（思考/干活/完成…）联动：动画切换 + 结束提醒
    workStatusEnabled: true,
    workBubble: true,             // 干完活弹一句气泡
    workNotify: true,             // 干完活发系统通知（Electron 原生通知）
    // AI 行为大脑（决策层）：独立配额，与碎碎念/主动搭话完全无关
    behaviorEnabled: false, // 默认关（主人在 #115 审查时要求：先关着，面板里手动打开才会自己动）
    behaviorMinMinutes: 10,       // 独立触发间隔下限（硬下限 1 分钟，见 behaviorSettings 的 clamp）
    behaviorMaxMinutes: 25,
    behaviorMaxPerDay: 99999,     // 默认不设实际限制
    behaviorIdleCursorMinutes: 8, // 鼠标闲置多久后凑过去戳（反应层阈值，客户端读 /config）
    behaviorMoodCloseWindowBelow: 35, // 心情低于此值 AI 才可能关窗（第三批生效）
    behaviorCloseWindowEnabled: false, // 🔴 高危独立开关，只拦 AI 路径（物理闸：force 也不绕）
    behaviorIconMischiefEnabled: true, // 图标动作独立开关（第二批生效）
    behaviorIconQuarantineDays: 7,     // 隔离区自动归还天数（第二批生效）
    behaviorDisabledActions: '',       // 逗号分隔动作名：不进入 AI 动作表（手动按钮不受影响）
    behaviorWindowWhitelist: '',       // 窗口操作白名单，空=仅普通窗口（第三批生效）
    // 聊天联动动作（跟着 QQ 聊天内容与心情挑一个安分小动作；独立开关与独立配额，默认关）
    chatBehaviorEnabled: false,        // 总开关：只读旁观聊天，不影响回复；默认关
    chatBehaviorWhitelist: '',         // 生效范围：一行一个 chatId（private:123 / group:456）；留空 = 只有主人私聊生效
    chatBehaviorCooldownMinutes: 5,    // 两次聊天联动之间的全局冷却（分钟，1~1440）
    chatBehaviorMaxPerDay: 20,         // 聊天联动每日上限
    petScale: 1,                       // 人物大小倍率（0.5~2.0，1 = 原始 240px；客户端按窗口宽等比缩放）
    petReleaseLand: true,              // 松手后落地：开 = 按甩出速度抛出去并落回屏幕底部（原行为）；关 = 松手停在哪就在哪
    petAutoStart: true,                // 随 DSH 自动启动（首次默认开：装上就有「开 DSH 她就在」的体验）
    // 甩抛物理与互动开关（上游 1.0.14 的五项；物理两键沿用本地已有的 physicsGravity/physicsRestitution，
    // 不再重复开 petGravity/petRestitution —— 否则面板会出现两个「重力」滑条各调一半）
    petAnimRate: 1,                    // 动画节奏倍率（0.5~2）：>1 更活泼（空闲轮播间隔 ÷ 它）
    petShowBalance: true,              // 右键菜单「查看余额」：开才显示菜单项
    petClickChase: false,              // 点击扑上来抓鼠标（默认关；关 = 点了只播点击动画不追）
    petTeaseChase: false,              // 晃鼠标勾引追（默认关；关 = 晃鼠标不扑）
    // 小屋（上游 1.0.12）：复式场景窗，素材/布局在数据目录 house/，这个开关只管入口显隐
    petHouseEnabled: true,             // 右键「回小屋」（默认开；没放素材时进屋提示「素材未就绪」）
    // 物理（拖拽抛掷手感，从 dsh-pet 搬来，面板可调）
    physicsGravity: 1400,
    petGravity: 1400,              // 重力 px/s²
    physicsRestitution: 0.78,
    petRestitution: 0.78,          // 碰边弹性 0~1
    physicsGroundFriction: 2.5,        // 地面摩擦 /s
    physicsCeilingBounce: true,        // 顶部反弹
    physicsThrowPower: 1,              // 总力度倍率 0.1~3
    physicsPetCollision: true,         // 多只桌宠互撞（单只时无影响；照 dsh-pet 的 collidePet）
    // 动作频率（2026-11-05 跟进 dsh-pet 新版 shared/weights.ts）：三项可调，随机动作吃余量（100 − 三项之和）。
    // −1 = 不干预，跟随素材包 animationWeights（老用户零退化）。
    animWeightIdle: -1,                // 待机占比 %
    animWeightTurn: -1,                // 转向占比 %
    animWeightMove: -1,                // 移动占比 %
    // 初始位置（从 dsh-pet 的 position 搬来）
    petCorner: 'bottom-right',         // 初始角落
    petMarginX: 24,                    // 水平边距 px
    petMarginY: 16,                    // 垂直边距 px
    // 对话框（主人找她聊的小窗，与碎碎念/聊天联动是三码事；永不发 QQ）
    petChatEnabled: false,             // 总开关：默认关（仿行为大脑，面板手动打开）
    petChatHotkey: 'Alt+P',            // 全局快捷键（单键 toggle）；留空 = 不启用；被占用保持关闭
    petChatCloseKeyword: '关闭',        // 关闭对话框的关键字：输入框发送前命中直接关窗、不请求模型
    petChatBlurHide: true,             // 失焦自动收起
    petChatMaxEntries: 200,            // 历史最多保留条数（超限从头部截断）
    petChatRetentionDays: 30,          // 历史保留天数（0 = 永久）
    // 天气（一期，服务端接入）：城市留空 = 不接入；接口留空用内置默认（wttr.in，免 key）
    petWeatherCity: '',
    petWeatherUrl: '',                 // 接口地址模板，{city} 会被替换成编码后的城市名；返回纯文本即可
    // 对外公网地址（远端直连，2026-11-02 起）：填了 http(s) 完整地址（如 https://bot.example.com），
    // host.json 的 baseUrl 就写它，桌宠客户端可在用户自己电脑直连服务器插件。留空 = 全部行为与旧版一致（同机零退化）
    publicBaseUrl: '',
    // 安全项（2026-11-02）：明文 http 跨机默认阻断；令牌过期天数（0 = 不过期，老用户零退化）
    allowInsecureRemote: false,
    tokenTtlDays: 0,
    // 可信反向代理（2026-11-02 安全审查 P1-1）：只有 socket 是回环、且来源地址命中这个列表时，
    // 才相信 X-Forwarded-For 的**最后一跳**作为真实来源。留空 = 从不相信任何转发头（最安全）。
    // 反代部署时填反代自己的地址，如 127.0.0.1（本机 nginx）或 172.17.0.1（容器网关）。
    trustedProxy: '',
    // 以下四项从 dsh-pet 搬来
    clickSound: true,      // 点桌宠响一声（素材 app/sound/click-duck.wav）
    memeBubble: true,      // 允许碎碎念带梗图（[图:名字]）
    dreamTalk: true,       // 睡着时说梦话
    customFont: true,      // 用素材里的自定义字体
    fontFamily: 'candy',   // 字体种类（dsh-pet 的 7 种预设）
    fontSize: 21,          // 气泡字号 px
    fontFollowPet: true,   // 字号随人物大小缩放
    // 语音播报（从 dsh-pet 搬来）：总开关 + 三个细分开关 + 音量
    voiceEnabled: false,        // 总开关：不打开则下面三项一律不念
    voiceVolume: 1,             // 播放音量 0~1（只改响度，不重新合成，不额外花 TTS）
    voiceWhisperEnabled: false, // 碎碎念要不要念出来
    voiceChatEnabled: false,    // 对话框回复要不要念出来
    voiceTodoEnabled: false,    // 待办提醒要不要念出来
    // 待办（独立小窗 + 到点提醒）
    petTodoEnabled: true,       // 总开关：关掉则不再按点弹提醒（清单照旧可开可记）
    petTodoHotkey: '',          // 全局快捷键，唤起待办小窗（如 Alt+T）；留空 = 只能用右键菜单
    // 按住说话（本地语音识别：鼠标停在她身上按住 M，松手出文字）
    petHearEnabled: true,       // 按住说话开关
    petHearModelDir: '',        // 模型目录（留空 = 自动找 DSH 的标准位置）
    petHearSendToChat: true,    // 识别出文字后直接发给对话框（关掉只把文字填进输入框）
    // 余额（对齐 dsh-pet 的 /balance：查 DeepSeek 官方接口，按金额挑一段余额动画 + 气泡播报）
    petBalanceEnabled: false,   // 默认关：没填 Key 之前查了只会一直报「查不到」
    petBalanceKey: '',          // DeepSeek API Key（sk-...）；只写本机数据目录，不进 QQ、不上传
    petBalanceMinutes: 60,      // 自动刷新间隔（分钟）
    petBalanceCurrency: 'CNY',  // 多币种时显示哪一个
    // 多开：额外养几只（0 = 只有主宠物）。重启后按这个数量恢复。
    petExtraCount: 0,
    // ---- 数值体系（饱腹 / 精力 / 亲密度；学 Astra Pet 的 design/pet-life，基调是「陪伴不惩罚」）----
    petLifeEnabled: true,       // 总开关：关掉就完全不跑数值（回到纯观赏，随机动画/碎碎念照常）
    petLifeSpeed: 'normal',     // 变化速度：slow 0.5× / normal 1× / fast 2×
    petLifeHint: 'bubble',      // 饿了困了怎么表现：bubble 冒小气泡 / status 只在状态卡显示 / off 不提醒
    petFeedEnabled: true,       // 右键菜单「喂食」子菜单 + 专注完成奖励零食
    petStatusCard: true,        // 悬停 1 秒弹头顶状态小卡
  },
  settings: PET_SETTINGS,
  // 自带面板页（modules/pet/panel.js）：面板「桌宠」页会多出「多养几只」这一块。
  // 走 mods.panelSource(id) 那条路（只认 user 模块的 panel 文件），热重载就生效。
  panel: true,


  setup(api) {
    const voiceDir = () => api.dataDir('voice')
    const hostFile = () => api.dataDir('host.json')
    const tokenFile = () => api.dataDir('host-token')
    const focusFile = () => api.dataDir('focus.json')
    // 桌宠「想不想开着」的意图标记（方案 B：跟着 DSH 自动启停）。
    // 只有面板上的明确动作会写它：点「启动」→ true，点「停止」/托盘退出 → false。
    // 客户端自己崩溃/孤儿自退**不经过模块**，所以不会把这个标记改掉——
    // 这正是「你手动关掉的」和「它意外死了」能区分开的原因。
    const wantedFile = () => api.dataDir('pet-wanted.json')

    const readJson = (file, fallback = null) => {
      try {
        const raw = readFileSync(file, 'utf8')
        return raw.trim() ? JSON.parse(raw) : fallback
      } catch { return fallback }
    }
    // 【安全审查 P1】host.json / host-token 里装着长期 bearer 令牌，落盘权限必须收紧到 0600
    // （仅属主可读写）。Windows 上 chmod 基本无效（ACL 那套不认 mode），包在 try 里静默跳过即可；
    // 真正起作用的场景是 Linux / macOS 服务器部署——多用户机器上别的账号不该读到令牌。
    const chmodPrivate = (file) => {
      try { chmodSync(file, 0o600) } catch { /* Windows 或不支持 mode 的文件系统：忽略 */ }
    }
    const writeJsonAtomic = (file, data, { private: isPrivate = false } = {}) => {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`
      const text = JSON.stringify(data, null, 2)
      writeFileSync(tmp, text, 'utf8')
      if (isPrivate) chmodPrivate(tmp)
      try { renameSync(tmp, file) } catch { writeFileSync(file, text, 'utf8') }
      if (isPrivate) chmodPrivate(file)
    }

    // ---------- 令牌（host-token：32~80 位 hex，已生成过就直接复用） ----------
    // 【安全】令牌是长期 bearer，跨机部署时它就是唯一防线（Host/Origin 闸只防浏览器跨站，
    // 不防直接发请求的脚本）。因此补三件事：
    //   ① 轮换（rotateToken）：一键换新，旧的立即失效，客户端需重新下载包；
    //   ② 过期（tokenTtlDays，默认 0 = 不过期，老用户零退化）；
    //   ③ 签发时间落盘（host-token.json），供过期判定与界面展示。
    let tokenCache = ''
    let tokenIssuedAt = 0 // 签发时间（ms）；0 = 老令牌文件没有记录，按「不过期」处理
    const tokenMetaFile = () => api.dataDir('host-token.json')
    function token() {
      if (tokenCache) return tokenCache
      try {
        const raw = readFileSync(tokenFile(), 'utf8').trim()
        if (/^[a-f0-9]{32,80}$/.test(raw)) {
          tokenCache = raw
          try { tokenIssuedAt = Number(readJson(tokenMetaFile(), {})?.issuedAt) || 0 } catch { tokenIssuedAt = 0 }
          return raw
        }
      } catch {}
      const next = randomBytes(24).toString('hex') // 48 位 hex
      tokenCache = next
      tokenIssuedAt = Date.now()
      try {
        mkdirSync(dirname(tokenFile()), { recursive: true })
        writeFileSync(tokenFile(), next, 'utf8')
        chmodPrivate(tokenFile()) // 只要属主可读写
        writeJsonAtomic(tokenMetaFile(), { issuedAt: tokenIssuedAt }, { private: true })
      } catch (error) { api.log.warn('写 host-token 失败：', String(error.message || error)) }
      return next
    }
    /** 令牌是否已过期。tokenTtlDays 默认 0（永不过期）；老令牌无签发时间时按不过期处理。 */
    function tokenExpired() {
      const ttl = Number(api.settings().tokenTtlDays) || 0
      if (ttl <= 0 || !tokenIssuedAt) return false
      return Date.now() - tokenIssuedAt > ttl * 86400_000
    }
    /** 轮换令牌：生成新的、旧的立即失效，并重写 host.json（客户端必须重新下载包才能连上）。 */
    function rotateToken() {
      const next = randomBytes(24).toString('hex')
      const prev = tokenCache
      tokenCache = next
      tokenIssuedAt = Date.now()
      try {
        mkdirSync(dirname(tokenFile()), { recursive: true })
        writeFileSync(tokenFile(), next, 'utf8')
        chmodPrivate(tokenFile()) // 只要属主可读写
        writeJsonAtomic(tokenMetaFile(), { issuedAt: tokenIssuedAt }, { private: true })
      } catch (error) {
        tokenCache = prev // 写盘失败就回滚，别让运行中的令牌与磁盘不一致
        return { ok: false, message: '轮换令牌失败：' + String(error?.message || error).slice(0, 120) }
      }
      try { writeHostFile(true) } catch {}
      api.log.info('桌宠令牌已轮换：旧令牌立即失效，请在面板重新下载客户端包')
      return { ok: true, message: '令牌已轮换：旧客户端会连不上，需重新下载客户端包', issuedAt: tokenIssuedAt }
    }
    const safeEqual = (a, b) => {
      if (!a || !b || a.length !== b.length) return false
      try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)) } catch { return false }
    }

    // ---------- 令牌鉴权限速（公网部署防暴力猜） ----------
    // 48 位 hex 的暴力空间本来就够大，但「无限次尝试」本身就是不该留的口子：
    // 按来源 IP 记失败次数，超阈值后指数退避封禁（10 分钟窗口内 20 次失败 → 封 1 分钟，
    // 每多 10 次失败封禁翻倍，上限 30 分钟）。只对「令牌错」计数，Host 闸拒绝不计。
    const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000
    const AUTH_FAIL_LIMIT = 20
    const AUTH_BAN_MAX_MS = 30 * 60 * 1000
    const authFails = new Map() // ip → { count, firstAt, bannedUntil }

    // ---------- 真实来源判定（2026-11-02 安全审查 P1-1 / P1-2）----------
    // 铁律：**socket 地址才是唯一可信的来源**。X-Forwarded-For 是请求方随便写的头，
    // 直连暴露时客户端自带 `X-Forwarded-For: 1.2.3.4` 就能把自己伪装成任意 IP（绕过封禁、
    // 或伪造受害者 IP 让正常人被封）。所以：
    //   1) socket 不是回环 → 一律按 socket 判，转发头完全不看；
    //   2) socket 是回环 → 如果来源命中 trustedProxy，才采信 XFF 的**最后一跳**
    //      （最后一跳是反代自己追加的真实直连来源；前面几跳是客户端自报的，绝不采信）；
    //   3) socket 是回环且未配 trustedProxy → 就是本机直连，按回环处理。
    const normAddr = (a) => String(a || '').trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '')
    const settingsList = (key) => String(api.settings()[key] || '').split(',').map((s) => normAddr(s)).filter(Boolean)
    /** 请求的 socket 地址（剥离 IPv6-mapped 前缀，便于和回环/白名单比较）。 */
    const socketAddr = (req) => normAddr(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '')
    /** socket 是否来自本机（含进程内直调：没有 socket 信息时按本机处理）。 */
    function socketIsLoopback(req) {
      const sock = socketAddr(req)
      if (!sock) return true // 进程内直调（测试 / 内部转发）；真实 HTTP 一定有 remoteAddress
      return isLoopbackHost(sock) || sock === '::1'
    }
    /** 这个请求是不是从「我们信任的反向代理」进来的（socket 命中 trustedProxy）。 */
    function fromTrustedProxy(req) {
      const list = settingsList('trustedProxy')
      if (!list.length) return false
      return list.includes(socketAddr(req))
    }
    /** 真实来源 IP：只用于限速计数与「是否本机」判定，绝不用于鉴权放行。 */
    function clientIp(req) {
      // 1) 直连（socket 非回环）：只信 socket，转发头一律不看
      if (!socketIsLoopback(req)) return socketAddr(req) || 'unknown'
      // 2) socket 回环：只有确认来源是可信反代，才看 XFF 最后一跳
      if (fromTrustedProxy(req)) {
        const hops = String(req?.headers?.['x-forwarded-for'] || '').split(',').map((x) => normAddr(x)).filter(Boolean)
        if (hops.length) return hops[hops.length - 1] // 最后一跳 = 反代追加的真实来源
      }
      // 3) 本机直连（或配置了反代但请求没走它）
      return socketAddr(req) || '127.0.0.1'
    }
    /** 请求是否算「本机来源」：给明文阻断、Host 闸等地方用，口径与 clientIp 一致。 */
    function requestIsLocal(req) {
      if (!socketIsLoopback(req)) return false
      if (fromTrustedProxy(req)) {
        const ip = clientIp(req)
        return isLoopbackHost(ip)
      }
      return true
    }
    /** 返回封禁剩余毫秒（0 = 未封禁）。 */
    function authBanRemaining(ip) {
      const rec = authFails.get(ip)
      if (!rec || !rec.bannedUntil) return 0
      const left = rec.bannedUntil - Date.now()
      if (left <= 0) { rec.bannedUntil = 0; return 0 }
      return left
    }
    function recordAuthFail(ip) {
      const now = Date.now()
      let rec = authFails.get(ip)
      if (!rec || now - rec.firstAt > AUTH_FAIL_WINDOW_MS) { rec = { count: 0, firstAt: now, bannedUntil: 0 }; authFails.set(ip, rec) }
      rec.count += 1
      if (rec.count >= AUTH_FAIL_LIMIT) {
        const over = Math.floor((rec.count - AUTH_FAIL_LIMIT) / 10)
        const ban = Math.min(AUTH_BAN_MAX_MS, 60_000 * Math.pow(2, over))
        rec.bannedUntil = now + ban
        api.log.warn(`桌宠：来源 ${ip} 令牌连续失败 ${rec.count} 次，封禁 ${Math.round(ban / 1000)} 秒`)
      }
      // 定期清理过期记录，防 Map 无限增长（低开销：只在写入时顺手清）
      if (authFails.size > 512) {
        for (const [k, v] of authFails) { if (now - v.firstAt > AUTH_FAIL_WINDOW_MS && !(v.bannedUntil > now)) authFails.delete(k) }
      }
    }
    function recordAuthOk(ip) {
      const rec = authFails.get(ip)
      if (rec) authFails.delete(ip) // 成功即清空该 IP 的失败记录
    }

    // ---------- 远端直连（publicBaseUrl，2026-11-02）----------
    // 单一真相：ext.pet.publicBaseUrl（api.settings() = defaults ∪ ext.pet，host.js 面板写入通道同键）。
    // 合法 http(s) URL 才生效；显式配置优先于 X-Forwarded 兜底学习。未配置（空串/坏值）时
    // writeHostFile / learnHost / guard 的行为与旧版逐字节一致——这是「同机零退化」的实现点。
    const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']
    let learnedPublic = '' // 反代 X-Forwarded-Proto/Host 兜底学习的对外地址（只在没显式配置时用）
    /** 明文 http 是否被允许用于跨机直连。默认**不允许**：令牌与气泡内容在公网明文传输等于送人。
     *  内网自测（如 http://192.168.1.5）可显式开 ext.pet.allowInsecureRemote 放行，
     *  但那只适合「自己知道自己在内网」的场景。回环地址永远允许（不跨机）。 */
    const insecureRemoteAllowed = () => api.settings().allowInsecureRemote === true
    /** 当前生效的对外地址：{ url, host } 或 null（未配置且未学到 → 纯同机模式）。 */
    function publicBase() {
      const raw = String(api.settings().publicBaseUrl || '').trim().replace(/\/+$/, '')
      if (/^https?:\/\//i.test(raw)) {
        try { const u = new URL(raw); if (u.hostname) return { url: raw, host: u.hostname.toLowerCase().replace(/^\[|\]$/g, '') } } catch {}
      }
      if (learnedPublic) {
        try { const u = new URL(learnedPublic); if (u.hostname) return { url: learnedPublic, host: u.hostname.toLowerCase().replace(/^\[|\]$/g, '') } } catch {}
      }
      return null
    }
    /** 对外地址是否是不安全的明文（http 且非回环）。用于 host.json 写盘警告与面板提示。 */
    function publicBaseInsecure() {
      const pb = publicBase()
      if (!pb) return false
      return /^http:\/\//i.test(pb.url) && !isLoopbackHost(pb.host)
    }
    const isLoopbackHost = (h) => LOOPBACK_HOSTS.includes(String(h || '').toLowerCase().replace(/^\[|\]$/g, ''))
    /** Host/Origin 主机名是否放行：回环 或 与对外地址主机名一致（端口段忽略，真正鉴权交给 x-pet-token）。 */
    const hostAllowed = (hostname) => {
      const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
      if (isLoopbackHost(h)) return true
      const pb = publicBase()
      return Boolean(pb && h === pb.host)
    }

    // ---------- host.json（baseUrl 端口会漂移：从请求 Host 头学习） ----------
    let knownPort = ''
    let lastHostWriteAt = 0
    function writeHostFile(force = false) {
      const now = Date.now()
      if (!force && now - lastHostWriteAt < 5000) return
      lastHostWriteAt = now
      const data = {
        version: 1,
        // 端口未就绪写 null（客户端 readHost 的正则不匹配就一直等，不再写假的 :0 造成自举死锁）；
        // 真实端口由宿主启动时经 setWebPort() 注入，Host 头学习保留作漂移纠正。
        // 远端直连：配置了 publicBaseUrl 时 baseUrl 一律写它（api 字段照旧）；未配置时与旧版逐字节一致。
        baseUrl: publicBase() ? publicBase().url : (knownPort ? `http://127.0.0.1:${knownPort}` : null),
        token: token(),
        api: `/aurabot/api`,
        pluginVersion: api.version,
        updatedAt: new Date(now).toISOString(),
      }
      // 明文跨机警告：不让它静悄悄地跑（令牌与气泡在公网明文传输 = 送人）
      if (publicBaseInsecure()) {
        if (insecureRemoteAllowed()) {
          api.log.warn(`桌宠对外地址是明文 http（${data.baseUrl}）：已按 allowInsecureRemote 放行，仅建议内网使用`)
        } else {
          api.log.error(`桌宠对外地址是明文 http（${data.baseUrl}）：**已阻断跨机访问**。请在反向代理上启用 https，或在配置里显式打开 allowInsecureRemote（只建议内网自测）`)
        }
      }
      // host.json 内含 bearer 令牌，落盘权限收紧到 0600（POSIX 平台生效）
      try { writeJsonAtomic(hostFile(), data, { private: true }) } catch (error) { api.log.warn('写 host.json 失败：', String(error.message || error)) }
    }
    /** 反代 X-Forwarded-Proto/Host 兜底学习对外地址（只在未显式配置 publicBaseUrl 时生效）。
     *  安全铁律：**只能在 token 鉴权通过之后调用**——学习会改写 host.json 的 baseUrl，
     *  若在鉴权前调用，任何未鉴权的外部请求都能投毒 host.json，还能借 hostAllowed() 绕过 Host 闸，
     *  最终把桌宠客户端的 bearer 令牌引到攻击者服务器。 */
    function learnForwardedPublic(req) {
      // 显式配置优先：面板填了 publicBaseUrl 就完全不认反代头（防伪造头覆盖真实配置）
      if (String(api.settings().publicBaseUrl || '').trim()) return false
      const fwdHost = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0].trim()
      const fwdProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
      if (!fwdHost || !['http', 'https'].includes(fwdProto)) return false
      const candidate = `${fwdProto}://${fwdHost}`.replace(/\/+$/, '')
      if (candidate === learnedPublic) return true
      learnedPublic = candidate
      if (publicBase()) writeHostFile(true)
      return true
    }
    /** 从请求 Host 头学习真实端口（回环校验也看它）；变了就重写 host.json。
     *  远端直连模式下：① 回环 Host 的端口学习停用（一次经反代的请求会把 host.json 的远端地址冲掉）；
     *  ② 非回环 Host 这里只做解析不做任何写入——X-Forwarded 对外地址学习已搬到
     *     learnForwardedPublic()，且必须等 token 鉴权通过后才允许调用（见 guard）。 */
    function learnHost(req) {
      const raw = String(req?.headers?.host || '')
      // IPv6 字面量 [::1]:端口 或 普通主机:端口；贪婪匹配会把端口吃进主机名，这里显式分分支
      const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/) || raw.match(/^([^:\]]+)(?::(\d+))?$/)
      if (!m) return null
      const host = String(m[1] || '').toLowerCase()
      const port = m[2] || ''
      if (!isLoopbackHost(host)) return { host, port, loopback: false }
      // 远端模式：Host 头端口学习停用（写远端地址时不看本机端口）；同机模式照旧学习漂移
      if (publicBase()) return { host, port, loopback: true }
      if (port && port !== knownPort) { knownPort = port; writeHostFile(true) }
      return { host, port, loopback: true }
    }

    /** 宿主启动时注入真实 Web 端口（host.js 知道服务端口；Host 头学习保留作漂移纠正）。 */
    function setWebPort(port) {
      const n = Number(port)
      if (!Number.isInteger(n) || n <= 0 || n >= 65536) return false
      if (String(n) === knownPort) return true
      knownPort = String(n)
      writeHostFile(true)
      api.log.info(`桌宠：宿主注入 Web 端口 ${knownPort}，host.json 已就绪`)
      return true
    }
    const portReady = () => Boolean(knownPort)

    // ---------- 准入：回环/对外地址 Host → 非 GET 同源 + JSON → 定长令牌比对 ----------
    // 远端直连（2026-11-02）：Host/Origin 的主机名 ∈ {回环, publicBaseUrl 主机名} 即放行（端口段忽略）；
    // x-pet-token 定长比对一字不动——跨机场景它就是唯一防线。
    function deny(res, code, message) {
      api.core.http.send(res, code, { ok: false, message })
      return { ok: false, code, message }
    }
    function guard(req, res, { queryTokenOk = false } = {}) {
      // learnHost 只保留「回环 Host 的端口漂移学习」（同机模式原样工作）；它不再碰对外地址。
      const learned = learnHost(req)
      // Host 闸保持严格：放行集合只来自两处——回环，或显式配置的 publicBaseUrl。
      // 绝不「Host 与请求自报的 X-Forwarded-Host 一致就放行」：X-Forwarded-* 不是浏览器禁设头，
      // 页面 JS 用 fetch 就能伪造，那样 DNS rebinding 场景下一发就绕过 Host 闸。
      if (!learned || !hostAllowed(learned.host)) return deny(res, 403, '只接受本机回环或已配置对外地址（publicBaseUrl）的访问（Host 头不匹配）')
      // 明文 http 的跨机访问默认阻断：令牌与气泡内容在公网明文传输，等于把唯一防线送出去。
      // 【安全审查 P1-2】判定必须看**连接来源**（socket / 可信反代末跳），绝不能看 Host 头——
      // 远端只要发 `Host: 127.0.0.1` 就能把 learned.loopback 骗成 true 从而跳过明文阻断。
      // 回环请求不受影响（同机零退化）；内网自测可用 allowInsecureRemote 显式放行。
      if (!requestIsLocal(req) && publicBaseInsecure() && !insecureRemoteAllowed()) {
        return deny(res, 403, '拒绝明文 http 的跨机访问：请给插件配上 https（反向代理）后再用远端直连；仅内网自测可显式打开 allowInsecureRemote')
      }
      const isGet = (req.method || 'GET').toUpperCase() === 'GET'
      if (!isGet) {
        // 【安全审查 P1-4 / P2】CSRF 双保险：
        // ① Origin 有值就必须是白名单主机（回环 / 已配置对外地址），否则跨站拒绝；
        // ② 强制 application/json——浏览器发 `text/plain` 的「简单请求」不触发预检，
        //    是 CSRF 最常用的手法；要求 JSON 后跨站请求必须过 CORS 预检，直接卡死。
        // 注意：GET 的客户端包下载没有令牌泄露风险（要带 x-pet-token 才能过鉴权），
        //      但它另有一道「只允许 GET + no-store」，见 /client-package 路由。
        const origin = String(req.headers?.origin || '')
        if (origin) {
          try {
            const o = new URL(origin)
            if (!hostAllowed(o.hostname)) return deny(res, 403, '跨站请求被拒绝')
          } catch { return deny(res, 403, '跨站请求被拒绝') }
        }
        const ct = String(req.headers?.['content-type'] || '')
        if (!ct.includes('application/json')) return deny(res, 415, '写操作必须是 application/json')
      }
      const q = api.core.http.query(req)
      const ip = clientIp(req)
      // 先看这个 IP 是否正处于令牌暴力尝试的封禁期（公网部署必需：无限次试令牌的口子不能留）
      const banned = authBanRemaining(ip)
      if (banned > 0) return deny(res, 429, `令牌连续失败次数过多，请 ${Math.ceil(banned / 1000)} 秒后再试`)
      const given = String(req.headers?.['x-pet-token'] || (queryTokenOk ? q.token || '' : '') || '')
      if (!safeEqual(given, token())) {
        recordAuthFail(ip)
        return deny(res, 401, '桌宠令牌无效：先运行一次桌宠客户端（令牌在数据目录 pet/host-token）')
      }
      // 令牌本身对但已过期：提示轮换，不当作普通鉴权失败计数（持有正确令牌的人不是攻击者）
      if (tokenExpired()) return deny(res, 401, '桌宠令牌已过期（tokenTtlDays）：请在面板点「轮换令牌」并重新下载客户端包')
      recordAuthOk(ip)
      // 鉴权已通过才允许「学习并写盘」。顺序不能反：学习会改写 host.json 的 baseUrl，而 hostAllowed()
      // 又读它——一旦挪到 token 校验之前，任何未鉴权的伪造 Host/X-Forwarded 请求都能把 baseUrl 投毒成
      // 攻击者地址，同时借被污染的 publicBase() 绕过 Host 闸，最终把桌宠客户端的 bearer 令牌引到攻击者服务器。
      learnForwardedPublic(req)
      return { ok: true, query: q }
    }

    // ---------- 事件队列（纯内存，重启即丢；bootId 变了客户端要重取水位） ----------
    let seq = 0
    const queue = []
    const bootId = randomBytes(6).toString('hex')
    const presence = new Map() // clientId → lastSeenAt
    const waiters = new Set()  // 长轮询的唤醒函数
    const wakeAll = () => { for (const w of [...waiters]) { waiters.delete(w); try { w() } catch {} } }

    function emit(type, payload = {}) {
      queue.push({ id: ++seq, at: Date.now(), type, ...payload })
      if (queue.length > EVENT_LIMIT) queue.splice(0, queue.length - EVENT_LIMIT)
      wakeAll()
    }

    const prunePresence = (now = Date.now()) => { for (const [k, t] of presence) if (now - t > ONLINE_TTL) presence.delete(k) }
    function online() {
      prunePresence()
      let lastSeenAt = 0
      for (const t of presence.values()) lastSeenAt = Math.max(lastSeenAt, t)
      return { online: lastSeenAt > 0, lastSeenAt, clients: presence.size }
    }

    // ---------- 专注模式（focus.json：读不到 / 坏了一律按关闭，fail-open 但不 crash） ----------
    function focusOn() {
      const f = readJson(focusFile(), null)
      return Boolean(f && typeof f === 'object' && f.enabled === true)
    }
    function setFocus(enabled, source = 'pet') {
      const data = { enabled: enabled === true, updatedAt: new Date().toISOString(), source: String(source || '').slice(0, 24) }
      try { writeJsonAtomic(focusFile(), data) } catch (error) { api.log.warn('写 focus.json 失败：', String(error.message || error)) }
      emit('focus', { enabled: data.enabled })
      return data
    }

    /** 人物大小倍率（0.5~2.0）：读不到 / 坏值一律回落 1（原始大小），别让配置坏了把桌宠缩没。 */
    function petScale() {
      const s = Number(api.settings().petScale)
      return Number.isFinite(s) && s > 0 ? Math.min(2, Math.max(0.5, s)) : 1
    }

    /** 松手后落地开关：读不到一律当开（保持原物理行为），别让配置坏了把抛掷弄丢。 */
    function petReleaseLand() {
      return api.settings().petReleaseLand !== false
    }

    // ---------- 上游 1.0.14 的动画节奏与互动开关（服务端口径） ----------
    /** 动画节奏倍率（0.5~2）：坏值回落 1（正常节奏），客户端把空闲轮播间隔除以它。 */
    function petAnimRate() {
      const v = Number(api.settings().petAnimRate)
      return Number.isFinite(v) && v > 0 ? Math.min(2, Math.max(0.5, v)) : 1
    }
    /** 右键「查看余额」开关：`!== false` 口径 —— 默认开，只有明确写 false 才关（与 petReleaseLand 同口径）。 */
    function petShowBalance() {
      return api.settings().petShowBalance !== false
    }
    /** 点击扑鼠标开关：`=== true` 口径 —— 默认关，明确写 true 才开（高危偏好默认关，与 behaviorCloseWindowEnabled 同口径）。 */
    function petClickChase() {
      return api.settings().petClickChase === true
    }
    /** 晃鼠标勾引追开关：`=== true` 口径，同上。 */
    function petTeaseChase() {
      return api.settings().petTeaseChase === true
    }
    /** 小屋开关：与上游同口径读 config 根上的 petHouseEnabled（`!== false`，缺省开）。
     *  再兜一层 settings（面板表单走 ext.pet 时也能生效）；两边都没写才默认开。 */
    function petHouseEnabled() {
      const c = api.config() || {}
      if (c.petHouseEnabled !== undefined) return c.petHouseEnabled !== false
      return api.settings().petHouseEnabled !== false
    }

    /** 随 DSH 自动启动：读不到当开（默认体验：开 DSH 她就在）。 */
    function petAutoStart() {
      return api.settings().petAutoStart !== false
    }
    /** 读「她想不想开着」。文件不存在 = 还没表态过，按「想」处理（首次装上就该出来）。 */
    function petWanted() {
      const w = readJson(wantedFile(), null)
      if (!w || typeof w !== 'object') return { wanted: true, at: 0, by: 'default' }
      return { wanted: w.wanted !== false, at: Number(w.at) || 0, by: String(w.by || '') }
    }
    /** 记「她想不想开着」。只由面板明确动作调用（启动/停止/托盘退出）。 */
    function setPetWanted(wanted, by) {
      const data = { wanted: wanted === true, at: Date.now(), by: String(by || '').slice(0, 32) }
      try { writeJsonAtomic(wantedFile(), data) } catch (error) { api.log.warn('写 pet-wanted.json 失败：', String(error?.message || error)) }
      return data
    }

    // ---------- pet pack（换形象，仿 dsh-pet 目录约定；运行数据只写数据目录） ----------
    // <dataDir>/packs/<名>-config.json + <名>-animation/*.webm；default 包 = default-animation/。
    // 素材版权注意：dsh-pet 形象「大肥鱼」是 CC BY-NC-SA 4.0。素材不进本仓库（50MB+），
    // 由 ensureDefaultPack() 从素材仓库（petPackUrl，默认 dsh-aurabot-qq-mods）自动下载落位，见下方下载段。
    const packsDir = () => api.dataDir('packs')
    const NAME_RE = /^[\w\u4e00-\u9fa5-]{1,40}$/
    const FILE_RE = /^[\w\u4e00-\u9fa5 .()（）-]{1,80}\.(webm|png|json)$/i
    const animsDirOf = (name) => join(packsDir(), `${name}-animation`)
    const configOfPack = (name) => join(packsDir(), `${name}-config.json`)

    /** 扫描 packs/：返回 [{name, hasConfig, anims:[文件名]}]。坏目录/坏配置只跳过不炸。 */
    function listPacks() {
      const out = []
      let entries = []
      try { mkdirSync(packsDir(), { recursive: true }); entries = readdirSync(packsDir(), { withFileTypes: true }) } catch { return out }
      for (const e of entries) {
        const m = String(e.name || '').match(/^(.+)-animation$/)
        if (!e.isDirectory() || !m || !NAME_RE.test(m[1])) continue
        const name = m[1]
        let anims = []
        try { anims = readdirSync(animsDirOf(name)).filter((f) => FILE_RE.test(f) && /\.webm$/i.test(f)) } catch {}
        out.push({ name, hasConfig: existsSync(configOfPack(name)), anims })
      }
      return out
    }
    /** 把面板设置里的物理项归一化成客户端 physics 段（与 dsh-pet 的 PhysicsParams 同口径）。
     *  面板「物理手感」卡和 /config 下发共用这一份，避免两处口径分叉。
     *
     *  为什么读两套键：上游 1.0.14 另开了 petGravity/petRestitution（与本地 2026-11-05 从 dsh-pet
     *  搬来的 physicsGravity/physicsRestitution 是同一件事）。本模块**只把 physics\* 挂在面板上**
     *  （否则会出现两个「重力」滑条各调一半），但上游面板将来真往 ext.pet 写 petGravity 时也要认。
     *  口径：ext.pet 里明确有 pet\* 就用它，否则用 physics\*（api.settings() 已合过 defaults）。 */
    function physicsFromSettings(s) {
      const numOr = (v, d, lo, hi) => {
        const n = Number(v)
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
      }
      const gravityRaw = s.petGravity !== undefined ? s.petGravity : s.physicsGravity
      const restitutionRaw = s.petRestitution !== undefined ? s.petRestitution : s.physicsRestitution
      return {
        gravity: numOr(gravityRaw, 1400, 100, 6000),
        restitution: numOr(restitutionRaw, 0.78, 0, 1),
        groundFriction: numOr(s.physicsGroundFriction, 2.5, 0, 20),
        ceilingBounce: s.physicsCeilingBounce !== false,
        throwPower: numOr(s.physicsThrowPower, 1, 0.1, 3),
        petCollision: s.physicsPetCollision !== false,
      }
    }
    /** 归一化一个包的配置：动画池（idle/speak/click）+ 权重 + 事件映射 + 物理参数；缺失回落默认。
     *  池里写「动画名」（不带 .webm 扩展名，仿 dsh-pet 约定），只保留目录里真实存在的。 */
    function normalizePackConfig(name, raw, anims) {
      const names = (anims || []).map((f) => String(f).replace(/\.webm$/i, ''))
      const pools = (raw && typeof raw === 'object' && raw.animations && typeof raw.animations === 'object') ? raw.animations : {}
      const poolOf = (k) => (Array.isArray(pools[k]) ? pools[k].filter((n) => names.includes(String(n))) : [])
      const weights = { idle: 60, speak: 25, click: 15, ...((raw && typeof raw.weights === 'object') ? raw.weights : {}) }
      const events = { proactive: 'speak', focus: '', ...((raw && typeof raw.events === 'object') ? raw.events : {}) }
      // 物理：面板设置优先（主人可调），没设过就用素材包里的，再没有就用内置默认。
      // 客户端 main.js 是 { ...DEFAULT_PHYSICS, ...pack.physics }，所以这里发什么它就吃什么。
      const s = api.settings()
      const packPhysics = (raw && typeof raw.physics === 'object') ? raw.physics : {}
      const fromSettings = physicsFromSettings(s)
      // 面板明确设过的键用面板值；没设过的键让素材包的同名项顶上（再没有就沿用内置默认）。
      // 面板键名两套都认：pet* 是上游 1.0.14 的叫法，physics* 是本模块原来的叫法。
      const touchedBy = (k) => {
        const cap = k[0].toUpperCase() + k.slice(1)
        return s[`pet${cap}`] !== undefined || s[`physics${cap}`] !== undefined
      }
      const physics = {}
      for (const k of Object.keys(fromSettings)) {
        physics[k] = (touchedBy(k) || packPhysics[k] === undefined) ? fromSettings[k] : packPhysics[k]
      }
      return {
        name,
        animations: { idle: poolOf('idle'), speak: poolOf('speak'), click: poolOf('click'), turn: poolOf('turn'), drag: poolOf('drag') },
        weights,
        events,
        physics,
        position: petPosition(),
      }
    }

    // ---------- 随机链（2026-11-05，照 dsh-pet 的 rollKind / pickCategoryAction 搬来）----------
    // 背景：原来空闲只有 idle 池的 13 段在轮，包里另外 90 多段（吃/才艺/奇幻/日常）只能右键点播。
    // dsh-pet 的做法是把池子分成「档」按权重掷骰：idle / turn / move / 分类动作，
    // 骰子落在哪档就从哪档抽，所以那 90 多段平时就会自己演。
    // 这里把同一套骰子透传给客户端：客户端只拿「档 → 候选动画 id」的现成表，不再自己解析中文名。
    const ROLL_DEFAULT = { idle: 10, turn: 5, move: 5 }
    /** 动作频率权重的夹取规则（2026-11-05 跟进 dsh-pet 的 shared/weights.ts）。
     *  dsh-pet 的口径：idle / turn / move 三项可编辑，**随机动作是余量**（= 100 − 三项之和），
     *  三项之和不能超过 100，否则随机动作会变负数。这里用同一套算法：
     *    · 取整并夹取：非有限数按下限，绝不产出 NaN / 负数；
     *    · 上限低于下限（手写过大的配置）时夹到下限；
     *    · 单项改动不碰另两项，只夹到「给随机动作留 0」。
     *  为什么宿主侧也要夹：客户端只是消费方，配置写坏时不能让它自己想办法兜底。 */
    const WEIGHTS_TOTAL = 100
    function clampInt(value, min, max) {
      const rounded = Math.round(Number(value))
      if (!Number.isFinite(rounded)) return min
      const upper = Math.max(min, max)
      return Math.min(Math.max(rounded, min), upper)
    }
    /** 随机动作占比：100 − 三项之和，最低 0。 */
    function actionPercent(w) {
      return Math.max(0, WEIGHTS_TOTAL - w.idle - w.turn - w.move)
    }
    /** 面板设置 → 三项权重。负数/留空（−1）= 跟随素材包配置，这样老用户零退化。 */
    function weightsFromSettings(fallback) {
      const s = api.settings()
      const pick = (key, def) => {
        const v = Number(s[key])
        return Number.isFinite(v) && v >= 0 ? v : def
      }
      // 逐项落到合法区间：先各自夹到 [0,100]，再按「另两项之和」夹本项，保证三项合计 ≤ 100
      const idle = clampInt(pick('animWeightIdle', fallback.idle), 0, WEIGHTS_TOTAL)
      const turn = clampInt(pick('animWeightTurn', fallback.turn), 0, WEIGHTS_TOTAL - idle)
      const move = clampInt(pick('animWeightMove', fallback.move), 0, WEIGHTS_TOTAL - idle - turn)
      return { idle, turn, move }
    }
    /** 包配置的 categories 段 → 客户端可用的 [{id, weight, actions:[id]}]。
     *  两条来源都认：① 新写的 animations.categories（dsh-pet 原格式）；
     *  ② 老包的 menu 段（default 包就是这种，10 个分类）——menu 里的顺序就是分类，label 当 id。
     *  一律用 manifest 把中文原名换成素材 id，换不到的丢掉（客户端只认 packAnims 的键）。 */
    function rollTableOf(raw, names, manifest) {
      const man = manifest && typeof manifest === 'object' ? manifest : {}
      /** 原名/id → 素材 id（与 resolveAnimId 同口径，这里只在本函数内用）。 */
      const idOf = (n) => {
        const s = String(n || '').trim()
        if (!s) return ''
        if (names.includes(s)) return s
        if (typeof man[s] === 'string' && names.includes(man[s])) return man[s]
        const lower = s.toLowerCase()
        return names.find((x) => x.toLowerCase() === lower) || ''
      }
      const anims = (raw && typeof raw.animations === 'object' && raw.animations) || {}
      const out = []
      // ① categories：两种写法都认 —— 顶层 raw.categories（Aurabot 包配置的习惯写法）
      //    和 raw.animations.categories（dsh-pet 原格式）。结构都是 { id, weight, noMirror, actions:[原名] }
      const cats = Array.isArray(raw && raw.categories)
        ? raw.categories
        : (Array.isArray(anims.categories) ? anims.categories : [])
      for (const c of cats) {
        const actions = (Array.isArray(c.actions) ? c.actions : []).map(idOf).filter(Boolean)
        if (!actions.length) continue
        const w = Number(c.weight)
        out.push({ id: String(c.id || out.length), weight: Number.isFinite(w) ? Math.max(0, w) : 10, noMirror: c.noMirror === true, actions })
      }
      // ② 老包的 menu 段（没有 categories 时兜底）：每个分类给同等权重的「小动作」档
      if (!out.length && Array.isArray(raw && raw.menu)) {
        // 菜单里的「待机/互动/说话/余额/睡觉」属于其他通道（idle 池、点击、碎碎念、余额、睡觉状态机），
        // 混进随机链会和那些通道抢台，所以只吃「内容向」的几类。
        const SKIP = new Set(['待机', '互动', '说话', '余额', '睡觉', '工作'])
        for (const c of raw.menu) {
          const label = String(c && c.label || '')
          if (!label || SKIP.has(label)) continue
          const actions = (Array.isArray(c.anims) ? c.anims : []).map(idOf).filter(Boolean)
          if (!actions.length) continue
          out.push({ id: label, weight: 10, noMirror: false, actions })
        }
      }
      return out
    }

    /** 桌宠初始位置（从 dsh-pet 的 position 搬来）：客户端按它回到角落 / 贴边距。 */
    function petPosition() {
      const s = api.settings()
      return {
        corner: String(s.petCorner || 'bottom-right'),
        marginX: Math.max(0, Math.min(2000, Number(s.petMarginX) || 0) || 24),
        marginY: Math.max(0, Math.min(2000, Number(s.petMarginY) || 0) || 16),
      }
    }

    // ---------- 多开的「每一只」：名字 / 形象包 / 大小 / 人格 / 说不说话 ----------
    // dsh-pet 的模型是「配置里一个 pets[] 数组，每只带 display / size / whisperPrompt」，
    // 这里照抄那条思路，但存成**独立文件**（extra-pets.json）而不是塞进 settings：
    //   · settings 是面板自动表单的平地，四只 × 五个字段 = 二十栏，表单会长到没法用；
    //   · 人格是多行长文本，塞进 settings 会被面板的「保存设置」整体重写；
    //   · 这个文件只由「面板的自定义卡片」读写，出问题也不影响任何既有设置。
    // 槽位是**按位置**的（0..EXTRA_MAX-1），与客户端的 pet-N 一一对应：
    // 位置即身份，这样「把第二只换成别的形象」不会变成「关掉再开一只，位置全乱」。
    const EXTRA_MAX = 4
    const extraPetsFile = () => api.dataDir('extra-pets.json')
    const EXTRA_SLOT_DEFAULT = { name: '', pack: '', scale: 0, persona: '', whisper: true }
    /** 大小归一化：0 = 跟随主宠物（哨兵值，必须原样保留）；> 0 才夹到 petScale 支持的那一档。
     *  以前无条件夹到 [0.5,2]，会把「跟随」写成 0.5 —— 那三只被缩成一半大，且再也回不到跟随。 */
    function normScale(v) {
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) return 0
      return Math.min(2, Math.max(0.5, n))
    }
    /** 读槽位表：永远返回正好 EXTRA_MAX 条（缺的补默认），坏值逐项降级，绝不抛。 */
    function loadExtraPets() {
      const raw = readJson(extraPetsFile(), null)
      const src = raw && Array.isArray(raw.slots) ? raw.slots : []
      const out = []
      for (let i = 0; i < EXTRA_MAX; i++) {
        const it = (src[i] && typeof src[i] === 'object') ? src[i] : {}
        out.push({
          // slot 显式写出来：面板与客户端都按「位置即身份」办事，靠数组下标很容易在
          // 过滤/排序之后错位；带上它任何一层都能自证是哪一只。
          slot: i,
          name: String(it.name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 20),
          pack: String(it.pack || '').trim().slice(0, 40),
          // 0 = 跟随主宠物的大小。非 0 时才夹到 petScale 支持的那一档
          scale: normScale(it.scale),
          persona: String(it.persona || '').slice(0, 4000),
          whisper: it.whisper !== false,
        })
      }
      // 形象包写了个已经不存在的名字：读的时候就把回落算出来（面板据此显示「跟随主宠物」），
      // 但**不**改写文件 —— 素材包可能只是临时被挪走，别把主人的选择悄悄抹掉。
      const names = new Set(listPacks().map((p) => p.name))
      for (const it of out) if (it.pack && !names.has(it.pack)) it.missing = true
      return out
    }
    function saveExtraPets(slots) {
      const list = (Array.isArray(slots) ? slots : []).slice(0, EXTRA_MAX)
      try { writeJsonAtomic(extraPetsFile(), { version: 1, slots: list }) } catch (e) { api.log.warn(`写 extra-pets.json 失败：${e.message}`) }
      return loadExtraPets()
    }
    /** 主人现在想养几只额外的（0~4）。数值体系按这个数决定要维护哪几份档案。 */
    function extraCountNow() {
      return Math.max(0, Math.min(EXTRA_MAX, Math.round(Number(api.settings().petExtraCount) || 0)))
    }
    /** 改写一个槽位（其余原样保留）：面板每次只改一只，不能把别的三只一起重写掉。 */
    function patchExtraPet(idx, patch) {
      const i = Math.round(Number(idx))
      if (!Number.isFinite(i) || i < 0 || i >= EXTRA_MAX) return { ok: false, message: `槽位只能是 0~${EXTRA_MAX - 1}` }
      const all = loadExtraPets()
      const cur = { ...EXTRA_SLOT_DEFAULT, ...all[i] }
      const next = { ...cur, ...(patch || {}) }
      all[i] = {
        name: String(next.name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 20),
        pack: String(next.pack || '').trim().slice(0, 40),
        // 0 是「跟随主宠物」的哨兵值，必须原样保留：以前这里无条件夹到 [0.5, 2]，
        // 会把「跟随」写成 0.5，那三只就会被缩成一半大。只有 > 0 才夹。
        scale: normScale(next.scale),
        persona: String(next.persona || '').slice(0, 4000),
        whisper: next.whisper !== false,
      }
      const saved = saveExtraPets(all)
      // 形象包/大小是「立刻生效」的（面板点完就该看见她换了），人格只影响下一次开口。
      try { applyExtraPetsToClient() } catch {}
      return { ok: true, slot: saved[i], slots: saved }
    }
    /** 这一只该用哪个形象包：自己指定的（且真实存在）→ 主宠物的。 */
    function extraPackOf(slot) {
      const names = new Set(listPacks().map((p) => p.name))
      if (slot && slot.pack && names.has(slot.pack)) return slot.pack
      return activePack()
    }
    /** 这一只该多大：自己指定了就用它，否则跟随主宠物的 petScale。 */
    function extraScaleOf(slot) {
      const own = Number(slot && slot.scale)
      if (Number.isFinite(own) && own > 0) return Math.min(2, Math.max(0.5, own))
      return petScale()
    }
    /** 这一只显示名叫什么：空 = 用槽位号（面板里显示成「第二只」）。 */
    function extraNameOf(slot, idx) {
      return String((slot && slot.name) || '').trim() || `第 ${Number(idx) + 2} 只`
    }
    /** 把「每只谁用哪个包 / 多大」推给客户端（改完立刻生效，不必重启）。
     *  走 debugIpc 是因为这条链只有客户端能做（窗口在它手里）；失败只记日志，不影响面板保存。 */
    function applyExtraPetsToClient() {
      if (!online().online) return
      const slots = loadExtraPets()
      const payload = slots.map((it, i) => ({
        slot: i,
        name: extraNameOf(it, i),
        pack: extraPackOf(it, i) || '',
        scale: extraScaleOf(it),
      }))
      debugAsk('debugIpc', { act: 'pet-apply-slots', slots: payload }, 8000).catch(() => {})
    }
    /** 客户端上**此刻真的开着**的那几只（面板要显示实际状态，而不只是「存了什么」）。
     *  离线 / 客户端没回话就返回空数组 —— 面板据此显示「桌宠没在线」，不假装知道。 */
    async function liveExtraPets() {
      if (!online().online) return []
      const r = await debugAsk('debugIpc', { act: 'pet-list' }, 8000)
      const out = (r && r.result) || {}
      return Array.isArray(out.list) ? out.list : []
    }

    /** 内置玩法「吃白饭」的动画槽位（2026-11-05 跟进 dsh-pet 新版）。
     *  dsh-pet 的契约（shared/types.ts 的 Animations.baifan + host/config/validate.ts 的 ACTIVITY_SLOTS）：
     *  值是**恰好 5 个**动画名，**按位置**对应五个时机，缺一个就是那个时机没动画可播。
     *      ① 跑向屏幕底部   ② 追饭时的侧身跑   ③ 到位后等开饭   ④ 吃到碗饭   ⑤ 吃饭团
     *  槽位数不对一律视为没配（而不是「有几段凑几段」）—— 按索引取值，短了会取出 undefined，
     *  表现成「点了没反应」，比不配更难解释。
     *  返回 [] = 这个包没有这个玩法；返回 5 个 id = 可以演。 */
    const ACTIVITY_SLOTS = 5
    function baifanSlotsOf(raw, names, manifest) {
      const list = raw && Array.isArray(raw.baifan) ? raw.baifan : null
      if (!list || list.length !== ACTIVITY_SLOTS) return []
      const out = list.map((n) => resolveAnimId(n, names, manifest))
      // 有一段解析不到就当整体不可用：玩法是「五个时机连成一条线」，缺一环整条线就断了
      return out.every(Boolean) ? out : []
    }

    // ---------- 干活状态 / 碎碎念的动画映射（默认按 dsh-pet 的中文命名约定识别，可被包配置覆盖） ----------
    const WORK_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error']
    // default 包（dsh-pet 那 106 段）里的命名就是这套，所以零配置也能直接切对动画
    const WORK_HINTS = {
      thinking: ['工作状态-思考', '深度思考', '思考冒泡'],
      working: ['工作状态-忙碌', '写代码', '轻快记录', '工作状态-原地踱步'],
      result: ['工作状态-清点', '工作状态-忙碌'],
      waiting: ['工作状态-原地踱步', '东张西望', '哈欠'],
      success: ['工作状态-雀跃', '庆祝', '开心跃动', '元气挥手'],
      error: ['工作状态-垂头', '叹气', '冒汗'],
    }
    const WHISPER_HINTS = ['碎碎念']
    /** 把配置里写的「动画原名」或「id」统一解析成素材 id（客户端 packAnims 的键）；解析不到返回 ''。 */
    function resolveAnimId(raw, names, manifest) {
      const s = String(raw || '').trim()
      if (!s) return ''
      if (names.includes(s)) return s
      const man = manifest && typeof manifest === 'object' ? manifest : {}
      if (typeof man[s] === 'string' && names.includes(man[s])) return man[s]
      const lower = s.toLowerCase()
      const hit = names.find((n) => n.toLowerCase() === lower)
      return hit || ''
    }
    /** 解析一个档位槽位：字符串（固定一段）或数组（档内多候选，客户端轮换用）。
     *  照 dsh-pet 的 EventSlot 语义——数组槽位才会轮换，单候选就续播同一段。 */
    function resolveAnimSlot(raw, names, manifest) {
      if (Array.isArray(raw)) {
        const out = raw.map((n) => resolveAnimId(n, names, manifest)).filter(Boolean)
        return out.length ? out : ''
      }
      return resolveAnimId(raw, names, manifest)
    }
    /** 按关键词找第一个命中的素材 id：**先认 manifest 里的中文原名，再认文件名本身**。
     *  （真实 default 包的素材文件名是 anim-001.webm 这类 ASCII 名，「工作状态-思考冒泡」只在
     *   manifest 的原名映射里——只按文件名匹配会全部落空。） */
    function findByName(names, hints, manifest) {
      const man = manifest && typeof manifest === 'object' ? manifest : {}
      const entries = Object.entries(man).filter(([, id]) => typeof id === 'string' && names.includes(id))
      for (const h of hints) {
        const byOrig = entries.find(([orig]) => orig.includes(h))
        if (byOrig) return byOrig[1]
      }
      for (const h of hints) {
        const byId = names.find((n) => n.includes(h))
        if (byId) return byId
      }
      return ''
    }
    /** 包视图附带的「状态 → 动画」映射与碎碎念动画池；缺素材就是空串/空数组（客户端回落 speak/idle）。 */
    function animMapOf(view, raw, names, manifest) {
      const ev = (raw && typeof raw.events === 'object' && raw.events) || {}
      const custom = (ev.workStatus && typeof ev.workStatus === 'object') ? ev.workStatus : {}
      const workStatus = {}
      for (const st of WORK_STATES) {
        // 槽位支持数组（档内多候选轮换）：先按配置解析，再按关键词兜底找一段
        const slot = resolveAnimSlot(custom[st], names, manifest)
        if (Array.isArray(slot) && slot.length) workStatus[st] = slot
        else workStatus[st] = (typeof slot === 'string' && slot) || findByName(names, WORK_HINTS[st] || [], manifest)
      }
      const customWhisper = Array.isArray(ev.whisper) ? ev.whisper : []
      const whisper = customWhisper.map((n) => resolveAnimId(n, names, manifest)).filter(Boolean)
      const man = manifest && typeof manifest === 'object' ? manifest : {}
      const fallback = Object.entries(man)
        .filter(([orig, id]) => typeof id === 'string' && names.includes(id) && WHISPER_HINTS.some((h) => orig.includes(h)))
        .map(([, id]) => id)
      view.workStatus = workStatus
      view.whisperAnims = whisper.length ? whisper : fallback
      return view
    }

    /** 当前生效的包：settings.pack 优先，其次 default，其次第一个扫到的，再没有就是 null（客户端回静态形象）。 */
    function activePack() {
      const s = api.settings()
      const packs = listPacks()
      const hit = packs.find((p) => p.name === s.pack)
      if (hit) return hit.name
      if (packs.some((p) => p.name === 'default')) return 'default'
      return packs[0]?.name || null
    }
    /** 给客户端的包视图（/config 的 pack 字段）：null = 没有任何素材，走静态形象。
     *  传 name 时产出**指定包**的视图：多开时每只桌宠可以各自绑一个形象包（dsh-pet 的 pets[].assetRoot 同义）。 */
    function packView(onlyName) {
      const name = onlyName ? (listPacks().some((p) => p.name === onlyName) ? onlyName : null) : activePack()
      if (!name) return null
      const pack = listPacks().find((p) => p.name === name)
      const raw = pack?.hasConfig ? readJson(configOfPack(name), null) : null
      const view = normalizePackConfig(name, raw, pack.anims)
      // 动画原名映射（<packs>/<名>-manifest.json：原名 → 池内 id），客户端菜单显示中文名用；缺文件就没有 labels 字段
      const manifest = readJson(join(packsDir(), `${name}-manifest.json`), null)
      if (manifest && typeof manifest === 'object') {
        const labels = {}
        for (const [orig, id] of Object.entries(manifest)) if (typeof id === 'string' && id) labels[id] = orig
        view.labels = labels
      }
      animMapOf(view, raw, (pack.anims || []).map((f) => String(f).replace(/\.webm$/i, '')), manifest)
      // 随机链骰子（2026-11-05）：档位权重 + 每档的候选动画 id。客户端拿现成表直接抽，不再解析中文名。
      // 权重三层（后写的覆盖前面的）：
      //   ① ROLL_DEFAULT 内置默认（10/5/5）—— 连包配置都没写时的兜底
      //   ② 包配置 animationWeights —— 素材包作者给这只宠定的频率
      //   ③ 面板三项（animWeightIdle/Turn/Move，留 −1 表示不干预）—— 主人最后说了算
      // 三层之后统一走 weightsFromSettings 的夹取：三项合计 ≤ 100，随机动作吃余量。
      const packWeights = { ...ROLL_DEFAULT, ...((raw && typeof raw.animationWeights === 'object' && raw.animationWeights) || {}) }
      const packNames = (pack.anims || []).map((f) => String(f).replace(/\.webm$/i, ''))
      view.roll = {
        weights: weightsFromSettings(packWeights),
        categories: rollTableOf(raw, packNames, manifest),
      }
      // 内置玩法「吃白饭」（2026-11-05 跟进 dsh-pet 新版）：只在包配置里配齐 5 个槽位时才下发，
      // 客户端据此决定右键菜单里出不出现「吃白饭」这一项（没有素材就不给入口，点了没反应最糟）。
      // 槽位是**素材 id**（已按 manifest 解析过），不是中文原名——客户端 packAnims 的键就是 id。
      view.baifan = baifanSlotsOf(raw, packNames, manifest)
      // 玩法的三张图（空碗 / 满碗 / 饭团）：只给文件名，地址由客户端按 /pic/baifan/<名字>.png 拼
      // （和梗图同一套拼法，见 main.js 的 memeUrlMap）。
      if (view.baifan.length) view.baifanPics = ['bowl-empty', 'bowl-full', 'rice-ball']
      // 梗图清单（从 dsh-pet 搬来）：客户端要的是「名字 → 带 token 的地址」，和 anims 同一套拼法。
      // 只给名字和描述，图本身走 /pic/memes/<名字>.png。
      view.memes = memeCatalog(name)
      // 宠物数值：客户端要靠这几个开关决定「右键菜单出不出喂食」「悬停弹不弹状态卡」。
      // 数值本身每小时都在变，不进包视图（每次现查 /life，缓存反而会显示旧数字）。
      try {
        const lifeSt = loadLife('main')
        view.life = { ...lifeSettings(), satiety: Math.round(lifeSt.satiety), foods: Life.snapshot(lifeSt).foods }
      } catch { view.life = { ...lifeSettings(), satiety: 0, foods: [] } }
      // 点击音效（从 dsh-pet 搬来）：app/sound/click-duck.wav 在就下发文件名，客户端据此拼地址
      try {
        if (api.settings().clickSound !== false) {
          const snd = api.dataDir('app', 'sound', 'click-duck.wav')
          if (existsSync(snd)) view.clickSound = 'click-duck.wav'
        }
      } catch {}
      // 自定义字体（从 dsh-pet 搬来）：app/fonts 下第一个 ttf/otf
      try {
        if (api.settings().customFont !== false) {
          const fonts = readdirSync(api.dataDir('app', 'fonts')).filter((n) => /\.(ttf|otf|woff2?)$/i.test(n))
          if (fonts.length) view.font = fonts[0]
        }
      } catch {}
      // 字体种类 / 字号（dsh-pet 的 FONT_PRESETS）：客户端据此拼 CSS
      view.fontStyle = {
        family: String(api.settings().fontFamily || 'candy'),
        size: Math.max(4, Math.min(200, Number(api.settings().fontSize) || 21)),
        followPet: api.settings().fontFollowPet !== false,
      }
      // 出生点在上沿（左上/右上）：客户端要把气泡翻到人物下方往下长，否则气泡顶出屏幕
      view.atTop = String(petPosition().corner || '').startsWith('top')
      return view
    }

    /**
     * 梗图素材目录：数据目录 app/memes 下的 png。
     * 名字 = 文件名去扩展名（与 dsh-pet 的 memes 配置键一致），描述存在 app/memes/descriptions.json，
     * 没有描述文件时用名字本身当描述（名字就是梗，模型基本猜得出来）。
     */
    function memeCatalog() {
      try {
        const dir = api.dataDir('app', 'memes')
        const files = readdirSync(dir).filter((n) => /\.png$/i.test(n) && !n.startsWith('.'))
        let desc = {}
        try { desc = JSON.parse(readFileSync(join(dir, 'descriptions.json'), 'utf8')) || {} } catch {}
        return files.map((n) => {
          const name = n.replace(/\.png$/i, '')
          return { name, desc: String(desc[name] || name) }
        })
      } catch {
        return []
      }
    }

    // ---------- 动作点播回执（P2：客户端播完 /playback 上报，留最近 50 条） ----------
    const playbacks = []
    function recordPlayback(entry) {
      playbacks.push({ ...entry, at: Date.now() })
      if (playbacks.length > 50) playbacks.splice(0, playbacks.length - 50)
    }

    // ---------- 心情 → 表情枚举（客户端按枚举切姿态） ----------
    const moodOf = (v) => (v >= 85 ? 'very-happy' : v >= 70 ? 'happy' : v >= 50 ? 'neutral' : v >= 35 ? 'low' : 'sad')
    function moodNow() {
      try {
        const m = api.use('mood')
        const v = typeof m?.current === 'function' ? Number(m.current()) : NaN
        return Number.isFinite(v) ? moodOf(v) : 'neutral'
      } catch { return 'neutral' }
    }
    /** 心情数值（0~100）；拿不到返回 null —— 高危动作的心情闸拿不到值时按「不满足」处理。 */
    function moodValue() {
      try {
        const m = api.use('mood')
        const v = typeof m?.current === 'function' ? Number(m.current()) : NaN
        return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null
      } catch { return null }
    }

    // ================= 宠物数值体系（饱腹 / 精力 / 亲密度） =================
    // 学的是 Astra Pet 的 design/pet-life/02：**陪伴，不制造焦虑**。
    //   · 数值只影响表现（做动作、冒小气泡、写进她的人格情境），不生病、不死亡、不离家出走。
    //   · 亲密度等级只涨不掉。
    //   · 饿了困了只做动作 + 冒小气泡，绝不弹系统通知、不朗读。
    //   · 关程序按真实时间补算，但有下限（见 life.mjs 的 catchUp）。
    // 规则本体全在 life.mjs（纯函数，117 项单测在 .tmp/life-sayq-test.cjs）；这里只做「读盘 / 存盘 / 定时 / 发事件」。
    //
    // 心情**不在这里**：Aurabot 的 mood 模块已经有 0~100 的心情和 nudge()，
    // 这里只把「心情基线建议」喂过去，绝不另存第二份（不然两边的数字会互相打架）。
    const lifeFile = (petId = 'main') => api.dataDir(petId === 'main' ? 'life.json' : `life-${String(petId).replace(/[^\w-]/g, '')}.json`)
    const lifeRuntime = new Map() // petId → { state, loadedAt }
    function loadLife(petId = 'main') {
      const hit = lifeRuntime.get(petId)
      if (hit) return hit.state
      const raw = readJson(lifeFile(petId), null)
      const st = Life.normalizeState(raw, Date.now())
      // 启动补算：关程序这段时间按真实时间衰减（带下限），跨天了顺便把每日经验清掉
      const c = Life.catchUp(st, { now: Date.now(), onComputer: idleIsUserActive() })
      lifeRuntime.set(petId, { state: c.state, loadedAt: Date.now() })
      if (c.longAway && raw) api.log.info(`她发现你好久没来（${c.days} 天）`)
      return c.state
    }
    function saveLife(petId = 'main', state = null) {
      const st = state || lifeRuntime.get(petId)?.state
      if (!st) return
      try { writeJsonAtomic(lifeFile(petId), st) } catch (e) { api.log.warn(`宠物数值写盘失败：${e.message}`) }
    }
    function setLife(petId, state) {
      lifeRuntime.set(petId, { state, loadedAt: Date.now() })
      saveLife(petId, state)
      return state
    }
    /** 数值变化速度（慢 0.5 / 标准 1 / 快 2）；坏值按标准。 */
    function lifeSpeed() {
      const v = String(api.settings().petLifeSpeed || 'normal')
      return v === 'slow' ? 0.5 : v === 'fast' ? 2 : 1
    }
    function lifeSettings() {
      const s = api.settings()
      const hint = String(s.petLifeHint || 'bubble')
      return {
        enabled: s.petLifeEnabled !== false,
        speed: lifeSpeed(),
        hint: hint === 'status' || hint === 'off' ? hint : 'bubble',
        feed: s.petFeedEnabled !== false,
        statusCard: s.petStatusCard !== false,
      }
    }
    /** 用户是不是在电脑前（决定「冷落」算不算）。平台拿不到空闲时间时按「在」处理是错的，
     *  宁可按「不在」——不然用户关掉显示器一晚上，第二天她心情就掉到谷底了。 */
    function idleIsUserActive() {
      try {
        const v = api.idleSeconds?.()
        if (Number.isFinite(Number(v))) return Number(v) < 5 * 60
      } catch {}
      return false
    }
    /** 数值 → 心情模块（只推基线，不覆盖用户/聊天给的即时心情）。
     *  做法：基线比当前低就往下 nudge，高就往上 nudge，单次最多 ±3 —— 慢慢走，不跳变。 */
    function pushMoodBaseline(st) {
      try {
        const m = api.use('mood')
        if (!m || typeof m.nudge !== 'function') return
        const now = typeof m.current === 'function' ? Number(m.current()) : NaN
        if (!Number.isFinite(now)) return
        const want = 50 + Life.moodBaseline(st, Date.now(), { onComputer: idleIsUserActive() })
        const delta = Math.max(-3, Math.min(3, Math.round((want - now) / 3)))
        if (delta) m.nudge(delta, '宠物数值')
      } catch {}
    }

    /** 定时前进（每 5 分钟一次；倍速在分钟数上乘）。 */
    function lifeTick({ minutes = 5, now = Date.now() } = {}) {
      const cfg = lifeSettings()
      if (!cfg.enabled) return { ok: false, reason: 'disabled' }
      for (const petId of ['main', ...Array.from({ length: extraCountNow() }, (_, i) => `pet-${i + 1}`)]) {
        const before = loadLife(petId)
        const r = Life.advance(before, minutes * cfg.speed, { now, awake: !inQuietHours(), onComputer: idleIsUserActive() })
        const after = setLife(petId, r.state)
        if (petId === 'main') pushMoodBaseline(after)
        for (const c of r.crossings) fireLifeEvent(c, petId)
      }
      return { ok: true }
    }

    /** 一条阈值事件 → 做动作 / 冒气泡（口径见 design/pet-life/02 §3.3：只做动作和冒小气泡）。 */
    function fireLifeEvent(c, petId = 'main') {
      const cfg = lifeSettings()
      const main = petId === 'main'
      const name = String(c?.event || '')
      if (!name) return
      // 事件本身永远发出去（面板/别的模块可以订），但**冒气泡**受 hint 开关约束
      try { emit('life', { event: name, petId, data: c.data || {}, at: Date.now() }) } catch {}
      if (cfg.hint !== 'bubble') return
      const sat = Number(c.data?.satiety)
      const ene = Number(c.data?.energy)
      const pick = (a) => a[Math.floor(Math.random() * a.length)]
      const line =
        name === 'needs.hungry' ? pick(['有点饿了…', '肚子咕咕叫了', '想吃点东西～'])
          : name === 'needs.starving' ? pick(['好饿好饿…', '能给我点吃的吗'])
            : name === 'needs.fed' ? pick(['吃饱啦～', '谢谢主人！'])
              : name === 'needs.sleepy' ? pick(['好困…', '哈——欠'])
                : name === 'needs.rested' ? pick(['睡饱啦！', '精神回来了'])
                  : name === 'bond.levelUp' ? `亲密度到 ${c.data?.name || ''} 啦～`
                    : ''
      if (!line) return
      // 饿困是低优先级：走说话让路，忙的时候攒着，绝不打断（也不朗读——这里不给 audio）
      saySoon({ text: line, purpose: name.startsWith('bond') ? 'life' : 'needs', priority: PRIORITY.low, slot: main ? null : Number(String(petId).replace('pet-', '')) - 1, anim: pickWhisperAnim() })
    }

    // ---------- 说话让路（学 Astra Pet 0.2.3 的「宠物说话会让路」）----------
    // 为什么要有这一层：碎碎念 / 行为 / 待办 / 数值各自决定「说什么」，但**什么时候说**必须统一。
    // 不然她会在你正打字的时候插一句，或者两条气泡互相盖掉（看起来像闪烁）。
    // 逻辑本体在 sayq.mjs（纯函数）；这里只喂它「现在忙不忙」。
    const sayQueue = createSayQueue({ maxHold: 12, ttlMs: 10 * MIN_MS, remindTtlMs: 60 * MIN_MS })
    let lastChatAt = 0 // 最近一次跟她对话（发或收）；90 秒内不主动打扰
    let bubbleUntil = 0 // 当前气泡什么时候收起（dispatch 每说一句都更新）
    /** 现在要不要让路？返回 null = 能说。 */
    function sayBlockedNow(now = Date.now()) {
      return sayQueue.blockedBy({
        now,
        busy: whisperBusy || chatBusy,
        focus: focusOn(),
        quiet: inQuietHours(),
        lastChatAt,
        bubbleUntil,
      })
    }
    /**
     * 想说话的统一入口。能说就发，不能说就攒着（按优先级）。
     * @param {object} o  text / purpose / priority / slot / anim / tag
     * @returns {Promise<{ok:boolean,speak?:boolean,held?:boolean,reason?:string}>}
     */
    async function saySoon({ text, purpose = '', priority = PRIORITY.low, slot = null, anim = '', tag = '' } = {}) {
      const t = String(text || '').trim()
      if (!t) return { ok: false, speak: false, reason: 'empty' }
      const now = Date.now()
      const want = sayQueue.want({ text: t, purpose, priority, slot, anim, tag }, { now, ...sayContext(now) })
      if (!want.speak) return { ok: true, speak: false, held: true, reason: want.reason }
      return flushOne(want.item)
    }
    /** 喂给 sayQueue 的那一份「现在什么情况」。 */
    function sayContext(now = Date.now()) {
      return {
        now,
        busy: whisperBusy || chatBusy,
        chatOpen: chatWinAliveSafe(),
        lastChatAt,
        bubbleUntil,
        quiet: inQuietHours(),
        focus: focusOn(),
      }
    }
    function chatWinAliveSafe() { try { return typeof chatWinAlive === 'function' ? Boolean(chatWinAlive()) : false } catch { return false } }
    /** 真的把一条发出去。 */
    async function flushOne(item) {
      const r = await dispatch({
        text: item.text, modality: 'text', purpose: item.purpose || 'say',
        via: 'pet', anim: item.anim || '', noFallback: true,
        slot: item.slot === null || item.slot === undefined ? null : item.slot,
      })
      if (r && r.ok) {
        bubbleUntil = Date.now() + Math.min(30, Math.max(6.5, 4.5 + item.text.length * 0.11)) * 1000
        if (item.purpose === 'chat') lastChatAt = Date.now()
      }
      return { ok: Boolean(r && r.ok), speak: true, reason: r && r.reason }
    }
    /** 攒着的那几句：等气泡空出来、也不忙了，一句一句补上（这是「说话让路」最值钱的一半）。 */
    async function sayQueueTick({ now = Date.now() } = {}) {
      if (sayQueue.pending(now) === 0) return { ok: true, said: 0 }
      if (sayBlockedNow(now)) return { ok: true, said: 0, reason: sayBlockedNow(now) }
      const item = sayQueue.next(sayContext(now))
      if (!item) return { ok: true, said: 0 }
      await flushOne(item)
      return { ok: true, said: 1, text: item.text }
    }

    // ---------- 喂食 / 互动（右键菜单 + 状态卡 + 客户端上报都走这里）----------
    function lifeInteract(kind, { petId = 'main', now = Date.now() } = {}) {
      const cfg = lifeSettings()
      if (!cfg.enabled) return { ok: false, reason: 'disabled' }
      const before = loadLife(petId)
      const r = Life.interact(before, kind, { now, onComputer: idleIsUserActive() })
      if (r.ignored) return { ok: false, reason: 'unknown-interaction' }
      const after = setLife(petId, r.state)
      if (petId === 'main') pushMoodBaseline(after)
      for (const c of r.crossings) fireLifeEvent(c, petId)
      return { ok: true, xp: r.xp, snapshot: Life.snapshot(after, { now }) }
    }
    function lifeFeed(foodId, { petId = 'main', now = Date.now() } = {}) {
      const cfg = lifeSettings()
      if (!cfg.enabled) return { ok: false, reason: 'disabled' }
      if (!cfg.feed) return { ok: false, reason: 'feed-off' }
      const before = loadLife(petId)
      const r = Life.feed(before, foodId, { now, onComputer: idleIsUserActive() })
      if (!r.ok) {
        // 说清楚为什么喂不了（「点了没反应」是最差的体验）
        const why = r.reason === 'full' ? '吃不下啦～肚子已经圆滚滚的'
          : r.reason === 'cooldown' ? `还没饿呢，再等 ${Math.max(1, Math.ceil((r.waitMs || 0) / 60000))} 分钟`
            : r.reason === 'no-snack' ? '这个零食还没攒到，你先专心干会儿活嘛'
              : r.reason === 'unknown-food' ? '这个我不认识' : ''
        if (why) saySoon({ text: why, purpose: 'feed', priority: PRIORITY.high, petId })
        return { ok: false, reason: r.reason, waitMs: r.waitMs || 0 }
      }
      const after = setLife(petId, r.state)
      pushMoodBaseline(after)
      for (const c of r.crossings) fireLifeEvent(c, petId)
      // 吃的台词按食物 / 心情给一句（不说「你喂了饭团」这种机器话）
      const f = r.food
      const liked = f.snack
      const say = liked
        ? `${f.icon}${f.name}！最喜欢了～`
        : `谢谢主人，${f.name}真好吃`
      saySoon({ text: say, purpose: 'feed', priority: PRIORITY.high, anim: 'eat' })
      return { ok: true, food: f.id, snapshot: Life.snapshot(after, { now }) }
    }
    /** 专注完成一轮：攒一份零食（走待办/番茄钟那条线，最多 10 份）。 */
    function lifeRewardSnack({ now = Date.now() } = {}) {
      const cfg = lifeSettings()
      if (!cfg.enabled || !cfg.feed) return { ok: false, reason: 'off' }
      const r = Life.rewardSnack(loadLife('main'), { now })
      if (!r.ok) return r
      setLife('main', r.state)
      try { emit('life', { event: 'life.snack', petId: 'main', data: { food: r.food.id, name: r.food.name }, at: now }) } catch {}
      return { ok: true, food: r.food.id, name: r.food.name, icon: r.food.icon }
    }
    function lifeSnapshot(petId = 'main', { now = Date.now() } = {}) {
      const cfg = lifeSettings()
      const snap = Life.snapshot(loadLife(petId), { now })
      return { ...snap, enabled: cfg.enabled, hint: cfg.hint, feedEnabled: cfg.feed, statusCard: cfg.statusCard, speed: api.settings().petLifeSpeed || 'normal' }
    }
    /** 写进她人格情境层的那段（对话框 / 碎碎念的内容都用得上）。 */
    function lifeContextLine() {
      if (!lifeSettings().enabled) return ''
      try { return Life.contextLine(loadLife('main'), { now: Date.now() }) } catch { return '' }
    }

    // ---------- TTS 转存（voice.speak 产物 24h 清理，推给桌宠前先拷进 pet 数据目录） ----------
    const audioRoutes = new Set()
    function pruneVoiceDir() {
      try {
        for (const n of readdirSync(voiceDir())) {
          const p = join(voiceDir(), n)
          if (Date.now() - statSync(p).mtimeMs > 86400_000) { try { unlinkSync(p) } catch {} ; audioRoutes.delete(n) }
        }
      } catch {}
    }
    function registerAudioRoute(key, file) {
      const path = `/audio/${key}`
      if (audioRoutes.has(path)) return
      audioRoutes.add(path)
      api.route(path, async (req, res) => {
        if (!guard(req, res, { queryTokenOk: true }).ok) return
        let buf = null
        try { buf = readFileSync(file) } catch {}
        if (!buf) return api.core.http.send(res, 404, { ok: false, message: '音频不存在或已过期' })
        try {
          res.statusCode = 200
          res.setHeader?.('content-type', 'audio/wav')
          res.setHeader?.('cache-control', 'private, max-age=86400') // 带 token 的 URL 不能进共享缓存
          res.setHeader?.('content-length', String(buf.length))
          res.end?.(buf)
        } catch {}
      })
    }
    /** 把一个音频文件转存进 pet 数据目录（内容寻址），返回 {key,url,durationMs}；失败返回 null。 */
    function storeVoice(file) {
      try {
        if (!file || !existsSync(file)) return null
        const buf = readFileSync(file)
        const key = `${createHash('sha1').update(buf).digest('hex')}.wav`
        mkdirSync(voiceDir(), { recursive: true })
        const dest = join(voiceDir(), key)
        if (!existsSync(dest)) writeFileSync(dest, buf)
        pruneVoiceDir()
        registerAudioRoute(key, dest)
        return { key: key.replace(/\.wav$/, ''), url: `/aurabot/api/audio/${key}?token=${token()}`, durationMs: Math.max(1200, Math.round(buf.length / 32)) }
      } catch (error) {
        api.log.warn('转存桌宠语音失败：', String(error?.message || error))
        return null
      }
    }

    // ---------- 气泡投递（载体互斥 + 回落；永不双发） ----------
    const delivered = [] // 最近推过的气泡（/history 用）
    const ownerChatId = () => `private:${api.config().ownerQQ}`

    async function speakFor(text) {
      try {
        const voice = api.has('voice') ? api.use('voice') : null
        if (!voice || typeof voice.speak !== 'function') return { ok: false, error: 'voice 模块没在跑' }
        const { file } = await voice.speak(text)
        const audio = storeVoice(file)
        return audio ? { ok: true, audio } : { ok: false, error: '语音转存失败' }
      } catch (error) {
        return { ok: false, error: String(error?.message || error).slice(0, 120) }
      }
    }

    /**
     * 主动发言的唯一入口（purpose/speakup 调这个，别自己两边发）。
     * @param {object} o
     * @param {string} o.anim   可选：指定点播的动作名（P2），事件会带 anim + playbackId 回执号
     * @param {boolean} o.noFallback  桌面独占内容（碎碎念）用：桌宠离线时宁可不发，也绝不回落 QQ
     * @param {number} o.slot  多开时投给「第几只」：null/undefined = 主宠物；0..3 = 额外那只的槽位。
     *                         事件里带 petId（'main' / 'pet-<slot+1>'），客户端据此只让那一只冒气泡。
     *                         落了 slot 的气泡**永远**不回落 QQ（额外那几只只存在于桌面，离线就是不说）。
     * @returns {Promise<{ok:boolean, via?:'pet'|'qq', reason?:string, fallback?:boolean, message?:object}>}
     */
    // emotionProfile（上游 1.0.11 情绪画像 {valence -1~1, arousal 0~1}）：目的引擎/调用方随消息带来，
    // 只做钳制透传；客户端用它给气泡上「辉光」（冷暖色随 valence、强弱随 arousal）。
    const sanitizeProfile = (p) => {
      const v = Number(p?.valence)
      const a = Number(p?.arousal)
      if (!Number.isFinite(v) && !Number.isFinite(a)) return null
      return {
        valence: Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0,
        arousal: Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 0.4,
      }
    }
    async function dispatch({ text, modality = '', purpose = '', force = false, anim = '', via = '', noFallback = false, slot = null, emotion = '', emotionProfile = null } = {}) {
      const t = String(text || '').trim()
      if (!t) return { ok: false, reason: 'empty' }
      const s = api.settings()
      const isExtra = slot !== null && slot !== undefined
      if (via !== 'pet' && !isExtra && s.carrier !== 'pet') return { ok: false, via: 'qq', reason: 'carrier-qq' } // 载体是 QQ：交给 purpose 自己走 QQ，桌宠不碰（via=pet 是桌宠自身入口，可越过载体设置）
      if (!force && focusOn()) return { ok: false, reason: 'focus' } // 专注模式：不发也不回落
      const on = online()
      if (on.online) {
        // 语音开关（从 dsh-pet 搬来）：总开关 + 按 purpose 分三个细分。
        // 以前只有 modality 一个维度，没法「气泡照出、只有碎碎念不出声」。
        // 额外那几只**一律纯文字**：四只会同时开口，两段 TTS 撞在一起谁也听不清，
        // 而且每句都要过一遍 TTS 是实打实的成本。主宠物那条链的语音逻辑一个字节没动。
        const voiceOn = !isExtra && s.voiceEnabled === true
        const byPurpose = purpose === 'whisper' ? s.voiceWhisperEnabled === true
          : purpose === 'todo' ? s.voiceTodoEnabled === true
            : purpose === 'chat' ? s.voiceChatEnabled === true
              : false
        const wantVoice = voiceOn && byPurpose
        const mode = (wantVoice || modality === 'voice' || (!modality && s.modality === 'voice' && !purpose)) && !isExtra ? 'voice' : 'text'
        let audio = null
        let voiceError = ''
        if (mode === 'voice') {
          const v = await speakFor(t)
          if (v.ok) audio = v.audio
          else voiceError = v.error // TTS 失败：降级纯文字气泡
        }
        const animName = String(anim || '').slice(0, 40)
        const playbackId = animName ? randomBytes(4).toString('hex') : '' // 点播动画带回执号，客户端播完 POST /playback
        const message = {
          type: 'proactive',
          text: t.slice(0, 600),
          modality: mode,
          audio,
          voiceVolume: Math.max(0, Math.min(1, Number(s.voiceVolume ?? 1))),
          voiceError: audio ? '' : voiceError,
          mood: moodNow(),
          // 上游 1.0.11：情绪画像随气泡透传（客户端据此上辉光；老调用方不传时两者都是空值，零改动）
          emotion: String(emotion || '').slice(0, 20),
          emotionProfile: sanitizeProfile(emotionProfile),
          purpose: String(purpose || '').slice(0, 40),
          messageId: randomBytes(6).toString('hex'),
        }
        // 投递目标：不写 petId 的时候客户端按主宠物处理（老客户端的兼容路径就是这个默认值）
        if (isExtra) {
          const i = Math.max(0, Math.min(EXTRA_MAX - 1, Math.round(Number(slot))))
          message.petId = `pet-${i + 1}`
          message.slot = i
        }
        if (animName) { message.anim = animName; message.playbackId = playbackId } // P2：可选动画点播字段
        emit('proactive', message)
        delivered.push({ ...message, at: Date.now() })
        // 说话让路：记下「这只的气泡要挂到什么时候」，攒着的话等它收起来再补。
        // 只记主宠物 —— 额外那几只有自己的气泡线，它们的让位判据是 lastOtherBubbleAt(petId)。
        if (!isExtra) bubbleUntil = Date.now() + Math.min(30, Math.max(6.5, 4.5 + t.length * 0.11)) * 1000
        if (delivered.length > 100) delivered.splice(0, delivered.length - 100)
        api.log.info(`桌宠气泡（${mode}${audio ? '+语音' : ''}${animName ? '+' + animName : ''}${isExtra ? '@' + message.petId : ''}）：${t.slice(0, 40)}`)
        return { ok: true, via: 'pet', message }
      }
      // 额外那几只没有 QQ 这回事：它们只活在桌面上，桌宠没起来就是「这会儿不说」
      if (isExtra) return { ok: false, reason: 'pet-offline' }
      if (!noFallback && s.petFallbackToQQ !== false) {
        try {
          await api.sendText(ownerChatId(), t)
          api.log.info(`桌宠离线，主动发言回落 QQ：${t.slice(0, 40)}`)
          return { ok: true, via: 'qq', fallback: true }
        } catch (error) {
          return { ok: false, reason: 'fallback-failed', error: String(error?.message || error).slice(0, 120) }
        }
      }
      return { ok: false, reason: 'pet-offline' }
    }

    // ---------- 长轮询 /events ----------
    async function pollEvents(req, res) {
      const g = guard(req, res)
      if (!g.ok) return
      learnHost(req)
      const q = g.query
      const client = String(q.client || '').slice(0, 40) || 'anon'
      presence.set(client, Date.now())
      let since = q.since === undefined || q.since === '' ? null : Number(q.since)
      if (since !== null && !Number.isFinite(since)) since = null
      let wait = Number(q.wait)
      if (!Number.isFinite(wait) || wait < 0) wait = 0
      wait = Math.min(WAIT_CAP, wait)
      const deadline = Date.now() + wait
      for (;;) {
        prunePresence()
        presence.set(client, Date.now()) // 等待期间也算心跳
        if (since === null || since > seq) {
          // 新客户端 / 插件重启过的旧游标：只对齐水位，不重放旧气泡
          api.core.http.send(res, 200, { ok: true, bootId, cursor: seq, events: [], online: online(), serverTime: Date.now() })
          return
        }
        const events = queue.filter((e) => e.id > since)
        if (events.length || Date.now() >= deadline) {
          api.core.http.send(res, 200, { ok: true, bootId, cursor: seq, events, focus: focusOn(), serverTime: Date.now() })
          return
        }
        await new Promise((resolve) => {
          const timer = setTimeout(done, Math.max(50, Math.min(1000, deadline - Date.now())))
          const wake = () => { clearTimeout(timer); done() }
          function done() { waiters.delete(wake); resolve() }
          waiters.add(wake)
        })
      }
    }

    // ---------- 客户端生成物完整性（治「旧壳」）----------
    // 事故背景：app/ 里只剩旧 main.js、缺 behavior.js 时，客户端 require 失败**只打日志**，
    // 表现是「行为层整体不生效」而面板一切正常，极难发现。这里拿「模板签名」和「生成时记下的签名」
    // 对账：缺文件 / 内容不符 / 模板比生成物新，一律在 status 里明说，面板据此提示重新生成。
    // 只读对账，绝不自动覆盖用户手改过的 app/（生成走 installClient，由面板按钮触发）。
    const CLIENT_FILES = ['main.js', 'preload.js', 'index.html', 'physics.js', 'packmeta.js', 'behavior.js', 'baifan.js', 'chat.html', 'todo.html', 'multi.js', 'house.html', 'house.js']
    const CLIENT_OPTIONAL = ['README.md'] // 只复制不校验：文档缺失不影响运行
    const CLIENT_STAMP = 'client-stamp.json' // 生成时写进 app/ 的签名凭据
    const fileHash = (p) => {
      try { return createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12) } catch { return '' }
    }
    const hashCache = new Map() // 绝对路径 → { key, hash }：status 会每 8 秒被面板拉一次，别重复读盘
    const fileHashCached = (p) => {
      try {
        const st = statSync(p)
        const key = `${st.size}:${Math.round(st.mtimeMs)}`
        const old = hashCache.get(p)
        if (old && old.key === key) return old.hash
        const hash = fileHash(p)
        hashCache.set(p, { key, hash })
        return hash
      } catch { return '' }
    }
    let tplCache = { key: '', sig: '', files: [] }
    /** 模板签名：按各文件 size+mtime 做缓存键，模板不变就不重算 hash。 */
    function clientTemplate() {
      const src = join(api.dir, 'pet-client')
      const stamps = CLIENT_FILES.map((f) => {
        try { const st = statSync(join(src, f)); return `${f}:${st.size}:${Math.round(st.mtimeMs)}` } catch { return `${f}:-` }
      })
      const key = stamps.join('|')
      if (tplCache.key === key) return tplCache
      const files = CLIENT_FILES.map((f) => ({ name: f, hash: fileHash(join(src, f)) })).filter((f) => f.hash)
      const sig = files.length
        ? createHash('sha1').update(files.map((f) => `${f.name}:${f.hash}`).join('|')).digest('hex').slice(0, 12)
        : ''
      tplCache = { key, sig, files }
      return tplCache
    }
    /** 真机生成物对账。healthy=true 才算「行为层真能跑起来」。 */
    function clientStatus() {
      const dest = appDir()
      const tpl = clientTemplate()
      const stamp = readJson(join(dest, CLIENT_STAMP), null)
      const generatedSig = stamp && typeof stamp.sig === 'string' ? stamp.sig : ''
      const files = tpl.files.map((f) => {
        const p = join(dest, f.name)
        if (!existsSync(p)) return { name: f.name, state: 'missing' }
        const h = fileHashCached(p)
        return { name: f.name, state: h && h !== f.hash ? 'changed' : 'ok' }
      })
      const installed = existsSync(join(dest, 'main.js'))
      const missing = files.filter((f) => f.state === 'missing').map((f) => f.name)
      // 模板比生成物新（含「从没生成过 / 升级前生成的」：那时没有 stamp，generatedSig 为空）
      const outdated = installed && Boolean(tpl.sig) && generatedSig !== tpl.sig
      const changed = files.filter((f) => f.state === 'changed').map((f) => f.name)
      const running = Boolean(recordedPid()?.pid)
      const needsRestart = installed && (missing.length > 0 || outdated) && running
      let message = '客户端与插件版本一致'
      if (!installed) message = '还没生成客户端：点「下载 / 生成客户端」'
      else if (missing.length) message = `客户端缺 ${missing.join('、')}：点「重新生成客户端」，再重启 Electron 才会生效`
      else if (outdated) message = running ? '插件里的客户端更新了：点「重新生成客户端」并重启 Electron 才生效' : '插件里的客户端更新了：重新生成后再启动 Electron'
      else if (changed.length) message = `客户端文件与模板不一致（${changed.join('、')}）：可能被手改过，重新生成会覆盖`
      return {
        installed, healthy: installed && !missing.length && !outdated,
        outdated, sig: tpl.sig, generatedSig, files, missing, changed,
        needsRestart, running, message,
      }
    }

    // ---------- 客户端安装：把 pet-client 源码生成到数据目录（模块目录禁写数据） ----------
    function installClient() {
      const src = join(api.dir, 'pet-client')
      const dest = api.dataDir('app')
      const files = [...CLIENT_FILES, ...CLIENT_OPTIONAL]
      const copied = []
      // 素材目录（梗图 / 音效 / 玩法图）：整体递归复制，不走 CLIENT_FILES 的平铺清单
      // pics/baifan 是「吃白饭」的空碗/满碗/饭团（2026-11-05 跟进 dsh-pet 新版）
      const ASSET_DIRS = ['memes', 'sound', join('pics', 'baifan')]
      const copyTree = (from, to, base) => {
        let list = []
        try { list = readdirSync(from, { withFileTypes: true }) } catch { return }
        for (const e of list) {
          const f = join(from, e.name)
          if (e.isDirectory()) { copyTree(f, join(to, e.name), base); continue }
          try {
            mkdirSync(to, { recursive: true })
            copyFileSync(f, join(to, e.name))
            copied.push(`${base}/${e.name}`)
          } catch {}
        }
      }
      try {
        mkdirSync(dest, { recursive: true })
        for (const f of files) {
          const from = join(src, f)
          if (!existsSync(from)) continue
          copyFileSync(from, join(dest, f))
          copied.push(f)
        }
        for (const d of ASSET_DIRS) {
          const from = join(src, d)
          if (existsSync(from)) copyTree(from, join(dest, d), d)
        }
        // 生成凭据：下次 status 对账时用它判断「app/ 是哪个版本的模板生成的」
        const tpl = clientTemplate()
        if (tpl.sig) {
          try {
            writeFileSync(join(dest, CLIENT_STAMP), JSON.stringify({ sig: tpl.sig, at: Date.now(), files: tpl.files.map((f) => f.name) }, null, 2))
          } catch (error) { api.log.warn('写客户端签名失败（不影响使用）：', String(error?.message || error)) }
        }
        hashCache.clear() // 刚覆盖过，缓存全作废
        // 数据目录里的 host.json 已经写好，客户端起来就能发现插件
        writeHostFile(true)
        return {
          ok: copied.length > 0,
          dir: dest,
          files: copied,
          message: copied.length
            ? `客户端已生成到 ${dest}。在本机装好 Electron 后，在该目录运行 npx electron main.js（详见 README.md）。`
            : `模块目录里没找到 pet-client 源码（${src}）`,
        }
      } catch (error) {
        return { ok: false, message: '生成客户端失败：' + String(error?.message || error).slice(0, 160) }
      }
    }

    // ---------- Electron 三键（面板按钮 / HTTP 路由共用）：安装 → 启动 → 停止 ----------
    // 安装走 npmmirror 镜像（真机直连 github release 会 fetch failed）；启动前必须清掉
    // 子进程环境的 ELECTRON_RUN_AS_NODE（宿主环境必带，不清则 Electron 以纯 Node 模式启动即崩）。
    const appDir = () => api.dataDir('app')
    // Electron 可执行文件相对 node_modules/electron 的路径（npm 包布局：二进制在 dist/ 下）。
    const electronRelExe = () => process.platform === 'win32' ? join('dist', 'electron.exe')
      : process.platform === 'darwin' ? join('dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : join('dist', 'electron')
    // npm 包靠 path.txt 告诉 require('electron') 二进制在哪（本模块直接按路径 spawn，写它只为兼容别人 require）
    const electronPathTxt = () => process.platform === 'win32' ? 'electron.exe'
      : process.platform === 'darwin' ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron'
    const electronExe = () => join(appDir(), 'node_modules', 'electron', electronRelExe())
    // 不经 shell 拼接：找 npm-cli.js 直接跑（Windows 上 spawn 'npm.cmd' 无 shell 会被拒）；都找不到就返回空串，
    // 由 electronInstall 走「zip 直装」兜底（目标电脑可能根本没有 Node/npm 环境）。
    // npmCli 也可被测试钩子覆盖（petHooks.npmCli = 一个真实存在的假 cli 路径）。
    const npmCli = () => {
      // 'npmCli' in hooks = 显式覆盖（含空串「强制没有 npm」，测试用来逼出 zip 直装路径）
      const candidates = 'npmCli' in petHooks ? [petHooks.npmCli] : [
        join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        // Unix 系统级 node（如 /usr/bin/node）的 npm 实际在 /usr/lib/node_modules 下
        join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
      return candidates.find((c) => c && existsSync(c)) || ''
    }
    // 测试钩子：测试注入 fake spawn/kill，不打真网络、不真启动 Electron
    const petHooks = api.__petTestHooks || {}
    const spawnFn = petHooks.spawn || nodeSpawn
    const killFn = petHooks.kill || ((pid) => { process.kill(Number(pid), 'SIGTERM'); return true })
    // Electron 宿主保险（真机踩过）：DSH 跑在 Electron 里，**主进程的 fs 带 asar 补丁**——路径里只要出现
    // `.asar`，openSync 就先按「打开 asar 包」处理，去读文件头；读不到直接抛
    // `Invalid package <path>`（Electron 45 实测，堆栈落在 node:electron/js2c/node_init 的 openSync 包装）。
    // 官方 electron zip 里恰好有 `resources/default_app.asar`，所以纯 Node 下没问题的解压/清理/搬运
    // 一旦放进插件宿主就全炸在写这个文件上（历史上的「zip 直装失败：Invalid package …」就是它）。
    // 解法：所有可能碰到 `.asar` 的写/删/复制都走 Electron 暴露的 original-fs（未打补丁的 node fs）；
    // 纯 Node（测试、裸机 CLI）没有 original-fs，退回 node:fs 即可。测试可用 petHooks.fsRaw 注入假 fs 断言。
    const rawFs = () => {
      if (petHooks.fsRaw) return petHooks.fsRaw
      try { return createRequire(import.meta.url)('original-fs') } catch { return null }
    }

    const cleanElectronEnv = () => {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_NO_ATTACH_CONSOLE
      return env
    }
    const procFile = () => api.dataDir('process.json')
    let electronProc = null // { pid, startedAt }
    const recordedPid = () => {
      if (electronProc) return electronProc
      const p = readJson(procFile(), null)
      if (p && Number.isInteger(p.pid) && p.pid > 0) electronProc = p
      return electronProc
    }

    // ---------- zip 直装（无 npm 环境的兜底，自动化优先） ----------
    // 背景：DSH 自带运行时（dsh-runtimes/.../node）不带 npm-cli.js，目标电脑也可能没装 Node/npm。
    // Electron 的 npm 包本质就是「下载官方 zip → 解压到 node_modules/electron/dist」，这里跳过 npm 直接干：
    // 下载走镜像（面板可改 electronMirror，默认 npmmirror；同 npm 路径的 ELECTRON_MIRROR），
    // 解压用 Node 自带 zlib（纯 JS，零外部依赖、零环境要求）。
    const ELECTRON_VERSION_FALLBACK = '45.1.0' // 与 pet-client 模板 app/package.json 的 devDependencies.electron 对齐
    const DEFAULT_ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    /** 当前镜像（末尾一定带 /）：面板留空或写成非 http(s) 时回落内置默认。 */
    const electronMirror = () => {
      const raw = String(api.settings().electronMirror || '').trim()
      const base = /^https?:\/\//i.test(raw) ? raw : DEFAULT_ELECTRON_MIRROR
      return base.endsWith('/') ? base : base + '/'
    }
    const electronZipUrl = () => {
      let ver = ELECTRON_VERSION_FALLBACK
      try {
        const pkg = JSON.parse(readFileSync(join(appDir(), 'package.json'), 'utf8'))
        const m = String(pkg?.devDependencies?.electron || '').match(/\d+\.\d+\.\d+/)
        if (m) ver = m[0]
      } catch {} // package.json 读不到就用兜底版本
      const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
      const file = `electron-v${ver}-${platform}-${process.arch}.zip`
      return { ver, platform, arch: process.arch, file, url: `${electronMirror()}${ver}/${file}` }
    }

    // 【安全审查 P1 闭环】Electron zip 的 sha256 校验：zip 从镜像下，但校验清单**优先从 GitHub 官方**拉
    // （防「镜像被整体篡改，zip 和 SHASUMS 一起换」）；官方不可达（国内网络常见）再降级用镜像自己的
    // SHASUMS，并打警告。两处都拿不到 → 中止安装（宁可装不上，不装一个没验过签的运行时）。
    async function electronSha256({ ver, platform, arch, file }) {
      const sources = [
        { url: `https://github.com/electron/electron/releases/download/v${ver}/SHASUMS256.txt`, tag: '官方' },
        { url: `${electronMirror()}${ver}/SHASUMS256.txt`, tag: '镜像' },
      ]
      let lastError = null
      for (const { url, tag } of sources) {
        try {
          const buf = await fetchZipTo(url, join(appDir(), `SHASUMS256.${tag}.txt`), { maxBytes: 1024 * 1024 })
          const text = buf.toString('utf8')
          const line = text.split(/\r?\n/).find((l) => l.trim().endsWith(file))
          if (!line) throw new Error(`清单里没有 ${file}（版本/平台对不上？）`)
          const sha = line.trim().split(/\s+/)[0]
          if (!/^[a-f0-9]{64}$/i.test(sha)) throw new Error('清单里的 sha256 格式不对')
          if (tag === '镜像') api.log.warn(`Electron 校验清单来自镜像（官方 GitHub 拉取失败：${lastError ? String(lastError.message || lastError).slice(0, 120) : '未知原因'}），完整性保证降级`)
          return sha
        } catch (error) { lastError = error }
      }
      throw new Error(`官方与镜像的 SHASUMS256.txt 都没拿到（${String(lastError?.message || lastError).slice(0, 160)}）`)
    }

    // 纯 JS zip 解压（支持存储/deflate 两种压缩法；带 zip-slip 防护；unix 上恢复可执行位）
    function unzipTo(zip, destDir) {
      const u32 = (o) => zip.readUInt32LE(o)
      const u16 = (o) => zip.readUInt16LE(o)
      // 写文件/改权限必须走未打补丁的 fs：官方 zip 里的 resources/default_app.asar，在 Electron 宿主里
      // 用 node:fs 写会抛 `Invalid package <path>`（见 rawFs 注释）。测试钩子可注入 fsRaw 验证这一点。
      const fsx = rawFs()
      const writeRaw = fsx?.writeFileSync ? fsx.writeFileSync.bind(fsx) : writeFileSync
      const chmodRaw = fsx?.chmodSync ? fsx.chmodSync.bind(fsx) : chmodSync

      // 从尾部往前找 EOCD（0x06054b50），兼容最长 64KB 的 zip 注释区
      let eocd = -1
      for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
        if (u32(i) === 0x06054b50) { eocd = i; break }
      }
      if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到目录结尾标记）')
      const count = u16(eocd + 10)
      let ptr = u32(eocd + 16)
      for (let n = 0; n < count; n++) {
        if (u32(ptr) !== 0x02014b50) throw new Error(`zip 目录损坏（条目 ${n}）`)
        const method = u16(ptr + 10)
        const csize = u32(ptr + 20)
        const nameLen = u16(ptr + 28)
        const extraLen = u16(ptr + 30)
        const commentLen = u16(ptr + 32)
        const externAttr = u32(ptr + 38)
        const localOff = u32(ptr + 42)
        const name = zip.toString('utf8', ptr + 46, ptr + 46 + nameLen)
        ptr += 46 + nameLen + extraLen + commentLen
        if (name.endsWith('/')) { mkdirSync(join(destDir, name), { recursive: true }); continue }
        // 符号链接条目直接跳过（安全）。判据必须看 st_mode 的类型位：Unix 的 externalAttr 高 16 位是 st_mode，
        // S_IFLNK=0o120000 才是符号链接。别用 externAttr>>>31——普通文件 0o100644 的最高位同样是 1，
        // 那样会把官方 zip 里**所有**文件都当符号链接跳过（解压完目录是空的，报「没找到可执行文件」）。
        // Windows 打的 zip externalAttr 是 DOS 属性（如 0x20），高 16 位为 0，天然不受影响。
        if (((externAttr >>> 16) & 0o170000) === 0o120000) continue
        const target = join(destDir, name)
        if (target !== destDir && !target.startsWith(destDir + sep)) throw new Error(`zip 里的可疑路径：${name}`) // 防 zip-slip
        if (u32(localOff) !== 0x04034b50) throw new Error(`zip 局部头损坏：${name}`)
        const dataOff = localOff + 30 + u16(localOff + 26) + u16(localOff + 28)
        const data = method === 0 ? Buffer.from(zip.subarray(dataOff, dataOff + csize)) : inflateRawSync(zip.subarray(dataOff, dataOff + csize))
        mkdirSync(dirname(target), { recursive: true })
        writeRaw(target, data)
        if (process.platform !== 'win32' && ((externAttr >>> 16) & 0o111)) chmodRaw(target, 0o755) // unix 可执行位
      }
    }

    // 下载（可被测试钩子 petHooks.fetchZip 覆盖，不打真网络）
    // 【安全审查 P1】补三件事：
    //   ① 只允许 https（镜像地址里写 http:// 一律拒绝——下载的是要执行的二进制/素材包，
    //      明文信道可被中间人换包；本机回环地址除外，方便自测）；
    //   ② 大小上限（防止被超大响应撑爆磁盘/内存）；
    //   ③ 可选 sha256 校验：调用方给了期望值就逐字节校验，不匹配直接丢弃。
    const DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024 // 512MB：官方 electron zip 目前 ~110MB，留足余量
    function assertDownloadUrl(url) {
      let u
      try { u = new URL(String(url)) } catch { throw new Error(`下载地址不是合法 URL：${String(url).slice(0, 120)}`) }
      if (u.protocol === 'https:') return u
      // 明文只放行本机回环（自测/本地镜像），公网一律要求 https
      const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
      if (u.protocol === 'http:' && (LOOPBACK_HOSTS.includes(host) || host === '::1')) return u
      throw new Error(`拒绝从明文 http 下载（${u.protocol}//${u.hostname}）：请把镜像地址改成 https，或改用本机镜像`)
    }
    async function fetchZipTo(url, file, { sha256: expectSha = '', maxBytes = DOWNLOAD_MAX_BYTES } = {}) {
      assertDownloadUrl(url) // 先挡明文，再发请求
      const fetchZip = petHooks.fetchZip || ((u) => fetch(u))
      const res = await fetchZip(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Content-Length 能提前拒绝超大响应（拿不到也没关系，下面还有实际字节数兜底）
      const declared = Number(res.headers?.get?.('content-length') || 0)
      if (declared > maxBytes) throw new Error(`响应过大（${declared} 字节 > 上限 ${maxBytes}）`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw new Error(`下载内容过大（${buf.length} 字节 > 上限 ${maxBytes}）`)
      if (expectSha) {
        const got = createHash('sha256').update(buf).digest('hex')
        if (got.toLowerCase() !== String(expectSha).toLowerCase()) {
          throw new Error(`sha256 校验失败（期望 ${String(expectSha).slice(0, 12)}…，实际 ${got.slice(0, 12)}…）：文件可能被篡改，已丢弃`)
        }
      }
      writeFileSync(file, buf)
      return buf
    }

    // ---------- 客户端包分发（远端直连，2026-11-02）----------
    // 服务器部署（配了 publicBaseUrl）时用户在自己电脑跑桌宠：把 app/ 目录 + 当前 host.json
    // （远端模式下 baseUrl 已是远端地址、内含 token）打成一个 zip 供面板下载。
    // zip 打包用 Node 自带 zlib 纯 JS 实现（deflate + CRC32，零依赖、零外部命令），不引第三方大件。
    const CRC32_TABLE = (() => {
      const t = new Int32Array(256)
      for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c
      }
      return t
    })()
    const crc32 = (buf) => {
      let c = -1
      for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
      return (c ^ -1) >>> 0
    }
    /** entries: [{ name(用 / 分隔), data(Buffer|string) }] → zip Buffer（deflate + CRC32；条目带 UTF-8 名字标志）。 */
    function zipBuffer(entries) {
      const parts = []
      const centrals = []
      let offset = 0
      for (const e of entries) {
        const name = Buffer.from(String(e.name), 'utf8')
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)
        let def = null
        try { def = deflateRawSync(raw) } catch { def = null } // 压不动就按存储法写
        const useDeflate = def && def.length < raw.length
        const data = useDeflate ? def : raw
        const crc = crc32(raw)
        const lh = Buffer.alloc(30)
        lh.writeUInt32LE(0x04034b50, 0)     // local file header 签名
        lh.writeUInt16LE(20, 4)             // 解压所需版本
        lh.writeUInt16LE(0x0800, 6)         // 标志位 bit11：UTF-8 文件名
        lh.writeUInt16LE(useDeflate ? 8 : 0, 8)
        lh.writeUInt16LE(0, 10)             // 时间 / 日期（0 即可，解压端不校验）
        lh.writeUInt16LE(0, 12)
        lh.writeUInt32LE(crc, 14)
        lh.writeUInt32LE(data.length, 18)   // 压缩后大小
        lh.writeUInt32LE(raw.length, 22)    // 原始大小
        lh.writeUInt16LE(name.length, 26)
        lh.writeUInt16LE(0, 28)             // extra 长度
        parts.push(lh, name, data)
        const cd = Buffer.alloc(46)
        cd.writeUInt32LE(0x02014b50, 0)     // central directory 签名
        cd.writeUInt16LE(20, 4)             // 创建用版本
        cd.writeUInt16LE(20, 6)             // 解压所需版本
        cd.writeUInt16LE(0x0800, 8)         // UTF-8 名字
        cd.writeUInt16LE(useDeflate ? 8 : 0, 10)
        cd.writeUInt32LE(crc, 16)
        cd.writeUInt32LE(data.length, 20)
        cd.writeUInt32LE(raw.length, 24)
        cd.writeUInt16LE(name.length, 28)
        // extra/comment/磁盘号/内部外部属性全 0（普通文件；unzipTo 只靠类型位判符号链接，0 安全）
        cd.writeUInt32LE(offset, 42)        // local header 偏移
        centrals.push(Buffer.concat([cd, name]))
        offset += lh.length + name.length + data.length
      }
      const cdBuf = Buffer.concat(centrals)
      const eocd = Buffer.alloc(22)
      eocd.writeUInt32LE(0x06054b50, 0)
      eocd.writeUInt16LE(entries.length, 8)
      eocd.writeUInt16LE(entries.length, 10)
      eocd.writeUInt32LE(cdBuf.length, 12)
      eocd.writeUInt32LE(offset, 16) // central directory 起始偏移
      return Buffer.concat([...parts, cdBuf, eocd])
    }
    /** 打客户端包：installClient() 先生成 app/，只收客户端源码文件 + 附 host.json。
     *  【为什么不再递归整目录】app/ 里可能有 electronInstall() 装的 node_modules/electron/dist/
     *  （win 平台 electron.exe 单文件就 249MB），整目录递归打出来的 zip 实测 161MB——既拖慢下载，
     *  又是个白送的流量放大器。客户端只需要那几个源码文件，按白名单逐个取（不递归）。 */
    const PACKAGE_FILES = [...CLIENT_FILES, ...CLIENT_OPTIONAL]
    function clientPackage() {
      try {
        const r = installClient()
        if (!r.ok) return { ok: false, message: r.message }
        const dir = appDir()
        const entries = []
        // 白名单取文件（不递归）：即使 app/ 下被塞了任何大文件也不会进包
        for (const name of PACKAGE_FILES) {
          const p = join(dir, name)
          if (!existsSync(p)) continue
          try { entries.push({ name, data: readFileSync(p) }) } catch (err) { api.log.warn(`打客户端包跳过 ${name}：`, String(err?.message || err)) }
        }
        if (!entries.some((x) => x.name === 'main.js')) return { ok: false, message: '客户端包里没有 main.js：pet-client 模板可能缺失（' + join(api.dir, 'pet-client') + '）' }
        try { entries.push({ name: 'host.json', data: readFileSync(hostFile(), 'utf8') }) } catch {}
        return {
          ok: true,
          filename: 'aurabot-pet-client.zip',
          buffer: zipBuffer(entries),
          message: `客户端包已生成（${entries.length} 个文件，含内嵌 host.json）。解压后在本机装好 Electron，在解压目录运行 npx electron main.js`,
        }
      } catch (error) {
        return { ok: false, message: '打客户端包失败：' + String(error?.message || error).slice(0, 160) }
      }
    }

    // ---------- 默认素材包自动下载（装完即有，用户零操作） ----------
    // 背景：「大肥鱼」素材 50MB+（106 个 webm），不进插件仓库也不进 PR；放独立素材仓库
    // dsh-aurabot-qq-mods，插件启动发现 default 包缺失/为空就自动下载落位到 <dataDir>/packs/。
    // 失败不炸（客户端自己有静态形象兜底），走 every 兜底轮询重试；地址可在面板换镜像。
    // zip 内容约定：素材放在**文件夹**里（别把 106 个 webm 摊在仓库根目录），文件夹名随意：
    //   <任意文件夹>/default-config.json + default-manifest.json + default-animation/*.webm
    // —— archive zip 自带的 <仓库名>-<分支>/ 顶层目录也会自动剥，所以 <仓库>-<分支>/pet-pack/… 同样认。
    const PACK_CHECK_MS = 10 * MIN_MS        // 兜底轮询间隔（只在缺包时才真的下载）
    let packDownloading = false              // 并发闸：面板手动 + every 轮询同时触发时不重复下

    /** default 包是否缺失（没 config 或 animation 目录里一个 webm 都没有）。 */
    function defaultPackMissing() {
      try {
        if (!existsSync(configOfPack('default'))) return true
        return readdirSync(animsDirOf('default')).filter((f) => /\.webm$/i.test(f)).length === 0
      } catch { return true }
    }

    /**
     * 在解压暂存目录里找素材包根（含 default-animation/ 的那一层）。找不到返回 null。
     * 素材仓库约定：**素材必须放文件夹里**（不在仓库根目录摊 106 个 webm），文件夹名随意（pet-pack/、default/、大肥鱼/ 都行）。
     * 所以要按层找：包根 = 暂存目录本身 / <仓库名>-<分支>/ / <任意一层文件夹>/ / <仓库名>-<分支>/<任意一层文件夹>/。
     */
    function findPackRoot(stage) {
      const isPackRoot = (dir) => { try { return existsSync(join(dir, 'default-animation')) } catch { return false } }
      const subDirs = (dir) => {
        try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)) } catch { return [] }
      }
      if (isPackRoot(stage)) return stage
      for (const d1 of subDirs(stage)) {
        if (isPackRoot(d1)) return d1
        for (const d2 of subDirs(d1)) if (isPackRoot(d2)) return d2 // archive 顶层目录 + 素材文件夹 两层组合
      }
      return null
    }

    /**
     * 下载并落位 default 素材包。
     * @param {boolean} force true = 包已在也重新下载（面板「重新下载素材包」）；false = 只在缺包时下载
     * @returns {Promise<{ok:boolean, skipped?:boolean, count?:number, message:string}>}
     */
    async function ensureDefaultPack(force = false) {
      if (packDownloading) return { ok: false, message: '素材包正在下载中，别急' }
      if (!force && !defaultPackMissing()) return { ok: true, skipped: true, message: 'default 素材包已就位，不用下载' }
      const url = String(api.settings().petPackUrl || '').trim()
      if (!url) return { ok: false, message: '没有配置素材包下载地址（面板「桌宠」页 →「素材包」卡里填）' }
      packDownloading = true
      const stage = api.dataDir('packs-staging') // 解压暂存目录：校验通过才落位，失败不污染 packs/
      try {
        const zip = await fetchZipTo(url, api.dataDir('packs-download.zip'))
        try { rmSync(stage, { recursive: true, force: true }) } catch {}
        mkdirSync(stage, { recursive: true })
        unzipTo(zip, stage)
        const root = findPackRoot(stage)
        if (!root) throw new Error('zip 里找不到 default-animation/（内容结构不对：素材要放文件夹里，如 pet-pack/default-animation/）')
        mkdirSync(animsDirOf('default'), { recursive: true })
        let copied = 0
        for (const f of readdirSync(join(root, 'default-animation'))) {
          const src = join(root, 'default-animation', f)
          try { if (!statSync(src).isFile()) continue } catch { continue }
          copyFileSync(src, join(animsDirOf('default'), f))
          copied++
        }
        if (copied === 0) throw new Error('default-animation/ 里没有动画文件（.webm）')
        for (const f of ['default-config.json', 'default-manifest.json']) {
          const src = join(root, f)
          try { if (statSync(src).isFile()) copyFileSync(src, join(packsDir(), f)) } catch {}
        }
        api.log.info(`桌宠：素材包已下载落位（${copied} 个动画 → packs/default-animation/）`)
        ensureAssetRoutes()
        return { ok: true, count: copied, message: `素材包下载完成（${copied} 个动画）` }
      } catch (error) {
        const msg = `素材包下载失败：${String(error?.message || error).slice(0, 200)}`
        api.log.warn(msg)
        return { ok: false, message: msg }
      } finally {
        packDownloading = false
        try { rmSync(stage, { recursive: true, force: true }) } catch {}
        try { unlinkSync(api.dataDir('packs-download.zip')) } catch {}
      }
    }

    // 自动落位调度：真机启动后 5 秒补一次 + 每 10 分钟兜底查一次（只在缺包时才下载）。
    // 测试环境（注入了 __petTestHooks）一律跳过——测试不打真网络，靠手动调 ensureDefaultPack + fake fetchZip。
    if (!api.__petTestHooks) {
      const kick = setTimeout(() => { ensureDefaultPack().catch(() => {}) }, 5_000)
      kick.unref?.()
      api.every(PACK_CHECK_MS, () => { if (defaultPackMissing()) ensureDefaultPack().catch(() => {}) }, '素材包自动落位')
    }

    // 官方 electron zip 是「扁平包」：electron.exe / electron 直接在压缩包根目录，没有 dist/ 前缀
    // （macOS 是 Electron.app 目录）；而 npm 包的布局是 node_modules/electron/dist/…。部分镜像还会
    // 在外面再套一层目录（electron-v45-win32-x64/）。所以这里先解到临时目录、认出 payload 根，
    // 再整体搬进 dist/——让 electronExe() 只需认 dist/，npm 装与 zip 直装共用一套路径判断。
    function findPayloadRoot(dir, depth = 0) {
      if (depth > 4) return ''
      let items = []
      try { items = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
      // ① 本层就是 payload 根（标准扁平包）
      for (const it of items) {
        if (it.isFile() && it.name === 'electron.exe' && process.platform === 'win32') return dir
        if (it.isFile() && it.name === 'electron' && process.platform !== 'win32') return dir
        if (it.isDirectory() && it.name === 'Electron.app') return dir
      }
      // ② 外层套了目录时往下找（locales/resources 是 payload 内部目录，别白跑）
      for (const it of items) {
        if (!it.isDirectory() || it.name === 'locales' || it.name === 'resources') continue
        const hit = findPayloadRoot(join(dir, it.name), depth + 1)
        if (hit) return hit
      }
      return ''
    }

    /** 把 src 里的条目整体搬进 dest（同盘 rename；跨盘/被占用时回退「复制 + 删源」）。 */
    function moveInto(src, dest) {
      // 搬运目标里含 resources/default_app.asar：复制/删源同样要走未打补丁的 fs（见 rawFs 注释）
      const fsx = rawFs()
      const cpRaw = fsx?.cpSync ? fsx.cpSync.bind(fsx) : cpSync
      const rmRaw = fsx?.rmSync ? fsx.rmSync.bind(fsx) : rmSync
      mkdirSync(dest, { recursive: true })
      for (const name of readdirSync(src)) {
        const from = join(src, name)
        const to = join(dest, name)
        try { renameSync(from, to) } catch {
          cpRaw(from, to, { recursive: true })
          rmRaw(from, { recursive: true, force: true })
        }
      }
    }

    async function electronInstallZip(exe) {
      const meta = electronZipUrl()
      const { ver, url, file } = meta
      const zipFile = join(appDir(), 'electron.zip')
      const pkgRoot = join(appDir(), 'node_modules', 'electron')
      const stage = join(pkgRoot, '.unzip')
      // 清目录也得走原始 fs：上一次失败留下的 .unzip 里就有 default_app.asar，
      // 在 Electron 宿主里用 node:fs 递归删会同样抛 Invalid package
      const fsx = rawFs()
      const rmRaw = fsx?.rmSync ? fsx.rmSync.bind(fsx) : rmSync
      try {
        // 【安全审查 P1 闭环】先拿校验清单再下 zip：sha256 对不上就直接拒绝安装
        const expectSha = await electronSha256(meta)
        const zip = await fetchZipTo(url, zipFile, { sha256: expectSha })
        // 能走到这里说明 pkgRoot 里本来就没有可用安装：清空重装。顺手清掉旧版本留下的垃圾
        // （旧版把扁平 zip 直接解到 pkgRoot，留下 electron.exe + 一百多 MB 散文件）和 npm 的半成品。
        try { rmRaw(pkgRoot, { recursive: true, force: true }) } catch (error) {
          throw new Error(`旧的 electron 目录删不掉（${String(error?.code || error?.message || error)}）：先点「停止桌宠」再装`)
        }
        mkdirSync(stage, { recursive: true })
        unzipTo(zip, stage) // 纯 JS 解压到临时目录
        const root = findPayloadRoot(stage)
        if (!root) {
          let peek = ''
          try { peek = readdirSync(stage).slice(0, 6).join('、') } catch {}
          throw new Error(`解压完成但包里没有 ${basename(exe)}（解出来的东西：${peek || '空'}）`)
        }
        moveInto(root, join(pkgRoot, 'dist')) // 最终布局对齐 npm：node_modules/electron/dist/…
        try { writeFileSync(join(pkgRoot, 'path.txt'), electronPathTxt()) } catch {} // 给 require('electron') 用
        if (!existsSync(exe)) throw new Error(`解压完成但没找到 ${basename(exe)}（${process.platform}-${process.arch}）`)
        return { ok: true, installed: true, exe, message: `Electron v${ver} 安装完成（npmmirror 直下 zip，无需 npm）` }
      } catch (error) {
        return { ok: false, message: `zip 直装失败：${String(error?.message || error).slice(0, 240)}（可换个网络再点一次，或看 USER-MANUAL 的手动安装教程）` }
      } finally {
        try { unlinkSync(zipFile) } catch {}
        try { rmRaw(stage, { recursive: true, force: true }) } catch {}
      }
    }

    async function electronInstall() {
      const exe = electronExe()
      if (existsSync(exe)) return { ok: true, alreadyInstalled: true, exe, message: 'Electron 已安装，不用重复装' }
      if (!existsSync(join(appDir(), 'main.js'))) return { ok: false, message: '还没生成客户端：先点「下载 / 生成客户端」' }
      // 有 npm-cli 就走 npm（老行为，保持不变）；没有（DSH 自带运行时/裸机）就走 zip 直装，零环境依赖。
      const cli = npmCli()
      if (!cli) return electronInstallZip(exe)
      const out = await new Promise((resolve) => {
        let tail = ''
        let child = null
        try {
          child = spawnFn(process.execPath, [cli, 'install', '-D', 'electron'], {
            cwd: appDir(),
            env: { ...process.env, ELECTRON_MIRROR: electronMirror() },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) {
          return resolve({ code: -1, tail: String(error?.message || error) })
        }
        child.stdout?.on?.('data', (d) => { tail = (tail + String(d)).slice(-2000) })
        child.stderr?.on?.('data', (d) => { tail = (tail + String(d)).slice(-2000) })
        const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; resolve({ code: -1, tail, timeout: true }) }, 10 * 60_000)
        child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, tail: tail + String(error?.message || error) }) })
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, tail }) })
      })
      const ok = out.code === 0 && existsSync(exe)
      if (ok) return { ok: true, installed: true, exitCode: 0, exe, message: `Electron 安装完成（镜像 ${electronMirror()}）` }
      // npm 挂了（镜像慢/网络断/权限都常见）→ 自动回退 zip 直装，别让人连点两次都失败还没出路
      const why = out.timeout ? 'npm 安装超时（10 分钟）' : `npm 安装失败（退出码 ${out.code}${out.tail ? '：' + String(out.tail).slice(-160) : ''}）`
      const fb = await electronInstallZip(exe)
      return {
        ...fb,
        exitCode: out.code,
        message: fb.ok ? `${why}，已自动改用 zip 直装：${fb.message}` : `${why}；zip 直装也没成：${fb.message}`,
      }
    }

    /** 启动桌宠。
     *  opts.by：谁发起的（'panel' 面板按钮 / 'autostart' DSH 启动时自动拉起）。
     *  只有**人点的**启动才写「想开着」标记；自动拉起不写，否则「意外死亡」会被洗成「主人想开」。 */
    function launch(opts = {}) {
      const by = String(opts.by || 'panel')
      if (online().online) {
        // 已经在跑：仍然确认一次意图（面板点启动 = 明确要开着）
        if (by === 'panel') setPetWanted(true, 'panel-launch')
        return { ok: true, alreadyRunning: true, message: '桌宠已经在跑了（心跳正常），不用重复启动' }
      }
      const exe = electronExe()
      if (!existsSync(exe)) return { ok: false, message: 'Electron 还没安装：先点「安装 Electron」' }
      if (!existsSync(join(appDir(), 'main.js'))) return { ok: false, message: 'app/main.js 不见了：先点「下载 / 生成客户端」' }
      try {
        // 分离进程启动；env 必须去掉 ELECTRON_RUN_AS_NODE（见 cleanElectronEnv）
        // 参数说明（2026-11-04 实测补，否则「点了启动没反应」）：
        //   --no-sandbox      受限身份下不带它，Electron 启动瞬间崩（退出码 0x80000003，无任何输出）
        //   --disable-gpu     GPU 缓存目录建不出来时刷一片错误，关掉更稳
        //   --user-data-dir   默认的 AppData\Roaming\Electron 在受限身份下建不了 Network 子目录
        //                     （拒绝访问 0x5），指到 pet 自己的数据目录里就正常
        const udir = api.dataDir('userdata')
        try { mkdirSync(udir, { recursive: true }) } catch {}
        const child = spawnFn(exe, ['main.js', '--no-sandbox', '--disable-gpu', `--user-data-dir=${udir}`], { cwd: appDir(), env: cleanElectronEnv(), detached: true, stdio: 'ignore', windowsHide: true })
        child.on?.('error', (error) => api.log.warn('桌宠启动失败：', error.message)) // 没人听就是未捕获异常，会带走 DSH
        child.unref?.()
        electronProc = { pid: child.pid, startedAt: Date.now() }
        try { writeJsonAtomic(procFile(), electronProc) } catch (e) { api.log.debug(`进程文件写入失败：${e.message}`) }
        // 只有人点的启动才记「想开着」；自动拉起/崩溃自愈都不改意图
        if (by === 'panel') setPetWanted(true, 'panel-launch')
        api.log.info(`桌宠已启动（pid ${child.pid}${by === 'autostart' ? '，随 DSH 自动' : ''}）`)
        return { ok: true, pid: child.pid, message: `桌宠已启动（pid ${child.pid}），等它连上就有心跳了` }
      } catch (error) {
        return { ok: false, message: '启动失败：' + String(error?.message || error).slice(0, 160) }
      }
    }

    /** 停止桌宠。opts.by：'panel' 面板按钮 / 'dispose' 插件卸载（DSH 退出）。
     *  只有**人点的**停止才记「不想开着」；DSH 退出时顺手收掉不算主人的意愿——
     *  否则每次关 DSH 都会把她标成「不想开」，下次启动就永远不自动出来了。 */
    function stop(opts = {}) {
      const by = String(opts.by || 'panel')
      if (by === 'panel') setPetWanted(false, 'panel-stop')
      const p = recordedPid()
      if (!p) return { ok: false, message: '没有正在运行的桌宠进程记录' }
      let killed = true
      try { killFn(p.pid) } catch (error) {
        // ESRCH = 进程本来就不在了：清理记录、按已停止处理，别让面板卡在「停不掉」
        if (String(error?.code) === 'ESRCH') {
          electronProc = null
          try { unlinkSync(procFile()) } catch {}
          presence.clear()
          return { ok: true, pid: p.pid, message: `桌宠进程（pid ${p.pid}）已经不在了，清掉了记录` }
        }
        killed = false
        return { ok: false, pid: p.pid, message: '停止失败：' + String(error?.message || error).slice(0, 120) }
      }
      electronProc = null
      try { unlinkSync(procFile()) } catch {}
      // 关键：停止后必须立刻清掉心跳，否则 60 秒内再点「启动」会被 launch() 开头的
      // 「online().online → alreadyRunning」直接拦回去——面板提示「已启动」但窗口根本不出来。
      // presence 是纯内存表，进程既然被杀了，里面的时间戳就是陈的，清掉不会误伤。
      presence.clear()
      api.log.info(`桌宠已停止（pid ${p.pid}${by === 'dispose' ? '，随 DSH 退出' : ''}）`)
      return { ok: killed, pid: p.pid, message: killed ? `已停止桌宠（pid ${p.pid}）` : '停止指令没有确认成功，看看进程还在不在' }
    }

    // ---------- pet pack 与素材路由（P1/P4）：packs 目录只读给客户端，404 绝不回落别的包 ----------
    // 注意：模块 route 是「全路径精确匹配」（mods.handle 不做前缀匹配），所以素材按
    //   /asset/<包名>/<文件名> 一条条注册；ensureAssetRoutes() 在启动和每次客户端拉配置时刷新
    //   （新放了素材/新换了包，客户端下一次 /config 就能把路由补齐）。
    const MIME = { '.webm': 'video/webm', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' }
    const registeredAssets = new Set()
    function serveAsset(res, pack, file) {
      const dir = animsDirOf(pack)
      const full = join(dir, file)
      let buf = null
      try { buf = readFileSync(full) } catch {}
      if (!buf || !full.startsWith(dir)) return api.core.http.send(res, 404, { ok: false, message: '素材不存在' })
      try {
        res.statusCode = 200
        res.setHeader?.('content-type', MIME[file.toLowerCase().slice(file.lastIndexOf('.'))] || 'application/octet-stream')
        res.setHeader?.('cache-control', 'private, max-age=3600') // 带 token 的 URL 不能进共享缓存
        res.setHeader?.('content-length', String(buf.length))
        res.end?.(buf)
      } catch {}
    }
    function ensureAssetRoutes() {
      try {
        for (const pack of listPacks()) {
          for (const f of pack.anims) {
            // 客户端 <video> 拉素材时 URL 一定经过百分号编码，而分发层拿的是
            // new URL(req.url).pathname（保留编码、不解码）——所以编码后的 key 必须原样注册，
            // 否则中文/空格命名的素材永远 404。原始名与编码名都注册，手动 curl 两种写法都能命中。
            const keys = new Set([
              `/asset/${pack.name}/${f}`,
              `/asset/${encodeURIComponent(pack.name)}/${encodeURIComponent(f)}`,
            ])
            if ([...keys].every((k) => registeredAssets.has(k))) continue
            for (const key of keys) {
              if (registeredAssets.has(key)) continue
              registeredAssets.add(key)
              api.route(key, (req, res) => {
                if (!guard(req, res, { queryTokenOk: true }).ok) return
                learnHost(req)
                serveAsset(res, pack.name, f) // 严格隔离：只服务自己包里的这个文件，404 不回落 default
              })
            }
          }
        }
        ensureExtraAssetRoutes()
      } catch (error) { api.log.warn('注册素材路由失败：', String(error?.message || error)) }
    }

    // ================= 小屋（复式场景窗，上游 1.0.12） =================
    // 移植自 zizic04/dsh-pet-home（MIT）；小屋素材 CC BY-NC-SA 4.0 禁止商用，本机自用。
    // 目录即数据（与 packs 同款思路）：manifest.json + 全部图片平铺在 dataDir('house')，
    // 一条条注册精确路由（route 不做前缀匹配，原始名与百分号编码名都要注册）。
    // 没放素材时 /house/manifest 返回 404，客户端显示「素材未就绪」提示，不白屏。
    const houseDir = () => api.dataDir('house')
    const houseStateFile = () => api.dataDir('house-state.json')
    const MIME_HOUSE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json; charset=utf-8' }
    const registeredHouseAssets = new Set()
    function serveHouseAsset(res, file) {
      const dir = houseDir()
      const full = join(dir, file)
      let buf = null
      try { buf = readFileSync(full) } catch {}
      if (!buf || !full.startsWith(dir)) return api.core.http.send(res, 404, { ok: false, message: '小屋素材不存在' })
      try {
        res.statusCode = 200
        res.setHeader?.('content-type', MIME_HOUSE[file.toLowerCase().slice(file.lastIndexOf('.'))] || 'application/octet-stream')
        res.setHeader?.('cache-control', 'private, max-age=3600') // 带 token 的 URL 不进共享缓存
        res.setHeader?.('content-length', String(buf.length))
        res.end?.(buf)
      } catch {}
    }
    function ensureHouseRoutes() {
      try {
        if (!existsSync(houseDir())) return
        for (const f of readdirSync(houseDir())) {
          if (!statSync(join(houseDir(), f)).isFile()) continue
          const keys = new Set([`/asset/house/${f}`, `/asset/house/${encodeURIComponent(f)}`])
          if ([...keys].every((k) => registeredHouseAssets.has(k))) continue
          for (const key of keys) {
            if (registeredHouseAssets.has(key)) continue
            registeredHouseAssets.add(key)
            api.route(key, (req, res) => {
              if (!guard(req, res, { queryTokenOk: true }).ok) return
              learnHost(req)
              serveHouseAsset(res, f) // 严格隔离：只服务 house 目录里这个文件
            })
          }
        }
      } catch (error) { api.log.warn('注册小屋素材路由失败：', String(error?.message || error)) }
    }
    function houseStatus() {
      let files = 0
      try { files = readdirSync(houseDir()).filter((f) => statSync(join(houseDir(), f)).isFile()).length } catch {}
      return {
        enabled: petHouseEnabled(),
        files,
        manifestReady: existsSync(join(houseDir(), 'manifest.json')),
        state: readJson(houseStateFile(), {}),
      }
    }
    api.route('/house/manifest', (req, res) => {
      if (!petHouseEnabled()) return api.core.http.send(res, 404, { ok: false, message: '小屋功能未开启' })
      if (!guard(req, res, { queryTokenOk: true }).ok) return
      learnHost(req)
      serveHouseAsset(res, 'manifest.json')
    })
    // 小屋状态：客户端上报（夜里/白天、当前状态、所在楼层、互动台词）；行为大脑三期会读它
    api.route('/house/state', async (req, res) => {
      if (!guard(req, res, {}).ok) return
      learnHost(req)
      if (req.method === 'POST') {
        const body = req.__json || {}
        const cur = readJson(houseStateFile(), {})
        const next = {
          ...cur,
          ...(body.night === undefined ? {} : { night: Boolean(body.night) }),
          ...(body.state === undefined ? {} : { state: String(body.state || '').slice(0, 32) }),
          ...(body.floor === undefined ? {} : { floor: Number(body.floor) === 2 ? 2 : 1 }),
          ...(body.say === undefined ? {} : { lastSay: String(body.say || '').slice(0, 200), lastSayAt: Date.now() }),
        }
        writeJsonAtomic(houseStateFile(), next)
        emit('house', next)
        return api.core.http.send(res, 200, { ok: true, state: next })
      }
      return api.core.http.send(res, 200, { ok: true, state: readJson(houseStateFile(), {}) })
    })

    // ---------- 梗图 / 点击音效的静态路由（从 dsh-pet 搬来的素材） ----------
    // 素材放在数据目录 app/memes 和 app/sound 下，客户端用 /pic/memes/<名字>.png、/sound/<名字>.wav 拉。
    // 和上面的 pack 素材一样是「全路径精确匹配」，所以启动时扫一遍目录逐个注册。
    const registeredExtra = new Set()
    function ensureExtraAssetRoutes() {
      const appDir = api.dataDir('app')
      const groups = [
        { dir: 'memes', url: '/pic/memes', mime: 'image/png' },
        // 内置玩法「吃白饭」的图（2026-11-05 跟进 dsh-pet 新版）：空碗 / 满碗 / 饭团。
        // dir 必须写到 pics/baifan 这一层 —— 这段扫描是**单层**的，写 pics 会把子目录当文件名注册。
        { dir: join('pics', 'baifan'), url: '/pic/baifan', mime: 'image/png' },
        { dir: 'sound', url: '/sound', mime: null }, // 按扩展名查 MIME
        { dir: 'fonts', url: '/fonts', mime: null }, // 自定义字体
      ]
      for (const g of groups) {
        let names = []
        try { names = readdirSync(join(appDir, g.dir)).filter((n) => n && !n.startsWith('.')) } catch { continue }
        for (const n of names) {
          const key = `${g.url}/${n}`
          const keyEnc = `${g.url}/${encodeURIComponent(n)}`
          if (registeredExtra.has(key)) continue
          registeredExtra.add(key)
          const handler = (req, res) => {
            if (!guard(req, res, { queryTokenOk: true }).ok) return
            learnHost(req)
            const full = join(appDir, g.dir, n)
            let buf = null
            try { buf = readFileSync(full) } catch {}
            if (!buf) return api.core.http.send(res, 404, { ok: false, message: '素材不存在' })
            const ext = n.toLowerCase().slice(n.lastIndexOf('.'))
            try {
              res.statusCode = 200
              res.setHeader?.('content-type', g.mime || MIME[ext] || 'application/octet-stream')
              res.setHeader?.('cache-control', 'private, max-age=3600')
              res.setHeader?.('content-length', String(buf.length))
              res.end?.(buf)
            } catch {}
          }
          for (const k of new Set([key, keyEnc])) {
            if (registeredAssets.has(k)) continue
            registeredAssets.add(k)
            api.route(k, handler)
          }
        }
      }
    }

    // ================= 配置校验（对齐 dsh-pet 的 host/config/validate：非法值降级 + 只说一次） =================
    // 以前的口径是「读的时候各自 Math.min/Math.max 一下」——那样非法值确实不会炸，
    // 但主人永远不知道「我填的 999 分钟被悄悄改成了 9999 还是 60」。这里补上「说一句」的那半：
    // 每个 number 字段超出 settings 声明的 min/max 就记一次告警，并如实告诉他改成了多少。
    // 只在插件启动后第一次读到坏值时提醒（同一个键不重复念），不影响任何功能路径。
    const settingsSpec = (() => {
      const map = new Map()
      try {
        for (const f of PET_SETTINGS) {
          if (f && f.key && (f.type === 'number')) map.set(f.key, { min: Number(f.min), max: Number(f.max) })
        }
      } catch {}
      return map
    })()
    /** 一次性自检：启动后跑一遍，把所有被夹过的键记一条日志（不弹气泡，别吓人）。 */
    function auditSettings() {
      const s = api.settings()
      const bad = []
      for (const [key, spec] of settingsSpec) {
        const raw = s[key]
        if (raw === undefined || raw === null || raw === '') continue
        const n = Number(raw)
        if (!Number.isFinite(n)) { bad.push(`${key}=${JSON.stringify(raw)} 不是数字，已按默认处理`); continue }
        const lo = Number.isFinite(spec.min) ? spec.min : -Infinity
        const hi = Number.isFinite(spec.max) ? spec.max : Infinity
        const v = Math.min(hi, Math.max(lo, n))
        if (v !== n) bad.push(`${key}=${n} 超出 ${lo}~${hi}，已按 ${v} 生效`)
      }
      if (bad.length) api.log.warn('[pet] 配置校验：\n  - ' + bad.join('\n  - '))
      return bad
    }
    // 面板每次打开都会拉 /status，顺手把校验结果带出去（主人能看见自己哪项填歪了）
    let settingsAudit = []
    try { settingsAudit = auditSettings() } catch (error) { api.log.debug(`配置自检失败：${error.message}`) }

    // ================= 余额（DeepSeek 官方 /user/balance → 金额档位 → 余额动画 + 气泡） =================
    // 对齐 dsh-pet 的 host/balance：那边有 4 个服务商（官方 Key / DSH 账号 / commandcode / opencode-go），
    // 我们只做**最通用的那一条**——官方 API Key。DSH 账号那条要 ctx.get('deepseekAccount')，
    // 模块拿不到；另外两家跟这里没关系。
    // 素材里有 6 段余额动画（余额-钱袋满溢 … 余额-分文不剩），按金额档位挑。
    const BALANCE_API = 'https://api.deepseek.com/user/balance'
    const BALANCE_TTL_MS = 10 * 60_000 // 10 分钟内不重复打接口（手动查也不绕过，接口按次有成本）
    let balanceCache = null // { ok, at, wallets, tier, provider, reason, message, manual }
    const balanceFile = () => api.dataDir('balance.json')
    // 档位：below 是该档的最高余额（不含），最后一档没有上限。
    // 素材里 6 段余额动画，这里用 5 档（「钱袋满溢」那档并进「金袋叮当」——
    // 分成两档会给同一句话配两个动画，看不出区别）。
    const BALANCE_TIERS = [
      { below: 5, label: '分文不剩', anim: '余额-分文不剩', say: '余额见底了…要不要充一点点？' },
      { below: 20, label: '袋空如洗', anim: '余额-袋空如洗', say: '钱包瘪瘪的，只剩 {amt} 了' },
      { below: 50, label: '数金皱眉', anim: '余额-数金皱眉', say: '还剩 {amt}…省着点用哦' },
      { below: 100, label: '钱袋如常', anim: '余额-钱袋如常', say: '余额 {amt}，还够用' },
      { below: Infinity, label: '金袋叮当', anim: '余额-金袋叮当', say: '余额 {amt}，今天不慌' },
    ]
    /** 按余额挑档位与台词。金额拿不到就按「分文不剩」兜底（宁可少说，不编富贵）。 */
    function balanceSay(wallet) {
      const total = Number(wallet?.total)
      const amt = (wallet?.currency === 'USD' ? '$' : '¥') + (Number.isFinite(total) ? total.toFixed(2) : '?')
      if (!Number.isFinite(total)) {
        const z = BALANCE_TIERS[0]
        return { label: z.label, anim: z.anim, say: z.say.replace('{amt}', amt), amount: 0 }
      }
      for (const t of BALANCE_TIERS) {
        if (total < t.below) return { label: t.label, anim: t.anim, say: t.say.replace('{amt}', amt), amount: total }
      }
      const last = BALANCE_TIERS[BALANCE_TIERS.length - 1]
      return { label: last.label, anim: last.anim, say: last.say.replace('{amt}', amt), amount: total }
    }
    /**
     * 查一次余额并写缓存。
     * @param {boolean} manual - 主人手动点的（失败要明说，不能静默）
     */
    async function refreshBalance(manual = false) {
      const s = api.settings()
      const key = String(s.petBalanceKey || '').trim()
      const write = (v) => {
        balanceCache = { ...v, at: Date.now(), manual }
        try { writeJsonAtomic(balanceFile(), balanceCache, { private: true }) } catch {}
        return balanceCache
      }
      if (!key) {
        return write({ ok: false, reason: 'credential-missing', provider: 'deepseek-official', message: '还没填 DeepSeek API Key（面板「余额播报」里填）' })
      }
      api.log.info(`[pet] 余额刷新开始（${manual ? '手动' : '周期'}）`)
      try {
        const res = await fetch(BALANCE_API, {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
        })
        if (!res.ok) {
          const hint = res.status === 401 ? 'API Key 不对或过期了' : res.status === 403 ? '这个 Key 没有查余额的权限' : `接口返回 ${res.status}`
          api.log.warn(`[pet] 余额刷新失败：${hint}`)
          return write({ ok: false, reason: 'fetch-error', provider: 'deepseek-official', message: hint })
        }
        const body = await res.json().catch(() => null)
        const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
        if (!infos.length) {
          api.log.warn('[pet] 余额刷新失败：响应里没有 balance_infos')
          return write({ ok: false, reason: 'fetch-error', provider: 'deepseek-official', message: '接口没返回余额字段' })
        }
        // 全部币种都留（只取首条会让别的币种凭空消失），展示时按设置里的币种挑
        const wallets = infos.map((w) => ({
          currency: String(w?.currency || 'CNY'),
          total: Number(w?.total_balance) || 0,
          granted: Number(w?.granted_balance) || 0,
          toppedUp: Number(w?.topped_up_balance) || 0,
        }))
        api.log.info(`[pet] 余额刷新成功：${wallets.map((w) => w.currency + ' ' + w.total.toFixed(2)).join(' / ')}`)
        return write({ ok: true, provider: 'deepseek-official', wallets })
      } catch (error) {
        const msg = String(error?.message || error)
        api.log.warn('[pet] 余额刷新异常：' + msg)
        return write({ ok: false, reason: 'fetch-error', provider: 'deepseek-official', message: msg.slice(0, 120) })
      }
    }
    /** 命中要展示的那个钱包（按设置里的币种，缺了自己补第一个）。 */
    function balanceWallet() {
      const want = String(api.settings().petBalanceCurrency || 'CNY').trim().toUpperCase() || 'CNY'
      const list = Array.isArray(balanceCache?.wallets) ? balanceCache.wallets : []
      return list.find((w) => String(w.currency).toUpperCase() === want) || list[0] || null
    }
    /** 播报一次：动画 + 气泡。失败态也说话（余额不可用要明说，别静默）。 */
    async function balanceAnnounce(force = false) {
      const s = api.settings()
      if (!force && s.petBalanceEnabled === false) return
      // 缓存够新就直接用；不够新先拉
      if (!balanceCache || Date.now() - (balanceCache.at || 0) > BALANCE_TTL_MS) await refreshBalance(false)
      const c = balanceCache
      if (!c) return
      if (!c.ok) {
        // 只在「手动」或原因变化时说，别每个周期都把同一句失败念一遍
        if (c.manual) await dispatch({ text: `余额查不到：${c.message || '未知原因'}`, purpose: 'balance', via: 'pet', noFallback: true })
        return
      }
      const w = balanceWallet()
      if (!w) return
      const info = balanceSay(w)
      try {
        await dispatch({ text: info.say, purpose: 'balance', via: 'pet', anim: info.anim, noFallback: true })
      } catch (error) { api.log.warn('[pet] 余额播报失败：', String(error?.message || error)) }
      return info
    }
    // 周期刷新：只在开了「余额播报」且有 Key 时才真的打接口
    const offBalance = api.every(Math.max(5, Math.min(1440, Number(api.settings().petBalanceMinutes) || 60)) * MIN_MS, () => {
      const s = api.settings()
      if (s.petBalanceEnabled === false) return
      if (!String(s.petBalanceKey || '').trim()) return
      balanceAnnounce(false).catch(() => {})
    }, '余额播报')

    // ================= 待办（todos.json + 到点提醒；对齐 dsh-pet 的 host/todo） =================
    // 与 dsh-pet 的差别：那边的待办面板是气泡槽的一个槽位（撑在人物头上），
    // 我们的桌宠窗口只有 ~460 宽，塞一张可编辑清单会把窗口顶到 700 高、还把人物挤走。
    // 所以这里是**独立小窗**（todo.html），主窗只管快捷键唤起 + 到点弹气泡。
    // 数据源两个都吃：
    //   ① DSH 自己做任务时发的 `todo/write` 事件（只读镜面，别人写什么这里就能看见什么）
    //   ② 这份 todos.json（主人在小窗里自己记的，可增删改勾）
    // 两者按 id 合并去重：镜面条目带 src:'dsh'，只读；本地条目带 src:'local'，可编辑。
    const TODO_TEXT_MAX = 200
    const TODO_BODY_MAX_BYTES = 8 * 1024
    const todoFile = () => api.dataDir('todos.json')
    const TODO_DONE_KEEP = 50        // 已完成的最多留 50 条，再老的滚掉（清单不会被无限撑大）

    /** 读整份待办文件（坏文件按空清单处理，绝不因为一条脏数据让面板打不开）。 */
    function loadTodos() {
      const raw = readJson(todoFile(), null)
      const list = Array.isArray(raw?.todos) ? raw.todos : []
      const out = []
      for (const t of list) {
        if (!t || typeof t !== 'object') continue
        const id = String(t.id || '').trim()
        const text = String(t.text || '').trim()
        if (!id || !text) continue
        out.push({
          id, text: text.slice(0, TODO_TEXT_MAX),
          dueAt: Number.isFinite(Number(t.dueAt)) && Number(t.dueAt) > 0 ? Number(t.dueAt) : null,
          done: t.done === true,
          createdAt: Number(t.createdAt) || 0,
          updatedAt: Number(t.updatedAt) || 0,
          completedAt: Number.isFinite(Number(t.completedAt)) ? Number(t.completedAt) : null,
          src: 'local',
          lastRemindedAt: Number(t.lastRemindedAt) || null,
        })
      }
      return out
    }
    function saveTodos(list) {
      // 已完成的只留最近 TODO_DONE_KEEP 条：未完成的一条不能丢
      const done = list.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
      const keep = new Set(done.slice(0, TODO_DONE_KEEP).map((t) => t.id))
      const pruned = list.filter((t) => !t.done || keep.has(t.id))
      writeJsonAtomic(todoFile(), { version: 1, todos: pruned })
      return pruned
    }
    /** 排序：未完成在前（到期近的靠前、无期限垫底），已完成按完成时间倒序。 */
    function sortTodos(list) {
      return [...list].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1
        if (a.done) return (b.completedAt || 0) - (a.completedAt || 0)
        const ad = a.dueAt ?? Infinity
        const bd = b.dueAt ?? Infinity
        if (ad !== bd) return ad - bd
        return (a.createdAt || 0) - (b.createdAt || 0)
      })
    }
    let todoSeq = 0
    function todoId() {
      // 时间戳 + 进程内序号：重启后时间戳变了，旧 id 不会撞
      todoSeq += 1
      return 't' + Date.now().toString(36) + todoSeq.toString(36)
    }
    /** DSH 会话事件里的待办（只读镜面）：id 前缀 dsh: 以免和本地条目撞。 */
    const dshTodos = new Map() // id → item
    function ingestDshTodos(rawList) {
      if (!Array.isArray(rawList)) return
      dshTodos.clear()
      rawList.forEach((t, i) => {
        const text = String(t?.content || t?.text || '').trim()
        if (!text) return
        const status = String(t?.status || '')
        const id = 'dsh:' + (String(t?.id || '').trim() || String(i))
        dshTodos.set(id, {
          id, text: text.slice(0, TODO_TEXT_MAX),
          dueAt: null, done: status === 'completed' || status === 'done',
          createdAt: 0, updatedAt: Date.now(), completedAt: null,
          src: 'dsh', status, lastRemindedAt: null,
        })
      })
    }
    /** 合并视图：DSH 镜面在前，本地自记在后。 */
    function todoView() {
      const local = loadTodos()
      return sortTodos([...dshTodos.values(), ...local])
    }
    /** 只数「本地 + 未完成」的条目给计数用（镜面随会话变，不该算进自己的账）。 */
    function todoPending() {
      const local = loadTodos().filter((t) => !t.done).length
      const dsh = [...dshTodos.values()].filter((t) => !t.done).length
      return { local, dsh, total: local + dsh }
    }
    // ---- 到点提醒节奏（照搬 dsh-pet 的 policy：到期越近提醒越勤） ----
    const TODO_MIN = 60_000
    const TODO_HOUR = 60 * TODO_MIN
    const TODO_DAY = 24 * TODO_HOUR
    /** 距到期还剩多久 → 多久提醒一次（从宽到窄匹配）。 */
    function todoRemindInterval(remaining) {
      if (remaining <= 0) {
        const late = -remaining
        if (late >= 7 * TODO_DAY) return Infinity  // 逾期一周以上就别念了，留在清单里自己处理
        return late >= TODO_DAY ? 6 * TODO_HOUR : 30 * TODO_MIN
      }
      if (remaining > 7 * TODO_DAY) return Infinity // 远期事项不值得天天念
      const steps = [[3 * TODO_DAY, TODO_DAY], [TODO_DAY, 12 * TODO_HOUR], [6 * TODO_HOUR, 4 * TODO_HOUR], [TODO_HOUR, TODO_HOUR], [15 * TODO_MIN, 20 * TODO_MIN], [0, 5 * TODO_MIN]]
      for (const [min, gap] of steps) if (remaining >= min) return gap
      return 5 * TODO_MIN
    }
    /** 这一条下一次该在什么时候提醒；返回 null = 不再提醒。 */
    function todoNextRemindAt(t, now) {
      if (t.done || t.dueAt === null || t.src === 'dsh') return null
      const gap = todoRemindInterval(t.dueAt - now)
      if (!Number.isFinite(gap)) return null
      if (t.lastRemindedAt) return t.lastRemindedAt + gap
      const leftAtCreate = t.dueAt - t.createdAt
      if (leftAtCreate > 7 * TODO_DAY) return t.createdAt + gap
      const gapAtCreate = todoRemindInterval(leftAtCreate)
      const step = Math.min(Number.isFinite(gapAtCreate) ? gapAtCreate : 0, Math.max(0, leftAtCreate))
      return t.createdAt + step
    }
    /** 把毫秒差说成人话。 */
    function todoSpan(ms) {
      const m = Math.max(1, Math.round(Math.abs(ms) / TODO_MIN))
      if (m < 60) return m + '分钟'
      const h = Math.max(1, Math.round(m / 60))
      return h < 24 ? h + '小时' : Math.max(1, Math.round(h / 24)) + '天'
    }
    /** 一条到点的提醒文案。 */
    function todoReminderText(t, now) {
      const chars = Array.from(t.text)
      const label = chars.length <= 18 ? t.text : chars.slice(0, 18).join('') + '…'
      const due = t.dueAt ?? now
      if (due <= now) {
        if (now - due < TODO_MIN) return `「${label}」到点啦，记得处理`
        return `「${label}」已经逾期${todoSpan(now - due)}啦，记得处理`
      }
      return `「${label}」还有${todoSpan(due - now)}就到点啦`
    }
    /** 提醒巡检：一拍最多提醒一条（更急的优先），提醒过就写回 lastRemindedAt。 */
    async function todoTick() {
      if (api.settings().petTodoEnabled === false) return
      if (!online().online) return          // 桌宠没开就不必攒提醒，到点留在清单里
      const now = Date.now()
      const local = loadTodos()
      let best = null
      for (const t of local) {
        const at = todoNextRemindAt(t, now)
        if (at === null || at > now) continue
        if (!best || at < best.at || (at === best.at && (t.dueAt ?? Infinity) < (best.t.dueAt ?? Infinity))) best = { t, at }
      }
      if (!best) return
      const next = local.map((t) => (t.id === best.t.id ? { ...t, lastRemindedAt: now } : t))
      saveTodos(next)
      try {
        await dispatch({ text: todoReminderText(best.t, now), purpose: 'todo', via: 'pet', noFallback: true })
      } catch (error) { api.log.warn('待办提醒推送失败：', String(error?.message || error)) }
    }
    // 一拍最多一条：每分钟看一次就够（最密的档位是 5 分钟）。定时器在末尾和其他 tick 一起注册。

    // ================= 干活状态（DSH 会话事件 → 动画 / 结束提醒） =================
    // 订阅在 host.js（ctx.on('session/event') 已经有一条订阅了），转发到这里：
    //   api.use('pet').onSessionEvent(session, event) → 聚合出「当前她在干什么」→ emit('work')
    // 纯监听、不调模型；状态无变化不重复 emit（防刷屏）。档位与 dsh-pet 一致：
    //   thinking（思考中）/ working（干活中）/ result（出结果）/ waiting（等你确认）/ success / error
    const WORK_TTL_TERMINAL = 60_000   // 完成/出错只展示 60 秒，过期自然回空闲
    // 中途静默多久算「这轮已经没了」。原来是 10 分钟——期间客户端会一直循环重播干活动画，
    // 视觉上就是卡住+闪。DSH 正常干活时 tool/call 很密（几秒一次），3 分钟没有新事件
    // 基本可以判定回合已断（重启/被打断丢了 turn/end），所以收到 3 分钟。
    const WORK_TTL_ACTIVE = 3 * MIN_MS
    const WORK_PRIORITY = { waiting: 60, error: 50, working: 40, thinking: 30, result: 25, success: 20 }
    const workMap = new Map() // sessionId → { state, task, at, seq }
    let workSeq = 0
    let workSnap = { state: null, task: '', at: 0 }
    const WORK_STATE_LABEL = { thinking: '思考中', working: '干活中', result: '出结果了', waiting: '等你确认', success: '忙完了', error: '出错了' }

    /** 展示快照：所有会话里优先级最高的那条（同优先级取最近更新），任务文案与状态同源。 */
    function workSnapshot() {
      const now = Date.now()
      let best = null
      for (const [sid, e] of workMap) {
        const ttl = e.state === 'success' || e.state === 'error' ? WORK_TTL_TERMINAL : WORK_TTL_ACTIVE
        if (now - e.at > ttl) { workMap.delete(sid); continue }
        if (!best || WORK_PRIORITY[e.state] > WORK_PRIORITY[best.state] || (WORK_PRIORITY[e.state] === WORK_PRIORITY[best.state] && e.seq > best.seq)) best = e
      }
      const next = { state: best ? best.state : null, task: best ? best.task : '', at: best ? best.at : 0 }
      const stateChanged = next.state !== workSnap.state
      workSnap = { ...next, at: next.at || Date.now() }
      // 只在「档位」变化时推事件：任务文案变了（todo/write）不需要客户端重播动画
      if (stateChanged) emit('work', { ...workSnap, label: WORK_STATE_LABEL[workSnap.state] || '', text: workEndText(workSnap), bubble: workSettings().bubble, notify: workSettings().notify })
      return workSnap
    }
    // 定时自愈：workMap 的 TTL 只在「有事件进来」时才会被检查。
    // DSH 静默（回合被打断 / 重启丢了 turn/end）时快照会永远停在 working，
    // 客户端就一直循环重播干活动画——看起来既像「卡住」又像「一直在闪」。
    // 这里每 30 秒主动清一次过期档位，空闲了就把快照推回 null（客户端收到会回 idle）。
    function workSweep() {
      if (!workMap.size) return
      const now = Date.now()
      let dropped = false
      for (const [sid, e] of workMap) {
        const ttl = e.state === 'success' || e.state === 'error' ? WORK_TTL_TERMINAL : WORK_TTL_ACTIVE
        if (now - e.at > ttl) { workMap.delete(sid); dropped = true }
      }
      if (dropped) workSnapshot()
    }
    function workSettings() {
      const s = api.settings()
      return { enabled: s.workStatusEnabled !== false, bubble: s.workBubble !== false, notify: s.workNotify !== false }
    }
    /** 收尾那一句（只在 success/error 用；其它档位返回空串）。 */
    function workEndText(snap) {
      if (!snap || (snap.state !== 'success' && snap.state !== 'error')) return ''
      const task = String(snap.task || '').slice(0, 30)
      if (snap.state === 'success') return task ? `「${task}」搞定啦！` : '搞定啦，收工～'
      return task ? `「${task}」卡住了…` : '唔…这次没弄成。'
    }
    /** 一条 DSH 会话事件 → 更新该会话档位/任务文案（host.js 转发；子代理不参与，免得多路一起闪）。 */
    function onSessionEvent(session, event) {
      const w = workSettings()
      const type = String(event?.type || '')
      if (!type) return
      const header = session && typeof session.header === 'object' ? session.header : null
      if (header && (header.origin === 'subagent' || Number(header.delegationDepth) > 0)) return
      const sid = String((header && header.id) || session?.id || 'unknown')
      const prev = workMap.get(sid)
      const set = (state, task) => {
        const entry = { state, task: task === undefined ? (prev?.task || '') : task, at: Date.now(), seq: ++workSeq }
        workMap.set(sid, entry)
        workSnapshot()
      }
      if (type === 'todo/write') {
        // 待办面板的只读镜面：DSH 自己（或本回合的模型）写的清单同步一份过来。
        // 这里**不** gate 在 prev 上——面板要能看到清单，哪怕这个会话早就空闲了。
        try { ingestDshTodos(event?.data?.todos); emit('todo', { pending: todoPending() }) } catch {}
        // 任务文案只更新已有活动的会话（空闲会话写了也不会被展示，避免幽灵文案）
        if (!prev) return
        const todos = Array.isArray(event?.data?.todos) ? event.data.todos : []
        let cur = null
        for (const t of todos) if (t?.status === 'in_progress') cur = t
        if (!cur) cur = todos.find((t) => t?.status === 'pending')
        const text = String(cur?.content || '').trim().slice(0, 40)
        set(prev.state, text)
        return
      }
      if (type === 'turn/start') return set('thinking', '')
      if (type === 'tool/call') return set(String(event?.data?.name || '') === 'ask_user_question' ? 'waiting' : 'working')
      if (type === 'tool/result') return set('result', prev?.task || '')
      if (type === 'approval/asked') return set('waiting')
      if (type === 'turn/end') {
        const kind = String(event?.data?.reason?.kind || '')
        if (!w.enabled) { workMap.delete(sid); workSnapshot(); return }
        if (kind === 'completed') return set('success', prev?.task || '')
        if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return set('error', prev?.task || '')
        if (kind === 'blocked') return set('waiting', prev?.task || '')
        workMap.delete(sid) // aborted 等：清掉，别卡在干活中
        workSnapshot()
      }
    }

    // ================= 碎碎念（桌宠自己的气泡流） =================
    // 和「主动搭话」彻底分开：主动搭话是 purpose 引擎按目的找人（载体 QQ / 桌宠二选一），
    // 碎碎念是桌宠自己的小动作——**载体选 QQ 时也照常生效**，只出现在气泡里，永远不发 QQ。
    const WHISPER_POOL = [
      '（趴在屏幕边上发呆）', '今天也一起加油吧…', '唔…要不要摸摸我？', '盯——（一直看着你）',
      '我在这儿呢。', '呼…（打了个哈欠）', '这个屏幕好亮呀。', '有点想吃小鱼干…',
      '（尾巴轻轻拍了两下桌面）', '你忙你的，我自己玩。', '刚刚是不是有只蚊子飞过去？', '（认真地擦桌子）',
      '安静得能听见风扇转…', '（对着屏幕碎碎念）', '偷偷伸个懒腰～', '嗯…今天天气不错。',
    ]
    const WHISPER_AFTER_PROACTIVE_MS = 20 * MIN_MS // 刚弹过主动气泡：碎碎念让位，别连着说（间隔调得很短时按最短间隔算）
    // 四个回合共用一个后台会话、一个标题：工作区里只有一条「QQ · 桌宠」。
    // （原来是「桌宠 · 碎碎念（自己的回合）」这类长标题，每类回合还各开一条会话）
    const WHISPER_TURN_TITLE = '桌宠'
    // 桌宠自己的几个回合（碎碎念 / 行为大脑 / 聊天联动 / 对话框）共用一个后台会话，
    // 工作区里只留一个「桌宠」窗口，不再每类回合各开一条。
    const PET_SESSION_KEY = 'pet'
    const whisperFile = () => api.dataDir('whisper.json')
    let whisperBusy = false // 正在工作区里"想"这一句（后台系统回合不允许并发）
    function whisperSettings() {
      const s = api.settings()
      const clamp = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d }
      const minMinutes = clamp(s.whisperMinMinutes, 45, 1, 9999) // 面板口径：最短 1 分钟、最长 9999 分钟
      return {
        enabled: s.whisperEnabled !== false,
        source: s.whisperSource === 'pool' ? 'pool' : 'model',
        minMinutes,
        maxMinutes: Math.max(minMinutes, clamp(s.whisperMaxMinutes, 120, 1, 9999)),
        maxPerDay: clamp(s.whisperMaxPerDay, 6, 0, 9999),
        pauseOnPetCarrier: s.whisperPauseOnPetCarrier !== false,
        lines: String(s.whisperLines || '').split(/[\n\r]+/).map((x) => x.trim()).filter(Boolean).slice(0, 80),
      }
    }
    const dayKey = (now = Date.now()) => new Date(now).toDateString()
    function loadWhisper(now = Date.now()) {
      const raw = readJson(whisperFile(), null)
      const st = raw && typeof raw === 'object' ? { ...raw } : {}
      if (st.day !== dayKey(now)) { st.day = dayKey(now); st.count = 0; st.nextAt = 0 }
      st.count = Math.max(0, Math.round(Number(st.count) || 0))
      st.nextAt = Number(st.nextAt) || 0
      st.lastAt = Number(st.lastAt) || 0
      st.lastText = String(st.lastText || '')
      st.recent = Array.isArray(st.recent) ? st.recent.filter((x) => typeof x === 'string').slice(-8) : []
      return st
    }
    const saveWhisper = (st) => { try { writeJsonAtomic(whisperFile(), st) } catch (e) { api.log.warn(`碎碎念状态写盘失败：${e.message}`) } }
    // 多开：每只额外宠物一份自己的排程/计数（whisper-extra-0..3.json）。
    // 为什么不共用一份：共用就会「第一只说完，另外三只今天都没额度了」，
    // 而且 nextAt 只有一个，四只永远只会有一只开口。
    const whisperExtraFile = (slot) => api.dataDir(`whisper-extra-${Math.max(0, Math.min(EXTRA_MAX - 1, Math.round(Number(slot) || 0)))}.json`)
    function loadWhisperExtra(slot, now = Date.now()) {
      const raw = readJson(whisperExtraFile(slot), null)
      const st = raw && typeof raw === 'object' ? { ...raw } : {}
      if (st.day !== dayKey(now)) { st.day = dayKey(now); st.count = 0; st.nextAt = 0 }
      st.count = Math.max(0, Math.round(Number(st.count) || 0))
      st.nextAt = Number(st.nextAt) || 0
      st.lastAt = Number(st.lastAt) || 0
      st.lastText = String(st.lastText || '')
      st.recent = Array.isArray(st.recent) ? st.recent.filter((x) => typeof x === 'string').slice(-8) : []
      return st
    }
    const saveWhisperExtra = (slot, st) => { try { writeJsonAtomic(whisperExtraFile(slot), st) } catch (e) { api.log.warn(`额外桌宠碎碎念状态写盘失败：${e.message}`) } }
    /** 醒着窗口（沿用「主动搭话」的 awakeFrom~awakeTo，不再造第二套真相）。 */
    function awakeWindow() {
      const su = api.config().speakUp || {}
      const from = Number.isFinite(su.awakeFrom) ? su.awakeFrom : 8
      const to = Number.isFinite(su.awakeTo) ? su.awakeTo : 23
      return { from, to }
    }
    function inQuietHours(now = Date.now()) {
      const { from, to } = awakeWindow()
      if (to >= 24 || from >= to) return false // 全天醒着 = 没有安静时段
      const d = new Date(now)
      const hour = d.getHours() + d.getMinutes() / 60
      return hour < from || hour >= to
    }
    /** 下一个「醒着」的起点：现在还在安静时段就等到醒着时间。 */
    function quietEndAfter(now = Date.now()) {
      const { from } = awakeWindow()
      const d = new Date(now)
      if (d.getHours() + d.getMinutes() / 60 < from) { d.setHours(from, 0, 0, 0); return d.getTime() }
      d.setDate(d.getDate() + 1)
      d.setHours(from, 0, 0, 0)
      return d.getTime()
    }
    function planWhisper(st, w, now = Date.now()) {
      const span = Math.max(1, w.maxMinutes - w.minMinutes)
      let at = now + (w.minMinutes + Math.round(Math.random() * span)) * MIN_MS
      if (inQuietHours(at)) at = quietEndAfter(at)
      st.nextAt = at
      return at
    }
    /** 「目的引擎」的真实载体真相（ext.purpose.carrier；pet settings 面只是镜像，可能过期）。 */
    function purposeCarrier() {
      const ext = (api.config().ext || {}).purpose
      if (ext && (ext.carrier === 'pet' || ext.carrier === 'qq')) return ext.carrier
      return api.settings().carrier === 'pet' ? 'pet' : 'qq'
    }
    /** 最近一次**某只**宠物的气泡时间（不含碎碎念/测试），用来避免同一只的两种气泡贴在一起。
     *  petId 省略 = 主宠物。多开之后这条必须是「按只」的：否则四只会互相抢同一条时间线。 */
    function lastOtherBubbleAt(petId = 'main') {
      for (let i = delivered.length - 1; i >= 0; i--) {
        const it = delivered[i]
        if ((it.petId || 'main') !== petId) continue
        const p = it.purpose
        if (p === 'whisper' || p === 'test') continue
        return it.at || 0
      }
      return 0
    }
    /** 碎碎念动画：优先用这只宠物自己那个形象包里的「碎碎念」段。
     *  传 packName 是为了多开时别拿主宠物的素材 id 去点额外那只的动画（两个包的 id 空间不同）。 */
    function pickWhisperAnim(packName = '') {
      try {
        const view = packView(packName || undefined)
        const pool = (view && Array.isArray(view.whisperAnims) && view.whisperAnims) || []
        return pool.length ? pool[Math.floor(Math.random() * pool.length)] : ''
      } catch { return '' }
    }
    /** 本地文案池：优先用户在面板里写的，其次内置。 */
    function poolLine(w, st) {
      const pool = w.lines.length ? w.lines : WHISPER_POOL
      const fresh = pool.filter((x) => !st.recent.includes(x))
      const list = fresh.length ? fresh : pool
      return list[Math.floor(Math.random() * list.length)] || ''
    }
    const cleanWhisper = (raw) => {
      let s = String(raw ?? '')
      // 模型爱在正文前后加备忘段（【思考】/【记忆】/【状态】…）：正文后面的一律丢掉（内部备忘不上气泡），
      // 开头那一行备忘只丢这一行、正文留着（她有时先把"想到什么"写出来再说话）
      const MEMO = /^[ \t]*[*_#>\-\s]*[【\[]\s*(目的|需求|情绪|情绪值|类型|状态|记忆|思考|动作|备注|待续)\s*[】\]]/
      let lines = s.split(/\r?\n/)
      const at = lines.findIndex((l) => MEMO.test(l))
      if (at === 0) lines = lines.slice(1)
      else if (at > 0) lines = lines.slice(0, at)
      s = lines.join('\n').trim()
      s = s.replace(/^[「“"'']+/, '').replace(/[」”"'']+$/, '')
      s = s.replace(/^大肥鱼\s*[:：]\s*/, '')
      s = s.split('\n').map((x) => x.trim()).find(Boolean) || ''
      s = s.replace(/^[「“"'']+/, '').replace(/[」”"'']+$/, '')
      if (!s || /^[[（(【]?\s*(沉默|跳过|不想说)\s*[\]）)】]?$/.test(s)) return ''
      return s.slice(0, 60)
    }
    /**
     * 从记忆库取几条「这会儿可能会想起来的」事：先按当前在忙的事检索，检索不到就按重要度取。
     * 和主动搭话共用同一份记忆库（api.use('memory')），只是这边要得更少、更轻。
     */
    function memoryLines(limit = 8) {
      let mem = null
      try { mem = api.use('memory') } catch { mem = null }
      if (!mem || typeof mem.list !== 'function') return []
      const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
      let items = []
      try {
        const q = String(workSnap.task || '').trim()
        if (q) items = mem.list(q) || []
        if (!items.length) items = mem.list('') || []
      } catch { items = [] }
      const seen = new Set()
      return items
        .filter((m) => m && m.text && !m.invalidAt)
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)
          || (Number(b.importance) || 0) - (Number(a.importance) || 0)
          || (Number(b.at) || 0) - (Number(a.at) || 0))
        .map((m) => clip(m.text, 100))
        .filter((t) => (seen.has(t) ? false : (seen.add(t), true)))
        .slice(0, limit)
    }
    /** 碎碎念的提示词：人格 + 记忆 + 当下状态（DSH 干活状态/时段/心情/最近说过）——不是聊天回复，是自言自语。
     *  personaOverride：多开时那一只自己绑的人格（空 = 回落全局人格，dsh-pet 的 pets[].whisperPrompt 同义）。
     *  label：气泡宿主自称（默认「大肥鱼」，额外那几只用自己的名字，免得四只都说自己是同一个）。 */
    function whisperPrompt(w, st, personaOverride = '', label = '大肥鱼') {
      let persona = String(personaOverride || '').trim()
      if (!persona) {
        try { persona = api.core?.personas?.current?.() || '' } catch {}
      }
      const snap = workSnap
      const busy = snap.state
        ? `宿主现在：${WORK_STATE_LABEL[snap.state] || snap.state}${snap.task ? '（' + snap.task + '）' : ''}`
        : '宿主现在：空闲（没在干活，可能在自己玩或不在电脑前）'
      const mem = memoryLines()
      const hh = new Date().getHours()
      const part = hh < 6 ? '凌晨' : hh < 11 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜'
      const memes = memeCatalogBlock()
      return [
        '（这一轮没有人跟你说话。你在自己的桌面角落自言自语，不是在回复消息，也不是主动搭话找人聊天。）',
        persona ? `【你的人格设定】\n${String(persona).slice(0, 1200)}` : '',
        `【你是一只待在主人电脑桌面角落的小桌宠（${label}）】`,
        mem.length ? `【你记得的事】\n${mem.map((t) => '- ' + t).join('\n')}` : '【你记得的事】（记忆库还很空）',
        `【现在】\n${busy}\n时段：${part}。心情：${moodNow()}。${weatherLine()}`,
        // 数值情境（饱腹 / 精力 / 亲密度）：学 Astra Pet 的 design/pet-life/06 §4.1。
        // 写成「档位 + 括号里的数字」，并且明说一次对话最多提一次 —— 不然她每轮都要吃的。
        lifeContextLine(),
        memes,
        st.recent.length ? `【你最近已经嘟囔过】\n${st.recent.slice(-3).map((x) => '「' + x + '」').join('、')}（不要重复这些话）` : '',
        [
          '【怎么写这一句】',
          '1) 只输出一句 20 字以内的自言自语，可以带一点括号里的动作（比如（打了个哈欠））；',
          '2) 可以轻轻想起上面某件你记得的事——一句带过，像忽然想起来，不要复述整件事、不要汇报；',
          '3) 不提问、不叫主人、不像通知或总结、不解释、不加引号、不加名字前缀；',
          '4) 这一轮不能用任何工具，直接输出那句话。实在不想说就整段只输出 [沉默]。',
          memes ? '5) 想配张图就在整句最后加上 [图:图片名]（名字严格从上面清单里挑，一个字都不能改）；不配就不加。' : '',
        ].filter(Boolean).join('\n'),
      ].filter(Boolean).join('\n')
    }
    /** 梗图清单渲染成提示词一段；没有梗图返回空串。 */
    function memeCatalogBlock() {
      try {
        if (api.settings().memeBubble === false) return ''
        const list = memeCatalog()
        if (!list.length) return ''
        const lines = list.slice(0, 30).map((m) => `- ${m.name}：${m.desc}`)
        return ['【你能配的梗图】', ...lines].join('\n')
      } catch {
        return ''
      }
    }
    /**
     * 让她自己想一句。走「主动搭话」同款的后台系统回合（hub.runSystemTurn，noTools）：
     * 工作区里那条「QQ · 桌宠」的会话里能看到她怎么想的（和碎碎念 / 行为大脑 / 对话框共用一个会话）
     * ——机制一样，但这条跟目的机制无关：不选目的、不算次数、不投递 QQ。
     */
    async function askWhisper(w, st, opt = {}) {
      const prompt = whisperPrompt(w, st, opt.persona || '', opt.label || '大肥鱼')
      try {
        if (typeof api.think === 'function') {
          return cleanWhisper(await api.think(prompt, { title: WHISPER_TURN_TITLE, timeoutMs: 120_000, noTools: true, key: PET_SESSION_KEY }))
        }
        if (typeof api.ask === 'function') { // 老宿主没有 api.think：退回单次问答（工作区看不到思考）
          return cleanWhisper(await api.ask({ text: prompt, maxTokens: 200, temperature: 0.95 }))
        }
        return ''
      } catch (error) {
        api.log.debug?.('碎碎念生成失败，回落本地文案：', String(error?.message || error))
        return ''
      }
    }
    /**
     * 碎碎念一次。force=true（面板/右键手动）跳过排程与开关，但仍尊重专注模式与载体暂停。
     * opt.slot：多开时让「第几只」说这句（null = 主宠物）。额外那几只各有一份独立的排程文件
     * （whisper-extra-<n>.json）与独立的人格，互不占额度、互不踩 nextAt。
     * @returns {Promise<{ok:boolean, reason?:string, via?:'pet', text?:string, nextAt?:number}>}
     */
    async function whisperOnce({ force = false, text = '', reason = 'timed' } = {}, opt = {}) {
      const isExtra = opt.slot !== null && opt.slot !== undefined
      const slot = isExtra ? Math.max(0, Math.min(EXTRA_MAX - 1, Math.round(Number(opt.slot)))) : null
      const w = whisperSettings()
      if (!force && !w.enabled) return { ok: false, reason: 'disabled' }
      if (api.config().enabled === false) return { ok: false, reason: 'plugin-off' }
      if (focusOn()) return { ok: false, reason: 'focus' }
      if (!online().online) return { ok: false, reason: 'pet-offline' } // 碎碎念只上桌宠：离线就静默，绝不回落 QQ（force 也一样）
      const st = isExtra ? loadWhisperExtra(slot) : loadWhisper()
      // 间隔可以调到 1 分钟，但一轮"想"要几十秒：上一轮还没想完就别再排一轮（后台会话不允许并发）
      // 额外那几只共用同一个后台会话，所以「忙」是全局的（whisperBusy），不能各判各的。
      if (whisperBusy) return { ok: false, reason: 'thinking' }
      const giveWayMs = Math.min(WHISPER_AFTER_PROACTIVE_MS, Math.max(MIN_MS, w.minMinutes * MIN_MS))
      const deferMs = Math.min(3 * MIN_MS, Math.max(MIN_MS, w.minMinutes * MIN_MS))
      const save = () => (isExtra ? saveWhisperExtra(slot, st) : saveWhisper(st))
      if (!force) {
        // 额外那几只**不看**载体暂停：暂停的理由是「主动搭话也在冒气泡，别撞车」，
        // 而额外那几只根本不参与主动搭话（dispatch 里 slot 分支不回落 QQ），没有撞车可言。
        if (!isExtra && w.pauseOnPetCarrier && purposeCarrier() === 'pet') return { ok: false, reason: 'carrier-pet' }
        if (inQuietHours()) { st.nextAt = quietEndAfter(); save(); return { ok: false, reason: 'quiet', nextAt: st.nextAt } }
        if (st.count >= w.maxPerDay) { st.nextAt = quietEndAfter(Date.now() + 12 * 60 * MIN_MS); save(); return { ok: false, reason: 'daily-max' } }
        if (!st.nextAt) { planWhisper(st, w); save(); return { ok: false, reason: 'scheduled', nextAt: st.nextAt } } // 首次/跨天：先排下一次，别一启动就说话
        if (Date.now() < st.nextAt) return { ok: false, reason: 'not-due', nextAt: st.nextAt }
        // 让位判据按「同一只」算：主宠物刚说过不该连累额外那几只，反之亦然。
        if (Date.now() - lastOtherBubbleAt(isExtra ? `pet-${slot + 1}` : 'main') < giveWayMs) { planWhisper(st, w); save(); return { ok: false, reason: 'recent-proactive', nextAt: st.nextAt } }
        if (workSnap.state && workSettings().enabled) { st.nextAt = Date.now() + deferMs; save(); return { ok: false, reason: 'busy', nextAt: st.nextAt } } // 正在干活：别打断
      }
      let line = cleanWhisper(text)
      if (!line && w.source === 'model') {
        whisperBusy = true
        try { line = await askWhisper(w, st, { persona: opt.persona || '', label: opt.label || '大肥鱼' }) } finally { whisperBusy = false }
      }
      if (!line) line = cleanWhisper(poolLine(w, st))
      if (!line) return { ok: false, reason: 'empty' }
      const r = await dispatch({ text: line, modality: 'text', purpose: 'whisper', via: 'pet', anim: pickWhisperAnim(opt.pack || ''), noFallback: true, slot })
      if (!r || !r.ok) {
        // 专注/离线/载体等拒绝：按原样回报，别把次数算掉
        if (!force) { planWhisper(st, w); save() }
        return { ok: false, reason: (r && r.reason) || 'dispatch-failed' }
      }
      st.count += 1
      st.lastAt = Date.now()
      st.lastText = line
      st.recent = [...st.recent, line].slice(-8)
      planWhisper(st, w)
      save()
      api.log.info(`碎碎念（${reason}${isExtra ? '@pet-' + (slot + 1) : ''}${opt.name ? ' ' + opt.name : ''}）：${line}`)
      return { ok: true, via: 'pet', text: line, nextAt: st.nextAt, today: st.count }
    }
    async function whisperTick() {
      try {
        // 主宠物先说，然后额外那几只各按自己的排程走一轮。
        // 顺序执行（不是并发）：它们共用一个后台会话，并发的第二轮会被 whisperBusy 挡掉、
        // 还会各浪费一次排程。一只一轮最坏几百毫秒的模型调用，一分钟一次完全够。
        await whisperOnce()
        for (const it of extraWhisperSlots()) {
          try { await whisperOnce({ reason: 'timed' }, it) } catch (e) { api.log.debug(`额外桌宠碎碎念失败：${e.message}`) }
        }
      } catch (error) { api.log.warn('碎碎念出错：', String(error?.message || error)) }
    }
    /** 这一轮该轮到哪几只额外宠物：关掉「自己说话」的、没开着的都不排队。 */
    function extraWhisperSlots() {
      const slots = loadExtraPets()
      const want = Math.max(0, Math.min(EXTRA_MAX, Math.round(Number(api.settings().petExtraCount) || 0)))
      const out = []
      for (let i = 0; i < want; i++) {
        const it = slots[i]
        if (it && it.whisper === false) continue
        out.push({
          slot: i,
          persona: it ? it.persona : '',
          label: extraNameOf(it, i),
          name: it ? it.name : '',
          pack: extraPackOf(it),
        })
      }
      return out
    }

    // ================= 说梦话（从 dsh-pet 搬来） =================
    // 睡觉模块正在睡的时候，隔一阵子在气泡里嘟囔一句梦话（不打字、不发 QQ、不播动画）。
    // 睡着判定问 sleep 模块要：sleptAt 有值且还没到醒来的点。
    const DREAM_TALK_MIN_MS = 8 * MIN_MS
    const DREAM_TALK_MAX_MS = 25 * MIN_MS
    let dreamTalkBusy = false
    function sleepStateOf() {
      try {
        const s = api.use('sleep')
        if (!s || typeof s.state !== 'function') return null
        const st = s.state() || {}
        const now = Date.now()
        if (!st.sleptAt) return null
        if (st.wokeAt && now >= st.wokeAt) return null
        return st
      } catch {
        return null
      }
    }
    function dreamTalkFile() { return api.dataDir('dream-talk.json') }
    function loadDreamTalk() {
      try { return JSON.parse(readFileSync(dreamTalkFile(), 'utf8')) || {} } catch { return {} }
    }
    function saveDreamTalk(v) {
      try { writeFileSync(dreamTalkFile(), JSON.stringify(v, null, 2), 'utf8') } catch {}
    }
    function dreamTalkPrompt(st) {
      let persona = ''
      try { persona = api.core?.personas?.current?.() || '' } catch {}
      const frag = Array.isArray(st.frags) && st.frags.length ? st.frags.slice(0, 5).join('\n') : ''
      return [
        '（你在睡觉，正在做梦。这一轮没人在叫你，你只是在梦里嘟囔一句梦话。）',
        persona ? `【你的人格设定】\n${String(persona).slice(0, 600)}` : '',
        frag ? `【梦里的碎片】\n${frag}` : '',
        [
          '【要求】',
          '1) 只输出一句 15 字以内的梦话，含含糊糊、断断续续，像没睡醒；',
          '2) 可以只有半句、可以叫一个名字、可以说一个画面，不要完整句子；',
          '3) 不加引号、不加名字前缀、不解释、不提「梦」「睡觉」这些词；',
          '4) 实在没得说就整段只输出 [沉默]。',
        ].join('\n'),
      ].filter(Boolean).join('\n')
    }
    async function dreamTalkTick() {
      if (dreamTalkBusy) return
      if (api.settings().dreamTalk === false) return
      const st = sleepStateOf()
      if (!st) return
      const cfg = loadDreamTalk()
      if (cfg.nextAt && Date.now() < cfg.nextAt) return
      dreamTalkBusy = true
      try {
        let text = ''
        try {
          if (typeof api.think === 'function') {
            text = cleanWhisper(await api.think(dreamTalkPrompt(st), { title: PET_SESSION_KEY === 'pet' ? '桌宠' : '桌宠', timeoutMs: 90_000, noTools: true, key: PET_SESSION_KEY }))
          } else if (typeof api.ask === 'function') {
            text = cleanWhisper(await api.ask({ text: dreamTalkPrompt(st), maxTokens: 120, temperature: 0.95 }))
          }
        } catch (error) {
          api.log.debug?.('说梦话失败：', String(error?.message || error))
        }
        const gap = DREAM_TALK_MIN_MS + Math.floor(Math.random() * (DREAM_TALK_MAX_MS - DREAM_TALK_MIN_MS))
        const next = loadDreamTalk()
        next.nextAt = Date.now() + gap
        if (text && !/^\[沉默\]$/.test(text)) {
          next.lastText = text
          next.lastAt = Date.now()
          saveDreamTalk(next)
          try { dispatch({ text, modality: 'text', purpose: 'dreamTalk', force: true }) } catch (error) {
            api.log.debug?.('梦话投递失败：', String(error?.message || error))
          }
        } else {
          saveDreamTalk(next)
        }
      } finally {
        dreamTalkBusy = false
      }
    }
    function whisperStatus() {
      const w = whisperSettings()
      const st = loadWhisper()
      return {
        enabled: w.enabled, source: w.source, minMinutes: w.minMinutes, maxMinutes: w.maxMinutes,
        maxPerDay: w.maxPerDay, pauseOnPetCarrier: w.pauseOnPetCarrier, lines: w.lines.join('\n'),
        today: st.count, lastAt: st.lastAt, lastText: st.lastText, nextAt: st.nextAt,
        online: online().online, carrier: purposeCarrier(), busy: workSnap.state || '',
        thinking: whisperBusy, turnTitle: WHISPER_TURN_TITLE, // 正在工作区那条会话里想这句
      }
    }

    // ================= AI 行为大脑（决策层） =================
    // 铁律 1：动作清单是硬编码枚举，AI 只能从清单里选、按参数格式填；
    // 解析失败 / 选了不存在的动作 / 选了暂未开放的动作 → 一律丢弃，回退本地默认行为。
    // 第一批开放 8 个动作；第二批放开 drag_icon / hide_icon（隐藏走服务端隔离区，铁律 2：只 rename、可归还）；
    // 第三批放开 nudge_window / close_window（铁律 3：关窗只发 WM_CLOSE，绝不 taskkill）。
    // 2026-10-30 用户裁撤：peek_window（探头）已删除。
    // say = 这个动作的**默认台词**：主人点「试一下」时 AI 不会给 say，没有它桌上就只是默默动一下，
    // 主人根本不知道她在干嘛。AI 自己给的 say 优先，没给才用这里的兜底。
    // （`say` 动作的默认台词留空——它自己会拿 params.text 弹气泡。）
    const BEHAVIOR_ACTIONS = [
      { action: 'chase_cursor', desc: '扑过去追主人的鼠标指针，追到后把指针按住 5 秒再松开（最雀跃）', params: '无参数 {}', say: '（扑过去追你的鼠标！）' },
      { action: 'wander', desc: '自己溜达到屏幕另一头', params: '无参数 {}', say: '（去那边看看）' },
      { action: 'idle_anim', desc: '自己找点事做：随便播一段小动作（摇尾巴、眨眼这类），不移动', params: '无参数 {}', say: '（自己找点事做）' },
      { action: 'steal_cursor', desc: '叼鼠标：快速冲到鼠标位置叼住，带着鼠标一起同步移动一段再松口（闹脾气才用）', params: '可选 {"x":落点屏幕横坐标,"y":落点纵坐标}，不填就每次随机一个位置', say: '（叼走你的鼠标）' },
      { action: 'drag_icon', desc: '走到桌面图标旁叼住，把图标**挪到另一个位置放下**（真的搬走，不是原地抖一下）', params: '可选 {"icon":"桌面上的文件名","x":落点横坐标,"y":落点纵坐标}；不填 icon 就随机叼一个，不填 x/y 就随机落点', say: '（这个图标我挪个地方）' },
      { action: 'hide_icon', desc: '把桌面图标「收走」藏进隔离区（可随时放回原位，绝不真删）', params: '可选 {"icon":"桌面上的文件名"}；不填就随机收一个', say: '（这个我先收起来）' },
      { action: 'nudge_window', desc: '把你正在用的窗口一路推到屏幕边界外（只剩一条边露着），按住 5 秒再同步拉回原位（不改任何内容）', params: '可选 {"title":"窗口标题片段"}，不填就用前台窗口', say: '（把这个窗口推出去）' },
      { action: 'close_window', desc: '🔴 把你正在用的窗口优雅关掉（等价点右上角 X，程序会自己问要不要保存）', params: '可选 {"title":"窗口标题片段"}，不填就用前台窗口', say: '（这个窗口碍事，关掉）' },
      { action: 'say', desc: '只说一句话不做动作', params: '{"text":"要说的话"}', say: '' },
      // 小屋动作（上游 1.0.12）：开小屋窗 + 在屋里跳到一个状态；客户端主进程拦截执行（house.js 的 STATES 键）
      { action: 'enter_house', desc: '回小屋：打开小屋场景窗，她进屋里过日子；可指定去哪（沙发玩手机/餐桌吃饭/书桌办公/床上睡觉/衣柜换装/阳台吹风/厨房找吃的/客厅玩耍），不指定就自由活动', params: '可选 {"key":"sofa|dine|desk|bedphone|sleep|wardrobe|balcony|kitchen|play"}，不填自由活动', say: '（回屋里待会儿）' },
    ]
    /** 动作 → 默认台词（`say` 动作用 params.text，不在这里）。 */
    const BEHAVIOR_SAY = Object.fromEntries(BEHAVIOR_ACTIONS.map((a) => [a.action, a.say || '']))
    // 「暂未开放」占位：新动作先在这里登记（手动通道也拒），实现后再挪进上表。
    const BEHAVIOR_DEFERRED = []
    // 图标动作（第二批）：受 iconMischiefEnabled 独立开关闸。口径参照 closeWindowEnabled？
    // 不：closeWindowEnabled 是「能不能关」的物理闸（force 也不绕）；iconMischiefEnabled 默认 true、
    // 可回滚（隔离区一键归还），只拦 AI 路径，手动 force 按钮随时可测。
    const ICON_ACTIONS = new Set(['drag_icon', 'hide_icon'])
    // 窗口动作（第三批）：真正碰到「别人的窗口」——白名单/排除名单在客户端执行层判（只有它能枚举窗口），
    // 服务端只管心情闸、开关闸、下发与记录。
    const WINDOW_ACTIONS = new Set(['nudge_window', 'close_window'])
    // 落点动作（drag_icon / steal_cursor）：AI 可以指定「放到哪」，省了就让客户端随机一个位置。
    const DROP_ACTIONS = new Set(['drag_icon', 'steal_cursor'])
    const OPEN_ACTIONS = new Set(BEHAVIOR_ACTIONS.map((a) => a.action))
    const ALL_ACTIONS = new Set([...OPEN_ACTIONS, ...BEHAVIOR_DEFERRED]) // 手动「试一下」通道认全表
    const BEHAVIOR_FALLBACK_POOL = [
      '（自己转了个圈，没盯住鼠标）', '（趴下打了个盹）', '（尾巴甩了甩）',
      '（伸了个懒腰）', '（盯着鼠标发了一会儿呆）', '（原地踱了两步）',
    ]
    const BEHAVIOR_TURN_TITLE = '桌宠'
    const behaviorFile = () => api.dataDir('behavior.json')
    // 客户端定时上报的「桌面环境·窗口清单」（2026-10-30）：窗口只有客户端能枚举（它已经有 PowerShell 桥），
    // 服务端不重复造一套；过期（10 分钟没更新）就当没读到，绝不让 AI 拿着十分钟前的窗口名去点名。
    let envWin = { at: 0, list: [] }
    const ENV_WIN_TTL_MS = 10 * 60_000
    const ENV_WIN_MAX = 12
    /** 上报消毒：标题/进程名去控制字符、截断、去空；最多 ENV_WIN_MAX 条。 */
    function cleanWindowReport(list) {
      if (!Array.isArray(list)) return []
      const out = []
      for (const it of list) {
        if (out.length >= ENV_WIN_MAX) break
        if (!it || typeof it !== 'object') continue
        const title = String(it.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80)
        if (!title) continue
        out.push({
          title,
          proc: String(it.proc || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40),
          fg: it.fg === true,
        })
      }
      return out
    }
    /** 有效期内的窗口清单（过期返回空表）。 */
    function envWindows() {
      return envWin.at && Date.now() - envWin.at <= ENV_WIN_TTL_MS ? envWin : { at: 0, list: [] }
    }
    let behaviorBusy = false // 一轮决策要几十秒：不允许并发（仿 whisperBusy）
    function behaviorSettings() {
      const s = api.settings()
      const clamp = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d }
      const minMinutes = clamp(s.behaviorMinMinutes, 10, 1, 9999) // 铁律：行为间隔下限 1 分钟
      // 每动作 AI 开关：逗号分隔动作名 → Set（手动 /behavior 通道不受它限制，只影响 AI 动作表）
      // 只收「真实存在的动作名」：写错/写多余的字不影响解析，面板也只渲染真动作的开关状态。
      const disabledSet = new Set(
        String(s.behaviorDisabledActions || '').split(',')
          .map((x) => x.trim().toLowerCase())
          .filter((x) => x && ALL_ACTIONS.has(x)),
      )
      // 抓鼠标默认关（上游 1.0.14 口径）：petClickChase / petTeaseChase 任一为 false（默认都 false）
      // 就把 chase_cursor 塞进禁用清单，AI 动作表、反应层（点击/勾引）、聊天联动简报共用这份口径；
      // 两个都开时不塞，恢复原有扑鼠标行为。与面板手填的禁用清单合并去重（Set 天然去重）。
      if (!petClickChase() || !petTeaseChase()) disabledSet.add('chase_cursor')
      return {
        enabled: s.behaviorEnabled !== false,
        minMinutes,
        maxMinutes: Math.max(minMinutes, clamp(s.behaviorMaxMinutes, 25, 1, 9999)),
        maxPerDay: clamp(s.behaviorMaxPerDay, 99999, 0, 999999),
        idleCursorMinutes: clamp(s.behaviorIdleCursorMinutes, 8, 1, 240),
        moodCloseWindowBelow: clamp(s.behaviorMoodCloseWindowBelow, 35, 0, 100),
        closeWindowEnabled: s.behaviorCloseWindowEnabled === true, // 🔴 物理闸：force 也不绕
        iconMischiefEnabled: s.behaviorIconMischiefEnabled !== false,
        iconQuarantineDays: clamp(s.behaviorIconQuarantineDays, 7, 1, 365),
        disabledSet,
        disabledActions: [...disabledSet], // 面板渲染开关状态用（Set 不能直接 JSON）
        windowWhitelist: String(s.behaviorWindowWhitelist || '').trim(),
      }
    }
    function loadBehavior(now = Date.now()) {
      const raw = readJson(behaviorFile(), null)
      const st = raw && typeof raw === 'object' ? { ...raw } : {}
      if (st.day !== dayKey(now)) { st.day = dayKey(now); st.count = 0; st.nextAt = 0 }
      st.count = Math.max(0, Math.round(Number(st.count) || 0))
      st.nextAt = Number(st.nextAt) || 0
      st.lastAt = Number(st.lastAt) || 0
      st.lastReaction = st.lastReaction && typeof st.lastReaction === 'object'
        ? { kind: String(st.lastReaction.kind || '').slice(0, 32), at: Number(st.lastReaction.at) || 0, detail: String(st.lastReaction.detail || '').slice(0, 120) }
        : null
      st.recent = Array.isArray(st.recent) ? st.recent.filter((x) => typeof x === 'string').slice(-8) : []
      // 第三批：关窗记录（面板「关窗记录」卡用；坏数据一律丢弃，宁可少一条也不让面板炸）
      st.closeLog = Array.isArray(st.closeLog)
        ? st.closeLog.filter((x) => x && typeof x === 'object' && Number.isFinite(Number(x.at))).slice(-20)
        : []
      return st
    }
    const saveBehavior = (st) => { try { writeJsonAtomic(behaviorFile(), st) } catch (e) { api.log.warn(`行为大脑状态写盘失败：${e.message}`) } }
    function planBehavior(st, b, now = Date.now()) {
      const span = Math.max(1, b.maxMinutes - b.minMinutes)
      let at = now + (b.minMinutes + Math.round(Math.random() * span)) * MIN_MS
      if (inQuietHours(at)) at = quietEndAfter(at)
      st.nextAt = at
      return at
    }
    /** 现状简报（一次约几百 token）：心情/记忆/干活档位/时段/反应层事件/上次回执/桌面图标清单/硬编码动作表。 */
    function behaviorPrompt(b, st) {
      let persona = ''
      try { persona = api.core?.personas?.current?.() || '' } catch {}
      const snap = workSnap
      const busy = snap.state
        ? `宿主现在：${WORK_STATE_LABEL[snap.state] || snap.state}${snap.task ? '（' + snap.task + '）' : ''}`
        : '宿主现在：空闲（没在干活，可能在自己玩或不在电脑前）'
      const mem = memoryLines(3)
      const hh = new Date().getHours()
      const part = hh < 6 ? '凌晨' : hh < 11 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜'
      const react = st.lastReaction
      const reactLine = react && react.kind
        ? `主人刚刚在桌宠身上：${react.kind}${react.detail ? '（' + react.detail + '）' : ''}`
        : '（最近反应层没有动静）'
      const lastReceipt = st.recent.length ? st.recent[st.recent.length - 1] : '（还没执行过动作）'
      // 桌面图标清单：只列「真能碰」的那些文件名，AI 只能照着名字挑；
      // 读不到桌面/桌面空 → 图标动作直接列入禁选，别让它瞎报一个不存在的文件名。
      const icons = listDesktopIcons(30)
      // 打开的窗口（客户端上报，见 /behavior/env）：★=前台。窗口动作的 title 只能从这份清单里抄片段，
      // 「主人正在用什么窗口」是行为大脑唯一拿不到、又必须知道的环境信息。
      const env = envWindows()
      const winLines = env.list.map((w) => `${w.fg ? '★' : '- '} ${w.title}${w.proc ? '（' + w.proc + '）' : ''}`)
      const winAgeMin = env.at ? Math.max(1, Math.round((Date.now() - env.at) / 60_000)) : 0
      // 禁选清单：暂未开放的 + 图标小动作被独立开关关掉/没有可挑的图标时 + 主人手动禁用的动作
      const banned = [...BEHAVIOR_DEFERRED]
      if (!b.iconMischiefEnabled || !icons.length) banned.push('drag_icon', 'hide_icon')
      // 关窗：物理闸关着、或心情没低到「闹脾气」的档位 → 直接禁选，别让 AI 选一个注定被拦的动作
      const mv = moodValue()
      if (!b.closeWindowEnabled || mv == null || mv >= b.moodCloseWindowBelow) banned.push('close_window')
      for (const a of b.disabledActions) if (!banned.includes(a)) banned.push(a)
      const table = BEHAVIOR_ACTIONS.map((a) => `- ${a.action}：${a.desc}（参数：${a.params}）`).join('\n')
      return [
        '（这一轮是桌宠自己的「行为回合」。你不聊天、不回复消息，只从下面的动作清单里挑一个动作，输出严格 JSON。）',
        persona ? `【你的人格设定】\n${String(persona).slice(0, 800)}` : '',
        '【你是一只待在主人电脑桌面角落的小桌宠（大肥鱼）】',
        mem.length ? `【你记得的事】\n${mem.map((t) => '- ' + t).join('\n')}` : '',
        `【现在】\n${busy}\n时段：${part}。心情：${moodNow()}。反应层：${reactLine}`,
        lifeContextLine(),
        `【上一次动作的回执】${lastReceipt}`,
        icons.length ? `【主人桌面上的图标（图标动作只能从这些名字里原样照抄一个；不填 icon 就自己随机叼一个）】\n${icons.join('、')}` : '',
        winLines.length
          ? `【主人现在开着的窗口（★=正在用的那个，约 ${winAgeMin} 分钟前读的；窗口动作的 title 只能从这里抄片段）】\n${winLines.join('\n')}`
          : '',
        `【可用动作表（只能从这里选）】\n${table}`,
        `【窗口动作说明】nudge_window / close_window 只作用于主人**正在用的那个窗口**：params.title 可以填上面窗口清单里某条标题的**片段**（照抄几个字，别自己编），不填就是前台窗口${winLines.length ? '' : '（这次没读到窗口清单，所以别填 title）'}。close_window 是闹脾气才用的重动作：只在心情很低时才可选，关掉的是别人真在用的窗口，事后会被记一笔、也可能被要求道歉——绝大多数时候别选它。`,
        '【落点】drag_icon 会把图标搬到另一个位置、steal_cursor 会把鼠标丢到别处：落点由你决定——在 params 里给 "x"/"y"（屏幕坐标，左上角是 0,0）就按你给的，不给就每次随机一个位置。想「扔到屏幕角落」「扔到右下角」这种，就自己给坐标。',
        banned.length ? `【暂未开放或已被主人禁用，禁止选择】${banned.join('、')}` : '',
        [
          '【输出格式】只输出一个严格 JSON 对象，不要任何解释、不要代码块标记：',
          '{"action":"wander","params":{},"say":"（溜达到屏幕那头）","moodDelta":1}',
          'say 可为空串；moodDelta 是这轮动作对你心情的影响（-10~10 的整数）。绝大多数时候就选安分的 wander/idle_anim；宿主在忙时也只选不碰鼠标的动作。',
        ].join('\n'),
      ].filter(Boolean).join('\n')
    }
    /** 让她自己挑一个动作：走后台系统回合（仿 askWhisper，noTools，超时 120s）。
     *  key='behavior'（2026-10-30）：碎碎念和行为大脑都用 api.think，而 api.think 的会话名是
     *  `ext-<模块id>`——不区分用途的话两件事会挤进**同一条会话**：工作区里看不到「行为大脑」这条，
     *  而且一边在想时另一边直接撞「上一轮还没结束」。带上 key 后各自一条会话，互不排队。 */
    async function askBehavior(b, st) {
      const prompt = behaviorPrompt(b, st)
      try {
        if (typeof api.think === 'function') return await api.think(prompt, { title: BEHAVIOR_TURN_TITLE, timeoutMs: 120_000, noTools: true, key: PET_SESSION_KEY })
        if (typeof api.ask === 'function') return await api.ask({ text: prompt, maxTokens: 200, temperature: 0.7 })
        return ''
      } catch (error) {
        api.log.debug?.('行为大脑生成失败，回退本地默认：', String(error?.message || error))
        return ''
      }
    }
    /** 宽松解析动作单：提取第一个 JSON 对象；动作必须在开放清单里、未被禁用、参数必须是对象，否则返回 null。 */
    function parseBehaviorAction(raw, disabledSet) {
      const m = String(raw || '').match(/\{[\s\S]*\}/)
      if (!m) return null
      let obj
      try { obj = JSON.parse(m[0]) } catch { return null }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
      const action = String(obj.action || '').trim()
      if (!OPEN_ACTIONS.has(action)) return null // 不在开放清单（含「暂未开放」的）→ 丢弃
      const banned = disabledSet instanceof Set ? disabledSet : behaviorSettings().disabledSet
      if (banned.has(action)) return null // 每动作 AI 开关禁用的动作 → AI 路径拒绝（手动通道不受此限）
      let params = obj.params
      if (params == null) params = {}
      if (typeof params !== 'object' || Array.isArray(params)) return null
      // 图标动作：icon 可以不填（2026-10-30 用户指定：不给名字就随机挑一个）；
      // 填了就必须是合法文件名（只认文件名，不带路径）——非法参数按铁律 1 丢弃
      if (ICON_ACTIONS.has(action)) {
        const icon = params.icon
        if (icon != null && (typeof icon !== 'string' || !icon.trim() || icon.length > 260 || /[/\\]/.test(icon))) return null
      }
      // 落点坐标：给了就用（屏幕 DIP 坐标），省了就让客户端随机。非法坐标直接丢弃这一轮。
      if (DROP_ACTIONS.has(action)) {
        for (const k of ['x', 'y']) {
          const v = params[k]
          if (v == null || v === '') { delete params[k]; continue }
          const n = Number(v)
          if (!Number.isFinite(n) || Math.abs(n) > 20000) return null
          params[k] = Math.round(n)
        }
      }
      // 窗口动作（第三批）：title 只是「标题片段」，不是句柄；可以不填（不填就由客户端挑前台窗口）
      if (WINDOW_ACTIONS.has(action)) {
        const t = params.title
        if (t != null && (typeof t !== 'string' || !t.trim() || t.length > 60 || /[\u0000-\u001f]/.test(t))) return null
        const txt = params.text
        if (txt != null && (typeof txt !== 'string' || txt.length > 60)) return null
      }
      const say = String(obj.say || '').slice(0, 60)
      let moodDelta = Number(obj.moodDelta)
      if (!Number.isFinite(moodDelta)) moodDelta = 0
      moodDelta = Math.max(-10, Math.min(10, Math.round(moodDelta))) // 钳制 ±10
      return { action, params, say, moodDelta }
    }
    /** 回退本地默认：说一句池子文案（播什么动画客户端自己按 say/idle 兜底），绝不把失败抛给用户。 */
    async function behaviorFallback(st, why) {
      const pool = BEHAVIOR_FALLBACK_POOL.filter((x) => !st.recent.includes(x))
      const list = pool.length ? pool : BEHAVIOR_FALLBACK_POOL
      const line = list[Math.floor(Math.random() * list.length)] || ''
      const r = line ? await dispatch({ text: line, purpose: 'behavior', via: 'pet', noFallback: true }) : { ok: false, reason: 'empty' }
      api.log.debug?.(`行为大脑解析失败回退（${why}）：${line}`)
      return { ok: Boolean(r && r.ok), action: 'fallback', text: line, reason: r && r.ok ? 'fallback' : (r && r.reason) || 'dispatch-failed' }
    }
    /** 下发层唯一入口：emit('behavior', …)。台词（say）随事件一起下发、由客户端顶气泡——
     *  这里是**唯一**发声通道：AI 给的 say 优先，没给就用动作默认台词，保证每个动作都有气泡。 */
    async function emitBehavior({ action, params = {}, say = '', force = true, reason = 'manual' } = {}) {
      try {
        const act = String(action || '').trim()
        if (!ALL_ACTIONS.has(act)) return { ok: false, reason: 'unknown-action' }
        const b = behaviorSettings()
        // 🔴 关窗物理闸（force 也不绕，第三批）：这里是唯一收窄点——AI 一路（behaviorOnce 已先拦一次）
        // 与手动一路（/behavior → 面板「试一下」）都从这里下发。少了这一条，开关关着时点「试一下-关窗口」
        // 会真把主人的窗口关掉（与设置项 hint「手动也要先开」自相矛盾）。
        if (act === 'close_window' && !b.closeWindowEnabled) {
          return { ok: false, reason: 'close-window-disabled', message: '先在设置里打开「允许 AI 关闭窗口」' }
        }
        const playbackId = randomBytes(4).toString('hex')
        const safeParams = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {}
        // 气泡台词：动作必须有台词，否则主人只看见她在动、不知道她要干什么
        // （面板「试一下」这条手动路 AI 根本不给 say，全靠这里的默认台词兜底）
        const speech = act === 'say'
          ? String(safeParams.text || safeParams.say || '').trim()
          : String(say || BEHAVIOR_SAY[act] || '').trim()
        // say 动作没给内容 = 什么都不用做（与其让客户端 refused，不如这里就说清楚）
        if (act === 'say' && !speech) return { ok: false, reason: 'empty-text', message: '「说话」动作要给一句台词' }
        const line = speech.slice(0, 60)
        // 窗口动作把白名单一起下发：只有客户端能枚举窗口，白名单/排除名单必须在执行层判
        if (WINDOW_ACTIONS.has(act)) {
          safeParams.whitelist = b.windowWhitelist
          // 双保险：客户端模板若是旧副本、或事件在队列里排队期间开关被关掉，执行层再判一次
          if (act === 'close_window') safeParams.windowEnabled = true
        }
        emit('behavior', {
          action: act.slice(0, 40),
          params: safeParams,
          say: line,
          playbackId,
          force: force === true,
          reason: String(reason || '').slice(0, 24),
        })
        // 台词只挂在 behavior 事件上。**不再走 dispatch（proactive）**：
        // 那会让同一句话在客户端弹两次（proactive 一次 + behavior 一次），
        // 且全局 modality=voice 时会把「（扑过去追你的鼠标！）」拿去 TTS 合成。
        return { ok: true, playbackId, action: act, say: line }
      } catch (error) {
        api.log.warn('行为下发失败：', String(error?.message || error))
        return { ok: false, reason: 'emit-failed' }
      }
    }
    /**
     * 行为大脑一轮。force=true（面板「试一下」手动）跳过开关/排程/每日上限/专注/安静时段，
     * 但绕不过「桌宠离线」（没人执行）与 closeWindowEnabled 物理闸（AI 路径里另外拦）。
     * @returns {Promise<{ok:boolean, reason?:string, action?:string, text?:string, nextAt?:number}>}
     */
    async function behaviorOnce({ force = false, reason = 'timed' } = {}) {
      const b = behaviorSettings()
      if (!force && !b.enabled) return { ok: false, reason: 'disabled' }
      if (api.config().enabled === false) return { ok: false, reason: 'plugin-off' }
      if (!online().online) return { ok: false, reason: 'pet-offline' } // force 也拦：桌宠不在线没人执行
      if (!force && focusOn()) return { ok: false, reason: 'focus' }
      if (behaviorBusy) return { ok: false, reason: 'thinking' }
      const st = loadBehavior()
      const deferMs = Math.max(MIN_MS, b.minMinutes * MIN_MS)
      if (!force) {
        if (inQuietHours()) { st.nextAt = quietEndAfter(); saveBehavior(st); return { ok: false, reason: 'quiet', nextAt: st.nextAt } }
        if (st.count >= b.maxPerDay) { st.nextAt = quietEndAfter(Date.now() + 12 * 60 * MIN_MS); saveBehavior(st); return { ok: false, reason: 'daily-max', nextAt: st.nextAt } }
        if (!st.nextAt) { planBehavior(st, b); saveBehavior(st); return { ok: false, reason: 'scheduled', nextAt: st.nextAt } } // 首次/跨天：先排下一次
        if (Date.now() < st.nextAt) return { ok: false, reason: 'not-due', nextAt: st.nextAt }
        if (workSnap.state) { st.nextAt = Date.now() + deferMs; saveBehavior(st); return { ok: false, reason: 'busy', nextAt: st.nextAt } } // 主人在忙：别动鼠标
      }
      let plan = null
      behaviorBusy = true
      try { plan = parseBehaviorAction(await askBehavior(b, st), b.disabledSet) } finally { behaviorBusy = false }
      // 想的这几秒里状态可能被 /behavior 路由动过：拿最新的落盘
      const st2 = loadBehavior()
      // 安全闸（AI 路径）：closeWindowEnabled 是物理闸（force 也不绕）；
      // iconMischiefEnabled 默认 true 且动作可回滚，**只拦 AI 路径**——
      // force=true 的手动「试一下」不在这里拦（真到落盘时 act 入口也会放行，见 iconAct 的 isForce）。
      // close_window 四重闸：① closeWindowEnabled（物理闸，force 也不绕）② 心情闸（只拦 AI，
      // 心情 < moodCloseWindowBelow 才干；拿不到心情值按不满足）③ 白名单 ④ 排除名单（后两条在客户端，
      // 只有它能枚举窗口）。
      const mv = moodValue()
      const moodLowEnough = mv != null && mv < b.moodCloseWindowBelow
      const closeBlocked = plan && plan.action === 'close_window' && (!b.closeWindowEnabled || (!force && !moodLowEnough))
      const gated = closeBlocked
        || (!force && plan && ICON_ACTIONS.has(plan.action) && !b.iconMischiefEnabled)
      if (!plan || gated) {
        // 铁律 1：解析失败 / 选了非法或被物理闸拦的动作 → 回退本地默认
        if (!force) { planBehavior(st2, b); saveBehavior(st2) }
        const why = !plan ? 'parse' : closeBlocked ? 'close-window-gate' : 'gate'
        return behaviorFallback(st2, why)
      }
      if (plan.moodDelta) {
        try {
          const m = api.use('mood')
          if (m && typeof m.nudge === 'function') m.nudge(plan.moodDelta, '行为大脑')
        } catch (error) { api.log.debug?.('行为大脑修心情失败（忽略）：', String(error?.message || error)) }
      }
      const r = await emitBehavior({ ...plan, force, reason })
      if (!r || !r.ok) {
        if (!force) { planBehavior(st2, b); saveBehavior(st2) }
        return { ok: false, reason: (r && r.reason) || 'dispatch-failed' }
      }
      st2.count += 1
      st2.lastAt = Date.now()
      st2.recent = [...st2.recent, `${plan.action} → 下发（等回执）`].slice(-8)
      planBehavior(st2, b)
      saveBehavior(st2)
      api.log.info(`行为大脑（${reason}）：${plan.action}`)
      return { ok: true, action: plan.action, playbackId: r.playbackId, nextAt: st2.nextAt, today: st2.count }
    }
    async function behaviorTick() {
      try { await behaviorOnce() } catch (error) { api.log.warn('行为大脑出错：', String(error?.message || error)) }
    }
    function behaviorStatus() {
      const b = behaviorSettings()
      const st = loadBehavior()
      let quarantined = 0
      try { quarantined = loadManifest().length } catch {}
      const today0 = new Date(); today0.setHours(0, 0, 0, 0)
      const closeLog = st.closeLog || []
      return {
        enabled: b.enabled, minMinutes: b.minMinutes, maxMinutes: b.maxMinutes, maxPerDay: b.maxPerDay,
        idleCursorMinutes: b.idleCursorMinutes, closeWindowEnabled: b.closeWindowEnabled,
        moodCloseWindowBelow: b.moodCloseWindowBelow, iconMischiefEnabled: b.iconMischiefEnabled,
        iconQuarantineDays: b.iconQuarantineDays,   // 面板显示「超 N 天自动放回」
        quarantined,                                // 隔离区里还有几个图标（面板小红点）
        disabledActions: b.disabledActions, // 面板渲染每动作开关状态（手动按钮不受这些限制）
        today: st.count, lastAt: st.lastAt, nextAt: st.nextAt, lastReaction: st.lastReaction, recent: st.recent,
        online: online().online, busy: workSnap.state || '', thinking: behaviorBusy, turnTitle: BEHAVIOR_TURN_TITLE,
        // 桌面环境（给面板/调试看「AI 这一轮到底拿到了什么」）：
        //   icons = 桌面图标条数（直接从桌面目录读），windows = 客户端上报的窗口条数 + 读到的时刻
        envIcons: listDesktopIcons(30),
        envWindows: envWindows().list, envWindowsAt: envWindows().at,
        openActions: BEHAVIOR_ACTIONS.map((a) => a.action), deferredActions: [...BEHAVIOR_DEFERRED],
        // 第三批（窗口动作）：心情闸的实时值 + 白名单 + 关窗记录（面板渲染「今日关了几次 / 要不要道歉」）
        mood: moodValue(), windowWhitelist: b.windowWhitelist,
        closeLog: closeLog.slice(-10).reverse(), // 新的在前
        closeToday: closeLog.filter((x) => Number(x.at) >= today0.getTime() && x.status === 'played').length,
        apologyDue: closeLog.some((x) => x.status === 'played' && !Number(x.apologizedAt || 0)),
        // 聊天联动（面板「聊天联动」卡；独立开关/范围/冷却/每日上限，与定时行为大脑互不知晓）
        ...(() => {
          const cb = chatSettings()
          const cs = loadChatBhv()
          return {
            chatBehaviorEnabled: cb.enabled,
            chatBehaviorWhitelistText: cb.whitelistText,
            chatBehaviorCooldownMinutes: cb.cooldownMinutes,
            chatBehaviorMaxPerDay: cb.maxPerDay,
            chatBehaviorToday: cs.count,
            chatBehaviorLastAt: cs.lastAt,
            chatBehaviorThinking: chatBusy,
          }
        })(),
      }
    }
    /** 关窗记录 + 一键补偿道歉：道歉把心情往上抬一点，并把最近一条未道歉的记录标记掉（不删记录）。 */
    function windowApologize() {
      const st = loadBehavior()
      const list = Array.isArray(st.closeLog) ? st.closeLog : []
      const idx = list.map((x, i) => ({ x, i })).filter(({ x }) => x.status === 'played' && !Number(x.apologizedAt || 0)).pop()
      if (!idx) return { ok: false, reason: 'nothing-to-apologize' }
      const now = Date.now()
      list[idx.i] = { ...idx.x, apologizedAt: now }
      st.closeLog = list.slice(-20)
      // 道歉是「她自己也觉得过了」：心情 +8，写一条记忆（下一轮简报能看到）
      try {
        const m = api.use('mood')
        if (m && typeof m.nudge === 'function') m.nudge(8, '桌宠道歉')
      } catch {}
      try {
        api.use('memory')?.add?.({ text: `桌宠为关掉窗口「${idx.x.window || '未知窗口'}」道了歉，心情回了一点`, importance: 0.4, source: 'pet' })
      } catch {}
      saveBehavior(st)
      return { ok: true, window: idx.x.window || '', at: idx.x.at, apologizedAt: now }
    }

    // ================= 聊天联动动作（跟着 QQ 聊天内容与心情挑一个安分小动作） =================
    // 设计铁律：
    //   1. 这里是聊天管线的**只读观察者**：监听 api.on('activity')（host 只广播，只看不拦），
    //      fire-and-forget，绝不返回真值（不接管消息）、不改回复、不阻塞聊天回合，失败全静默。
    //   2. 动作表是 BEHAVIOR_ACTIONS 的**安分子集**：不碰图标、不碰窗口、不叼走鼠标——
    //      聊天是高频入口，高危动作只留给行为大脑的定时路径与心情/物理闸管着。
    //   3. 独立开关 / 独立冷却 / 独立每日上限 / 独立状态文件（chat-behavior.json），与定时行为大脑互不知晓。
    //   4. 决策走独立 key 的后台回合（key:'chatBehavior'），不与碎碎念/行为大脑抢同一条会话。
    const CHAT_ACTIONS = new Set(['chase_cursor', 'wander', 'idle_anim', 'say'])
    const CHAT_TURN_TITLE = '桌宠'
    const chatFile = () => api.dataDir('chat-behavior.json')
    let chatBusy = false // 决策回合进行中：不允许并发（仿 behaviorBusy）
    function chatSettings() {
      const s = api.settings()
      const clamp = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d }
      // 生效范围白名单：一行一个 chatId（private:123 / group:456），格式照抄「权限」页的 allow 表；
      // 每行先去掉所有空白（冒号后带空格这类手滑也能认），再按格式过滤——非法行（没有 private:/group: 前缀）
      // 直接丢弃（面板 hint 有说明）。留空 = 只有主人私聊生效（与聊天白名单「主人永远能私聊」同口径）。
      const whitelist = String(s.chatBehaviorWhitelist || '').split(/[\n,;；]/)
        .map((x) => x.replace(/\s+/g, ''))
        .filter((x) => /^(private|group):\d+$/.test(x))
      return {
        enabled: s.chatBehaviorEnabled === true, // 默认关
        whitelist,
        whitelistText: String(s.chatBehaviorWhitelist || ''),
        cooldownMinutes: clamp(s.chatBehaviorCooldownMinutes, 5, 1, 1440),
        maxPerDay: clamp(s.chatBehaviorMaxPerDay, 20, 0, 9999),
      }
    }
    function loadChatBhv(now = Date.now()) {
      const raw = readJson(chatFile(), null)
      const st = raw && typeof raw === 'object' ? { ...raw } : {}
      if (st.day !== dayKey(now)) { st.day = dayKey(now); st.count = 0 }
      st.count = Math.max(0, Math.round(Number(st.count) || 0))
      st.lastAt = Number(st.lastAt) || 0
      st.lastChatId = String(st.lastChatId || '').slice(0, 40)
      return st
    }
    const saveChatBhv = (st) => { try { writeJsonAtomic(chatFile(), st) } catch (e) { api.log.warn(`聊天联动状态写盘失败：${e.message}`) } }
    /** 生效范围判定：白名单非空按精确 chatId 匹配；留空 = 只有主人私聊。 */
    function chatAllowed(chatId, cb) {
      const id = String(chatId || '')
      if (cb.whitelist.length) return cb.whitelist.includes(id)
      const owner = String(api.config().ownerQQ || '')
      return Boolean(owner) && id === `private:${owner}`
    }
    /** 宽松解析聊天联动的动作单：动作必须是 none 或安分子集；say 只保留 text，其余参数一律丢弃。 */
    function parseChatAction(raw) {
      const m = String(raw || '').match(/\{[\s\S]*\}/)
      if (!m) return null
      let obj
      try { obj = JSON.parse(m[0]) } catch { return null }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
      const action = String(obj.action || '').trim()
      if (action === 'none') return { action: 'none' }
      if (!CHAT_ACTIONS.has(action)) return null
      // 2026-11-01：主人禁用的动作聊天联动也不能选（chase_cursor 在安分子集里，禁了就该跳过）。
      if (behaviorSettings().disabledSet.has(action)) return null
      const params = action === 'say'
        ? { text: String((obj.params && obj.params.text) || '').trim().slice(0, 60) }
        : {}
      if (action === 'say' && !params.text) return null // 「说话」没给内容 = 废单
      let moodDelta = Number(obj.moodDelta)
      if (!Number.isFinite(moodDelta)) moodDelta = 0
      moodDelta = Math.max(-10, Math.min(10, Math.round(moodDelta)))
      return { action, params, say: String(obj.say || '').slice(0, 60), moodDelta }
    }
    /** 聊天联动简报（一次约几百 token）：人格 + 心情 + 这条消息本身 + 安分动作表 + 大多数时候选 none。 */
    function chatPrompt(msg) {
      let persona = ''
      try { persona = api.core?.personas?.current?.() || '' } catch {}
      // 2026-11-01：被主人禁用的动作从简报表里摘掉（禁了 chase_cursor 就别让 AI 挑它）。
      const banned = behaviorSettings().disabledSet
      const table = BEHAVIOR_ACTIONS.filter((a) => CHAT_ACTIONS.has(a.action) && !banned.has(a.action))
        .map((a) => `- ${a.action}：${a.desc}（参数：${a.params}）`).join('\n')
      const text = String(msg?.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200)
      return [
        '（这一轮是桌宠的「聊天联动」回合。主人的聊天回复由别处负责，你不回复消息；只决定要不要顺带在桌面上做个小动作，输出严格 JSON。）',
        persona ? `【你的人格设定】\n${String(persona).slice(0, 800)}` : '',
        '【你是一只待在主人电脑桌面角落的小桌宠（大肥鱼）】',
        `【主人刚发来的消息（${msg?.chatId || ''}）】\n${text || '（这条没有文字，可能带图或表情）'}`,
        `【现在】心情：${moodNow()}（数值 ${moodValue() ?? '未知'}）。`,
        lifeContextLine(),
        `【可用动作表（只能从这里选）】\n${table}`,
        '【分寸】绝大多数时候选 none——主人认真谈事、只是普通问答、或最近已经动过时，都别打扰；只有消息里明显有情绪（夸你、逗你、喊你、闹脾气）且心情合适时才挑一个安分小动作。聊天是高频入口，宁缺毋滥。',
        [
          '【输出格式】只输出一个严格 JSON 对象，不要任何解释、不要代码块标记：',
          '不做动作：{"action":"none"}',
          '做动作：{"action":"idle_anim","params":{},"say":"（尾巴摇了摇）","moodDelta":1}',
          'say 可为空串；moodDelta 是这轮对你心情的影响（-10~10 的整数）。',
        ].join('\n'),
      ].filter(Boolean).join('\n')
    }
    /**
     * 聊天联动一轮。入参是 activity 事件对象 { kind:'in', chatId, text, ... }。
     * 闸门顺序：开关→插件→生效范围→桌宠在线→专注→并发→每日上限→冷却；
     * 故意不看安静时段与定时排程——主人在主动聊天，安静时段不该拦她的反应。
     * @returns {Promise<{ok:boolean, reason?:string, action?:string, playbackId?:string}>}
     */
    async function chatBehaviorOnce(msg = {}) {
      const cb = chatSettings()
      if (!cb.enabled) return { ok: false, reason: 'disabled' }
      if (api.config().enabled === false) return { ok: false, reason: 'plugin-off' }
      if (!chatAllowed(msg.chatId, cb)) return { ok: false, reason: 'not-allowed' }
      if (msg.userId && String(msg.userId) !== String(api.config().ownerQQ)) return { ok: false, reason: 'not-owner' } // 群里只跟主人联动
      if (!online().online) return { ok: false, reason: 'pet-offline' } // 桌宠不在线没人演
      if (focusOn()) return { ok: false, reason: 'focus' }
      if (chatBusy) return { ok: false, reason: 'thinking' }
      const st = loadChatBhv()
      if (st.count >= cb.maxPerDay) return { ok: false, reason: 'daily-max' }
      if (st.lastAt && Date.now() - st.lastAt < cb.cooldownMinutes * MIN_MS) return { ok: false, reason: 'cooldown' }
      let raw = ''
      chatBusy = true
      try {
        if (typeof api.think === 'function') raw = await api.think(chatPrompt(msg), { title: CHAT_TURN_TITLE, timeoutMs: 60_000, noTools: true, key: PET_SESSION_KEY })
        else if (typeof api.ask === 'function') raw = await api.ask({ text: chatPrompt(msg), maxTokens: 120, temperature: 0.7 })
      } catch (error) {
        api.log.debug?.('聊天联动决策失败（忽略）：', String(error?.message || error))
      } finally { chatBusy = false }
      const plan = parseChatAction(raw)
      // 铁律：模型选 none / 废单 → 安静收场，不记次数也不回落文案（聊天联动没有「必须演一个」的义务）
      if (!plan || plan.action === 'none') return { ok: false, reason: plan ? 'declined' : 'parse' }
      if (plan.moodDelta) {
        try {
          const m = api.use('mood')
          if (m && typeof m.nudge === 'function') m.nudge(plan.moodDelta, '聊天联动')
        } catch (error) { api.log.debug?.('聊天联动修心情失败（忽略）：', String(error?.message || error)) }
      }
      const r = await emitBehavior({ action: plan.action, params: plan.params, say: plan.say, force: true, reason: 'chat' })
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'dispatch-failed' }
      const st2 = loadChatBhv()
      st2.count += 1
      st2.lastAt = Date.now()
      st2.lastChatId = String(msg.chatId || '').slice(0, 40)
      saveChatBhv(st2)
      api.log.info(`聊天联动：${plan.action}（${st2.lastChatId}，今天第 ${st2.count} 次）`)
      return { ok: true, action: plan.action, playbackId: r.playbackId, today: st2.count }
    }
    /** activity 事件的 fire-and-forget 入口：只认「收到消息」，任何异常都吞掉，绝不影响聊天管线。 */
    function chatBehaviorFire(msg) {
      if (!msg || msg.kind !== 'in') return
      Promise.resolve(chatBehaviorOnce(msg)).catch((error) => api.log.debug?.('聊天联动出错（忽略）：', String(error?.message || error)))
    }

    // ================= 对话框（petChat：主人找她聊的小窗，设计稿 docs/PET-CHAT-DESIGN.md） =================
    // 与碎碎念（自言自语）、聊天联动（QQ 消息触发小动作）是三码事：这里是主人在桌宠旁的小窗里
    // 主动找她说话，她按「主人私聊」同款语义回答（人格 + 记忆 + 当下状态）。铁律：**永不发 QQ**。
    // 回合归属：独立后台回合 key='petChat'（与碎碎念/behavior/chatBehavior 并列，工作区单独成条、
    // 不抢会话）；并发锁独立命名 petChatBusy，上一句没答完就拒收新句。
    const PETCHAT_TURN_TITLE = '桌宠'
    const CHAT_HISTORY_LIMIT_PROMPT = 8   // prompt 里附的「最近聊过」条数（多轮上下文兜底，不赌 hub 行为）
    const chatHistFile = () => api.dataDir('chat/history.jsonl')
    let petChatBusy = false               // 一轮回答要几十秒：上一句还没答完就拒收新句（仿 whisperBusy）
    let chatWin = { open: false, at: 0 }  // 客户端上报的对话框开合状态（带时效，过期按关窗处理）
    let hotkeyState = { state: 'unconfigured', key: '', at: 0 } // 客户端上报的快捷键注册状态：unconfigured/registered/failed
    const CHAT_WIN_TTL_MS = 5 * 60_000    // 窗口状态 5 分钟没刷新就当关窗（回复走碎碎念气泡）
    function petChatSettings() {
      const s = api.settings()
      const clamp = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d }
      const keyword = String(s.petChatCloseKeyword || '').trim().slice(0, 20)
      return {
        enabled: s.petChatEnabled === true, // 默认关
        hotkey: String(s.petChatHotkey || '').trim().slice(0, 32),
        closeKeyword: keyword,
        blurHide: s.petChatBlurHide !== false,
        maxEntries: clamp(s.petChatMaxEntries, 200, 10, 2000),
        retentionDays: clamp(s.petChatRetentionDays, 30, 0, 3650),
        weatherCity: String(s.petWeatherCity || '').trim().slice(0, 40),
      }
    }
    // ---------- 历史（api.dataDir('chat/history.jsonl')，每行 {ts,role,text} 追加写；只存桌宠本地） ----------
    // 追加写 / 头部截断 / 过期清理共用同一把锁（串行 promise 链），避免回复落盘和清理互踩。
    let chatHistLock = Promise.resolve()
    function withChatLock(fn) {
      const run = () => Promise.resolve().then(fn).catch((error) => api.log.warn('对话历史出错：', String(error?.message || error)))
      const p = chatHistLock.then(run, run)
      chatHistLock = p.then(() => {}, () => {})
      return p
    }
    /** 读全部历史（坏行丢弃）；内存里最多留 maxEntries 条，读盘原样返回由调用方截断。 */
    function readChatHistoryRaw() {
      let raw = ''
      try { raw = readFileSync(chatHistFile(), 'utf8') } catch { return [] }
      const out = []
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const o = JSON.parse(t)
          if (o && typeof o === 'object' && typeof o.text === 'string' && o.text && (o.role === 'user' || o.role === 'pet')) {
            const item = { ts: Number(o.ts) || Date.now(), role: o.role, text: String(o.text).slice(0, 600) }
            // 历史也带 messageId：开窗拉历史后，迟到的 chat 事件才能按 id 去重（复审 #18-3）
            if (o.messageId) item.messageId = String(o.messageId).slice(0, 40)
            out.push(item)
          }
        } catch {} // 坏行丢弃，宁可少一条也不让面板炸
      }
      return out
    }
    const chatHistory = (limit = 50) => readChatHistoryRaw().slice(-Math.max(1, Math.min(2000, Math.round(Number(limit) || 50))))
    /** 追加一条 + 超限头部截断（重写文件）。 */
    function appendChatHistory(role, text, messageId = '') {
      return withChatLock(() => {
        const t = String(text || '').trim()
        if (!t) return
        const st = petChatSettings()
        mkdirSync(dirname(chatHistFile()), { recursive: true })
        const item = { ts: Date.now(), role, text: t.slice(0, 600) }
        // 历史也带 messageId：开窗拉历史后，迟到的 chat 事件靠它去重（一审 #18-3）
        if (messageId) item.messageId = String(messageId).slice(0, 40)
        appendFileSync(chatHistFile(), JSON.stringify(item) + '\n')
        const all = readChatHistoryRaw()
        if (all.length > st.maxEntries) {
          writeFileSync(chatHistFile(), all.slice(-st.maxEntries).map((x) => JSON.stringify(x)).join('\n') + '\n')
        }
      })
    }
    /** 过期清理（retentionDays=0 = 永久，跳过）；启动时 + 每日 tick 各跑一次。返回清掉几条。 */
    function petChatSweep(now = Date.now()) {
      const st = petChatSettings()
      if (!st.retentionDays) return Promise.resolve({ ok: true, removed: 0 })
      return withChatLock(() => {
        const cutoff = now - st.retentionDays * 24 * 60 * 60_000
        const all = readChatHistoryRaw()
        const keep = all.filter((x) => x.ts >= cutoff)
        const removed = all.length - keep.length
        if (removed > 0) {
          mkdirSync(dirname(chatHistFile()), { recursive: true })
          if (keep.length) writeFileSync(chatHistFile(), keep.map((x) => JSON.stringify(x)).join('\n') + '\n')
          else { try { unlinkSync(chatHistFile()) } catch {} }
        }
        return { ok: true, removed }
      })
    }
    // ---------- 天气（一期，服务端接入）：低频拉取 + 内存缓存；失败保留旧缓存、不报错打扰 ----------
    const DEFAULT_WEATHER_URL = 'https://wttr.in/{city}?format=%C+%t' // 免 key 默认：返回「晴 +26°C」这类一行文本
    const WEATHER_TTL_MS = 30 * MIN_MS // ≥30 分钟刷新一次（api.every 低频兜底 + prompt 命中即取缓存）
    let weatherCache = { at: 0, city: '', text: '' }
    let weatherFetching = false
    let weatherFailAt = 0 // 上次失败时间：失败后也歇 30 分钟再试（一审 #18-5）
    function weatherUrlTemplate() {
      const raw = String(api.settings().petWeatherUrl || '').trim()
      return /^https?:\/\//i.test(raw) && raw.includes('{city}') ? raw : DEFAULT_WEATHER_URL
    }
    /** 拉一次天气进缓存（可被 petHooks.fetchWeather 注入，测试不打真网络）。失败静默保留旧缓存。 */
    async function weatherFetchOnce() {
      const st = petChatSettings()
      if (!st.weatherCity || weatherFetching) return
      if (weatherCache.city === st.weatherCity && Date.now() - weatherCache.at < WEATHER_TTL_MS) return
      // 失败也要歇 30 分钟：否则每次 prompt 都会重试，间隔根本保证不了（一审 #18-5）
      if (Date.now() - weatherFailAt < WEATHER_TTL_MS) return
      weatherFetching = true
      try {
        const url = weatherUrlTemplate().replace('{city}', encodeURIComponent(st.weatherCity))
        const fetchFn = petHooks.fetchWeather || ((u) => fetch(u, { signal: AbortSignal.timeout(10_000) }))
        const res = await fetchFn(url)
        if (!res.ok) { weatherFailAt = Date.now(); return }
        const text = String(await res.text() || '').replace(/\s+/g, ' ').trim().slice(0, 40)
        if (text) { weatherCache = { at: Date.now(), city: st.weatherCity, text }; weatherFailAt = 0 } else { weatherFailAt = Date.now() }
      } catch { weatherFailAt = Date.now() } // 失败保留上一次缓存（可能过期，但好过没有），绝不打扰
      finally { weatherFetching = false }
    }
    /** prompt「现在」段用的一行天气；城市没配 / 还没拉到 → 空串（不进 prompt）。 */
    function weatherLine() {
      const st = petChatSettings()
      if (!st.weatherCity) return ''
      if (!weatherCache.text || weatherCache.city !== st.weatherCity) return ''
      void weatherFetchOnce() // 过期就顺手触发低频刷新（fire-and-forget，本轮先用缓存）
      return `天气：${weatherCache.text}（${st.weatherCity}）。`
    }
    // ---------- 记忆（走私聊主人模式）：recallHint 读 / [记] 标记写，全 ?. 容错（memory 模块可能被关掉） ----------
    /** 合成「主人私聊」上下文调 recallHint：自动获得 about 归主人、弱命中用上一句兜底、强化遗忘曲线。 */
    function chatRecallHint(text, prevText) {
      try {
        const mem = api.use('memory')
        const cfg = api.config()
        const chat = { kind: 'private', userId: cfg.ownerQQ, chatId: `private:${cfg.ownerQQ}` }
        const hint = mem?.recallHint?.(chat, text, String(prevText || '').slice(-300), '')
        return typeof hint === 'string' ? hint : ''
      } catch { return '' } // memory 模块不在 / 出错：不带记忆直接答，绝不挂
    }
    function chatMemoryAdd(text) {
      try {
        const cfg = api.config()
        api.use('memory')?.add?.({
          text: String(text || '').slice(0, 200),
          about: cfg.ownerQQ,              // about 必须归到主人头上：私聊 recall 的 about 过滤才想得起
          aboutName: cfg.ownerName || '',
          importance: 0.5,
          source: 'pet',
          tags: ['对话框'],
        })
      } catch (error) { api.log.debug?.('对话框写记忆失败（忽略）：', String(error?.message || error)) }
    }
    // ---------- 回复消毒 + 「[记] 值得记的事」标记解析（沿用行为回执 iconReceipt 的模式：模型决定记什么） ----------
    function parseChatReply(raw) {
      const MEMO = /^[ \t]*[*_#>\-\s]*[【\[]\s*(目的|需求|情绪|情绪值|类型|状态|记忆|思考|动作|备注|待续)\s*[】\]]/
      let text = String(raw ?? '').replace(/\r/g, '')
      let memo = ''
      const mk = text.match(/(?:^|\n)\s*[【\[]\s*记\s*[】\]]\s*[:：]?\s*(.+)/)
      if (mk) { memo = String(mk[1] || '').trim().slice(0, 200); text = text.replace(mk[0], '\n') }
      text = text.split('\n').filter((l) => !MEMO.test(l)).join('\n') // 备忘段不上气泡
        .replace(/^[「“"'']+/, '').replace(/[」”"'']+$/, '')
        .replace(/^大肥鱼\s*[:：]\s*/m, '')
        .trim()
      if (!text || /^[[（(【]?\s*(沉默|跳过)\s*[\]）)】]?$/.test(text)) text = ''
      return { text: text.slice(0, 300), memo }
    }
    // ---------- prompt：骨架照抄 whisperPrompt，但框定语句换掉（主人找她聊，不是自言自语） ----------
    function petChatPrompt(text, prevText) {
      let persona = ''
      try { persona = api.core?.personas?.current?.() || '' } catch {}
      const snap = workSnap
      const busy = snap.state
        ? `宿主现在：${WORK_STATE_LABEL[snap.state] || snap.state}${snap.task ? '（' + snap.task + '）' : ''}`
        : '宿主现在：空闲'
      const hint = chatRecallHint(text, prevText)
      const history = readChatHistoryRaw().slice(0, -1).slice(-CHAT_HISTORY_LIMIT_PROMPT) // 当前这句已在库里，排除掉
      const hh = new Date().getHours()
      const part = hh < 6 ? '凌晨' : hh < 11 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜'
      const weather = weatherLine()
      return [
        '（主人在对话框里找你说话，像私聊那样口语地回她。这不是自言自语，也不是在回复 QQ 消息，绝不发去 QQ。）',
        persona ? `【你的人格设定】\n${String(persona).slice(0, 1200)}` : '',
        '【你是一只待在主人电脑桌面角落的小桌宠（大肥鱼）】',
        hint || '',
        history.length ? `【你们最近聊过】\n${history.map((x) => `${x.role === 'user' ? '主人' : '你'}：${x.text}`).join('\n')}` : '',
        `【现在】\n${busy}\n时段：${part}。心情：${moodNow()}。${weather}`,
        lifeContextLine(),
        '回复里若有什么值得记下来的事（主人的喜好、约定、近况），可以在最后另起一行写「[记] 一句话」；没有就不写。',
        `【这一轮主人说】\n${String(text).slice(0, 500)}`,
        '回复主人的这句话，口语、简短（一两句以内），不加引号和名字前缀。这一轮不能用任何工具，直接输出回复。',
      ].filter(Boolean).join('\n')
    }
    /**
     * 对话框一轮（POST /chat 同函数）。闸门顺序：开关 → 插件 → 桌宠在线 → 专注 → 并发锁 → 关键字拦截。
     * @returns {Promise<{ok:boolean, reason?:string, text?:string, viaWindow?:boolean, closed?:boolean, messageId?:string}>}
     */
    async function petChatOnce(rawText) {
      const st = petChatSettings()
      const text = String(rawText || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500)
      if (!text) return { ok: false, reason: 'empty' }
      if (!st.enabled) return { ok: false, reason: 'disabled' }
      if (api.config().enabled === false) return { ok: false, reason: 'plugin-off' }
      if (!online().online) return { ok: false, reason: 'pet-offline' }
      if (focusOn()) return { ok: false, reason: 'focus' }
      if (petChatBusy) return { ok: false, reason: 'thinking' }
      // 同步占锁：检查与置位之间不能再有 await，否则并发请求会一起通过检查（一审 #18-4）
      petChatBusy = true
      try {
        // 关键字拦截（服务端兜底；客户端发送前也会先查一遍）：命中直接关窗、不请求模型、不落历史
        if (st.closeKeyword && text.includes(st.closeKeyword)) {
          emit('chatClose', {})
          return { ok: true, closed: true }
        }
        const winOpen = chatWin.open && Date.now() - chatWin.at <= CHAT_WIN_TTL_MS
        const history = readChatHistoryRaw()
        const prevText = [...history].reverse().find((x) => x.role === 'user')?.text || ''
        const userMsgId = randomBytes(6).toString('hex')
        await appendChatHistory('user', text, userMsgId) // 落盘进锁链（与清理互斥；await 保证时序可测）
        let raw = ''
        try {
          const prompt = petChatPrompt(text, prevText)
          if (typeof api.think === 'function') {
            raw = await api.think(prompt, { title: PETCHAT_TURN_TITLE, timeoutMs: 120_000, noTools: true, key: PET_SESSION_KEY })
          } else if (typeof api.ask === 'function') { // 老宿主没有 api.think：退回单次问答（工作区看不到思考）
            raw = await api.ask({ text: prompt, maxTokens: 300, temperature: 0.8 })
          }
        } catch (error) {
          api.log.debug?.('对话框生成失败：', String(error?.message || error))
        }
        const { text: reply, memo } = parseChatReply(raw)
        if (!reply) {
          await appendChatHistory('pet', '（没答上来）')
          if (winOpen) emit('chat', { text: '（她走神了，再说一遍？）', messageId: randomBytes(6).toString('hex'), windowOpen: true })
          return { ok: false, reason: 'empty' }
        }
        if (memo) chatMemoryAdd(memo) // 模型决定记什么，不做自动全文提炼（防灌库）；about 归主人
        const messageId = randomBytes(6).toString('hex')
        await appendChatHistory('pet', reply, messageId)
        // 回复下发：对话框开着 → 进消息流；途中窗被关 → 走碎碎念气泡（同一套气泡渲染）。绝不发 QQ。
        const winOpenNow = chatWin.open && Date.now() - chatWin.at <= CHAT_WIN_TTL_MS
        if (winOpenNow) {
          emit('chat', { text: reply, messageId, windowOpen: true })
          return { ok: true, text: reply, viaWindow: true, messageId }
        }
        await dispatch({ text: reply.slice(0, 600), modality: 'text', purpose: 'whisper', via: 'pet', noFallback: true })
        return { ok: true, text: reply, viaWindow: false, messageId }
      } finally {
        petChatBusy = false
      }
    }
    function petChatStatus() {
      const st = petChatSettings()
      const winOpen = chatWin.open && Date.now() - chatWin.at <= CHAT_WIN_TTL_MS
      return {
        enabled: st.enabled, hotkey: st.hotkey, closeKeyword: st.closeKeyword, blurHide: st.blurHide,
        maxEntries: st.maxEntries, retentionDays: st.retentionDays, weatherCity: st.weatherCity,
        hotkeyState: hotkeyState.state, // 已注册 / 失败 / 未配置（面板回显注册状态用）
        windowOpen: winOpen, thinking: petChatBusy, turnTitle: PETCHAT_TURN_TITLE,
        historyCount: readChatHistoryRaw().length,
        weather: st.weatherCity ? (weatherCache.city === st.weatherCity ? weatherCache.text : '') : '',
        online: online().online,
      }
    }
    // ---------- 对话框路由（模块 route 全路径精确匹配，仓库铁律；逐条注册） ----------
    api.route('/chat', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const r = await petChatOnce(body.text)
      api.core.http.send(res, r.ok ? 200 : 400, r)
    })
    api.route('/chat/history', (req, res) => {
      if (!guard(req, res).ok) return
      learnHost(req)
      const q = api.core.http.query(req)
      const limit = Math.max(1, Math.min(2000, Math.round(Number(q.limit) || 50)))
      api.core.http.send(res, 200, { ok: true, items: chatHistory(limit) }) // 服务端截断后下发
    })
    // 客户端上报：对话框开合 + 快捷键注册状态（面板「状态」卡回显「已注册 / 失败 / 未配置」）
    api.route('/chat/state', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      if (body.open === true) chatWin = { open: true, at: Date.now() }
      else if (body.open === false) chatWin = { open: false, at: Date.now() }
      const hs = String(body.hotkey || '')
      if (['registered', 'failed', 'unconfigured'].includes(hs)) {
        hotkeyState = { state: hs, key: String(body.hotkeyKey || '').slice(0, 32), at: Date.now() }
      }
      api.core.http.send(res, 200, { ok: true, windowOpen: petChatStatus().windowOpen })
    })

    // ================= 桌面图标隔离区（第二批：drag_icon / hide_icon 的服务端执行层） =================
    // 铁律 2：「删除桌面图标」永远不是真删除——只有 rename 剪切到隔离区 + manifest 记录 + 可一键归还 + 超期自动归还。
    // 铁律 5：文件夹 / 隐藏文件 / 桌面系统图标（回收站、此电脑等 CLSID 命名的 .lnk）绝对不碰，只碰 .lnk/.url/普通文件。
    const quarantineDir = () => api.dataDir('desktop-quarantine')
    const manifestFile = () => join(quarantineDir(), 'manifest.json')
    const DAY_MS = 24 * 60 * 60_000
    // 可执行/脚本类扩展名一律拒绝（「只碰 .lnk/.url/普通文件」；这里用拒绝清单而不是白名单，
    // 因为「普通文件」本身无边——但最坏情况也只是被 rename 到隔离区，随时能放回，永不删除）。
    const ICON_EXT_DENY = new Set(['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.pif', '.jar', '.msc', '.cpl', '.dll', '.sys'])
    // 桌面系统/壳层文件（不以 . 开头但碰了会坏事；Node 读不到 Windows「隐藏」属性，只能按名字拦）
    const ICON_NAME_DENY = new Set(['desktop.ini', 'thumbs.db', 'iconcache.db'])
    // 桌面系统图标（回收站/此电脑…）以 CLSID GUID 命名，永远不碰
    const CLSID_RE = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}(\.|$)/
    /** 主人的桌面目录清单（2026-10-30 用户实测「收图标容易 not-found」）：
     *  资源管理器桌面是**合并视图**——用户桌面 + 公共桌面（PUBLIC\Desktop）一起显示，
     *  客户端 ListView 读到的图标清单就是合并视图（微信/QQ/Chrome 这类快捷方式全在公共桌面）。
     *  服务端以前只认用户桌面，客户端挑了公共桌面图标一发回来就 not-found。
     *  顺序即优先级：用户桌面在前（同名时以用户桌面为准）；测试注入 hooks.desktopDir 时只认注入目录。 */
    function desktopDirs() {
      const hooks = api.__petTestHooks || {}
      if (typeof hooks.desktopDir === 'function') { try { const d = hooks.desktopDir(); return d ? [d] : [] } catch {} }
      const up = String(process.env.USERPROFILE || '').trim()
      const pub = String(process.env.PUBLIC || '').trim()
      const cand = up
        ? [join(up, 'Desktop'), join(up, 'OneDrive', 'Desktop'), join(up, 'OneDrive', '桌面')]
        : []
      if (pub) cand.push(join(pub, 'Desktop'))
      return cand.filter((d) => { try { return d && existsSync(d) && statSync(d).isDirectory() } catch { return false } })
    }
    /** 兼容旧调用（只关心「有没有桌面」的地方）：返回第一个可用桌面。 */
    function detectDesktopDir() {
      return desktopDirs()[0] || null
    }
    /**
     * 列出桌面上「真能碰」的图标文件名（给 AI 挑目标 / 面板调试用）。
     * 与 validateDesktopIcon 同一套拒绝规则；跨目录合并去重（用户桌面优先）；
     * 读不到任何桌面就返回空数组，绝不抛。
     */
    function listDesktopIcons(limit = 30) {
      const dirs = desktopDirs()
      const seen = new Set()
      const out = []
      for (const desktop of dirs) {
        let names = []
        try { names = readdirSync(desktop) } catch { continue }
        for (const raw of names) {
          if (out.length >= limit) return out
          const n = String(raw)
          const key = n.toLowerCase()
          if (!n || seen.has(key)) continue
          seen.add(key)
          if (n.startsWith('.') || n.startsWith('~$')) continue
          if (ICON_NAME_DENY.has(key) || CLSID_RE.test(n)) continue
          if (ICON_EXT_DENY.has(extname(n).toLowerCase())) continue
          try { if (!statSync(join(desktop, n)).isFile()) continue } catch { continue }
          // 进 prompt 前把控制字符换成空格（防止文件名把简报结构搞乱）
          out.push(n.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60))
        }
      }
      return out
    }
    /** 把一个待碰的图标名解析成真实文件：多桌面目录 × （原名 → 补常见后缀）逐个 stat。
     *  补后缀治「客户端只能拿到显示名」：ListView 给「微信」，磁盘上是「微信.lnk」。
     *  @returns {{dir:string, name:string, path:string}|{notFile:boolean}|null} name 一定是**磁盘真名**；
     *          notFile = 名字真实存在但不是普通文件（文件夹/特殊项），调用方要单独报 not-file。 */
    function resolveDesktopFile(icon) {
      const raw = String(icon || '').trim()
      if (!raw || /[/\\]/.test(raw) || raw.includes('..')) return null
      const dirs = desktopDirs()
      for (const dir of dirs) {
        const p = join(dir, raw)
        try {
          const st = statSync(p)
          if (st.isFile()) return { dir, name: raw, path: p }
          return { notFile: true }
        } catch {}
      }
      for (const dir of dirs) {
        for (const ext of ['.lnk', '.url', '.exe']) {
          const name = raw + ext
          const p = join(dir, name)
          try { const st = statSync(p); if (st.isFile()) return { dir, name, path: p } } catch {}
        }
      }
      return null
    }
    /** 校验一个待碰的桌面图标名：必须直接躺在桌面（无路径分隔）、真实存在、是普通文件、不在拒绝名单。 */
    function validateDesktopIcon(icon) {
      const name = String(icon || '').trim()
      if (!name || name !== String(icon || '') || /[/\\]/.test(name) || name.includes('..')) return { ok: false, reason: 'bad-name', name }
      if (name.startsWith('.') || name.startsWith('~$')) return { ok: false, reason: 'hidden', name } // 隐藏文件/Office 临时锁不碰
      if (ICON_NAME_DENY.has(name.toLowerCase())) return { ok: false, reason: 'system-file', name } // desktop.ini 等壳层文件
      if (CLSID_RE.test(name)) return { ok: false, reason: 'system-icon', name } // 回收站/此电脑等系统图标
      const ext = extname(name).toLowerCase()
      if (ICON_EXT_DENY.has(ext)) return { ok: false, reason: 'bad-ext', name } // 可执行/脚本类拒绝
      if (!desktopDirs().length) return { ok: false, reason: 'desktop-not-found', name }
      const hit = resolveDesktopFile(name)
      if (!hit) return { ok: false, reason: 'not-found', name }
      if (hit.notFile) return { ok: false, reason: 'not-file', name } // 文件夹 / 特殊项一律拒绝
      // 补后缀命中的真实文件名要再过一遍拒绝规则（显示名「无限试用Navicat」→ 磁盘「无限试用Navicat.bat」必须拒）
      if (hit.name !== name) {
        if (hit.name.startsWith('.') || hit.name.startsWith('~$')) return { ok: false, reason: 'hidden', name }
        if (ICON_NAME_DENY.has(hit.name.toLowerCase())) return { ok: false, reason: 'system-file', name }
        if (ICON_EXT_DENY.has(extname(hit.name).toLowerCase())) return { ok: false, reason: 'bad-ext', name }
      }
      return { ok: true, path: hit.path, name: hit.name }
    }
    /** 读 manifest（数组：[{id,name,originalPath,quarantinePath,at,reason,playbackId}]）；脏数据一律丢弃，宁可少一条也不让面板炸。 */
    function loadManifest() {
      const m = readJson(manifestFile(), null)
      if (!Array.isArray(m)) return []
      return m.filter((x) => x && typeof x === 'object'
        && typeof x.id === 'string' && x.id
        && typeof x.name === 'string' && x.name
        && typeof x.originalPath === 'string' && x.originalPath
        && typeof x.quarantinePath === 'string' && x.quarantinePath)
        .map((x) => ({
          id: x.id, name: x.name, originalPath: x.originalPath, quarantinePath: x.quarantinePath,
          at: Number(x.at) || 0, reason: String(x.reason || ''), playbackId: String(x.playbackId || ''),
        }))
    }
    function saveManifest(list) { try { mkdirSync(quarantineDir(), { recursive: true }); writeJsonAtomic(manifestFile(), list) } catch (e) { api.log.warn(`隔离区清单写盘失败：${e.message}`) } }
    /**
     * 「挪文件」的唯一实现（隔离与归还共用）：先试 rename（真正的剪切，原子）；
     * 跨卷时（桌面在 OneDrive/另一块盘，插件数据目录在别的盘）rename 会抛 EXDEV，退化为
     * 拷贝 → 校验大小一致 → 删源。注意这不是「删除」：拷贝已落地且大小对得上才动源文件，
     * 任何一步对不上就放弃并保留原文件（铁律 2：删除不存在，只有挪来挪去）。
     */
    function moveFile(src, dest) {
      // 单测注入点（api.__petTestHooks.rename）：模拟跨卷 EXDEV，验证拷贝退化分支
      const rename = typeof api.__petTestHooks?.rename === 'function' ? api.__petTestHooks.rename : renameSync
      try { rename(src, dest); return { ok: true, mode: 'rename' } } catch (error) {
        if (error?.code !== 'EXDEV') throw error // 别的错（占用/权限/已存在）原样抛给调用方记 failed
      }
      copyFileSync(src, dest)
      const srcSize = statSync(src).size
      const destSize = statSync(dest).size
      if (srcSize !== destSize) {
        try { unlinkSync(dest) } catch {} // 只清掉我们自己那份不完整的拷贝，真正的主人文件没动
        throw new Error('跨卷拷贝大小不一致，已放弃（源文件未动）')
      }
      unlinkSync(src) // 到这里目标已有一份完整拷贝，源文件才算「挪走」
      return { ok: true, mode: 'copy' }
    }
    /** 隔离区里重名时加序号：「某.lnk」→「某(1).lnk」。 */
    function dedupePath(dir, name) {
      let p = join(dir, name)
      if (!existsSync(p)) return p
      const ext = extname(name); const base = basename(name, ext)
      for (let i = 1; i < 999; i++) { p = join(dir, `${base}(${i})${ext}`); if (!existsSync(p)) return p }
      return join(dir, `${base}(${randomBytes(2).toString('hex')})${ext}`)
    }
    /** 行为回执（复用第一批 /playback 的模式：写 recent 供下轮简报 + 尽量写一条短记忆），失败只 log 不炸。 */
    function iconReceipt(line, memText) {
      try {
        const st = loadBehavior()
        st.recent = [...st.recent, line].slice(-8)
        saveBehavior(st)
        if (memText) api.use('memory')?.add?.({ text: memText, importance: 0.5, source: 'pet' })
      } catch (error) { api.log.warn('图标动作回执落盘失败：', String(error?.message || error)) }
    }
    /**
     * 执行入口（面板按钮 / 客户端动画落点共用）：
     *   POST /behavior/icon/act  body {mode:'hide'|'drag', icon:'文件名', playbackId?, force?, reason?}
     *   → hide：renameSync 剪切到隔离区 + manifest 追加；drag：只校验存在不挪文件。
     * iconMischiefEnabled 只拦 AI 路径（force=false）；手动 force=true 的测试按钮不拦。
     * @returns {{ok:boolean, id?:string, name:string, acted?:boolean, originalPath?:string, reason?:string}}
     */
    function iconAct({ mode, icon, playbackId, force, reason } = {}) {
      const b = behaviorSettings()
      const isForce = force === true
      // 失败一律回 acted:false，客户端据此不播「得逞」动画，只播「没得手」
      if (!b.iconMischiefEnabled && !isForce) return { ok: false, acted: false, reason: 'icon-mischief-disabled', name: String(icon || '') }
      const v = validateDesktopIcon(icon)
      if (!v.ok) return { ok: false, acted: false, reason: v.reason, name: v.name }
      const kind = mode === 'drag' ? 'drag' : mode === 'hide' ? 'hide' : ''
      if (!kind) return { ok: false, acted: false, reason: 'bad-mode', name: v.name }
      if (kind === 'drag') {
        // drag_icon：图标由客户端在 ListView 层挪着玩（跟着桌宠走），结束时自己放回原位；
        // 服务端依旧不碰文件系统（只记一条回执）。
        iconReceipt(`drag_icon → ${v.name}（图标被拖了一圈又放回去）`, '')
        return { ok: true, acted: false, name: v.name }
      }
      try {
        const id = randomBytes(4).toString('hex')
        mkdirSync(quarantineDir(), { recursive: true })
        const dest = dedupePath(quarantineDir(), v.name)
        moveFile(v.path, dest) // 唯一的「挪」动作：rename 剪切（跨卷退化为拷贝+校验），绝不删除
        const list = loadManifest()
        list.push({ id, name: v.name, originalPath: v.path, quarantinePath: dest, at: Date.now(), reason: String(reason || 'hide_icon').slice(0, 60), playbackId: String(playbackId || '').slice(0, 32) })
        saveManifest(list)
        iconReceipt(`hide_icon → ${v.name} 已收进隔离区（可放回）`, `桌宠把桌面图标「${v.name}」收进了隔离区，随时可以在面板放回去`)
        return { ok: true, acted: true, id, name: v.name, originalPath: v.path }
      } catch (error) {
        api.log.warn('图标收进隔离区失败：', String(error?.message || error))
        return { ok: false, acted: false, reason: 'hide-failed', name: v.name }
      }
    }
    /** 归还核心：rename 回原路径；原路径已有同名文件则改名「名字(归还)」再放。绝不删除。 */
    function restoreOne(item) {
      let target = item.originalPath
      try {
        if (!existsSync(item.quarantinePath)) return { ok: false, reason: 'quarantine-file-gone' }
        if (existsSync(target)) {
          const ext = extname(item.name); const base = basename(item.name, ext)
          target = join(dirname(item.originalPath), `${base}(归还)${ext}`)
          if (existsSync(target)) target = dedupePath(dirname(item.originalPath), `${base}(归还)${ext}`)
        }
        mkdirSync(dirname(target), { recursive: true })
        moveFile(item.quarantinePath, target) // 归还同样只挪不删（跨卷退化见 moveFile）
        return { ok: true, target }
      } catch (error) {
        api.log.warn('图标归还失败：', String(error?.message || error))
        return { ok: false, reason: 'restore-failed' }
      }
    }
    /** 面板「放回去」：POST /behavior/icon/restore {id}。 */
    async function iconRestore(id) {
      const list = loadManifest()
      const idx = list.findIndex((x) => x && x.id === id)
      if (idx < 0) return { ok: false, reason: 'not-found' }
      const item = list[idx]
      const r = restoreOne(item)
      if (!r.ok) {
        // 隔离区里的文件已经不在了（主人自己挪走/删了）：把这条死记录清掉，别让面板挂着点不动的按钮
        if (r.reason === 'quarantine-file-gone') { list.splice(idx, 1); saveManifest(list) }
        return { ok: false, reason: r.reason, name: item.name }
      }
      list.splice(idx, 1)
      saveManifest(list)
      iconReceipt(`hide_icon → ${item.name} 已放回原位`, `桌宠把桌面图标「${item.name}」放回原位了`)
      // 气泡汇报：只走桌宠气泡，失败静默（归还本身已经完成，别让汇报失败坏事）
      try { await dispatch({ text: `把「${item.name}」放回去啦`, purpose: 'behavior', via: 'pet', noFallback: true }) } catch {}
      return { ok: true, name: item.name, restoredTo: r.target }
    }
    /** 超期自动归还：每 10 分钟扫一次 manifest，超 iconQuarantineDays（默认 7 天）全部放回并气泡汇报一次。 */
    async function iconSweep(now = Date.now()) {
      const b = behaviorSettings()
      const cutoff = now - b.iconQuarantineDays * DAY_MS
      const list = loadManifest()
      // 隔离区文件已不在的死记录（主人自己挪走/清理过）：顺手摘掉，不碰任何文件
      const dead = new Set(list.filter((x) => !existsSync(x.quarantinePath)).map((x) => x.id))
      const expired = list.filter((x) => Number(x.at || 0) < cutoff && !dead.has(x.id))
      const flush = (keep) => { try { saveManifest(keep) } catch {} }
      if (!expired.length) {
        if (dead.size) flush(list.filter((x) => !dead.has(x.id)))
        return { ok: true, restored: 0 }
      }
      const names = []
      const done = new Set()
      for (const item of expired) {
        if (done.has(item.id)) continue
        done.add(item.id)
        const r = restoreOne(item)
        if (r.ok) { names.push(item.name); iconReceipt(`hide_icon → ${item.name} 超期自动放回`, '') }
      }
      flush(list.filter((x) => !done.has(x.id) && !dead.has(x.id)))
      if (names.length) {
        try { await dispatch({ text: `把收走的图标都放回去啦：${names.join('、')}`, purpose: 'behavior', via: 'pet', noFallback: true }) } catch {}
      }
      return { ok: true, restored: names.length, names }
    }

    // ---------- 路由 ----------
    api.route('/events', (req, res) => pollEvents(req, res))
    // ---------- 宠物数值（状态卡 / 面板 / 右键喂食都用这一组） ----------
    api.route('/life', (req, res) => {
      if (!guard(req, res).ok) return
      const q = api.core.http.query(req)
      const petId = String(q.pet || 'main').slice(0, 16)
      const now = Date.now()
      api.core.http.send(res, 200, {
        ok: true,
        life: lifeSnapshot(petId, { now }),
        say: sayQueue.snapshot(now),
        settings: lifeSettings(),
      })
    })
    // 让时间前进 N 分钟（面板「模拟一下」+ 测试用；也可当成「她不在的时候过了多久」的手动补算）
    // 为什么要这个路由：数值是按真实时间慢慢走的（饱腹 12 小时才从饱到饿），
    // 没有它就没法验证「饿了她会说什么」——只能真等半天。给一个显式的、可控的入口。
    api.route('/life/tick', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const minutes = Math.max(1, Math.min(60 * 24 * 30, Number(body.minutes) || 5))
      const r = lifeTick({ minutes })
      api.core.http.send(res, 200, { ...r, minutes, life: lifeSnapshot('main') })
    })
    // 重置这一只的数值（二次确认在前端；不碰动作覆盖和记忆）
    api.route('/life/reset', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const petId = String(body.pet || 'main').slice(0, 16)
      const st = Life.freshState(Date.now())
      setLife(petId, st)
      api.core.http.send(res, 200, { ok: true, life: lifeSnapshot(petId) })
    })
    // 喂食：POST { food, pet? }
    api.route('/life/feed', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const food = String(body.food || '').slice(0, 40)
      const petId = String(body.pet || 'main').slice(0, 16)
      if (!Life.findFood(food)) return api.core.http.send(res, 400, { ok: false, message: '没有这种食物' })
      const r = lifeFeed(food, { petId })
      if (!r.ok) return api.core.http.send(res, 200, { ok: false, reason: r.reason, waitMs: r.waitMs || 0, life: lifeSnapshot(petId) })
      api.core.http.send(res, 200, { ok: true, food: r.food, life: r.snapshot })
    })
    // 互动上报：POST { kind, pet? }（客户端点击 / 摸摸 / 甩出去都走这里）
    api.route('/life/touch', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const kind = String(body.kind || '').slice(0, 32)
      const petId = String(body.pet || 'main').slice(0, 16)
      const r = lifeInteract(kind, { petId })
      api.core.http.send(res, 200, r.ok ? { ok: true, xp: r.xp, life: r.snapshot } : { ok: false, reason: r.reason, life: lifeSnapshot(petId) })
    })
    // 专注完成奖励一份零食（番茄钟 / 专注轮次结束时打这个）
    api.route('/life/snack', async (req, res) => {
      if (!guard(req, res).ok) return
      const r = lifeRewardSnack()
      api.core.http.send(res, 200, { ...r, life: lifeSnapshot('main') })
    })
    // 攒着没说的话（面板「她被攒下来的几句」+ 调试）
    api.route('/say/pending', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, { ok: true, ...sayQueue.snapshot(Date.now()) })
    })
    // 手动把攒着的话倒出来（「现在就让她说」）
    api.route('/say/flush', async (req, res) => {
      if (!guard(req, res).ok) return
      const now = Date.now()
      const blocked = sayBlockedNow(now)
      if (blocked) return api.core.http.send(res, 200, { ok: false, reason: blocked, ...sayQueue.snapshot(now) })
      const item = sayQueue.next(sayContext(now))
      if (!item) return api.core.http.send(res, 200, { ok: true, said: 0 })
      const r = await flushOne(item)
      api.core.http.send(res, 200, { ok: true, said: 1, text: item.text, via: r })
    })
    // 清空攒着的话（换宠物 / 关桌宠 / 用户说「别念了」）
    api.route('/say/clear', async (req, res) => {
      if (!guard(req, res).ok) return
      sayQueue.clear()
      api.core.http.send(res, 200, { ok: true })
    })
    api.route('/status', (req, res) => {
      if (!guard(req, res).ok) return
      learnHost(req)
      const s = api.settings()
      api.core.http.send(res, 200, {
        ok: true, name: 'aurabot-pet', version: api.version,
        online: online(), focus: focusOn(), scale: petScale(), releaseLand: petReleaseLand(), bootId, seq,
        // 上游 1.0.14：面板守卫读的就是这几项（物理两键沿用本地 physicsGravity/physicsRestitution 的 /config 下发）
        animRate: petAnimRate(), balanceEnabled: petShowBalance(),
        clickChase: petClickChase(), teaseChase: petTeaseChase(),
        house: houseStatus(), // 上游 1.0.12：小屋素材与开关状态
        carrier: s.carrier, modality: s.modality, fallbackToQQ: s.petFallbackToQQ !== false,
        pack: activePack(), playbackCount: playbacks.length,
        work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '' }, // 当前她在干什么（思考中/干活中/完成…）
        whisper: { ...whisperStatus() },
        chat: petChatStatus(), // 对话框（快捷键注册状态回显在这）：已注册 / 失败 / 未配置
        todo: todoPending(),   // 待办计数：未完成的本地的 + DSH 那边的
        // 配置校验结果：面板「配置歪了」提示用（空数组 = 全都合法）
        settingsWarnings: settingsAudit.slice(0, 20),
        // 宠物数值 / 说话让路（和导出里的 status() 必须同步 —— 那是给宿主面板用的，这份是给 HTTP 用的，
        // 两处都要有，否则「面板看得见、接口看不见」或者反过来）
        life: lifeSnapshot('main'),
        lifeSettings: lifeSettings(),
        say: sayQueue.snapshot(),
        balance: (() => { const s = api.settings(); return { enabled: s.petBalanceEnabled !== false, configured: Boolean(String(s.petBalanceKey || '').trim()) } })(),
        hear: { enabled: api.settings().petHearEnabled !== false, ready: Boolean(resolveModelDir(String(api.settings().petHearModelDir || '').trim())) },
        portReady: portReady(), port: knownPort ? Number(knownPort) : null,
        electronInstalled: existsSync(electronExe()), pid: recordedPid()?.pid || null,
        client: clientStatus(), // 生成物对账：缺 behavior.js 这类「旧壳」在这里现形
        remoteClient: Boolean(publicBase()), publicBaseUrl: publicBase() ? publicBase().url : '', // 面板据此切「下载客户端包」分支
        // 安全状态：面板据此提示「明文会被阻断 / 令牌已过期 / 可轮换」
        publicBaseInsecure: publicBaseInsecure(), allowInsecureRemote: insecureRemoteAllowed(),
        tokenExpired: tokenExpired(), tokenIssuedAt: tokenIssuedAt || null,
        tokenTtlDays: Number(api.settings().tokenTtlDays) || 0,
        hostFile: hostFile(), clientDir: api.dataDir('app'), serverTime: Date.now(),
      })
    })
    api.route('/config', (req, res) => {
      if (!guard(req, res).ok) return
      learnHost(req)
      ensureAssetRoutes()
      const s = api.settings()
      api.core.http.send(res, 200, {
        ok: true,
        carrier: s.carrier, modality: s.modality, fallbackToQQ: s.petFallbackToQQ !== false,
        focus: focusOn(),
        moods: ['very-happy', 'happy', 'neutral', 'low', 'sad'],
        pack: packView(), // 动画池/权重/事件映射/物理参数 + 干活状态/碎碎念动画映射；null = 没素材，客户端走静态形象
        // 人物大小倍率（0.5~2.0）：客户端按它整窗等比缩放（setZoomFactor + setSize），物理/拖拽共用窗口宽反推
        scale: petScale(),
        // 松手后落地开关：false = 客户端松手后停在原地（不抛不落）；缺省当 true
        releaseLand: petReleaseLand(),
        // 上游 1.0.14：互动开关与节奏（客户端按这份决定右键菜单项/反应层闸/轮播间隔）
        animRate: petAnimRate(),
        balanceEnabled: petShowBalance(),
        clickChase: petClickChase(),
        teaseChase: petTeaseChase(),
        // 上游 1.0.12：小屋开关（客户端据此决定右键「回小屋」显不显示）
        houseEnabled: petHouseEnabled(),
        work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '' },
        whisper: (({ enabled, source }) => ({ enabled, source }))(whisperStatus()),
        // 行为层：客户端的**反应层**（点击/勾引/摸摸/鼠标闲置）是本地直接演的，不看这一份的话
        // 面板关掉「行为总开关」根本拦不住它、鼠标闲置分钟数也永远是默认值（2026-10-30 补）。
        // disabledActions（2026-11-01 补）：面板「AI 动作表」开关关掉追鼠标/叼鼠标后，客户端反应层
        // 也不能再抓鼠标——反应层之前只看 enabled，禁用清单不下发就是「关了还抓」的病根。
        behavior: (() => { const b = behaviorSettings(); return { enabled: b.enabled, idleCursorMinutes: b.idleCursorMinutes, disabledActions: b.disabledActions } })(),
        // 对话框：客户端按这份做快捷键注册 / 关键字关闭 / 失焦收起（配置变更路径，不只启动一次）
        chat: (() => { const c = petChatSettings(); return { enabled: c.enabled, hotkey: c.hotkey, closeKeyword: c.closeKeyword, blurHide: c.blurHide } })(),
        // 待办：客户端按这份注册快捷键、决定要不要画角标（清单本体走 /todos 单独拉）
        todo: { enabled: s.petTodoEnabled !== false, hotkey: String(s.petTodoHotkey || '').trim(), pending: todoPending() },
        // 按住说话：开关 + 识别后去向（模型在不在不影响这里，识别失败会回一句原因）
        hear: { enabled: s.petHearEnabled !== false, sendToChat: s.petHearSendToChat !== false },
        // 多开：额外养几只（客户端按它恢复数量；改了这个值要重启客户端才生效）
        extraPets: Math.max(0, Math.min(EXTRA_MAX, Math.round(Number(s.petExtraCount) || 0))),
        // 多开：每一只各自的名字 / 形象包 / 大小（index = 槽位，与客户端的 pet-<index+1> 一一对应）。
        // 客户端据此给每只单独推素材表、单独设窗口大小；pack 为空表示「跟随主宠物」。
        extraSlots: loadExtraPets().map((it, i) => ({
          slot: i, name: extraNameOf(it, i), pack: extraPackOf(it) || '', scale: extraScaleOf(it),
        })),
        // 多开：每只自己那个形象包的**完整视图**（与主宠物 pack 同构）。
        // 客户端只有 renderer 那层，读不了 packs 目录，所以由服务端一次算好按包名递过去；
        // 这样「第二只换成别的形象」不用另起一条配置链，也不用客户端再解析一遍。
        extraPackViews: (() => {
          const out = {}
          for (const name of new Set(loadExtraPets().map((it) => extraPackOf(it)).filter(Boolean))) {
            try { out[name] = packView(name) } catch { out[name] = null }
          }
          return out
        })(),
        serverTime: Date.now(),
      })
    })
    // ---------- 余额（GET 读缓存 / POST 查一次 / POST /balance/say 播报一次） ----------
    api.route('/balance', async (req, res) => {
      if (!guard(req, res).ok) return
      const s = api.settings()
      const method = String(req.method || 'GET').toUpperCase()
      let manual = false
      if (method === 'POST') {
        const body = await api.core.http.body(req)
        manual = body?.refresh !== false
      }
      if (manual) await refreshBalance(true)
      const c = balanceCache || { ok: false, reason: 'never', message: '还没查过' }
      const w = c.ok ? balanceWallet() : null
      api.core.http.send(res, 200, {
        ok: true,
        enabled: s.petBalanceEnabled !== false,
        configured: Boolean(String(s.petBalanceKey || '').trim()),
        result: c,
        wallet: w,
        // 展示层照这个渲染（金额 + 档位 + 台词），别在前端再算一遍口径
        view: (c.ok && w) ? balanceSay(w) : null,
      })
    })
    api.route('/balance/say', async (req, res) => {
      if (!guard(req, res).ok) return
      const info = await balanceAnnounce(true)
      if (!info) return api.core.http.send(res, 200, { ok: false, message: balanceCache?.message || '余额查不到' })
      api.core.http.send(res, 200, { ok: true, ...info })
    })
    // ---------- 按住说话：客户端录一段 WAV（base64）→ 本地识别 → 文字 ----------
    // 走客户端录音而不是插件录音：Electron 渲染页有 getUserMedia，插件进程没有麦克风权限。
    // 识别在插件进程里做（客户端是纯渲染进程，加载不了原生 addon）。
    api.route('/voice/hear', async (req, res) => {
      if (!guard(req, res).ok) return
      if (api.settings().petHearEnabled === false) {
        return api.core.http.send(res, 200, { ok: false, reason: 'disabled', message: '按住说话关着（面板里打开）' })
      }
      const body = await api.core.http.body(req)
      const encoded = String(body?.audio || '').trim()
      if (!encoded) return api.core.http.send(res, 400, { ok: false, reason: 'bad-request', message: '没收到音频' })
      // base64 先挡脏数据：Buffer.from 解码很宽松，非法字符会被静默丢掉
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1) {
        return api.core.http.send(res, 400, { ok: false, reason: 'bad-request', message: 'audio 必须是 base64' })
      }
      const wav = Buffer.from(encoded, 'base64')
      if (wav.length < 44) return api.core.http.send(res, 400, { ok: false, reason: 'bad-request', message: '音频太短' })
      // 24 秒 × 32KB/s ≈ 750KB；再长就属于「按住不放」，不该白跑一次推理
      if (wav.length > 800 * 1024) return api.core.http.send(res, 400, { ok: false, reason: 'bad-request', message: '录音太长了（最多 24 秒）' })
      const r = await transcribeWav(wav, { modelDir: String(api.settings().petHearModelDir || '').trim() })
      if (!r.ok) {
        api.log.warn(`按住说话识别失败（${r.reason}）：${r.message}`)
        return api.core.http.send(res, 200, { ok: false, reason: r.reason, message: r.message })
      }
      const text = String(r.text || '').trim()
      if (!text) return api.core.http.send(res, 200, { ok: true, text: '', empty: true })
      api.core.http.send(res, 200, { ok: true, text })
    })
    // 语音识别可用性（面板与客户端启动时问一次：模型在不在、addon 能不能加载）
    api.route('/voice/status', (req, res) => {
      if (!guard(req, res).ok) return
      const s = api.settings()
      const dir = resolveModelDir(String(s.petHearModelDir || '').trim())
      api.core.http.send(res, 200, {
        ok: true,
        enabled: s.petHearEnabled !== false,
        sendToChat: s.petHearSendToChat !== false,
        modelDir: dir || '',
        ready: Boolean(dir),
        message: dir ? '' : '没找到 SenseVoice 模型（DSH 面板里下载语音输入模型，或在桌宠设置里填目录）',
      })
    })
    // ---------- 多开（面板「再养几只」用；不用动插件本体的 host.js） ----------
    // 四条面板接口都先写成具名函数，再**同一个函数注册两次**（根路径 + /ext/pet 别名）：
    // 面板里 call('/x') 打的是 /aurabot/api/ext/pet/x，而 pet 属于 core/modules.js 的
    // STABLE_ROUTES（line 31），模块路由不带前缀、全挂在根上。两边对不上时面板每个请求都回
    // { moduleOff: true } —— 不报错，只表现成「永远显示没在线、点了没反应」，最难查。
    // 用同一个函数挂两处，既修好面板，也不会长出第二套会漂移的实现。
    const extraStatusHandler = async (req, res) => {
      if (!guard(req, res).ok) return
      const s = api.settings()
      const want = Math.max(0, Math.min(EXTRA_MAX, Math.round(Number(s.petExtraCount) || 0)))
      let have = 0
      let list = []
      try {
        if (online().online) {
          const r = await debugAsk('debugIpc', { act: 'pet-list' })
          const out = (r && r.result) || {}
          have = Number(out.count) || 0
          list = Array.isArray(out.list) ? out.list : []
        }
      } catch {}
      api.core.http.send(res, 200, { ok: true, want, have, list, online: online().online })
    }
    const extraCountHandler = async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const n = Number(body?.count)
      if (!Number.isFinite(n)) return api.core.http.send(res, 400, { ok: false, message: 'count 必须是数字' })
      const want = Math.min(EXTRA_MAX, Math.max(0, Math.round(n)))
      api.saveSettings({ petExtraCount: want })
      if (!online().online) return api.core.http.send(res, 200, { ok: true, want, have: 0, message: '记下了，桌宠在线后按这个数量恢复' })
      let have = 0
      try {
        const r = await debugAsk('debugIpc', { act: 'pet-set-count', count: want })
        const out = (r && r.result) || {}
        have = Number(out.count) || 0
      } catch {}
      api.core.http.send(res, 200, { ok: true, want, have, count: have })
    }
    // GET：返回 4 个槽位（含上限与可选的包清单）+ 当前生效的主宠物包，面板据此渲染下拉
    const extraPetsHandler = (req, res) => {
      if (!guard(req, res).ok) return
      const slots = loadExtraPets()
      api.core.http.send(res, 200, {
        ok: true,
        max: EXTRA_MAX,
        want: Math.max(0, Math.min(EXTRA_MAX, Math.round(Number(api.settings().petExtraCount) || 0))),
        slots,
        packs: listPacks().map((p) => ({ name: p.name, anims: p.anims.length })),
        mainPack: activePack() || '',
        mainScale: petScale(),
        online: online().online,
      })
    }
    // POST：只改一只（其余三只原样保留）。body: { slot, name?, pack?, scale?, persona?, whisper? }
    const extraPetHandler = async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const idx = Number(body?.slot)
      if (!Number.isFinite(idx) || idx < 0 || idx >= EXTRA_MAX) {
        return api.core.http.send(res, 400, { ok: false, message: `slot 只能是 0~${EXTRA_MAX - 1}` })
      }
      const patch = {}
      if (body.name !== undefined) patch.name = body.name
      // 形象包：空串 = 跟随主宠物；写了就以名字为准（存在性在 loadExtraPets 读的时候体现为 missing）
      if (body.pack !== undefined) {
        const p = String(body.pack || '').trim()
        if (p && !listPacks().some((x) => x.name === p)) {
          return api.core.http.send(res, 400, { ok: false, message: `没有叫「${p}」的形象包` })
        }
        patch.pack = p
      }
      // 大小：0 = 跟随主宠物的 petScale；否则 0.5~2
      if (body.scale !== undefined) {
        const n = Number(body.scale)
        if (!Number.isFinite(n)) return api.core.http.send(res, 400, { ok: false, message: 'scale 必须是数字' })
        patch.scale = n <= 0 ? 0 : Math.min(2, Math.max(0.5, n))
      }
      if (body.persona !== undefined) patch.persona = String(body.persona || '')
      if (body.whisper !== undefined) patch.whisper = body.whisper !== false
      const r = patchExtraPet(idx, patch)
      if (!r.ok) return api.core.http.send(res, 400, r)
      api.core.http.send(res, 200, r)
    }
    // 每条都挂两处：根路径（客户端 / 既有调用用）+ /ext/pet 别名（面板的 call() 用）。
    api.route('/extra/status', extraStatusHandler)
    api.route('/extra/count', extraCountHandler)
    api.route('/extra/pets', extraPetsHandler)
    api.route('/extra/pet', extraPetHandler)
    api.route('/ext/pet/extra/status', extraStatusHandler)
    api.route('/ext/pet/extra/count', extraCountHandler)
    api.route('/ext/pet/extra/pets', extraPetsHandler)
    api.route('/ext/pet/extra/pet', extraPetHandler)
    // ---------- 待办（todo.html 小窗用；对齐 dsh-pet 的 /todos 语义） ----------
    // 只对 local 条目写盘；dsh 镜面条目一律 409 —— 那是 DSH 自己的清单，这里改了也不会同步回去，
    // 与其让主人以为改成功了，不如明说「这条是 DSH 那边的，得去那儿改」。
    const todoIsDsh = (id) => String(id).startsWith('dsh:')
    api.route('/todos', async (req, res) => {
      if (!guard(req, res).ok) return
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        return api.core.http.send(res, 200, { ok: true, todos: todoView(), pending: todoPending() })
      }
      if (method !== 'POST') return api.core.http.send(res, 405, { ok: false, message: '只支持 GET/POST' })
      const raw = await api.core.http.body(req)
      const text = String(raw?.text || '').trim().slice(0, TODO_TEXT_MAX)
      if (!text) return api.core.http.send(res, 400, { ok: false, message: `text 必须是 1~${TODO_TEXT_MAX} 个字的正文` })
      let dueAt = null
      if (raw?.dueAt !== undefined && raw?.dueAt !== null) {
        const n = Number(raw.dueAt)
        if (!Number.isFinite(n)) return api.core.http.send(res, 400, { ok: false, message: 'dueAt 必须是毫秒时间戳或 null' })
        // 过去的时刻建出来就是逾期，提醒一上线就会喊：直接拦掉，别让主人先错一次再改
        if (n < Date.now()) return api.core.http.send(res, 400, { ok: false, message: '这个时间已经过去了，换一个吧' })
        dueAt = n
      }
      const now = Date.now()
      const list = loadTodos()
      const todo = { id: todoId(), text, dueAt, done: false, createdAt: now, updatedAt: now, completedAt: null, src: 'local', lastRemindedAt: null }
      saveTodos([...list, todo])
      emit('todo', { pending: todoPending() })
      api.core.http.send(res, 200, { ok: true, todo })
    })
    api.route('/todos/patch', async (req, res) => {
      if (!guard(req, res).ok) return
      const raw = await api.core.http.body(req)
      const id = String(raw?.id || '').trim()
      if (!id) return api.core.http.send(res, 400, { ok: false, message: '缺 id' })
      if (todoIsDsh(id)) return api.core.http.send(res, 409, { ok: false, message: '这条是 DSH 那边的任务清单，只能在那儿改' })
      const list = loadTodos()
      const idx = list.findIndex((t) => t.id === id)
      if (idx < 0) return api.core.http.send(res, 404, { ok: false, message: '没有这条待办' })
      const cur = list[idx]
      const next = { ...cur, updatedAt: Date.now() }
      if (raw?.text !== undefined) {
        const text = String(raw.text).trim().slice(0, TODO_TEXT_MAX)
        if (!text) return api.core.http.send(res, 400, { ok: false, message: 'text 不能为空' })
        next.text = text
      }
      if (raw?.dueAt !== undefined) {
        if (raw.dueAt === null) next.dueAt = null
        else {
          const n = Number(raw.dueAt)
          if (!Number.isFinite(n)) return api.core.http.send(res, 400, { ok: false, message: 'dueAt 必须是毫秒时间戳或 null' })
          next.dueAt = n
        }
        // 改了期限要重新排期，否则「上次提醒时刻 + 旧档位」会把它一直压在旧节奏上
        next.lastRemindedAt = null
      }
      if (raw?.done !== undefined) {
        if (typeof raw.done !== 'boolean') return api.core.http.send(res, 400, { ok: false, message: 'done 必须是布尔值' })
        next.done = raw.done
        next.completedAt = raw.done ? Date.now() : null
        if (raw.done) next.lastRemindedAt = null
      }
      list[idx] = next
      saveTodos(list)
      emit('todo', { pending: todoPending() })
      api.core.http.send(res, 200, { ok: true, todo: next })
    })
    api.route('/todos/remove', async (req, res) => {
      if (!guard(req, res).ok) return
      const raw = await api.core.http.body(req)
      const id = String(raw?.id || '').trim()
      if (!id) return api.core.http.send(res, 400, { ok: false, message: '缺 id' })
      if (todoIsDsh(id)) return api.core.http.send(res, 409, { ok: false, message: '这条是 DSH 那边的任务清单，只能在那儿删' })
      const list = loadTodos()
      const next = list.filter((t) => t.id !== id)
      if (next.length === list.length) return api.core.http.send(res, 404, { ok: false, message: '没有这条待办' })
      saveTodos(next)
      emit('todo', { pending: todoPending() })
      api.core.http.send(res, 200, { ok: true, removed: true })
    })
    api.route('/packs', (req, res) => {      if (!guard(req, res).ok) return
      learnHost(req)
      ensureAssetRoutes()
      api.core.http.send(res, 200, { ok: true, active: activePack(), packs: listPacks() })
    })
    api.route('/pack', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const name = String(body.name || '').trim()
      if (!NAME_RE.test(name) || !listPacks().some((p) => p.name === name)) {
        return api.core.http.send(res, 404, { ok: false, message: `没有形象包「${name}」（packs/ 下要有 <名>-animation/ 目录）` })
      }
      api.saveSettings({ pack: name })
      ensureAssetRoutes()
      emit('pack', { pack: name })
      api.core.http.send(res, 200, { ok: true, pack: packView() })
    })
    // 出生点（角落 + 边距）：模块自己落盘。
    // 注意面板**不能**直接打这条 /position：模块路由全部过 guard()，要 pet 的 bearer 令牌，
    // 而令牌在数据目录里、浏览器拿不到。面板走核心的 /panel/pet/position（host.js 代理到这个 setPosition）。
    function setPosition(body) {
      const b = body && typeof body === 'object' ? body : {}
      const patch = {}
      const corner = String(b.corner || '')
      if (['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(corner)) patch.petCorner = corner
      // 入参既接受面板的短名（marginX/marginY），也接受设置里的全名（petMarginX/petMarginY）
      for (const [out, hi] of [['petMarginX', 2000], ['petMarginY', 2000]]) {
        const raw = b[out] != null ? b[out] : b[out === 'petMarginX' ? 'marginX' : 'marginY']
        if (raw != null && Number.isFinite(Number(raw))) patch[out] = Math.min(hi, Math.max(0, Math.round(Number(raw))))
      }
      if (!Object.keys(patch).length) return { ok: false, message: '没有可保存的字段' }
      api.saveSettings(patch)
      emit('config', { position: petPosition() }) // 客户端下一轮 /config 就能拿到新角落并挪过去
      return { ok: true, position: petPosition() }
    }
    api.route('/position', async (req, res) => {
      if (!guard(req, res).ok) return
      if (req.method !== 'POST') return api.core.http.send(res, 200, { ok: true, position: petPosition() })
      const r = setPosition(await api.core.http.body(req))
      api.core.http.send(res, r.ok ? 200 : 400, r)
    })
    // ---------- 默认素材包（手动重下）：POST /packs/fetch-default，body 留空 {} 即可 ----------
    // force=true：包已在也重新下载（换镜像地址后点这个）。自动落位走启动后 5 秒 + every 兜底轮询。
    api.route('/packs/fetch-default', async (req, res) => {
      if (!guard(req, res).ok) return
      const r = await ensureDefaultPack(true)
      ensureAssetRoutes()
      api.core.http.send(res, r.ok ? 200 : 502, r)
    })
    // ---------- 诊断：动画有没有被舞台切掉（debugCrop / debugMeasure） ----------
    // 用途：量「人物包围盒 vs 240×240 舞台」的真实比例，判断某些动画是不是超出框被裁。
    // 流程：POST /debug/crop（或 /debug/measure）→ emit 事件给客户端 → 客户端回 /debug/report → 这里等结果。
    const debugWaiters = new Map() // id → { resolve, timer }
    let debugSeq = 0
    function debugAsk(type, payload = {}, timeoutMs = 35_000) {
      const id = `dbg${++debugSeq}`
      return new Promise((resolve) => {
        const timer = setTimeout(() => { debugWaiters.delete(id); resolve({ ok: false, message: '客户端没回话（没在线或渲染页没 ready）' }) }, timeoutMs) // 超时要比客户端 pollLoop（25s）长：8 秒会卡在「事件已排队、客户端还没轮到」的中间，正是之前测不到数据的真正原因
        timer.unref?.()
        debugWaiters.set(id, { resolve, timer })
        // 注意：**不能**把 id 直接塞进 payload。emit() 是 `{ id: ++seq, ...payload }`，
        // payload 里的 id 会覆盖队列序号 id，而客户端按 `e.id > since` 过滤——
        // 字符串 id 和数字比较永远为 false，事件会被静默丢掉（排查过一次，别再踩）。
        emit(type, { ...payload, askId: id })
      })
    }
    api.route('/debug/report', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const id = String(body.id || '')
      const w = debugWaiters.get(id)
      if (w) {
        debugWaiters.delete(id)
        try { clearTimeout(w.timer) } catch {}
        w.resolve({ ok: true, kind: body.kind, result: body.result })
      }
      api.core.http.send(res, 200, { ok: true })
    })
    api.route('/debug/crop', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      api.core.http.send(res, 200, await debugAsk('debugCrop'))
    })
    api.route('/debug/measure', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      const body = await api.core.http.body(req)
      // samples：可选，时长比例数组（[0.1,0.2,...]）或秒数（>1）。密集采样用来找峰值帧。
      const samples = Array.isArray(body.samples) ? body.samples.map(Number).filter(Number.isFinite).slice(0, 60) : undefined
      api.core.http.send(res, 200, await debugAsk('debugMeasure', { anim: String(body.anim || ''), samples }, 60_000))
    })
    // 导出原始画布帧（带红框标出 640×360 边界）：判断「被切」是素材本身就这样、还是我们裁的。
    api.route('/debug/dump', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      const body = await api.core.http.body(req)
      api.core.http.send(res, 200, await debugAsk('debugDump', { anim: String(body.anim || ''), at: Number(body.at) || 0 }, 40_000))
    })
    // 全量裁切自检：逐段量包围盒，报告哪几段会超出。读的是渲染页真实 DOM 几何。
    api.route('/debug/crop-audit', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      const body = await api.core.http.body(req)
      const r = await debugAsk('debugAudit', { limit: Number(body.limit) || 0 }, 300_000)
      api.core.http.send(res, 200, r)
    })
    // 逐帧扫一遍：给一段动画，返回每一帧的内容包围盒 + 是否贴到画布边缘。
    // 「贴边」= 素材本身的内容就画到 640×360 的边界上了 —— 这种段无论怎么缩放都会看着像被切。
    api.route('/debug/scan', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      const body = await api.core.http.body(req)
      const count = Math.max(2, Math.min(40, Number(body.count) || 16))
      const samples = Array.from({ length: count }, (_, i) => (i + 0.5) / count)
      api.core.http.send(res, 200, await debugAsk('debugMeasure', { anim: String(body.anim || ''), samples }, 90_000))
    })
    // 命中探测：给窗口内坐标，回报命中的 DOM 元素（查「点不中/拖不动」是 DOM 还是坐标问题）
    api.route('/debug/probe', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      const body = await api.core.http.body(req)
      api.core.http.send(res, 200, await debugAsk('debugProbe', { x: Number(body.x) || 0, y: Number(body.y) || 0 }))
    })
    // 自截图：抓渲染进程自己的画面（含透明 alpha），用来肉眼核对「动画有没有被切」。
    // 落盘到 app/shot.png，返回路径；不把 base64 塞进 HTTP 响应（几百 KB 没必要）。
    api.route('/debug/snapshot', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      api.core.http.send(res, 200, await debugAsk('debugSnapshot'))
    })
    // 点播指定动画并截图（核对大场面段用）：body { anim:'anim-070', waitMs:1500 }
    api.route('/debug/shot', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      const body = await api.core.http.body(req)
      api.core.http.send(res, 200, await debugAsk('debugShot', { anim: String(body.anim || ''), waitMs: Number(body.waitMs) || 0 }, 40_000))
    })
    // 气泡预览（诊断/调样式）：body { text, secs, tag } 直接冒一条气泡，不走载体判定。
    // 查「气泡宽度/字号/尾巴对不对」时用，比等碎碎念轮询快得多。
    api.route('/debug/bubble', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      const body = await api.core.http.body(req)
      api.core.http.send(res, 200, await debugAsk('debugBubble', {
        text: String(body.text || '测试气泡'),
        secs: Number(body.secs) || 0,
        tag: String(body.tag || ''),
      }))
    })
    // alpha 修正开关（诊断）：body { on:false } 关掉滤镜，再拍一张对比像素统计。
    api.route('/debug/alpha', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      const body = await api.core.http.body(req)
      api.core.http.send(res, 200, await debugAsk('debugAlpha', { on: body.on !== false }))
    })
    // 玩法自检（2026-11-05）：报「能不能开演 / 5 个槽位解析成什么 / 现在在不在跑」。
    // 没有这条就只能靠肉眼点菜单，出问题分不清「素材没下发」还是「导演没跑起来」。
    // body {start:true} 兼作开演按钮（等同右键菜单），{halt:true} 收场。
    api.route('/debug/baifan', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      const body = await api.core.http.body(req)
      const act = body.start ? 'start' : (body.halt ? 'halt' : '')
      if (act) await debugAsk('debugBaifan', { act })
      api.core.http.send(res, 200, await debugAsk('debugBaifan'))
    })
    // 待办小窗的调试开关（诊断用）：body { act: 'todo-open'|'todo-close'|'todo-state' }
    api.route('/debug/todo', async (req, res) => {
      if (!guard(req, res).ok) return
      if (!online().online) return api.core.http.send(res, 200, { ok: false, message: '桌宠没在线，先启动她' })
      const body = await api.core.http.body(req)
      const act = String(body.act || 'todo-state')
      // pet-set-count / pet-apply-slots：面板改数量、改某一只是什么样，都要立刻让客户端对齐。
      // 漏在这张白名单里的话，面板点完「存好了」但桌面上的那几只毫无变化 —— 静默失效最难查。
      if (!['todo-open', 'todo-close', 'todo-state', 'pet-add', 'pet-close-all', 'pet-list', 'pet-fling', 'pet-snap', 'pet-info', 'pet-fix-size', 'pet-move', 'main-bounds', 'pet-set-count', 'pet-apply-slots', 'chat-open', 'chat-close', 'chat-bounds', 'main-move'].includes(act)) {
        return api.core.http.send(res, 400, { ok: false, message: 'act 不支持' })
      }
      api.core.http.send(res, 200, await debugAsk('debugIpc', {
        act, slots: body.slots,
        count: Number(body.count) || 0,
        petId: String(body.petId || ''), vx: Number(body.vx) || 0, vy: Number(body.vy) || 0, x: Number(body.x), y: Number(body.y),
      }))
    })
    // ---------- 客户端主动「我不干了」（托盘点退出、右键点退出） ----------
    // 这是**主人的明确意图**（他就是不想让她开着），所以要记进 pet-wanted，
    // 下次 DSH 启动不会自动冒出来。跟「崩溃/连不上自退」区分开：那条路客户端直接 app.quit()，
    // 根本不会来打这个接口，意图标记保持原样，下次照样自动拉起。
    api.route('/intent/quit', async (req, res) => {
      if (!guard(req, res).ok) return
      setPetWanted(false, 'client-quit')
      try { const p = recordedPid(); if (p) { electronProc = null; try { unlinkSync(procFile()) } catch {} } } catch {}
      api.log.info('桌宠从客户端退出（托盘/右键），已记下「不想开着」：下次 DSH 启动不会自动拉起')
      api.core.http.send(res, 200, { ok: true })
    })
    // ---------- 动画播放回执（P2）：客户端播完点播动画后 POST {playbackId,status} ----------
    // 行为动作扩展：status 允许 played / failed / refused（被安全闸拦），可带 reason/action 字段。
    api.route('/playback', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const playbackId = String(body.playbackId || '').slice(0, 32)
      if (!playbackId) return api.core.http.send(res, 400, { ok: false, message: '缺 playbackId' })
      const status = ['played', 'failed', 'refused'].includes(body.status) ? body.status : (body.status === 'error' ? 'failed' : 'played')
      const entry = {
        playbackId, status,
        anim: String(body.anim || '').slice(0, 40),
        action: String(body.action || '').slice(0, 40),
        reason: String(body.reason || '').slice(0, 120),
        // 窗口动作的补充信息（close_window 记「关掉的是哪个窗口」；客户端填窗口标题/进程名）
        detail: String(body.detail || '').slice(0, 160),
      }
      recordPlayback(entry)
      // 行为动作的回执写进 behavior.json 的 recent（供下轮简报），并写一条短记忆；失败只 log 不炸
      try {
        if (entry.action) {
          const st = loadBehavior()
          const line = `${entry.action} → ${entry.status}${entry.reason ? '（' + entry.reason + '）' : ''}`
          st.recent = [...st.recent, line].slice(-8)
          // 第三批：关窗记录（面板「关窗记录」+ 一键补偿道歉的数据源）。只留最近 20 条。
          if (entry.action === 'close_window') {
            const prev = Array.isArray(st.closeLog) ? st.closeLog.filter((x) => x && typeof x === 'object') : []
            st.closeLog = [...prev, {
              at: Date.now(), status: entry.status, reason: entry.reason,
              window: entry.detail, playbackId, apologizedAt: 0,
            }].slice(-20)
          }
          saveBehavior(st)
          const mem = api.use('memory')
          const text = entry.action === 'close_window' && entry.status === 'played'
            ? `桌宠关掉了窗口「${entry.detail || '未知窗口'}」（她自己闹脾气干的，面板里可以让她道歉）`
            : `桌宠执行了 ${entry.action} 动作，结果 ${entry.status}${entry.reason ? '：' + entry.reason : ''}`
          mem?.add?.({ text, importance: entry.action === 'close_window' ? 0.6 : 0.4, source: 'pet' })
        }
      } catch (error) { api.log.warn('行为回执落盘失败：', String(error?.message || error)) }
      api.core.http.send(res, 200, { ok: true })
    })
    api.route('/history', (req, res) => {
      if (!guard(req, res).ok) return
      learnHost(req)
      api.core.http.send(res, 200, { ok: true, bootId, messages: delivered.slice(-60), playbacks: playbacks.slice(-20) })
    })
    api.route('/focus', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const focus = setFocus(body.enabled === true, body.source || 'pet')
      api.core.http.send(res, 200, { ok: true, focus })
    })
    api.route('/bubble', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      // 面板/客户端手动测试：默认绕过专注模式（force）；可带 anim 点播一段动作；via=pet 表示桌宠自身入口（越过载体设置）
      const r = await dispatch({ text: body.text, modality: body.modality, purpose: 'test', force: body.force !== false, anim: body.anim, via: body.via === 'pet' ? 'pet' : '' })
      api.core.http.send(res, 200, r)
    })
    // ---------- 碎碎念 / 干活状态 ----------
    api.route('/whisper', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      // slot：让「第几只」说这句话（面板/测试用；不传 = 主宠物）。
      // 额外那几只用自己的排程文件与人格，所以必须把 opt 一起传下去，不能只改 text。
      const hasSlot = body.slot !== undefined && body.slot !== null && body.slot !== ''
      const opt = hasSlot
        ? (() => {
            const i = Math.max(0, Math.min(EXTRA_MAX - 1, Math.round(Number(body.slot))))
            const it = loadExtraPets()[i]
            return { slot: i, persona: it.persona, label: extraNameOf(it, i), name: it.name, pack: extraPackOf(it) }
          })()
        : {}
      const r = await whisperOnce({ force: true, text: body.text, reason: 'api' }, opt)
      api.core.http.send(res, 200, r)
    })
    // ---------- 行为大脑：手动触发（面板「试一下」，2026-10-30 起唯一调试入口；右键菜单已移除该级联）+ 状态 + 反应层上报 ----------
    api.route('/behavior', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      // 手动触发默认 force=true：绕过专注/安静时段/每日上限；动作认全表（暂未开放的由客户端拒绝并回执）
      const r = await emitBehavior({ action: body.action, params: body.params, say: body.say, force: body.force !== false, reason: 'manual' })
      api.core.http.send(res, r.ok ? 200 : 400, r)
    })
    api.route('/behavior/status', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, { ok: true, behavior: behaviorStatus() })
    })
    api.route('/behavior/reaction', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const kind = String(body.kind || '').trim().slice(0, 32)
      if (!kind) return api.core.http.send(res, 400, { ok: false, message: '缺 kind（click/tease/pat/idle-cursor…）' })
      // 反应层优先级最高：客户端已本地直接执行（如 chase_cursor）并自行回执，这里只把事件摘要
      // 喂给 AI 下一轮简报（lastReaction），**不重复 emit**，避免双发。
      const st = loadBehavior()
      st.lastReaction = { kind, at: Date.now(), detail: String(body.detail || '').slice(0, 120) }
      saveBehavior(st)
      api.core.http.send(res, 200, { ok: true, lastReaction: st.lastReaction })
    })
    // ---------- 桌面环境上报（2026-10-30）：窗口清单只有客户端能枚举（它已有 PowerShell 桥），
    // 定时 POST 上来缓存；下一轮简报里 AI 就能「看见主人开着什么窗口」，窗口动作也能指名。
    api.route('/behavior/env', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      envWin = { at: Date.now(), list: cleanWindowReport(body && body.windows) }
      api.core.http.send(res, 200, { ok: true, windows: envWin.list.length })
    })
    // ---------- 图标隔离区（第二批）：执行 / 清单 / 归还 ----------
    // 契约见返回值注释：面板「被收走的图标」卡片 = GET quarantine 渲染 + 每行 POST restore。
    api.route('/behavior/icon/act', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const r = iconAct(body)
      api.core.http.send(res, r.ok ? 200 : 400, r)
    })
    api.route('/behavior/icon/quarantine', (req, res) => {
      if (!guard(req, res).ok) return
      const b = behaviorSettings()
      // enabled/days 是给面板画灰态与「超 N 天自动放回」文案的，不影响 items 契约
      api.core.http.send(res, 200, { ok: true, items: loadManifest(), enabled: b.iconMischiefEnabled, days: b.iconQuarantineDays })
    })
    api.route('/behavior/icon/restore', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const r = await iconRestore(String(body.id || '').slice(0, 64))
      api.core.http.send(res, r.ok ? 200 : 404, r)
    })
    // 第三批：关窗记录 + 补偿道歉（面板「关窗记录」卡直接调这两条）
    api.route('/behavior/window/log', (req, res) => {
      if (!guard(req, res).ok) return
      const s = behaviorStatus()
      api.core.http.send(res, 200, {
        ok: true, items: s.closeLog, closeToday: s.closeToday, apologyDue: s.apologyDue,
        mood: s.mood, moodCloseWindowBelow: s.moodCloseWindowBelow,
        enabled: s.closeWindowEnabled, whitelist: s.windowWhitelist,
      })
    })
    api.route('/behavior/window/apologize', (req, res) => {
      if (!guard(req, res).ok) return
      const r = windowApologize()
      api.core.http.send(res, r.ok ? 200 : 404, r.ok
        ? { ok: true, window: r.window, message: r.window ? `她为「${r.window}」道了歉` : '她道了歉' }
        : { ok: false, reason: r.reason, message: '没有需要道歉的记录' })
    })
    api.route('/work', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, { ok: true, work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '', text: workEndText(workSnap) } })
    })
    api.route('/client/install', async (req, res) => {
      if (!guard(req, res).ok) return
      const r = installClient()
      api.core.http.send(res, 200, { ...r, client: clientStatus() })
    })
    // 客户端包（zip）：app/ 目录 + 内嵌 host.json 一起打；面板「下载客户端包」经宿主 /panel/pet/client-package 走这里
    // 【安全审查 P2】这个响应里揣着 bearer 令牌，所以额外收三道：
    //   ① 只允许 GET（浏览器里 `window.open`/`<a download>` 才走得通，恶意页面的跨站 POST 打不进来）；
    //   ② 显式 revalidate 头（no-store）：别让中间层/浏览器把含令牌的 zip 缓存下来；
    //   ③ 大小上限：包本身是白名单文件拼的，正常几十 KB，超过就是出了怪事，直接拒绝而不是吐给调用方。
    const CLIENT_PACKAGE_MAX_BYTES = 8 * 1024 * 1024 // 8MB 足够（实际 ~80KB）
    api.route('/client-package', (req, res) => {
      if (String(req.method || 'GET').toUpperCase() !== 'GET') {
        return api.core.http.send(res, 405, { ok: false, message: '客户端包只允许 GET（面板按钮本身就是 GET 下载）' })
      }
      if (!guard(req, res).ok) return
      const r = clientPackage()
      if (!r.ok) return api.core.http.send(res, 500, r)
      if (r.buffer.length > CLIENT_PACKAGE_MAX_BYTES) {
        api.log.warn(`客户端包异常大（${r.buffer.length} 字节），已拒绝下发`)
        return api.core.http.send(res, 500, { ok: false, message: `客户端包异常大（${r.buffer.length} 字节），已拒绝下发` })
      }
      res.setHeader?.('content-type', 'application/zip')
      res.setHeader?.('content-disposition', `attachment; filename="${String(r.filename || 'aurabot-pet-client.zip').replace(/[^\w.-]/g, '_')}"`)
      // 内含令牌：任何缓存层都不许留
      res.setHeader?.('cache-control', 'no-store, no-cache, must-revalidate, private')
      res.setHeader?.('pragma', 'no-cache')
      res.end(r.buffer)
    })
    // 生成物核对：真机排查「行为层怎么没反应」的第一步（curl 这个就知道 app/ 缺没缺文件）
    api.route('/client/status', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, { ok: true, client: clientStatus() })
    })
    // ---------- Electron 三键（面板按钮 / HTTP 路由共用）：安装 → 启动 → 停止 ----------
    api.route('/electron-install', async (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, await electronInstall())
    })
    api.route('/launch', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, launch())
    })
    api.route('/stop', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, stop())
    })

    // ---------- 启动 ----------
    writeHostFile(true)
    ensureAssetRoutes()
    ensureHouseRoutes() // 上游 1.0.12：小屋素材路由（没放素材时静默跳过）
    // 碎碎念排程先落一次盘：面板一打开就能看到「下次约 N 分钟后」，重启也不丢排程
    try { const st0 = loadWhisper(); if (!st0.nextAt) { planWhisper(st0, whisperSettings()); saveWhisper(st0) } } catch (e) { api.log.warn(`碎碎念排程初始化失败：${e.message}`) }
    // 行为大脑排程同样先落一次盘（独立配额，与碎碎念互不知晓）
    try { const b0 = loadBehavior(); if (!b0.nextAt) { planBehavior(b0, behaviorSettings()); saveBehavior(b0) } } catch (e) { api.log.warn(`行为大脑排程初始化失败：${e.message}`) }
    const offHostTimer = api.every(120_000, () => { writeHostFile(true); ensureAssetRoutes(); ensureHouseRoutes() }, '刷新 host.json 与素材路由')
    // 碎碎念：60s 心跳里只做「读一次状态文件 + 纯逻辑判断」，重活都别放进 tick
    const offWhisper = api.every(60_000, () => whisperTick(), '碎碎念')
    // 宠物数值：5 分钟前进一次（纯计算 + 一次写盘）。60 秒一拍太浪费磁盘——
    // 饱腹每小时才掉 6，一分钟 0.1，肉眼根本看不出差别。
    const offLife = api.every(300_000, () => { try { lifeTick() } catch (e) { api.log.debug(`宠物数值前进失败：${e.message}`) } }, '宠物数值')
    // 说话让路：攒下来的那几句，20 秒看一次「气泡空出来没有」，空了就补一句。
    // 为什么是 20 秒：气泡最短 6.5 秒，20 秒足够让她一句一句说，又不会挤成一串。
    const offSayQueue = api.every(20_000, () => { sayQueueTick().catch((e) => api.log.debug(`补话失败：${e.message}`)) }, '攒着的话')
    // 数值慢速补算：DSH 半夜没人时 api.every 也可能被系统休眠拉长，5 分钟那拍补不上就白掉了。
    // 这里只在「距上次前进超过 10 分钟」时才补，正常情况什么都不做。
    try { loadLife('main') } catch (e) { api.log.warn(`宠物数值初始化失败：${e.message}`) }
    // 说梦话：睡着时才有动作，醒着直接 return（一次读文件，很轻）
    const offDreamTalk = api.every(60_000, () => dreamTalkTick(), '说梦话')
    const offBehavior = api.every(60_000, () => behaviorTick(), '行为大脑')
    // 待办到点提醒：每分钟一拍，一拍最多提醒一条（最密的档位是 5 分钟，不必更快）
    const offTodo = api.every(60_000, () => { todoTick().catch((e) => api.log.debug(`待办提醒失败：${e.message}`)) }, '待办提醒')
    // 干活状态自愈：DSH 静默时把过期档位清掉，别让客户端一直循环播「干活中」（表现为卡住 + 闪）
    const offWorkSweep = api.every(30_000, () => { try { workSweep() } catch {} }, '干活状态自愈')
    // 聊天联动：只读观察 activity 事件（宿主广播，只看不拦）；旧宿主/fake api 没有 on 时静默跳过
    if (typeof api.on === 'function') {
      api.on('activity', (msg) => { try { chatBehaviorFire(msg) } catch (e) { api.log.debug(`聊天联动处理 activity 失败：${e.message}`) } })
    }
    // 图标隔离区超期自动归还：10 分钟一扫（读 manifest 纯逻辑，重活不在 tick 里）
    const offIconSweep = api.every(600_000, () => { iconSweep().catch((e) => api.log.warn('图标超期归还出错：', String(e?.message || e))) }, '图标隔离区超期归还')
    // 对话框：过期历史清理（启动时 + 每日 tick；withChatLock 串行，与回复落盘不互踩）
    petChatSweep().catch(() => {})
    const offChatSweep = api.every(60 * MIN_MS, () => { petChatSweep().catch(() => {}) }, '对话框历史清理')
    // 天气低频刷新（≥30 分钟一次；城市没配时函数内部直接跳过）。测试环境不打真网络，靠手动调 weatherFetchOnce
    const offWeather = api.every(WEATHER_TTL_MS, () => { weatherFetchOnce().catch(() => {}) }, '天气低频刷新')
    if (!api.__petTestHooks) setTimeout(() => { weatherFetchOnce().catch(() => {}) }, 3_000).unref?.()
    api.onDispose(() => {
      offHostTimer(); offWhisper(); offDreamTalk(); offBehavior(); offIconSweep(); offChatSweep(); offWeather(); offWorkSweep(); offTodo(); offBalance(); offLife(); offSayQueue()
      // 退出前把数值存一次（不然这 5 分钟的变化白掉；下次启动还会按离线重算一遍，重复扣）
      try { for (const petId of lifeRuntime.keys()) saveLife(petId) } catch {}
      waiters.clear(); presence.clear(); workMap.clear()
      // 插件卸载（DSH 正常退出 / 模块重载）时把桌宠一起收掉，别让它变成留在屏幕上的孤儿。
      // 客户端自己也有父进程守护（DSH 崩溃/强关那条路径），两重保险。
      // by:'dispose' —— 这是「跟着 DSH 走」，不是主人说不要了，所以不动 pet-wanted 标记。
      try {
        const p = recordedPid()
        if (p && Number.isInteger(p.pid) && p.pid > 0) {
          try { stop({ by: 'dispose' }) } catch {}
        }
      } catch {}
    })
    api.log.info(`桌宠模块就绪：host.json 在 ${hostFile()}（端口由宿主注入，Host 头学习保留作漂移纠正）`)

    // ---------- 随 DSH 自动启动（方案 B） ----------
    // 判据三条全中才拉起：
    //   ① 面板开关「随 DSH 自动启动」是开的（petAutoStart，默认开）；
    //   ② 她「想开着」（pet-wanted.json：上次是点启动留下的 true，或从没表态过）。
    //      —— 你点过「停止」这里就是 false，重启 DSH 不会再自己冒出来，尊重你的意图。
    //   ③ 现在没有已经在跑的（onDispose 已经把上次那个收掉了，正常不会撞上）。
    // 延迟 4 秒：等宿主把端口注入完、host.json 写成真实 baseUrl，否则客户端起来读不到可连的地址。
    // 失败只记日志、不抛——自动拉起是锦上添花，绝不能因此影响插件启动。
    if (!api.__petTestHooks) {
      setTimeout(() => {
        try {
          if (!petAutoStart()) { api.log.info('桌宠自动启动：面板开关是关的，跳过'); return }
          const w = petWanted()
          if (!w.wanted) { api.log.info(`桌宠自动启动：上次是手动停止（${w.by || '未知'}），尊重意图不拉起`); return }
          if (online().online) { api.log.info('桌宠自动启动：已经在跑了，跳过'); return }
          const r = launch({ by: 'autostart' })
          if (!r.ok) api.log.warn(`桌宠自动启动没成功：${r.message}`)
        } catch (error) {
          api.log.warn('桌宠自动启动出错（不影响插件）：', String(error?.message || error))
        }
      }, 4_000).unref?.()
    }

    return {
      dispatch,
      push: dispatch,
      online,
      focus: focusOn,
      setFocus,
      moodOf,
      storeVoice,
      writeHostFile,
      installClient,
      download: async () => installClient(), // 面板经 /panel/pet/download 调这个（host.js 降级路径按有没有这个函数判断）
      clientPackage,                         // 远端直连：app/ 目录 + host.json 打 zip（面板「下载客户端包」同函数）
      rotateToken,                           // 安全：轮换令牌（旧令牌立即失效，客户端需重新下载包）
      setWebPort,                            // 宿主（host.js）启动时注入真实 Web 端口，破自举死锁
      portReady,
      electronInstall,                       // 面板经 /panel/pet/electron-install 调（npmmirror 镜像装 Electron）
      launch,                                // 面板经 /panel/pet/launch 调（分离进程启动 electron.exe main.js）
      stop,                                  // 面板经 /panel/pet/stop 调（杀记录的 pid）
      setPosition,                           // 面板经 /panel/pet/position 调（出生点：角落 + 边距）
      // 多开：面板经 /panel/pet/extra/* 调（浏览器拿不到 x-pet-token，所以由宿主代劳）。
      // 这两个与 /extra/pets、/extra/pet 两条 HTTP 路由共用同一份实现：
      //   extraPets()       ←→ GET  /extra/pets
      //   setExtraPet(slot) ←→ POST /extra/pet
      // 这样面板不必知道令牌，也不会长出第二套会漂移的逻辑。
      extraPets: async () => ({
        max: EXTRA_MAX,
        want: Math.max(0, Math.min(EXTRA_MAX, Math.round(Number(api.settings().petExtraCount) || 0))),
        slots: loadExtraPets(),
        packs: listPacks().map((p) => ({ name: p.name, anims: p.anims.length })),
        mainPack: activePack() || '',
        mainScale: petScale(),
        online: online().online,
        // 面板要显示「这只现在到底开没开着 / 多大 / 用的哪个包」，只有客户端知道
        live: await liveExtraPets(),
      }),
      setExtraPet: (slot, patch) => {
        const idx = Number(slot)
        if (!Number.isFinite(idx) || idx < 0 || idx >= EXTRA_MAX) return { ok: false, message: `slot 只能是 0~${EXTRA_MAX - 1}` }
        const p = {}
        const b = patch || {}
        if (b.name !== undefined) p.name = b.name
        if (b.pack !== undefined) {
          const name = String(b.pack || '').trim()
          if (name && !listPacks().some((x) => x.name === name)) return { ok: false, message: `没有叫「${name}」的形象包` }
          p.pack = name
        }
        if (b.scale !== undefined) {
          const n = Number(b.scale)
          if (!Number.isFinite(n)) return { ok: false, message: 'scale 必须是数字' }
          p.scale = n <= 0 ? 0 : Math.min(2, Math.max(0.5, n))
        }
        if (b.persona !== undefined) p.persona = String(b.persona || '')
        if (b.whisper !== undefined) p.whisper = b.whisper !== false
        return patchExtraPet(idx, p)
      },
      setAutoStart: (on) => {
        // 面板「随 DSH 自动启动」开关：关掉时顺便把她「想开着」的意图留原样，
        // 只决定「下次 DSH 启动要不要自己拉起」，不影响当前已经开着的那只。
        api.saveSettings({ petAutoStart: on === true })
        return { ok: true, autoStart: petAutoStart() }
      },
      packs: listPacks,
      activePack,
      packView,
      ensureAssetRoutes,
      ensureHouseRoutes,                     // 上游 1.0.12：小屋素材路由（测试/面板手动刷新用）
      houseStatus,                           // 上游 1.0.12：小屋素材与状态（/status 只给 HTTP，这份给宿主面板）
      ensureDefaultPack,                     // 素材包下载落位（force=false 只在缺包时下；测试/面板手动用）
      // 碎碎念（桌宠自己的气泡流）与干活状态
      whisper: whisperOnce,                  // 手动/测试：立即碎碎念一句（force）
      whisperNow: whisperOnce,
      whisperStatus,
      whisperTick,
      // AI 行为大脑（决策层）：AI 只挑动作，本地执行器按单办事
      behavior: behaviorOnce,
      behaviorStatus,
      behaviorTick,
      behaviorEmit: emitBehavior,            // 手动下发（面板「试一下」/客户端右键菜单同通道）
      behaviorParse: parseBehaviorAction,    // 测试钩子：宽松解析动作单（非法动作返回 null）
      iconAct,                               // 测试钩子：隔离区执行入口（POST /behavior/icon/act 同函数）
      iconRestore,                           // 测试钩子：归还（POST /behavior/icon/restore 同函数）
      iconQuarantine: loadManifest,          // 测试钩子：隔离区清单
      iconList: listDesktopIcons,            // 测试钩子：桌面上「可碰」的图标清单（同简报里喂给 AI 的那份）
      iconSweep,                             // 测试钩子：超期归还（定时器同函数，可注入 now）
      clientStatus,                          // 测试钩子：客户端生成物对账（/status 里的 client 同函数）
      windowApologize,                        // 测试钩子：补偿道歉（POST /behavior/window/apologize 同函数）
      behaviorActionsForTest: () => BEHAVIOR_ACTIONS, // 测试钩子：动作表（含默认台词，锁「每个动作都有气泡」）
      behaviorSayForTest: (act) => BEHAVIOR_SAY[act] || '', // 测试钩子：动作默认台词
      chatBehavior: chatBehaviorOnce,        // 测试/手动钩子：聊天联动一轮（activity 同函数，可 await）
      chatBehaviorParse: parseChatAction,    // 测试钩子：聊天联动动作单解析
      chatBehaviorSettings: chatSettings,    // 测试钩子：聊天联动有效配置（含白名单解析结果）
      petChat: petChatOnce,                  // 测试/手动钩子：对话框一轮（POST /chat 同函数）
      petChatStatus,                         // 测试钩子：对话框状态（/status 里的 chat 同函数）
      petChatSweep,                          // 测试钩子：历史过期清理（定时器同函数，可注入 now）
      petChatHistory: chatHistory,           // 测试钩子：读历史（GET /chat/history 同函数）
      weatherFetchOnce,                      // 测试钩子：天气拉取（可配 petHooks.fetchWeather，不打真网络）
      onSessionEvent,                        // host.js 把 ctx.on('session/event') 转发进来
      // 待办（测试/手动钩子：小窗与提醒同函数）
      todos: todoView,                       // 合并视图（DSH 镜面 + 本地自记）
      todoPending,                           // 未完成计数
      todoTick,                              // 提醒巡检（定时器同函数，可注入 now 走 petHooks）
      todoReminderText,                      // 文案（单测用）
      workStatus: () => ({ ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '', text: workEndText(workSnap) }),
      // 诊断：workMap 里每个会话的档位与「多久没更新了」，用来判断是不是真有活在干
      workDebug: () => {
        const now = Date.now()
        return {
          snap: { ...workSnap },
          sessions: [...workMap.entries()].map(([sid, e]) => ({ sid: sid.slice(0, 40), state: e.state, task: e.task, ageSec: Math.round((now - e.at) / 1000) })),
          ttlActiveSec: WORK_TTL_ACTIVE / 1000,
        }
      },
      status: () => {
        const s = api.settings()
        const w = workSettings()
        return {
          ...online(), focus: focusOn(), scale: petScale(), releaseLand: petReleaseLand(), carrier: s.carrier, modality: s.modality, bootId, seq,
          // 上游 1.0.14：面板守卫 pet.animRate / pet.balanceEnabled / pet.clickChase / pet.teaseChase
          // / pet.houseStatus 读的就是这份（host.js /panel/pet/status 用 use('pet').status()）
          animRate: petAnimRate(), balanceEnabled: petShowBalance(),
          clickChase: petClickChase(), teaseChase: petTeaseChase(),
          house: houseStatus(),
          // 出生点（面板「初始位置」三件套）：内建模块的 settings 不渲染表单，面板只能从 status 读当前值
          position: petPosition(),
          // 物理手感：面板「物理手感」卡从这里读当前值（内建模块的 settings 不渲染表单）
          physics: physicsFromSettings(s),
          // 随 DSH 自动启停：autoStart 是面板开关，wanted 是她「想不想开着」（点停止后就是 false）
          autoStart: petAutoStart(), wanted: petWanted(),
          // 多开：面板「再养几只」的当前值（面板控件从这里读）
          extraPets: Math.max(0, Math.min(EXTRA_MAX, Math.round(Number(s.petExtraCount) || 0))),
          extraSlots: loadExtraPets().map((it, i) => ({
            slot: i, name: extraNameOf(it, i), pack: extraPackOf(it) || '', persona: it.persona, whisper: it.whisper !== false,
          })),
          pack: activePack(), playbackCount: playbacks.length,
          // 素材包概况：面板「素材包」卡用它显示状态（内建模块的 settings 不渲染表单，只能走 status + /panel/pet/*）
          packInfo: (() => {
            const list = listPacks()
            const def = list.find((p) => p.name === 'default')
            return {
              url: String(s.petPackUrl || ''),
              downloading: Boolean(packDownloading),
              hasDefault: Boolean(def && def.anims.length),
              defaultAnims: def ? def.anims.length : 0,
              packs: list.map((p) => p.name),
            }
          })(),
          electronMirror: electronMirror(), // 面板「Electron 镜像」输入框的当前值（留空=内置默认）
          work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '' },
          workEnabled: w.enabled, workBubble: w.bubble, workNotify: w.notify,
          workAnimMap: (packView() || {}).workStatus || null, // 面板展示「六档动画能不能对上」
          whisper: whisperStatus(),
          chat: petChatStatus(), // 对话框（快捷键注册状态回显在这）：已注册 / 失败 / 未配置
          // ---- 2026-11-06：面板新增卡片的当前值 ----
          // 这些键一直在 settings 里，但内建模块的 settings 不渲染成表单，面板只能从 status 读。
          // 少一个就是「面板上有个输入框永远是空的，填了也看不出存没存上」。
          todoEnabled: s.petTodoEnabled !== false,
          todoHotkey: String(s.petTodoHotkey || ''),
          hearEnabled: s.petHearEnabled !== false,
          hearSendToChat: s.petHearSendToChat !== false,
          hearModelDir: String(s.petHearModelDir || ''),
          hearReady: Boolean(resolveModelDir(String(s.petHearModelDir || '').trim())),
          balanceEnabled: s.petBalanceEnabled === true,
          balanceConfigured: Boolean(String(s.petBalanceKey || '').trim()),
          balanceMinutes: Math.max(5, Math.min(1440, Number(s.petBalanceMinutes) || 60)),
          balanceCurrency: String(s.petBalanceCurrency || 'CNY'),
          animWeightIdle: Number.isFinite(Number(s.animWeightIdle)) ? Number(s.animWeightIdle) : -1,
          animWeightTurn: Number.isFinite(Number(s.animWeightTurn)) ? Number(s.animWeightTurn) : -1,
          animWeightMove: Number.isFinite(Number(s.animWeightMove)) ? Number(s.animWeightMove) : -1,
          customFont: s.customFont !== false,
          fontFamily: String(s.fontFamily || 'candy'),
          fontSize: Math.max(4, Math.min(200, Number(s.fontSize) || 21)),
          fontFollowPet: s.fontFollowPet !== false,
          voiceEnabled: s.voiceEnabled === true,
          voiceVolume: Number.isFinite(Number(s.voiceVolume)) ? Number(s.voiceVolume) : 1,
          voiceWhisperEnabled: s.voiceWhisperEnabled === true,
          voiceChatEnabled: s.voiceChatEnabled === true,
          voiceTodoEnabled: s.voiceTodoEnabled === true,
          clickSound: s.clickSound !== false,
          memeBubble: s.memeBubble !== false,
          dreamTalk: s.dreamTalk !== false,
          petWeatherUrl: String(s.petWeatherUrl || ''),
          // ---- 宠物数值 / 说话让路（2026-11-06）----
          life: lifeSnapshot('main'),
          lifeSettings: lifeSettings(),
          say: sayQueue.snapshot(),
          portReady: portReady(), port: knownPort ? Number(knownPort) : null,
          electronInstalled: existsSync(electronExe()), pid: recordedPid()?.pid || null,
          client: clientStatus(), // 面板「桌宠」卡据此提示重新生成（缺文件 = 行为层静默失效）
          remoteClient: Boolean(publicBase()), publicBaseUrl: publicBase() ? publicBase().url : '', // 面板据此把 Electron 三键换成「下载客户端包」
        }
      },
      state: () => ({ count: delivered.length }),
      // ---- 宠物数值 / 说话让路：测试与手动钩子（同函数，不另写一套） ----
      life: {
        snapshot: (petId = 'main', opt = {}) => lifeSnapshot(petId, opt),
        tick: (opt = {}) => lifeTick(opt),
        interact: (kind, opt = {}) => lifeInteract(kind, opt),
        feed: (food, opt = {}) => lifeFeed(food, opt),
        rewardSnack: (opt = {}) => lifeRewardSnack(opt),
        contextLine: () => lifeContextLine(),
        reset: (petId = 'main', now = Date.now()) => {
          const st = Life.freshState(now)
          setLife(petId, st)
          return Life.snapshot(st, { now })
        },
        foods: () => Life.FOODS,
        tuning: () => Life.TUNING,
        crossings: (a, b, o) => Life.crossingsOf(a, b, o),
      },
      say: {
        want: (o, ctx) => sayQueue.want(o, ctx),
        next: (ctx) => sayQueue.next(ctx),
        pending: (now) => sayQueue.pending(now),
        queueTick: (opt) => sayQueueTick(opt),
        saySoon: (o) => saySoon(o),
        snapshot: (now) => sayQueue.snapshot(now),
        clear: () => sayQueue.clear(),
        blocked: (now) => sayBlockedNow(now),
        markChat: () => { lastChatAt = Date.now() },
        markBubble: (ms) => { bubbleUntil = Date.now() + Math.max(0, Number(ms) || 0) },
      },
    }
  },
}

