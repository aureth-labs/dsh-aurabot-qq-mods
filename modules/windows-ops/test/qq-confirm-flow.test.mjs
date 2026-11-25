// qq-confirm-flow.test.mjs —— 发起前截图确认的整段接线（fake api + fake ps）
// 覆盖：start 只发截图不发按钮 → 主人回复「取消」不执行 → 回复「确认」才执行 → 结束后 pending 清空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'
import { b64arg } from '../lib/ps.mjs'

const DATA = mkdtempSync(join(tmpdir(), 'wops-qq-confirm-'))
const BOT = '3046003374'
const OWNER = '916617067'

function fakeApi() {
  const sent = { texts: [], images: [] }
  const handlers = {}
  let calls = 0
  const api = {
    dataDir: () => DATA,
    config: () => ({ botQQ: BOT, ownerQQ: OWNER }),
    settings: () => ({
      enabled: true,
      allowInput: true,
      confirmDanger: true,
      rateLimit: 0,
      qqBotQQ: BOT,
      qqOwnerQQ: OWNER,
      qqBotName: '机器人',
      qqOwnerName: '主人',
      qqConfirmBeforeStart: true,
    }),
    rule: () => {},
    defineTool: (def) => def,
    tool: () => {},
    command: () => {},
    route: () => {},
    onDispose: () => {},
    on: (event, fn) => { handlers[event] = fn },
    isOwner: (id) => String(id) === OWNER,
    sendText: async (chat, text) => { sent.texts.push({ chat, text }) },
    sendImage: async (chat, image) => { sent.images.push({ chat, image }) },
    core: { hub: { turnSendersAllOwner: () => true }, http: {} },
    __windowsOpsTestHooks: {
      ps: {
        isWin: () => true,
        b64arg,
        run: async (script) => {
          calls += 1
          if (calls === 1) {
            return JSON.stringify({ x: 0, y: 0, w: 3840, h: 2160, sw: 1600, sh: 900 })
          }
          return Buffer.from(JSON.stringify({ ok: true, message: 'fake QQ native action ok' }), 'utf8').toString('base64')
        },
      },
    },
  }
    return { api, sent, handlers, calls: () => calls }
}

test('发起前截图确认：start 先发图给主人，确认后才执行 QQ 动作', async () => {
  const { api, sent, handlers } = fakeApi()
  const out = mod.setup(api)
  // 空 target = 主人；窗口/QQ 参数都由 settings 提供，不碰真 QQ。
  const r = await out.qq.share({})
  assert.equal(r.ok, true)
  assert.equal(r.pending, true)
  assert.match(r.message, /发起前截图/)
  assert.equal(sent.images.length, 1)
  assert.equal(sent.images[0].chat, `private:${OWNER}`)
  assert.equal(sent.texts.length, 1)
  assert.match(sent.texts[0].text, /发起前确认/)
  assert.match(sent.texts[0].text, /回复「确认」/)
  // 还没确认：QQ 动作没跑（fake ps 只被截图调用过一次）
  assert.equal(out.qq.status().pending?.op, 'qq.share')

  const handled = await handlers.message({ kind: 'private', userId: OWNER, text: '确认' })
  assert.equal(handled, true)
  assert.equal(out.qq.status().pending, null)
  assert.equal(sent.texts.at(-1).text, '已发起：fake QQ native action ok')
  assert.equal(out.status().share.active, true)
})

test('发起前截图确认：远程协助确认后执行，且不经过通用危险确认队列', async () => {
  const { api, sent, handlers } = fakeApi()
  const out = mod.setup(api)
  await out.qq.assist({})
  assert.equal(out.qq.status().pending?.op, 'qq.assist')
  assert.equal(out.status().confirms.length, 0)
  const handled = await handlers.message({ kind: 'private', userId: OWNER, text: '确认' })
  assert.equal(handled, true)
  assert.equal(out.status().assist.active, true)
  assert.match(sent.texts.at(-1).text, /已发起/)
  assert.equal(out.status().confirms.length, 0)
})

test('发起前截图确认：主人回复取消，QQ 动作不执行，pending 清空', async () => {
  const { api, sent, handlers } = fakeApi()
  const out = mod.setup(api)
  await out.qq.assist({})
  assert.equal(out.status().confirms.length, 0) // 截图确认替代通用危险确认，不再弹第二次
  const handled = await handlers.message({ kind: 'private', userId: OWNER, text: '取消' })
  assert.equal(handled, true)
  assert.equal(out.qq.status().pending, null)
  assert.match(sent.texts.at(-1).text, /已取消/)
  assert.equal(out.status().assist.active, false)
})


