/** @type {import('../aurabot').AurabotModule} */
export default {
    id: 'duel',
    name: '宝可梦对决',
    version: '1.0.0',
    api: 1,
    description: '娱乐友谊赛：群里说「发起决斗」→ 对方主人说「接受」→ 两条鱼按回合口令对喷；回合推进靠「〈系统提示：…〉」消息，被双方模块拦下，不喂给大模型',

    defaults: {
        acceptTimeout: 120,
        turnTimeout: 180,
        duelRounds: 5,
        opponentOwners: '',
        fishType: '',
        fishSkills: '',
        fishTraits: '',
        fishNotes: '',
    },

    settings: [
        { key: 'acceptTimeout', label: '等待接受超时（秒）', type: 'number', min: 10, max: 600 },
        { key: 'turnTimeout', label: '每回合超时（秒）', type: 'number', min: 10, max: 600, hint: '等主人下令 / 等对方鱼反应的时间' },
        { key: 'duelRounds', label: '回合数', type: 'number', min: 1, max: 10 },
        { key: 'opponentOwners', label: '谁能应战（主人 QQ）', type: 'textarea', hint: '只有名单里的主人说「接受」才算数；多个用逗号、空格或换行分开。留空 = 谁先喊都行' },
        // 鱼的信息页：全部只当表演参考，不改变任何数值与胜负
        { key: 'fishType', label: '鱼的信息 · 属性', type: 'text', placeholder: '例如：水', hint: '留着当惯用元素用。留空 = 无。只影响演出，不影响克制判定和输赢' },
        { key: 'fishSkills', label: '鱼的信息 · 技能', type: 'textarea', placeholder: '例如：水枪、甩尾、装死', hint: '常用招式或打法，可以拿来演。留空 = 无' },
        { key: 'fishTraits', label: '鱼的信息 · 特性', type: 'textarea', placeholder: '例如：皮糙肉厚、记仇、爱吹牛', hint: '招牌特点或小毛病。留空 = 无' },
        { key: 'fishNotes', label: '鱼的信息 · 其他', type: 'textarea', placeholder: '随便写，比如口头禅、软肋、黑历史', hint: '想补的都可以写在这里。留空 = 无。以上都只作参考，没有实力加成' },
    ],

    /**
     * 协议（两条鱼各自跑这个模块，靠群消息广播同步）：
     *
     *   人 A：发起决斗            → A 的鱼进入 waiting（发起方）
     *                               别的鱼看到后也进入 waiting（应战方，等自己的主人）
     *   人 B：接受                → A 的鱼开会：发「对决开始」「第一回合上开始」
     *                               B 的鱼收到后进入对战
     *                               设置项 opponentOwners 非空时，A 的鱼只认名单里的主人应战
     *   上半场：A 下令 → A 的鱼反应 → B 的鱼反应 → B 的鱼发「第N回合下开始」
     *   下半场：B 下令 → B 的鱼反应 → A 的鱼反应 → A 的鱼发「第N+1回合上开始」
     *   最后一回合结束后，A 的鱼当裁判，发「对决结束，X获胜」
     */
    setup(api) {
        // !! 外壳必须避开【】 !! 宿主的出口清洗会把【系统……】整段当成注入的提示词删掉
        // （reply.js 的 memoryPromptRanges），用【系统提示：…】发出去，群里其实什么都收不到，
        // 只剩一条「模型输出整段都是提示词复读」告警 —— 对手也就永远等不到开场的系统提示。
        const SYS_HEAD = '〈系统提示：'
        const SYS_TAIL = '〉'
        // 旧外壳仍然认，免得对面还跑着老版本
        const SYS_HEAD_OLD = '【系统提示：'
        const SYS_TAIL_OLD = '】'
        const MAX_TEXT = 200          // 一条命令最多记多少字
        const MAX_TRANSCRIPT = 40     // 转录最多留多少条
        const SEEN_TTL = 10 * 60_000  // 消息去重记忆多久
        const SEEN_MAX = 2000

        const log = (...a) => api.log.info('[duel]', ...a)
        const warn = (...a) => api.log.warn('[duel]', ...a)

        /** 设置项每次都现读（面板改完不用重载模块） */
        const setting = (key, fallback) => {
            const n = Number(api.settings()?.[key])
            return Number.isFinite(n) && n > 0 ? n : fallback
        }

        /** 文本型设置项（QQ 名单），同样每次现读 */
        const settingText = (key, fallback = '') => {
            const v = api.settings()?.[key]
            return v == null ? fallback : String(v)
        }

        const digits = (v) => String(v ?? '').replace(/\D/g, '')

        /**
         * 谁能说「接受」：名单为空 = 谁先喊都行（默认）；名单非空 = 只认名单里的主人。
         * 名单在设置面板里填，多个用逗号/空格/换行分开。
         */
        const canAccept = (qq) => {
            const list = settingText('opponentOwners', '')
                .split(/[\s,，、;；]+/)
                .map(digits)
                .filter(Boolean)
            if (!list.length) return true
            return list.includes(digits(qq))
        }

        // ---------------- 鱼的信息（设置页） ----------------
        /** 主人填的属性/技能/特性/其他：留空就不出现，写了也只当表演参考 */
        const FISH_FIELDS = [
            ['属性', 'fishType'],
            ['技能', 'fishSkills'],
            ['特性', 'fishTraits'],
            ['其他', 'fishNotes'],
        ]

        const fishInfo = () => FISH_FIELDS
            .map(([label, key]) => [label, String(settingText(key, '') || '').trim().replace(/\s*\n+\s*/g, '；')])
            .filter(([, v]) => v)

        const fishProfile = () => {
            const rows = fishInfo()
            if (!rows.length) return ''
            return [
                '你这条鱼的设定（主人填的，只作表演参考，不增加也不削减任何实力，输赢仍看场面和嘴皮子）：',
                ...rows.map(([label, v]) => `- ${label}：${v}`),
            ].join('\n')
        }

        // ---------------- 状态 ----------------
        // 每条鱼（每个插件实例）同时只打一场；state.chatId 决定只认哪个群
        let state = { phase: 'idle' }
        let timer = null
        let chain = Promise.resolve()
        let lastEndAt = 0

        const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }

        const armTimer = (ms, fire) => {
            clearTimer()
            timer = setTimeout(() => {
                timer = null
                try { fire() } catch (e) { warn('计时器回调出错', e?.message || e) }
            }, ms)
        }

        const reset = (why) => {
            if (state.phase !== 'idle' && why) log(`对决结束：${why}`)
            clearTimer()
            lastEndAt = Date.now()
            state = { phase: 'idle' }
        }

        // 串行队列：模型调用慢也不会打乱顺序，更不会因为「正忙」把对方的话丢掉
        const enqueue = (task) => {
            chain = chain.then(task).catch((e) => warn('处理消息出错', e?.stack || e?.message || e))
        }

        // ---------------- 小工具 ----------------
        /** 自己的 QQ：message 事件带 raw（原始事件），onebot 事件本身就有 self_id，都不需要再问网关 */
        const selfIdOf = (msg) => String(msg?.raw?.self_id || api.config().botQQ || '')

        const isSysText = (t) => typeof t === 'string'
            && ((t.startsWith(SYS_HEAD) && t.endsWith(SYS_TAIL)) || (t.startsWith(SYS_HEAD_OLD) && t.endsWith(SYS_TAIL_OLD)))
        const sysBody = (t) => (t.startsWith(SYS_HEAD)
            ? t.slice(SYS_HEAD.length, -SYS_TAIL.length)
            : t.slice(SYS_HEAD_OLD.length, -SYS_TAIL_OLD.length))

        const sendSys = (chatId, body) => api.sendText(chatId, `${SYS_HEAD}${body}${SYS_TAIL}`)

        /** 人格：core.personas.current() 直接返回人设正文（字符串），不是对象 */
        const getPersona = () => {
            try {
                const p = api.core?.personas?.current?.()
                if (typeof p === 'string') return p.trim()
                return String(p?.content || p?.text || p?.body || '').trim()
            } catch (e) {
                warn('读人格失败', e?.message || e)
                return ''
            }
        }

        const parseNum = (s) => {
            if (/^\d+$/.test(s)) return Number(s)
            const d = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
            if (s === '十') return 10
            if (s.length === 2 && s[0] === '十') return 10 + (d[s[1]] || 0)
            if (s.length === 2 && s[1] === '十') return (d[s[0]] || 0) * 10
            if (s.length === 3 && s[1] === '十') return (d[s[0]] || 0) * 10 + (d[s[2]] || 0)
            return d[s] || 0
        }

        const extractText = (message, self) => {
            if (typeof message === 'string') return message
            if (!Array.isArray(message)) return ''
            const parts = []
            for (const seg of message) {
                if (!seg || !seg.type) continue
                const data = seg.data || {}
                if (seg.type === 'text') parts.push(String(data.text || ''))
                else if (seg.type === 'at') {
                    if (String(data.qq) !== String(self)) parts.push(`@${data.name || data.qq || ''} `)
                } else if (seg.type === 'image' || seg.type === 'mface') parts.push('[图片]')
                else if (seg.type === 'face') parts.push('[表情]')
                else if (seg.type === 'record') parts.push('[语音]')
                else if (seg.type === 'video') parts.push('[视频]')
            }
            return parts.join('').trim()
        }

        /** 原始 OneBot 事件 → 统一的 msg 形状（message 事件直接给的就是这个形状） */
        const fromEvent = (evt) => {
            const self = String(evt.self_id || '')
            const group = evt.message_type === 'group'
            return {
                kind: group ? 'group' : 'private',
                chatId: group ? `group:${evt.group_id}` : `private:${evt.user_id}`,
                userId: String(evt.user_id ?? ''),
                groupId: group ? String(evt.group_id ?? '') : '',
                nickname: String(evt.sender?.card || evt.sender?.nickname || evt.user_id || ''),
                text: extractText(evt.message, self),
                messageId: String(evt.message_id ?? ''),
                raw: evt,
            }
        }

        // 两条通道（message / onebot）会收到同一条消息，按 messageId 去重
        const seen = new Map()
        const markSeen = (id) => {
            if (!id) return false
            const now = Date.now()
            const at = seen.get(id)
            if (at && now - at < SEEN_TTL) return true
            seen.set(id, now)
            if (seen.size > SEEN_MAX) {
                for (const [k, v] of seen) if (now - v > SEEN_TTL) seen.delete(k)
                if (seen.size > SEEN_MAX) seen.clear()
            }
            return false
        }

        const pushLine = (d, who, text) => {
            if (!text) return
            d.transcript.push({ who, text })
            while (d.transcript.length > MAX_TRANSCRIPT) d.transcript.shift()
        }

        // ---------------- 模型 ----------------
        // 出站清洗（hub.cleanOutbound）会把「整段都像提示词」的输出删空、按沉默处理，
        // 对方就永远等不到这一手 → 回合卡到超时。所以先在本地自查，必要时换短提示重来。
        const squash = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}\u200B-\u200D\uFEFF\u2060]/gu, '')
        const META_ECHO = /系统提示|输出格式|人格设定|你的身份|当前命令|最近记录|效果拔群|属性克制|不要出现/

        /** 输出像不像把提示词背了一遍（归一化后连续 14 字撞上就算） */
        const echoesPrompt = (out, prompt) => {
            if (META_ECHO.test(String(out ?? ''))) return true
            const a = squash(out)
            const b = squash(prompt)
            if (!a || !b) return false
            if (a.length >= 8 && b.includes(a)) return true
            for (let i = 0; i + 14 <= a.length; i++) if (b.includes(a.slice(i, i + 14))) return true
            return false
        }

        /** 重试也救不回来时的兜底：至少给一句动作 + 台词，别让回合断掉 */
        const PLAN_B = [
            '甩了甩尾巴，没接话。\n「……哼。」',
            '吐了个泡泡，装作没听见。\n「就这？」',
            '沉到水底又浮上来，斜眼看他。\n「再说一遍？」',
        ]
        const planB = (d) => PLAN_B[Math.abs(Number(d?.round) || 0) % PLAN_B.length]

        const LEAN_SYSTEM = '你在演一条参加口才对决的鱼。照下面的记录接着演：先写 1-2 句动作，再写 1-2 句「」台词，60 字以内。不要复述任何规则或说明，直接输出正文。'

        const genReaction = async (d, hint) => {
            const persona = getPersona()
            const system = [
                '你在演一条参加回合制口才对决的鱼。照下面的记录接着演，直接输出正文。',
                persona ? `你的人格设定：\n${persona}` : '',
                fishProfile(),
                '这场对决有隐性的属性克制，只用来决定「这一手的效果」，不许说破：先看对方这一手打的是什么属性（火水草电冰岩地面飞毒虫超能格斗幽灵龙钢一般），你自己又是什么属性、谁克谁，看不出来就按「一般」算；设了「属性」就按它算你惯常的属性，但克制仍看这一手实际打出来的东西。相克：火克草、草克水、水克火；电克水/飞行；地面克电；岩石克火/飞行；冰克草/龙/飞行；格斗克一般/岩石/冰；超能克格斗/毒；毒克草；钢克冰/岩石。',
                '效果只写进动作：占上风就压过去，对方的招式被烧穿、冲散或逼退；吃亏就明显落下乘，台词照样嘴硬；势均力敌就有来有回。不要出现「属性」「克制」「效果拔群」「倍率」「暴击」，也不要报招式名和数字；别每一手都写成自己占上风。',
                '格式：1-2 句动作（第三人称）+ 1-2 句台词（「」包裹），整段不超过 120 字。',
                '本场只是娱乐友谊赛，不涉及真实对抗；不要提到「系统提示」，不要解释规则，不要跳出角色。',
            ].filter(Boolean).join('\n\n')

            const ctx = []
            ctx.push(`第${d.round}回合 ${d.half === 'upper' ? '上' : '下'}半场`)
            ctx.push(`你的身份：${d.role === 'sender' ? `发起方鱼（主人的名字是「${d.senderName}」）` : `应战方鱼（主人的名字是「${d.receiverName}」）`}`)
            if (d.lastCmd) ctx.push(`当前命令：${d.lastCmd}`)
            if (d.transcript.length) {
                ctx.push('最近记录：')
                for (const t of d.transcript.slice(-10)) ctx.push(`${t.who}：${t.text}`)
            }
            if (hint) ctx.push(hint)

            const prompt = ctx.join('\n')
            try {
                let r = String(await api.ask({ system, text: prompt, maxTokens: 350 }) || '').trim()
                if (echoesPrompt(r, system)) {
                    warn('输出像是在复读提示词，换短提示重来一次')
                    r = String(await api.ask({ system: LEAN_SYSTEM, text: prompt, maxTokens: 200 }) || '').trim()
                }
                if (!r || echoesPrompt(r, LEAN_SYSTEM)) {
                    warn('重试后仍不可用，改用备用反应')
                    return planB(d)
                }
                return r
            } catch (e) {
                warn('生成反应失败', e?.message || e)
                return '（愣了一下）'
            }
        }

        const judgeWinner = async (d) => {
            const system = '你是客观裁判。根据对决记录判断哪一方表现更好（更有气势、更聪明、更有口才）。只输出获胜方主人的名字，不要标点，不要解释。'
            const text = [
                `发起方主人：${d.senderName}`,
                `应战方主人：${d.receiverName}`,
                '',
                '记录：',
                ...d.transcript.map((t) => `${t.who}：${t.text}`),
                '',
                '获胜方（只输出名字）：',
            ].join('\n')
            try {
                const r = String(await api.ask({ system, text, maxTokens: 30 }) || '').trim()
                const hasSender = d.senderName && r.includes(d.senderName)
                const hasReceiver = d.receiverName && r.includes(d.receiverName)
                if (hasReceiver && !hasSender) return d.receiverName
                if (hasSender) return d.senderName
                return d.senderName
            } catch (e) {
                warn('裁判调用失败，默认发起方获胜', e?.message || e)
                return d.senderName
            }
        }

        // ---------------- 反应发送 ----------------
        /**
         * 一段反应当作一条消息发出去。以前按行拆条发，对方鱼会把第一行当成整段反应记进转录，
         * 后面的台词变成孤立消息，容易误判成下一手的命令。
         */
        const sendReaction = async (chatId, text) => {
            let t = String(text || '').trim()
            if (!t) return
            // 万一模型自己写出「【系统提示：…】」，别让对方的模块当成协议消息（会乱跳回合）
            if (t.startsWith(SYS_HEAD) || t.startsWith(SYS_HEAD_OLD)) t = `…${t}`
            t = t.slice(0, 800)
            // 用官方同一套出站清洗探一次：整条会被清空的（提示词复读），换成备用反应再发，
            // 否则消息直接消失，对方等不到这一手，回合只能靠超时收场。
            try {
                const probe = api.core?.hub?.cleanOutbound?.(chatId, t)
                if (typeof probe === 'string') {
                    const kept = squash(probe).length
                    if (!kept) {
                        warn('这条反应会被出口清洗整条拦掉，改用备用反应')
                        t = planB(state.phase === 'duel' ? state : null)
                    } else if (kept < squash(t).length) {
                        t = probe.trim()
                    }
                }
            } catch (e) {
                warn('出站自检失败，照常发', e?.message || e)
            }
            if (!t.trim()) return
            await api.sendText(chatId, t)
        }

        // ---------------- 计时 ----------------
        const armTurnTimer = () => {
            armTimer(setting('turnTimeout', 180) * 1000, () => {
                if (state.phase !== 'duel') return
                const chatId = state.chatId
                warn('回合超时，结束对决')
                sendSys(chatId, '超时，对决结束').catch(() => { })
                reset('回合超时')
            })
        }

        const armWaitTimer = () => {
            const sec = setting('acceptTimeout', 120)
            armTimer(sec * 1000, () => {
                if (state.phase !== 'waiting') return
                if (state.isSender) {
                    sendSys(state.chatId, '无人接受，对决取消').catch(() => { })
                    reset('无人接受')
                } else {
                    // 应战方：主人没接就算悄悄作罢，不在群里刷提示
                    reset('主人没应战')
                }
            })
        }

        // ---------------- 进入对决 ----------------
        const enterAsSender = async (chatId, senderQQ, senderName, receiverQQ, receiverName) => {
            clearTimer()
            state = {
                phase: 'duel', chatId, role: 'sender',
                round: 1, half: 'upper', stage: 'init',
                senderQQ, senderName, receiverQQ, receiverName,
                opponentFishQQ: '', transcript: [], lastCmd: '',
            }
            const d = state
            log(`对决开始：${senderName} vs ${receiverName}`)
            try {
                await sendSys(chatId, '对决开始')
                await sendSys(chatId, '第一回合上开始')
            } catch (e) {
                warn('发送开场提示失败', e?.message || e)
            }
            if (state !== d || d.stage !== 'init') return
            d.stage = 'wait_cmd'
            armTurnTimer()
        }

        const enterAsReceiver = async (chatId, senderQQ, senderName, receiverQQ, receiverName) => {
            clearTimer()
            state = {
                phase: 'duel', chatId, role: 'receiver',
                round: 0, half: 'upper', stage: 'wait_duel_start',
                senderQQ, senderName, receiverQQ, receiverName,
                opponentFishQQ: '', transcript: [], lastCmd: '',
            }
            log(`应战：${receiverName} 接 ${senderName}，等对方开场`)
            // 等「对决开始」最多一个回合的时间
            armTimer(setting('turnTimeout', 180) * 1000, async () => {
                if (!(state.phase === 'duel' && state.stage === 'wait_duel_start')) return
                warn('没等到开场的「对决开始」，对方可能没接上（对方没装模块/名单没放行/它没收到「接受」），先收场')
                // 在群里说一声，别让人干等着；对方若也跑这个模块，看到这句会一起清场
                await sendSys(chatId, '开场超时，对决取消').catch((e) => warn('发超时提示失败', e?.message || e))
                if (state.phase === 'duel' && state.stage === 'wait_duel_start') reset('没等到开场提示')
            })
        }

        // ---------------- 系统提示 ----------------
        const handleSys = async (msg) => {
            if (state.phase !== 'duel') return
            const d = state
            if (msg.chatId !== d.chatId) return
            const body = sysBody(msg.text)
            const self = selfIdOf(msg)
            // 谁发的系统提示，谁就是对方鱼
            if (!d.opponentFishQQ && msg.userId !== self && msg.userId !== d.senderQQ && msg.userId !== d.receiverQQ) {
                d.opponentFishQQ = msg.userId
                log('对方鱼 QQ：', msg.userId)
            }

            if (body === '对决开始') {
                if (d.stage === 'wait_duel_start') {
                    d.stage = 'wait_round_start'
                    armTurnTimer()
                }
                return
            }

            let m = /^第([一二三四五六七八九十\d]+)回合上开始$/.exec(body)
            if (m) {
                if (['wait_duel_start', 'wait_round_start', 'wait_cmd', 'wait_opp_react'].includes(d.stage)) {
                    d.round = parseNum(m[1]) || d.round
                    d.half = 'upper'
                    d.stage = 'wait_cmd'
                    armTurnTimer()
                }
                return
            }

            m = /^第([一二三四五六七八九十\d]+)回合下开始$/.exec(body)
            if (m) {
                if (['wait_round_start', 'wait_cmd', 'wait_opp_react'].includes(d.stage)) {
                    d.round = parseNum(m[1]) || d.round
                    d.half = 'lower'
                    d.stage = 'wait_cmd'
                    armTurnTimer()
                }
                return
            }

            m = /^对决结束[，,]\s*(.+?)获胜$/.exec(body)
            if (m) {
                log('胜者：', m[1])
                reset(`判定「${m[1]}」获胜`)
                return
            }

            if (body === '无人接受，对决取消' || body === '对方拒绝，对决取消' || body === '超时，对决结束' || body === '开场超时，对决取消' || body === '对决取消') {
                reset(body)
            }
        }

        // ---------------- 对决中的普通消息 ----------------
        const handleDuelMsg = async (msg) => {
            const d = state.phase === 'duel' ? state : null
            if (!d || msg.chatId !== d.chatId) return

            const own = api.isOwner(msg.userId)
            const cmdOwnerQQ = d.half === 'upper' ? d.senderQQ : d.receiverQQ
            const isCmdOwner = String(msg.userId) === String(cmdOwnerQQ)

            if (d.stage === 'wait_cmd') {
                if (!isCmdOwner) return
                const cmd = String(msg.text || '').trim().slice(0, MAX_TEXT)
                if (!cmd) return

                // 对方主人的口令记成「对方主人」，别让模型以为是自己主人下的令
                pushLine(d, own ? `主人(${msg.nickname})` : `对方主人(${msg.nickname})`, cmd)
                d.lastCmd = cmd

                if (d.role === 'sender' && d.half === 'upper') {
                    const r = await genReaction(d, '轮到你反应。')
                    if (state !== d) return
                    await sendReaction(d.chatId, r)
                    if (state !== d) return
                    pushLine(d, '发起方鱼', r)
                    d.stage = 'wait_opp_react'
                } else if (d.role === 'receiver' && d.half === 'lower') {
                    const r = await genReaction(d, '轮到你反应。')
                    if (state !== d) return
                    await sendReaction(d.chatId, r)
                    if (state !== d) return
                    pushLine(d, '应战方鱼', r)
                    d.stage = 'wait_opp_react'
                } else {
                    // 这一手是对方鱼的反应回合
                    d.stage = 'wait_opp_react'
                }
                if (state === d) armTurnTimer()
                return
            }

            if (d.stage === 'wait_opp_react') {
                if (own) return
                if (msg.userId === d.senderQQ || msg.userId === d.receiverQQ) return
                if (d.opponentFishQQ) {
                    if (msg.userId !== d.opponentFishQQ) return
                } else {
                    // 发起方永远收不到对方鱼发的「开局」提示（那是自己发的），第一句话就是对方的反应，属于正常路径
                    d.opponentFishQQ = String(msg.userId)
                    log('认人：', msg.userId)
                }
                const reaction = String(msg.text || '').trim().slice(0, MAX_TEXT)
                if (!reaction) return
                pushLine(d, d.role === 'sender' ? '应战方鱼' : '发起方鱼', reaction)

                if (d.role === 'sender') {
                    if (d.half === 'upper') {
                        // 对方先反应，轮到下半场：等对方发「第N回合下开始」
                        d.stage = 'wait_round_start'
                        armTurnTimer()
                    } else {
                        const r = await genReaction(d, '对方已经反应，轮到你。')
                        if (state !== d) return
                        await sendReaction(d.chatId, r)
                        if (state !== d) return
                        pushLine(d, '发起方鱼', r)

                        const total = setting('duelRounds', 5)
                        if (d.round >= total) {
                            const winner = await judgeWinner(d)
                            if (state !== d) return
                            await sendSys(d.chatId, `对决结束，${winner}获胜`).catch((e) => warn('发送结局失败', e?.message || e))
                            reset(`判定「${winner}」获胜`)
                        } else {
                            const next = d.round + 1
                            await sendSys(d.chatId, `第${next}回合上开始`).catch((e) => warn('发送回合提示失败', e?.message || e))
                            if (state !== d) return
                            d.round = next
                            d.half = 'upper'
                            d.stage = 'wait_cmd'
                            armTurnTimer()
                        }
                    }
                } else {
                    if (d.half === 'upper') {
                        const r = await genReaction(d, '对方已经反应，轮到你。')
                        if (state !== d) return
                        await sendReaction(d.chatId, r)
                        if (state !== d) return
                        pushLine(d, '应战方鱼', r)
                        await sendSys(d.chatId, `第${d.round}回合下开始`).catch((e) => warn('发送回合提示失败', e?.message || e))
                        if (state !== d) return
                        d.half = 'lower'
                        d.stage = 'wait_cmd'
                        armTurnTimer()
                    } else {
                        // 对方先反应，等对方开下一回合
                        d.stage = 'wait_round_start'
                        armTurnTimer()
                    }
                }
            }
        }

        // ---------------- 路由 ----------------
        /** 这条消息要不要从她手里接管（返回 true 就是不进大模型） */
        const shouldClaim = (msg) => {
            if (msg.kind !== 'group') return false
            if (state.phase !== 'idle') return msg.chatId === state.chatId
            const t = String(msg.text || '').trim()
            if (t === '发起决斗') return true
            // 刚结束的一瞬间，避免「接受 / 拒绝」被她当成普通闲聊接一句
            if (t === '接受' || t === '拒绝') return Date.now() - lastEndAt < 5000
            return false
        }

        const handleMessage = async (msg) => {
            if (markSeen(msg.messageId)) return
            if (msg.kind !== 'group') return
            const self = selfIdOf(msg)
            if (self && msg.userId === self) return

            if (isSysText(msg.text)) {
                if (state.phase === 'duel') await handleSys(msg)
                return
            }

            if (state.phase !== 'idle' && msg.chatId !== state.chatId) return

            if (state.phase === 'idle') {
                if (String(msg.text || '').trim() !== '发起决斗') return
                if (api.isOwner(msg.userId)) {
                    state = {
                        phase: 'waiting', isSender: true, chatId: msg.chatId,
                        senderQQ: msg.userId, senderName: msg.nickname,
                        receiverQQ: '', receiverName: '',
                    }
                    log(`${msg.nickname} 发起决斗，等待有人接受`)
                } else {
                    state = {
                        phase: 'waiting', isSender: false, chatId: msg.chatId,
                        senderQQ: msg.userId, senderName: msg.nickname,
                        receiverQQ: String(api.config().ownerQQ || ''), receiverName: '',
                    }
                    log(`${msg.nickname} 发起决斗，等主人回应`)
                }
                armWaitTimer()
                return
            }

            if (state.phase === 'waiting') {
                const w = state
                const t = String(msg.text || '').trim()
                if (msg.chatId !== w.chatId) return

                if (w.isSender) {
                    if (msg.userId === w.senderQQ) return   // 发起人自己的话不作数
                    if (t === '接受') {
                        if (!canAccept(msg.userId)) {
                            log(`「${msg.nickname}」想应战，但不在应战名单里，忽略`)
                            return
                        }
                        await enterAsSender(w.chatId, w.senderQQ, w.senderName, msg.userId, msg.nickname)
                    } else if (t === '拒绝') {
                        if (!canAccept(msg.userId)) return
                        await sendSys(w.chatId, '对方拒绝，对决取消').catch(() => { })
                        reset('对方拒绝')
                    }
                    return
                }

                // 应战方：只有自己的主人能决定
                if (!api.isOwner(msg.userId)) return
                if (t === '接受') {
                    await enterAsReceiver(w.chatId, w.senderQQ, w.senderName, msg.userId, msg.nickname)
                } else if (t === '拒绝') {
                    reset('主人拒绝')
                }
                return
            }

            if (state.phase === 'duel') await handleDuelMsg(msg)
        }

        // ---------------- 注册 ----------------
        api.on('message', (msg) => {
            if (msg.kind !== 'group') return false
            const claim = shouldClaim(msg)
            if (claim) enqueue(() => handleMessage(msg))
            return claim
        })

        // 兜底通道：原始事件先于中枢过滤到达，别的机器人 / 被中枢忽略的消息也能接住
        api.on('onebot', (evt) => {
            if (evt.post_type !== 'message' || evt.message_type !== 'group') return
            if (evt.self_id && String(evt.user_id) === String(evt.self_id)) return
            const msg = fromEvent(evt)
            if (!shouldClaim(msg)) return
            enqueue(() => handleMessage(msg))
        })

        api.command({
            name: 'duel',
            aliases: ['对决'],
            desc: '查看对决状态',
            run: () => {
                const st = state.phase === 'idle'
                    ? '空闲。在群里说「发起决斗」开始。'
                    : state.phase === 'waiting'
                        ? (state.isSender ? '等待有人接受…' : '有人向你下战书，说「接受」或「拒绝」。')
                        : state.phase === 'duel'
                            ? `对决中：第${state.round}回合${state.half === 'upper' ? '上' : '下'}半场`
                            : '未知状态'
                const rows = fishInfo()
                const lines = [st]
                lines.push(rows.length
                    ? `我的鱼：${rows.map(([k, v]) => `${k}(${v})`).join(' ')}`
                    : '我的鱼：还没填属性/技能/特性（设置页「鱼的信息」，留空就是无）')
                lines.push('本对决仅为娱乐友谊赛，不用于真实对抗。')
                return lines.join('\n')
            },
        })

        api.onDispose(() => reset())
    },
}
