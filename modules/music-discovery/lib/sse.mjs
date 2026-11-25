// SSE（text/event-stream）解析与 AI 解读收集。
//
// 依据：
//  1. SSE 规范（跨 chunk / CRLF / 多行 data / 注释 / 空行边界 / event 名）；
//  2. Codex 两次受控真实采样的结构（receipts/codex-sse-schema*.json）：
//     data 是 JSON，字段固定为 chunk_idx:number、chunk_type:"output"、
//     chunk_content:string（纯文本）、references:null；结束是 event:done + data:[DONE]。
//
// 所以只解析「chunk_type === "output" 且 chunk_content 是字符串」这一种已核结构。
// 其他 chunk_type（包括未知的 references 之类）只记类型名、不猜内容；
// 不以任何「猜出来的字段名」当解读文本。
//
// 结果必须区分：完整（收到结束标记且没被截断/没报错）、部分（有文本但流没正常结束）、
// 截断（到达字数上限）、错误（流里出现 error 事件，优先于已有文本）、空流。

/** 增量 SSE 解码器：喂 chunk，吐完整事件。 */
export function createSseDecoder() {
  let buffer = ''
  let dataLines = []
  let eventName = ''

  function emit(out) {
    if (!dataLines.length) {
      eventName = ''
      return
    }
    out.push({ event: eventName, data: dataLines.join('\n') })
    dataLines = []
    eventName = ''
  }

  function takeLine(line, out) {
    if (line === '') {
      emit(out)
      return
    }
    if (line.startsWith(':')) return // 注释/心跳
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    let value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') eventName = value
    // id / retry 对解读无用，忽略
  }

  return {
    /** @param {string} chunk @returns {Array<{event:string,data:string}>} */
    push(chunk) {
      const out = []
      buffer += String(chunk ?? '').replace(/^\uFEFF/, '')
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        takeLine(line, out)
      }
      return out
    },
    /** 流结束时把最后一行/最后一个事件补出来。 */
    end() {
      const out = []
      if (buffer) {
        takeLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer, out)
        buffer = ''
      }
      emit(out)
      return out
    },
  }
}

const MAX_UNKNOWN_TYPES_TRACKED = 8

/**
 * 收集 AI 解读文本。
 * @param {{maxChars?: number}} [options]
 */
export function createInterpretationCollector({ maxChars = 4000 } = {}) {
  const state = {
    text: '',
    events: 0,
    textEvents: 0,
    outputEvents: 0,
    unknownJsonEvents: 0,
    /** 只记结构类型名（字母数字），不记任何内容 */
    unknownChunkTypes: [],
    errorEvents: 0,
    done: false,
    truncated: false,
  }

  function pushText(raw) {
    if (state.text.length >= maxChars) {
      state.truncated = true
      return
    }
    const remain = maxChars - state.text.length
    if (raw.length > remain) {
      state.text += raw.slice(0, remain)
      state.truncated = true
    } else {
      state.text += raw
    }
  }

  function noteUnknownType(name) {
    // 类型名是结构信息；只接受短的安全字符，避免把内容字段当类型名记下来
    const safe = typeof name === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(name) ? name : ''
    if (safe && !state.unknownChunkTypes.includes(safe) && state.unknownChunkTypes.length < MAX_UNKNOWN_TYPES_TRACKED) {
      state.unknownChunkTypes.push(safe)
    }
  }

  return {
    take({ event = '', data = '' } = {}) {
      state.events += 1
      const raw = String(data ?? '')
      const trimmed = raw.trim()
      const eventName = String(event ?? '').toLowerCase()

      // error 事件优先记账：后面就算还有文本/[DONE] 也不能抹掉这个错误
      if (/error/i.test(eventName)) {
        state.errorEvents += 1
        return
      }
      if (!trimmed) {
        if (eventName === 'done') state.done = true
        return
      }
      if (trimmed === '[DONE]') {
        state.done = true
        return
      }
      if (eventName === 'done') {
        state.done = true
        return
      }

      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let json = null
        try {
          json = JSON.parse(trimmed)
        } catch {
          state.unknownJsonEvents += 1
          return
        }
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          state.unknownJsonEvents += 1
          return
        }
        const type = typeof json.chunk_type === 'string' ? json.chunk_type : ''
        if (type === 'output') {
          // 已核结构：chunk_content 必须是字符串；chunk_idx 若出现必须是数字
          if (typeof json.chunk_content !== 'string') {
            state.unknownJsonEvents += 1
            return
          }
          if (json.chunk_idx !== undefined && typeof json.chunk_idx !== 'number') {
            state.unknownJsonEvents += 1
            return
          }
          state.outputEvents += 1
          state.textEvents += 1
          pushText(json.chunk_content)
          return
        }
        // 已核样例之外的类型：不当内容，只记类型名
        state.unknownJsonEvents += 1
        noteUnknownType(type)
        return
      }

      // 纯文本 data（早期实现按文本流处理，继续兼容）
      state.textEvents += 1
      pushText(raw)
    },

    get truncated() {
      return state.truncated
    },

    result() {
      const hasText = state.text.trim().length > 0
      const base = { ...state, partial: hasText ? state.text : '' }
      // 1) 报错优先于已有文本：文本后出现 error 也算失败
      if (state.errorEvents > 0) return { ...base, ok: false, code: 'sse-error' }
      // 2) 到达字数上限：不是完整解读
      if (state.truncated) return { ...base, ok: false, code: 'sse-truncated' }
      // 3) 有文本但没收到结束标记：只能算部分
      if (hasText && !state.done) return { ...base, ok: false, code: 'sse-partial' }
      // 4) 收到结束标记且有文本：完整
      if (hasText) return { ...base, ok: true, code: '' }
      // 5) 没有可用文本
      if (state.unknownJsonEvents > 0) return { ...base, ok: false, code: 'sse-unknown-frames' }
      return { ...base, ok: false, code: 'sse-empty' }
    },
  }
}
