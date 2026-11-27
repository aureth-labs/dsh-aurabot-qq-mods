// 判断一句话是不是「家人托付的活」。
// 纯本地规则，不调模型（模型走系统会话会冷却、会漏，不可靠）。
// 用真实家人消息调过：80 条闲聊里误报控制在个位数。

// 明确的托付/询问动词——命中即活
const TASK_VERB =
  /(帮我|帮忙|替我|帮爸爸|帮妈妈|帮爷爷|查一下|查查|核对|检查一下|统计|导出|对比一下|比对|找一下|找找|找一找|列一下|列出|汇总|整理一下|整理成|转成|转换成|算一下|算算|合计|多少台|几台|哪家公司|哪个公司|最贵|最便宜|中位数|平均每台|按.*分组)/

// 让「我」做判断/识别的祈使句
const ASK_ME = /(你看|你看看|帮我看|是什么材质|是什么|值多少钱|能不能用|好不好|怎么办|多少|对吧|是吧)/

// 明确的闲聊/陈述/情绪——命中即闲（优先级最高）
const IDLE =
  /^(嗯|哦|啊|好的|行|可以|哈哈|是吗|对|是的|收到|谢谢|挺好|不错|好|ok|OK|😂|[笑哭][泪奔]|发工资了|我吃饭啊|没啥事|知道了|嗯嗯|嗯 没有了|我都存上了|吃上饭了|我还没吃饱|齁死我了|服了|没来|没有|还没开始|谁知道|放笔|我饿着肚子|闲的|我先忙|行吧)[。！!~\s]*$/

// 文件消息算活
function isFile(text) {
  return /^\[文件 /.test(String(text || '').trim())
}

/** 'task' | 'idle' */
export function classify(text) {
  const s = String(text || '').trim()
  if (!s) return 'idle'
  if (isFile(s)) return 'task'
  if (IDLE.test(s)) return 'idle'
  if (TASK_VERB.test(s)) return 'task'
  // 「加上…」这种陈述式托付：只有在提到具体东西时才算活
  if (/^(加上|再加|把.*加上|按.*来|就.*对吧)/.test(s) && /\d|工资|存|钱|表|块|元/.test(s)) {
    return 'task'
  }
  // 「你看这个是什么」——识别类请求
  if (ASK_ME.test(s) && /[?？]|材质|这个|什么|多少/.test(s)) return 'task'
  return 'idle'
}

export function isTask(text) {
  return classify(text) === 'task'
}
