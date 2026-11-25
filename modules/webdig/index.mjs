// 网页挖数据（webdig）：给她「自己上网翻」的那双手。
//   · 工具 qq_web_dig：给一个网址，把站里的数据抓下来落盘，回一句摘要，让她自己 read。
//   · 只抓公开内容：先读 robots.txt，明确禁止的路径跳过；请求之间默认停 800ms。
//   · 不碰登录态、不绕验证码、不伪装成别人。
// 抓取逻辑在 lib/webdig.mjs（纯 Node 自带能力，不需要装包，不走浏览器）。

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

export default {
  id: 'webdig',
  api: 1,
  name: '网页挖数据',
  version: '1.0.0',
  description: '让她自己去一个网站里翻数据和提示词：先看 robots.txt，再把页面自带的数据或公开接口挖出来落盘，回一句结果摘要。只抓公开内容，不走登录态、不绕验证码。',

  setup(api) {
    // api 上只有 defineTool，没有 str/int 这些快捷方法——properties 直接手写 JSON Schema
    const { defineTool } = api
    // 抓取脚本跟着模块走（lib/webdig.mjs），模块装到哪都在自己包里，不依赖外部路径
    const SCRIPT = join(HERE, 'lib', 'webdig.mjs')

    const run = (args, timeoutMs = 120_000) => new Promise((resolve) => {
      execFile(process.execPath, args, { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ ok: !error, error: error && error.message, stdout: String(stdout || ''), stderr: String(stderr || '') })
      })
    })

    /** 从落盘目录里读 summary.json，抽成一句能直接看的话。 */
    function summarize(outDir) {
      const f = join(outDir, 'summary.json')
      if (!existsSync(f)) return null
      let s = null
      try { s = JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
      const lines = []
      if (s.robots?.exists) lines.push(`robots.txt 有规则，已跳过 ${s.robots.disallow?.length || 0} 条禁止路径`)
      lines.push(`首页 ${s.homeBytes} 字节`)
      const jsons = s.jsonFiles || []
      lines.push(`抓到 JSON ${jsons.length} 个、其他 ${(s.textFiles || []).length} 个`)
      const clue = (s.arrays || []).slice(0, 6)
      if (clue.length) {
        lines.push('有内容的字段：')
        for (const a of clue) lines.push(`  ${a.from.split('/').pop()} → ${a.path}（${a.count} 条：${(a.keys || []).slice(0, 8).join(', ')}）`)
      }
      for (const n of (s.notes || []).slice(0, 4)) lines.push('注意：' + n)
      return { text: lines.join('\n'), files: jsons.map((j) => j.file), summary: s }
    }

    api.rule(() => [
      '- 你能用 qq_web_dig 自己去翻一个网站：给网址，它会把页面自带的数据或公开接口挖下来落盘，并告诉你哪段字段有内容。',
      '- 只拿公开的东西：开跑先读 robots.txt，明文禁止的路径会跳过，请求之间会停一下。要登录、要验证码的站抓不到就如实说抓不到，不硬来。',
      '- 抓下来之后用 read 去看那几个落盘的 json，别凭猜。',
    ])

    api.tool(({ chat }) => {
      if (!chat || chat.kind === 'system') return []
      return defineTool({
        name: 'qq_web_dig',
        description: '自己去翻一个网站：给网址，先看 robots.txt，再把页面自带的数据或公开接口挖下来落盘（json 等），回来给你内容线索。只抓公开内容，不走登录态、不绕验证码。',
        properties: {
          url: { type: 'string', description: '要翻的网址，比如 https://example.com' },
          max: { type: 'integer', description: '最多抓几个数据地址，默认 8' },
          delay: { type: 'integer', description: '每次请求间隔毫秒，默认 800（别调太低）' },
        },
        required: ['url'],
        slow: '我去这个站里翻翻数据，稍等一下',
        execute: async ({ url, max, delay }) => {
          const raw = String(url || '').trim()
          if (!/^https?:\/\//i.test(raw)) return { ok: false, message: '要给一个完整的 http(s) 网址' }
          if (!existsSync(SCRIPT)) return { ok: false, message: '找不到抓取脚本：' + SCRIPT }
          const outDir = api.dataDir('out', String(Date.now()))
          const args = [
            SCRIPT, raw, '--out', outDir,
            '--max', String(Math.min(Math.max(Number(max) || 8, 1), 20)),
            '--delay', String(Math.max(Number(delay) || 800, 300)),
          ]
          const r = await run(args)
          const sum = summarize(outDir)
          if (!sum) return { ok: false, message: '跑完了但没拿到结果：' + (r.stderr || r.stdout || r.error || '').slice(-400) }
          // 内容别整段塞回上下文，给摘要 + 落盘路径，让她自己 read
          const head = sum.text.split('\n').slice(0, 14).join('\n')
          return {
            ok: true,
            message: `${raw}\n${head}\n落盘：${outDir}`,
            outDir,
            files: sum.files.slice(0, 10),
            arrays: (sum.summary.arrays || []).slice(0, 10),
            notes: sum.summary.notes || [],
          }
        },
      })
    })
  },
}
