// index.mjs —— mijia 模块入口（装配层）
// 作用：小米米家云设备列表与开/关控制。三个入口：
//   1. /米家 命令（框架只认主人）
//   2. 自然消息（私聊里说「米家设备」「开客厅灯」；主人或授权名单，默认仅私聊）
//   3. AI 工具 mijia_control（只挂给有权限的会话，让她听得懂「把客厅灯关了」）
// 云协议实现在 lib/cloud.js（v2 扫码协议，走 api.mijia.tech 加密网关）；
// 解析/权限纯函数在 lib/parse.js。
// 登录无需账号密码：面板点「扫码登录」，用米家 APP 扫二维码即可；令牌缓存在 api.dataDir()。

import { createMiCloud } from './lib/cloud.js'
import { parseIntent, matchDevice, canControl, formatDevices, classifyDevice } from './lib/parse.js'

export default {
  id: 'mijia',
  name: '逛米家（米家智控）',
  version: '1.1.3',
  api: 1,
  description: '米家设备列表与开/关控制：扫码登录免账号密码，私聊说「开客厅灯」或用 /米家 命令，也能让她自己调工具',
  panel: 'panel.js',
  defaults: {
    enabled: false,
    whitelist: '',
    privateOnly: true,
    cacheSeconds: 300,
    homeName: '', // 只看哪个家（家庭名称或 id）；空=全部家庭
  },
  // settings 留空：面板字段全部由 panel.js 接管（账号/密码/总开关与验证登录放同一张卡上），
  // 运行时兜底见下面 getSettings()。
  settings: [],

  setup(api) {
    const testHooks = api.__mijiaTestHooks || {}

    const getSettings = () => {
      const s = api.settings()
      return {
        enabled: s.enabled === true,
        whitelist: String(s.whitelist || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
        privateOnly: s.privateOnly !== false, // 默认开
        cacheSeconds: Math.max(30, Number(s.cacheSeconds) || 300),
        homeName: String(s.homeName || '').trim(), // 空=全部家庭
      }
    }

    const HELP =
      '米家用法：\n' +
      '「米家设备」——列设备（名称/在线状态/型号）\n' +
      '「开 客厅灯」「关掉 插座」——开关设备\n' +
      '或者直接跟我说：「把客厅灯关了」「音响音量调到 30」「客厅灯什么状态」，我自己调工具。'

    // 惰性云客户端：协议 v2 不需要账号密码（扫码登录），令牌缓存在数据目录
    let cloud = null
    function getCloud() {
      if (!cloud) {
        cloud = (testHooks.createMiCloud || createMiCloud)({
          dataDir: api.dataDir(),
          log: (t) => api.log.info(`[mijia] ${t}`),
        })
      }
      return cloud
    }

    /** 权限门：这条消息（或这个会话的用户）能不能碰米家 */
    function gateOf(msg) {
      const s = getSettings()
      return {
        isOwner: api.isOwner(msg.userId),
        whitelist: s.whitelist,
        privateOnly: s.privateOnly,
      }
    }

    /** 按意图执行：返回给用户看的文字 */
    async function runIntent(intent, msg) {
      const gate = gateOf(msg)
      const allow = canControl(msg, gate)
      if (!allow.ok) return allow.reason
      if (!getSettings().enabled) return '米家智控总开关没开：请主人到面板打开「总开关」。'
      if (intent.intent === 'help') return HELP
      try {
        const c = getCloud()
        if (intent.intent === 'list') {
          const items = await c.deviceList(false, getSettings().cacheSeconds * 1000)
          return formatDevices(items)
        }
        // 开/关：先取列表（走缓存）模糊匹配设备
        const items = await c.deviceList(false, getSettings().cacheSeconds * 1000)
        const { device, candidates } = matchDevice(items, intent.name)
        if (!device) {
          if (!candidates.length) return `没找到叫「${intent.name}」的设备，说「米家设备」可以看列表。`
          return `「${intent.name}」匹配到多台设备，说得更具体些：\n` + candidates.map((d) => d.name).join('、')
        }
        if (!device.isOnline) return `「${device.name}」现在是离线状态，碰不到它。`
        const on = intent.intent === 'on'
        await c.setOnOff(device, on)
        return `好啦，「${device.name}」已${on ? '打开' : '关闭'}。`
      } catch (e) {
        api.log.error(`[mijia] 执行失败：${e.message}`)
        return `米家那边出了岔子：${e.message}`
      }
    }

    // ---- 对内 API（其他模块经 api.use('mijia') 调用；调用方自担权限，这里只管执行）----
    //      did 或设备名（模糊匹配，唯一命中才执行）皆可。

    /** 按名称模糊定位设备；返回 { device } 或 { error }（多台/无命中） */
    async function locateDevice(nameOrDid) {
      const c = getCloud()
      const items = await c.deviceList(false, getSettings().cacheSeconds * 1000)
      if (items.some((d) => d.did === String(nameOrDid))) {
        return { device: items.find((d) => d.did === String(nameOrDid)) }
      }
      const { device, candidates } = matchDevice(items, String(nameOrDid))
      if (!device) {
        return candidates.length
          ? { error: `「${nameOrDid}」匹配到多台设备：${candidates.map((d) => d.name).join('、')}` }
          : { error: `没找到叫「${nameOrDid}」的设备` }
      }
      return { device }
    }

    function onlineGate(device) {
      return device.isOnline ? null : `「${device.name}」现在是离线状态`
    }

    /**
     * 第三方模块 API：设备列表，支持多维筛选（全可叠加）。
     * opts: {
     *   refresh      强制刷新（跳过缓存）
     *   room         房间名（子串匹配，如「客厅」）
     *   type         设备类型：light/switch/ac/curtain/fan/sensor/hub/other，或中文标签（灯/插座…）
     *   online       true=仅在线，false=仅离线
     *   controllable true=仅可控（有开关语义），false=仅查看类
     *   name         设备名（子串匹配）
     *   model        型号（子串匹配）
     * }
     * 返回 [{ did,name,model,roomName,roomId,isOnline,type,label,controllable }]
     */
    async function listDevices(opts = {}) {
      const { refresh = false, room, type, online, controllable, name, model, home } = opts
      const c = getCloud()
      // home 优先用调用方给的，其次用设置里的「只看哪个家」
      let items = await c.deviceList(refresh, getSettings().cacheSeconds * 1000, {
        home: home === undefined ? getSettings().homeName : home,
      })
      items = items.map((d) => ({ ...d, ...classifyDevice(d.model, d.name) }))
      if (room) items = items.filter((d) => String(d.roomName || '').includes(String(room)))
      if (type) {
        const t = String(type).toLowerCase()
        items = items.filter((d) => d.type === t || String(d.label) === String(type))
      }
      if (online !== undefined) items = items.filter((d) => d.isOnline === !!online)
      if (controllable !== undefined) items = items.filter((d) => d.controllable === !!controllable)
      if (name) items = items.filter((d) => String(d.name).includes(String(name)))
      if (model) items = items.filter((d) => String(d.model).includes(String(model)))
      return items
    }

    /** 第三方模块 API：按房间汇总（房间 -> {total, online, types:{type:count}}），报表/场景模块好用 */
    async function listRooms({ refresh = false } = {}) {
      const items = await listDevices({ refresh })
      const rooms = new Map()
      for (const d of items) {
        const r = rooms.get(d.roomName) || { room: d.roomName, total: 0, online: 0, types: {} }
        r.total++
        if (d.isOnline) r.online++
        r.types[d.label] = (r.types[d.label] || 0) + 1
        rooms.set(d.roomName, r)
      }
      return Array.from(rooms.values())
    }

    /** 第三方模块 API：开/关设备。返回 { ok, message } */
    async function control(nameOrDid, on) {
      try {
        const { device, error } = await locateDevice(nameOrDid)
        if (error) return { ok: false, message: error }
        const off = onlineGate(device)
        if (off) return { ok: false, message: off }
        await getCloud().setOnOff(device, !!on)
        return { ok: true, message: `「${device.name}」已${on ? '打开' : '关闭'}`, device }
      } catch (e) {
        return { ok: false, message: e.message }
      }
    }

    /** 第三方模块 API：下发属性（key=规格 control key，如 p2_2；或语义名 brightness/colorTemp/volume）。返回 { ok, message } */
    async function setState(nameOrDid, key, value) {
      try {
        const { device, error } = await locateDevice(nameOrDid)
        if (error) return { ok: false, message: error }
        const off = onlineGate(device)
        if (off) return { ok: false, message: off }
        const c = getCloud()
        const props = await c.specProps(device.model)
        // 语义名兼容：brightness/colorTemp/volume 这类常用名直接映射到对应控件
        let control = (props.controls || []).find((x) => x.key === key)
        if (!control && ['brightness', 'colorTemp', 'volume'].includes(String(key))) {
          const re = { brightness: /亮度|brightness/i, colorTemp: /色温|colou?r[-._ ]?temp/i, volume: /音量|volume/i }[key]
          control = (props.controls || []).find((x) => re.test(`${x.description} ${x.name}`) && x.kind === 'slider')
        }
        if (!control) return { ok: false, message: `「${device.name}」没有 ${key} 这个控制项` }
        let v = value
        if (control.kind === 'select') v = Number(value)
        else if (control.kind === 'slider') v = Math.round(Number(value))
        await c.setProp(device, { siid: control.siid, piid: control.piid }, v)
        return { ok: true, message: `「${device.name}」${control.zh || control.name}已调整`, device }
      } catch (e) {
        return { ok: false, message: e.message }
      }
    }

    /** 第三方模块 API：查设备当前状态。返回 { ok, state: {key:value}, controls: 规格控件表 } */
    async function getState(nameOrDid) {
      try {
        const { device, error } = await locateDevice(nameOrDid)
        if (error) return { ok: false, message: error }
        const c = getCloud()
        const props = await c.specProps(device.model)
        const states = await c.getStates([device])
        return { ok: true, state: states[device.did] || {}, controls: props.controls || [], device }
      } catch (e) {
        return { ok: false, message: e.message }
      }
    }

    // ---- 入口 1：/米家 命令（框架天然只认主人）----
    api.command({
      name: '米家',
      desc: '米家设备列表与开关：/米家 列表、/米家 开 客厅灯、/米家 关 插座',
      async run(arg, msg) {
        const a = arg.trim()
        if (!a) return HELP
        const intent = parseIntent(a)
        if (!intent) return HELP
        return runIntent(intent, msg)
      },
    })

    // ---- 入口 2：自然消息（私聊优先；权限门见 parse.js canControl）----
    api.on('message', async (msg) => {
      const text = String(msg.text || '').trim()
      if (!text) return false
      const intent = parseIntent(text)
      if (!intent) return false
      // 没开总开关或没权限时静默放行：消息入口不扰民（明确的 /米家 命令才会给出提示）
      if (!getSettings().enabled) return false
      if (!canControl(msg, gateOf(msg)).ok) return false
      const reply = await runIntent(intent, msg)
      await api.reply(msg, reply)
      return true // 接管，她不再处理
    })

    // ---- 入口 2.5：面板路由（供 panel.js 调；面板属主人界面，不设 QQ 权限门）----
    // GET /devices?refresh=1：列全部设备（附类型）；POST /control {did, on}：按 did 开/关
    api.route('/devices', async (req) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const refresh = url.searchParams.get('refresh') === '1'
        // home 为空=全部家庭；给了就只看那一家（家庭 id 或名称子串）
        const home = String(url.searchParams.get('home') || '').trim()
        const c = getCloud()
        const all = await c.deviceList(refresh, getSettings().cacheSeconds * 1000)
        const items = home ? all.filter((d) => d.homeId === home || (d.homeName || '').includes(home)) : all
        return {
          ok: true,
          home,
          homes: await c.homesList(refresh, getSettings().cacheSeconds * 1000),
          devices: items.map((d) => ({ ...d, ...classifyDevice(d.model, d.name) })),
          total: all.length,
        }
      } catch (e) {
        api.log.error(`[mijia] 面板取设备列表失败：${e.message}`)
        return { ok: false, message: e.message, notificationUrl: e.notificationUrl || '' }
      }
    })
    // GET /homes：面板「家庭」下拉用（id/名称/是否共享/房间数）
    api.route('/homes', async (req) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const refresh = url.searchParams.get('refresh') === '1'
        return { ok: true, homes: await getCloud().homesList(refresh, getSettings().cacheSeconds * 1000) }
      } catch (e) {
        api.log.error(`[mijia] 面板取家庭列表失败：${e.message}`)
        return { ok: false, message: e.message }
      }
    })
    // POST /qr/start：领扫码登录二维码（不阻塞），返回 { qr, loginUrl } 或 { refreshed: true }
    api.route('/qr/start', async () => {
      try {
        const r = await getCloud().qrStart()
        if (r.refreshed) return { ok: true, refreshed: true, message: '登录凭证仍有效，已自动续期，无需扫码' }
        return {
          ok: true,
          qr: r.qr || '',
          loginUrl: r.loginUrl || '',
          message: '二维码已就绪，请用米家 APP 扫一扫',
        }
      } catch (e) {
        api.log.error(`[mijia] 领取二维码失败：${e.message}`)
        return { ok: false, message: e.message }
      }
    })
    // POST /qr/poll：长轮询等扫码（挂起最长 ~120 秒），扫码成功即登录
    api.route('/qr/poll', async () => {
      try {
        const r = await getCloud().qrPoll()
        return { ok: true, message: `扫码登录成功（userId=${r.userId}），凭证已缓存到本机数据目录` }
      } catch (e) {
        api.log.error(`[mijia] 扫码等待失败：${e.message}`)
        return { ok: false, timeout: /超时|timeout|code=20003/i.test(e.message), message: e.message }
      }
    })
    // POST /logout：清除本机登录凭证，设备列表一并作废（下次操作前需重新扫码）
    api.route('/logout', async () => {
      try {
        const r = await getCloud().logout()
        return { ok: true, had: r.had, message: r.had ? '已退出登录，本机凭证已清除' : '本来就没有登录态' }
      } catch (e) {
        api.log.error(`[mijia] 退出登录失败：${e.message}`)
        return { ok: false, message: e.message }
      }
    })
    // GET /qr/state：面板判断是否已有登录态
    api.route('/qr/state', async () => {
      try {
        return { ok: true, loggedIn: await getCloud().hasLogin() }
      } catch (e) {
        return { ok: false, loggedIn: false, message: e.message }
      }
    })

    api.route('/control', async (req) => {
      try {
        const body = await api.core.http.body(req)
        const did = String(body?.did || '')
        const on = !!body?.on
        if (!did) return { ok: false, message: '缺少设备 did' }
        const c = getCloud()
        const items = await c.deviceList(false, 15000) // 控制前取一次短缓存列表定位设备
        const device = items.find((d) => d.did === did)
        if (!device) return { ok: false, message: '设备不在列表里（可能刚被移除），刷新后再试' }
        if (!device.isOnline) return { ok: false, message: `「${device.name}」离线，碰不到它` }
        await c.setOnOff(device, on)
        return { ok: true, message: `「${device.name}」已${on ? '打开' : '关闭'}` }
      } catch (e) {
        api.log.error(`[mijia] 面板控制失败：${e.message}`)
        return { ok: false, message: e.message }
      }
    })

    // GET /spec?model=...：查型号可用控制点（开关/亮度/色温 的 siid/piid），面板滑条用
    api.route('/spec', async (req) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const model = String(url.searchParams.get('model') || '')
        if (!model) return { ok: false, message: '缺少 model' }
        const props = await getCloud().specProps(model)
        return { ok: true, props }
      } catch (e) {
        api.log.error(`[mijia] 查规格失败：${e.message}`)
        return { ok: false, message: e.message }
      }
    })
    // POST /prop {did, key, value}：按规格里的 control key 下发属性（滑条/下拉/开关通用）
    api.route('/prop', async (req) => {
      try {
        const body = await api.core.http.body(req)
        const did = String(body?.did || '')
        const key = String(body?.key || '')
        const value = body?.value
        if (!did || !key || value === undefined) return { ok: false, message: '参数不齐：did / key / value' }
        const c = getCloud()
        const items = await c.deviceList(false, 15000)
        const device = items.find((d) => d.did === did)
        if (!device) return { ok: false, message: '设备不在列表里（可能刚被移除），刷新后再试' }
        const props = await c.specProps(device.model)
        const control = (props.controls || []).find((x) => x.key === key)
        if (!control) return { ok: false, message: `「${device.name}」没有 ${key} 这个控制项` }
        // 下拉值按米家惯例转数字；布尔原样；滑条取整
        let v = value
        if (control.kind === 'select') v = Number(value)
        else if (control.kind === 'slider') v = Math.round(Number(value))
        await c.setProp(device, { siid: control.siid, piid: control.piid }, v)
        return { ok: true, message: `「${device.name}」${control.name}已调整` }
      } catch (e) {
        api.log.error(`[mijia] 调节失败：${e.message}`)
        return { ok: false, message: e.message }
      }
    })

    // POST /state {dids:[...]}：批量查设备当前状态，并顺带带回各型号的规格控件表
    // （状态列要按控件语义显示，规格跟着一次回来，面板不用先点「调节」才拉）
    api.route('/state', async (req) => {
      try {
        const body = await api.core.http.body(req)
        const dids = Array.isArray(body?.dids) ? body.dids.map(String).slice(0, 50) : []
        if (!dids.length) return { ok: false, message: '缺少 dids' }
        const c = getCloud()
        const items = await c.deviceList(false, getSettings().cacheSeconds * 1000)
        const targets = items.filter((d) => dids.includes(d.did))
        const states = await c.getStates(targets)
        // 触碰过的型号规格一并回（服务端有缓存，不重复打规格库）
        const specs = {}
        for (const d of targets) {
          if (!specs[d.model]) {
            try { specs[d.model] = await c.specProps(d.model) } catch { /* 单型号失败不拖垮整体 */ }
          }
        }
        return { ok: true, states, specs }
      } catch (e) {
        api.log.error(`[mijia] 查状态失败：${e.message}`)
        return { ok: false, message: e.message }
      }
    })

    // ---- 入口 3：给她的工具（只挂有权限的私聊会话）----
    api.tool(({ chat, sessionId }) => {
      if (chat.kind !== 'private') return []
      const msg = { userId: chat.userId, kind: 'private' }
      if (!canControl(msg, gateOf(msg)).ok) return []
      return [
        api.defineTool({
          name: 'mijia_control',
          description: '控制与查询小米米家智能家居：列设备、开/关设备、查设备当前状态、调亮度/色温/音量等属性。',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'on', 'off', 'state', 'set'],
              description: 'list=列设备（可按 room/type/online 筛），on/off=开/关设备，state=查设备当前状态，set=调属性（需 key 和 value）',
            },
            device: { type: 'string', description: '设备名或 did，如「客厅灯」；action 为 list 时可省略' },
            home: { type: 'string', description: 'action=list 时按家庭筛（家庭名或 id，子串），如「我的家」' },
            room: { type: 'string', description: 'action=list 时按房间筛（子串），如「客厅」' },
            type: { type: 'string', description: 'action=list 时按类型筛：light/switch/ac/curtain/fan/sensor/hub' },
            online: { type: 'string', enum: ['true', 'false'], description: 'action=list 时按在线状态筛' },
            key: { type: 'string', description: 'action=set 时要调的属性名：brightness=亮度，colorTemp=色温，volume=音量 等' },
            value: { type: 'string', description: 'action=set 时的目标值：亮度/音量 1~100，色温 2700~6500' },
          },
          required: ['action'],
          execute: async ({ action, device, home, room, type, online, key, value }) => {
            if (!['list', 'on', 'off', 'state', 'set'].includes(action)) {
              return { ok: false, message: 'action 只能是 list/on/off/state/set' }
            }
            if (action === 'list') {
              const items = await listDevices({
                home, room, type,
                online: online === undefined ? undefined : online === 'true',
              })
              return {
                ok: true,
                message: items.length
                  ? `米家设备（${items.length} 台）：\n` + items.map(formatDevicesLine).join('\n')
                  : '没找到符合条件的设备。',
              }
            }
            if (!device) return { ok: false, message: '该操作需要给出设备名' }
            if (action === 'on' || action === 'off') return control(device, action === 'on')
            if (action === 'state') {
              const r = await getState(device)
              if (!r.ok) return r
              const labels = Object.entries(r.state).map(([k, v]) => {
                const c = (r.controls || []).find((x) => x.key === k)
                return (c?.zh || c?.name || k) + '：' + (c?.kind === 'select' ? (c.options || []).find((o) => o.value === v)?.label ?? v : v)
              })
              return { ok: true, message: `「${r.device.name}」当前状态：${labels.join('；') || '没有可查的控制项'}` }
            }
            // action === 'set'
            if (!key || value === undefined) return { ok: false, message: '调属性需要 key 和 value（如 key=brightness, value=50）' }
            return setState(device, key, value)
          },
        }),
      ]
    })

    // 让她知道自己有这本事（只对私聊规则说，群聊不提）
    api.rule((kind) =>
      kind === 'private'
        ? '你可以用 mijia_control 工具控制与查询小米米家设备：开灯关插座、问某台设备的状态、调亮度色温音量等都用它。'
        : ''
    )

    /** 设备列一行简述（工具 list 动作用） */
    function formatDevicesLine(d) {
      return `${d.isOnline ? '●' : '○'}${d.name}（${d.label} · ${d.model}）${d.roomName ? ' @' + d.roomName : ''}${d.controllable ? '' : ' [仅查看]'}`
    }

    return {
      /** 给别的模块/测试用：按文字意图执行一次（带权限门与用户文案） */
      runIntent,
      /**
       * 第三方模块 API（api.use('mijia') 后可用）：
       *   listDevices({refresh,home,room,type,online,controllable,name,model})
       *       -> [{did,name,model,roomName,homeId,homeName,isOnline,type,label,controllable}] 多维筛选设备列表
       *      home：家庭 id 或名称子串（不传=用设置里的「只看哪个家」，仍为空=全部家庭）
       *   homesList({refresh}) -> [{id,name,uid,shared,roomCount}] 账号下的家庭（共享家庭 shared=true）
       *   listRooms({refresh}) -> [{room,total,online,types:{标签:数}}] 按房间汇总
       *   control(nameOrDid, on)            -> { ok, message } 开/关设备
       *   setState(nameOrDid, key, value)   -> { ok, message } 调属性；key 可用规格 key（p2_2）或语义名（brightness/colorTemp/volume）
       *   getState(nameOrDid)               -> { ok, state:{key:value}, controls:[规格控件表] }
       * 注意：这些方法不走 QQ 权限门（跨模块调用方自担权限），只有消息入口有权限门。
       */
      listDevices,
      homesList: () => getCloud().homesList(),
      listRooms,
      control,
      setState,
      getState,
    }
  },
}
