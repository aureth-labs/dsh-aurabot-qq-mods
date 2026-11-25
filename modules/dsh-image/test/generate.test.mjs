// 端到端：用一个假宿主模拟 DSH 的 llm / attachments 服务，验证整条生图链路。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateViaDsh } from '../lib/generate.mjs'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])

// 测试域名是虚构的；注入解析结果，让 SSRF 校验走真实代码路径而不是卡在 DNS。
const dns = async () => [{ address: '93.184.216.34' }]

/** 假宿主：llm 按给定的分片流式回答，attachments 能读回图片块。 */
function fakeDsh (chunks, { imageBytes = PNG } = {}) {
  const calls = []
  return {
    calls,
    llm: {
      async *stream (options) {
        calls.push(options)
        for (const c of chunks) yield c
      },
    },
    attachments: {
      async readImage (ref) {
        return { data: imageBytes, ref }
      },
    },
  }
}

test('文本里的 Markdown 图片链接：解析并下载', async () => {
  const dsh = fakeDsh([{ type: 'text-delta', text: '画好了 ![图](https://img.example/a.png)' }])
  const original = globalThis.fetch
  let fetched = null
  globalThis.fetch = async (url) => {
    fetched = url
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  try {
    const buf = await generateViaDsh({ dsh, target: { provider: 'doubao', model: 'image-gen' }, prompt: '一条船', dnsImpl: dns })
    assert.ok(Buffer.isBuffer(buf))
    assert.equal(buf.length, PNG.length)
    // 请求确实发给了选中的模型，且消息是内容块数组
    assert.equal(dsh.calls[0].provider, 'doubao')
    assert.equal(dsh.calls[0].model, 'image-gen')
    assert.deepEqual(dsh.calls[0].messages[0].content, [{ type: 'text', text: '一条船' }])
    assert.equal(fetched, 'https://img.example/a.png')
  } finally {
    globalThis.fetch = original
  }
})

test('图片块：直接走附件服务读回，不再下载', async () => {
  const dsh = fakeDsh([
    { type: 'block-start', index: 0, blockType: 'image' },
    { type: 'block-end', index: 0, block: { type: 'image', attachment: { attachmentId: 'sha256:x' } } },
    { type: 'text-delta', text: '画好了' },
  ])
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('不该下载') }
  try {
    const buf = await generateViaDsh({ dsh, target: { provider: 'doubao', model: 'image-gen' }, prompt: 'x' })
    assert.equal(buf.length, PNG.length)
  } finally {
    globalThis.fetch = original
  }
})

test('模型只回文字没有图：错误信息带上回复开头，方便排查', async () => {
  const dsh = fakeDsh([{ type: 'text-delta', text: '抱歉，这个模型不支持生图。' }])
  await assert.rejects(
    () => generateViaDsh({ dsh, target: { provider: 'doubao', model: 'chat' }, prompt: 'x' }),
    /没有返回图片.*抱歉/s,
  )
})

test('模型什么都没回：提示内容为空', async () => {
  const dsh = fakeDsh([])
  await assert.rejects(
    () => generateViaDsh({ dsh, target: { provider: 'doubao', model: 'image-gen' }, prompt: 'x' }),
    /没有返回任何内容/,
  )
})

test('流里报错：如实抛出', async () => {
  const dsh = fakeDsh([{ type: 'finish', reason: { kind: 'error', failure: { message: '额度用完了' } } }])
  await assert.rejects(
    () => generateViaDsh({ dsh, target: { provider: 'doubao', model: 'image-gen' }, prompt: 'x' }),
    /额度用完了/,
  )
})

test('内网链接拒绝下载，且不发起请求', async () => {
  const dsh = fakeDsh([{ type: 'text-delta', text: '![x](http://127.0.0.1:8080/secret.png)' }])
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; return new Response(PNG) }
  try {
    await assert.rejects(
      () => generateViaDsh({ dsh, target: { provider: 'doubao', model: 'image-gen' }, prompt: 'x' }),
      /非公网地址/,
    )
    assert.equal(called, false)
  } finally {
    globalThis.fetch = original
  }
})

test('没有 llm 服务时给出明确提示', async () => {
  await assert.rejects(
    () => generateViaDsh({ dsh: {}, target: { provider: 'p', model: 'm' }, prompt: 'x' }),
    /宿主没有 llm 服务/,
  )
})

test('没选模型时给出明确提示', async () => {
  await assert.rejects(
    () => generateViaDsh({ dsh: fakeDsh([]), target: {}, prompt: 'x' }),
    /还没有选择生图模型/,
  )
})
