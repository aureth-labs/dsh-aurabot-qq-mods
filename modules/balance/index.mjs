// 查余额：/balance（/余额 /查余额 /钱包）查 DeepSeek 官方和自定义中转站的账户余额，
// 结果也会写进 /help 的「扩展模块加的」里。
// 每个来源单独查，某一个挂了不影响别的；没填 key 的会直接说没填。

import fs from 'node:fs'

const TIMEOUT = 10_000

const money = (n, cur) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  const sym = String(cur || 'CNY').toUpperCase() === 'USD' ? '$' : '¥'
  return sym + v.toFixed(2)
}

/** 从各家返回的 JSON 里认出余额。认不出返回 null。 */
function readBalance(json) {
  if (!json || typeof json !== 'object') return null
  // DeepSeek 官方：{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
  if (Array.isArray(json.balance_infos) && json.balance_infos.length) {
    const b = json.balance_infos[0]
    const parts = []
    if (b.topped_up_balance != null) parts.push('充值 ' + money(b.topped_up_balance, b.currency))
    if (b.granted_balance != null) parts.push('赠金 ' + money(b.granted_balance, b.currency))
    return money(b.total_balance, b.currency) + (parts.length ? '（' + parts.join(' + ') + '）' : '')
  }
  // one-api / new-api：{ data: { quota, used_quota } }，quota 单位是 1/500000 美元
  const d = json.data && typeof json.data === 'object' ? json.data : json
  if (typeof d.quota === 'number') {
    const usd = d.quota / 500000
    const used = typeof d.used_quota === 'number' ? '，已用 ' + money(d.used_quota / 500000, 'USD') : ''
    return money(usd, 'USD') + used
  }
  // OpenAI 风格账单：{ hard_limit_usd, system_hard_limit_usd }
  for (const k of ['hard_limit_usd', 'system_hard_limit_usd']) if (typeof json[k] === 'number') return money(json[k], 'USD') + '（额度上限）'
  // 通用：balance / total_balance / remain
  for (const k of ['balance', 'total_balance', 'remain', 'remaining']) {
    if (typeof d[k] === 'number') return money(d[k], json.currency || d.currency)
  }
  return null
}

async function getJson(url, key) {
  const r = await fetch(url, {
    headers: {
      authorization: 'Bearer ' + key,
      accept: 'application/json',
      // new-api / one-api 的管理接口要这一句才认
      'new-api-user': '1',
    },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, ok: r.ok, json, text }
}

/** 中转站：挨个试常见路径，第一个能读出余额的就用它。 */
async function relayBalance(base, key) {
  const root = String(base || '').trim().replace(/\/+$/, '')
  if (!root) return '没填地址（面板「余额」里填中转站地址）'
  if (!key) return '没填 key'
  const paths = ['/user/balance', '/api/user/self', '/v1/dashboard/billing/subscription']
  let last = ''
  for (const p of paths) {
    try {
      const r = await getJson(root.replace(/\/v1$/, '') + p, key)
      if (r.ok) {
        const v = readBalance(r.json)
        if (v) return v
        last = '认不出返回的格式'
      } else {
        last = 'HTTP ' + r.status + (/401|403/.test(String(r.status)) ? '（key 不对？）' : '')
      }
    } catch (error) {
      last = error && error.name === 'TimeoutError' ? '超时了' : '连不上'
    }
  }
  return '查不到：' + (last || '不知道为啥')
}

async function deepseekBalance(key) {
  if (!key) return '本机没找到 sk- 开头的 key（面板「余额」里填一个就行）'
  try {
    const r = await getJson('https://api.deepseek.com/user/balance', key)
    if (!r.ok) return '查不到：HTTP ' + r.status + (/401|403/.test(String(r.status)) ? '（key 不对？）' : '')
    const v = readBalance(r.json)
    const ok = r.json && r.json.is_available === false ? '（账户不可用了，没钱了吧）' : ''
    return (v || '认不出返回的格式') + ok
  } catch (error) {
    return error && error.name === 'TimeoutError' ? '超时了' : '连不上'
  }
}

/** 面板没填 key 时，自己去环境变量和 DSH 凭据文件里找 sk- 开头的 key。 */
function autoDeepseekKey() {
  const ok = (v) => /^sk-[A-Za-z0-9_-]{16,}$/.test(String(v || '').trim())
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY', 'DS_API_KEY']) {
    const v = String(process.env[name] || '').trim()
    if (ok(v)) return v
  }
  const home = process.env.USERPROFILE || process.env.HOME || ''
  // 自己的配置里存过的 key（面板填的也在这里）
  try {
    const cfgFile = home + '/.dsh/plugins-data/aurabot/config.json'
    if (fs.existsSync(cfgFile)) {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      const v = cfg && cfg.ext && cfg.ext.balance && cfg.ext.balance.deepseekKey
      if (ok(v)) return String(v).trim()
    }
  } catch {}
  // DSH 凭据文件里的 API_KEY 条目
  try {
    const file = home + '/.dsh/.credentials.yaml'
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const m of text.matchAll(/^\s*([A-Za-z0-9_]*(?:API_KEY|APIKEY|_KEY))\s*:\s*(\S+)\s*$/gm)) {
        if (!/DEEPSEEK|^DS_/i.test(m[1])) continue
        if (ok(m[2])) return m[2]
      }
    }
  } catch {}
  return ''
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'balance',
  name: '查余额',
  version: '1.0.0',
  api: 1,
  description: '主人发 /余额 查 DeepSeek 官方和中转站的账户余额',
  defaults: { deepseekKey: '', relayUrl: '', relayKey: '' },
  settings: [
    { key: 'deepseekKey', label: 'DeepSeek 官方 API Key', type: 'password', hint: 'platform.deepseek.com 里 sk- 开头的 key' },
    { key: 'relayUrl', label: '中转站地址', type: 'text', placeholder: 'https://example.com' },
    { key: 'relayKey', label: '中转站 API Key', type: 'password' },
  ],

  setup(api) {
    const query = async () => {
      const st = api.settings() || {}
      const relayOn = String(st.relayUrl || '').trim()
      const lines = ['余额：', 'DeepSeek 官方：' + (await deepseekBalance(String(st.deepseekKey || '').trim() || autoDeepseekKey()))]
      if (relayOn) lines.push('中转站：' + (await relayBalance(relayOn, String(st.relayKey || '').trim())))
      return lines.join('\n')
    }

    api.command({
      name: 'balance',
      aliases: ['余额', '查余额', '钱包'],
      desc: '查账户余额（DeepSeek 官方 + 中转站）',
      run: query,
    })

    // 她自己也能查：别人问「你还有多少钱」时用
    api.tool((where) => {
      const owner = where && where.level === 'full'
      if (!owner) return []
      return api.defineTool({
        name: 'balance_now',
        description: '查一下 DeepSeek 官方账户和中转站的余额',
        properties: {},
        execute: async () => ({ ok: true, message: await query() }),
      })
    })
    api.rule(() => '你想知道自己还有多少钱的时候，用 balance_now 查余额')

    api.log.info('[balance] 已加载：/余额 可用')
  },
}
