/**
 * 能力兼容说明（数据表驱动）
 * ==========================
 * 数据与 roost `src/onebot/capability.js` 的 CAPABILITY 对齐。
 * 这里不写死文案在面板里——面板和「兼容说明」命令共用这一份，
 * 免得两边说法分叉（这是 roost capability.js 顶部自己定的规矩）。
 *
 * avail: support / degrade / unsupported —— 与 roost 的 level 一一对应
 * onAurabot: 该功能对大肥鱼的影响说明
 */

export const CAPABILITIES = [
  // 发送
  { action: 'send_private_msg', avail: 'support', onAurabot: '私聊回复正常' },
  { action: 'send_group_msg', avail: 'support', onAurabot: '群聊回复正常；多段消息按条拆开' },
  { action: 'send_msg', avail: 'support', onAurabot: '与上面同一条发送路径' },
  { action: 'delete_msg', avail: 'support', onAurabot: '2 分钟内撤回；撤他人需机器人是群管理员' },
  { action: 'send_group_forward_msg', avail: 'unsupported', onAurabot: '官方只能收合并转发、不能发：合并转发类回复会退化' },

  // 查询
  { action: 'get_login_info', avail: 'support', onAurabot: '取机器人号正常' },
  { action: 'get_group_info', avail: 'support', onAurabot: '群信息正常，有缓存' },
  { action: 'get_group_list', avail: 'degrade', onAurabot: '官方无查询接口，只列事件里见过的群' },
  { action: 'get_group_member_info', avail: 'degrade', onAurabot: '只给号码和已知昵称，头像/头衔可能缺' },
  { action: 'get_group_member_list', avail: 'degrade', onAurabot: '只列「在群里说过话的人」，不是全量成员' },
  { action: 'get_msg', avail: 'degrade', onAurabot: '只记得最近 500 条；引用旧消息可能取不到' },
  { action: 'get_forward_msg', avail: 'degrade', onAurabot: '只覆盖本次进程收到的合并转发' },
  { action: 'get_stranger_info', avail: 'support', onAurabot: '需好友关系，否则可能返回找不到' },
  { action: 'get_friend_list', avail: 'unsupported', onAurabot: '官方没有好友列表接口' },
  { action: 'get_group_msg_history', avail: 'degrade', onAurabot: '用账本回放，只有本进程收到过的' },
  { action: 'get_friend_msg_history', avail: 'degrade', onAurabot: '同上' },

  // 群管
  { action: 'set_group_ban', avail: 'support', onAurabot: '禁言正常，需群管理员，最长 30 天' },
  { action: 'set_group_whole_ban', avail: 'unsupported', onAurabot: '官方只有单成员禁言，没有全员禁言' },
  { action: 'set_group_kick', avail: 'unsupported', onAurabot: '内邀接口，普通机器人会被拒' },
  { action: 'set_group_add_request', avail: 'support', onAurabot: '进群审批正常，需群管理员' },
  { action: 'set_friend_add_request', avail: 'unsupported', onAurabot: '官方没有加好友审批接口' },
  { action: 'set_group_card', avail: 'unsupported', onAurabot: '官方无对应接口，改群名片不可用' },
  { action: 'set_group_name', avail: 'unsupported', onAurabot: '官方无对应接口' },
  { action: 'set_group_admin', avail: 'unsupported', onAurabot: '官方无对应接口' },
  { action: 'set_group_leave', avail: 'unsupported', onAurabot: '官方无对应接口' },
  { action: 'set_group_special_title', avail: 'unsupported', onAurabot: '官方无对应接口' },

  // 资料
  { action: 'set_qq_profile', avail: 'degrade', onAurabot: '只改官方后台的昵称/头像/简介' },
  { action: 'set_self_longnick', avail: 'support', onAurabot: '写机器人简介正常' },
  { action: 'get_self_longnick', avail: 'support', onAurabot: '读机器人简介正常' },

  // 其它
  { action: 'set_input_status', avail: 'unsupported', onAurabot: '「输入中」状态发不了' },
  { action: 'send_poke', avail: 'unsupported', onAurabot: '官方没有拍一拍：戳一戳相关玩法不可用' },
  { action: 'can_send_image', avail: 'support', onAurabot: '发图正常' },
  { action: 'can_send_record', avail: 'degrade', onAurabot: '发语音要先在 roost 外接页装 silk-wasm' },
  { action: 'get_status', avail: 'support', onAurabot: '状态查询正常' },
  { action: 'get_version_info', avail: 'support', onAurabot: '版本查询正常' },
  { action: 'mark_msg_as_read', avail: 'support', onAurabot: '空实现，官方无已读概念' },
  { action: 'get_image', avail: 'degrade', onAurabot: '从附件缓存取 URL，有时效' },
  { action: 'get_record', avail: 'degrade', onAurabot: '从附件缓存取 URL，有时效' },
  { action: 'fetch_ptt_text', avail: 'degrade', onAurabot: '用官方语音转文字，效果看官方' },
  { action: 'set_restart', avail: 'unsupported', onAurabot: '安全面，一律拒绝' },
  { action: 'get_cookies', avail: 'unsupported', onAurabot: '安全面，一律拒绝' },
  { action: 'get_csrf_token', avail: 'unsupported', onAurabot: '安全面，一律拒绝' },
];

