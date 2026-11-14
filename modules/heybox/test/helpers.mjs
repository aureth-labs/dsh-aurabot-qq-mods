import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeyboxClient } from '../lib/api.mjs'
import { createHeybox } from '../lib/site.mjs'

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })
export const ok = (result = {}) => json({ status: 'ok', result })
export const defer = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

export function fixture({ config = {}, fetcher = async () => { throw new Error('禁止联网') }, hub, verifier, initialState, now = new Date(2026, 5, 8, 10).getTime(), tokenBrowser = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-test-'))
  let time = now
  const cfg = {
    enabled: true, dryRun: false, ownerQQ: '12345678', speakUp: { awakeFrom: 0, awakeTo: 24 },
    heybox: { enabled: true, autoBrowse: true, cookie: 'pkey=old; heybox_id=1', maxRunsPerDay: 6, intervalHours: 4, ...config.heybox },
    ...Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'heybox')),
  }
  const calls = []
  const turns = []
  const sends = []
  const chat = {
    runSystemTurn: async (...args) => { turns.push(args); return JSON.stringify({ note: '发现一个有趣的帖子', share: '', linkId: '' }) },
    sendText: async (...args) => { sends.push(args); return { message_id: 1 } },
    ...hub,
  }
  const stateFile = join(dir, 'state.json')
  if (initialState) writeFileSync(stateFile, JSON.stringify(initialState))
  const hb = createHeybox({
    getConfig: () => cfg,
    setCookie: (value) => { cfg.heybox.cookie = value },
    hub: chat, verifier, stateFile, credFile: join(dir, 'missing.json'), now: () => time,
    // 扫码补取 x_xhh_tokenid 那步默认注入一个「什么都不给」的假浏览器，
    // 免得单测真的去起 Edge；要测成功路径时传入 tokenBrowser
    tokenBrowser: tokenBrowser === undefined ? fakeTokenBrowser({ token: null }) : tokenBrowser,
    clientFactory: (options) => new HeyboxClient({ ...options, random: () => 0.5, delay: async (ms) => { time += ms }, fetchImpl: async (...args) => { calls.push(args); return fetcher(...args) } }),
  })
  return { hb, cfg, calls, turns, sends, stateFile, get time() { return time }, set time(v) { time = v }, close() { hb.dispose(); rmSync(dir, { recursive: true, force: true }) } }
}

/** 假的取 token 浏览器：给什么 token 就返回什么，token 为 null 表示前端没种 */
export function fakeTokenBrowser({ token = null, failOpen = false } = {}) {
  const state = { opened: 0, cookies: token ? [{ name: 'x_xhh_tokenid', value: token }] : [] }
  return {
    state,
    open: async () => (failOpen ? { ok: false, message: '起不来' } : { ok: true }),
    setCookies: async (list) => (list || []).length,
    goto: async () => {},
    cookies: async () => state.cookies,
    close: async () => {},
  }
}