/** 面板顶部和「兼容说明」共用的几条大坑 */
export const CAVEATS = [
  {
    title: '群聊身份是合成号',
    body: '官方接口给的是 openid，roost 兼容层会映射成 OneBot 数字号：私聊能用真 QQ 号（主人识别正常），但群聊里其他人大多是合成号。依赖真 QQ 号的人物记忆、@ 识别、按 QQ 号的白名单在群里会失真。解决办法：去 roost 面板「身份」页绑定，或先在「通知」页配好 SMTP 邮箱，让常用用户自己发 /绑定QQ <QQ号>（验证码发到 QQ号@qq.com），再发 /QQ验证码 <6位码> 完成；也可 /绑定群号、/绑定成员 由主人代绑。1.1.5 起独占模式也放行这些绑定命令。绑定后换机器人（换 AppID）openid 变了也能按号码读回旧记忆，存量数据不用动。',
  },
  {
    title: '被动回复窗口很紧',
    body: '官方接口群聊 5 分钟 / 单聊 60 分钟，同一条消息最多回 5 次（群）/ 4 次（单聊）。大肥鱼的攒批（2.5/5 秒，上限 8/15 秒）和多轮回复容易耗光窗口，超时后要降级成主动消息（也受额度限制）。',
  },
  {
    title: '部分 OneBot 专属玩法没有',
    body: '拍一拍、合并转发发送、好友列表、全员禁言、改群名片/群名/头衔等官方没有对应接口，会明确拒绝或退化。空间、收藏到 QQ 这类依赖第三方协议的能力也不可用；「接入大肥鱼」会自动关掉空间日记和空间互动，退回原网关时还原。',
  },
  {
    title: '改头像 / 昵称 / 简介要先登录开放平台',
    body: '这些不是 OneBot action，roost 是走开发者后台 CGI 改的（setBot → requireReady，未登录报 NOT_LOGGED_IN）。扫码建机器人只给 AppID/AppSecret，不等于开放平台登录态；要改资料先去 roost 面板「开放平台」页扫码登录开发者后台。',
  },
  {
    title: '独占模式二选一',
    body: '兼容层设为 exclusive 时消息不再进 roost 自己的插件管线：大肥鱼接下来，roost 的 dsh-roost AI 就不能同时回话。要两边都回请用 parallel（但可能重复回复）。',
  },
];

/**
 * 用 roost 而不是裸官方接口的理由（「我们的优化」）
 * ================================================
 * 对照的是「自己拿官方 SDK 硬接」的基线，不是对照 aurabot 原来的 OneBot。
 * 每条都标了出处，免得写成空话；面板和 README 共用。
 */
export const WHY_ROOST = [
  {
    title: '被动回复窗口帮你管',
    body: '官方群聊 5 分钟、单聊 60 分钟，同一条消息最多回 5/4 次。roost 按 msg_id 记账、数着次数，攒批超时或窗口过期会自动降级到主动消息，而不是静默失败。裸接官方 API 这些都要自己写。',
  },
  {
    title: '攒批合并,回复更像人',
    body: '对方连发几条时先等一下（2.5/5 秒，上限 8/15 秒）再一起回，避免一句话拆成好几条刷屏。同时避开官方的短窗口，超时前一定发出去。',
  },
  {
    title: '投递账本，发出去没一目了然',
    body: '每条回复进账本，能查到底送出去了还是卡在重试。官方接口本身不告诉你「这条到底到没到」，裸接只能靠猜。',
  },
  {
    title: '断线自动补拉，消息不丢',
    body: 'SSE 事件流带序号，断线重连后按 since 补拉；网关没起来时消息先排队，连上再补发，不会 silently 丢掉。',
  },
  {
    title: 'openid 映射成数字号',
    body: '把官方的 openid 映射成 OneBot 用的整数号（真号优先、否则稳定合成号），大肥鱼的内存、@ 识别、会话键才能照常工作。这是兼容层的核心价值。',
  },
  {
    title: '凭据与权限守门',
    body: '面板密钥、SSRF 防护、来源校验都在 roost 这层；非本机的兼容端口默认要显式放行才监听。不会把控制机器人的端口裸奔到公网。',
  },
];

/** 用户必须自己做的三步（模块代劳不了） */
export const MANUAL_STEPS = [
  '准备手机 QQ：模块启动 roost 后会给二维码，扫码即可建机器人并自动拿凭证（不用自己去开放平台抄 AppID/AppSecret）',
  '去 roost 面板「群组」页认领主人（owners 为空时任何人发 /claim 都能当主人，先认领防止被抢）',
  '把机器人拉进要用的群，并在 QQ 群设置里打开「接收所有消息 / 全量消息」（不开只收到 @ 的）',
  '群里聊一会儿让 roost 收集常用用户；主人先在 roost 面板「通知」页配好 SMTP 邮箱，常用用户就能发 /绑定QQ <QQ号> 收邮件验证码，再发 /QQ验证码 <码> 自助绑；也可到「身份」页由主人代绑 QQ 号 / 群号',
  '以上做好后，最后才点「接入大肥鱼」并重启 DSH——记忆直接认人、不串合成号',
];

export function summary() {
  const out = { support: 0, degrade: 0, unsupported: 0 };
  for (const c of CAPABILITIES) out[c.avail] += 1;
  return out;
}

export function textDigest() {
  const s = summary();
  const lines = [
    `兼容能力：${s.support} 项支持 / ${s.degrade} 项降级 / ${s.unsupported} 项不支持`,
    '',
    `${CAVEATS.length} 个要注意：`,
    ...CAVEATS.map((c, i) => `${i + 1}. ${c.title}——${c.body}`),
    '',
    '要你自己做（模块代劳不了）：',
    ...MANUAL_STEPS.map((m, i) => `${i + 1}. ${m}`),
  ];
  return lines.join('\n');
}

export function textWhyRoost() {
  return ['为什么用 roost 而不是裸官方接口：', ...WHY_ROOST.map((w, i) => `${i + 1}. ${w.title}——${w.body}`)].join('\n');
}
