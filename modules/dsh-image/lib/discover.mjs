// 发现 DSH 里「已接入的生图模型」。
//
// DSH 的 llm 服务会列出每个已配置的对话提供方及其模型目录。豆包把
// 「豆包 生图（Seedream 5.0）」作为一个普通对话模型暴露出来，选中它时
// 插件会把这一轮当成生图技能请求（input_skill: imageGen），上游返回图片。
// 所以这里只认「明确是生图」的模型，普通聊天模型和「图片理解」类都不算。

/** 生图模型的 id / 名称特征。命中一个就算生图。 */
const IMAGE_MODEL = /生图|绘图|图像生成|图片生成|image[ -]?(?:gen|generation)|seedream|dall-?e|gpt-image|flux|imagen|cogview|qwen-image|wanx|grok-imagine/i

/** 只认明确的生图别名；多模态聊天模型不算生图模型。 */
export function isImageModel (model) {
  const id = String(model?.id ?? model?.model ?? '')
  const name = String(model?.name ?? '')
  return IMAGE_MODEL.test(id) || IMAGE_MODEL.test(name)
}

/** 提供方信息在不同版本里有 id / provider / name 几种写法。 */
export function providerIdOf (entry) {
  if (typeof entry === 'string') return entry
  return String(entry?.id ?? entry?.provider ?? entry?.name ?? '')
}

/**
 * 把 llm 服务的目录整理成可选的生图模型清单。
 * @param {Array} providers listProviders() 的结果
 * @param {(id: string) => Promise<Array>} listModels 取某个提供方的模型
 * @returns {Promise<{models: Array<{provider: string, model: string, name: string}>, errors: Array<{provider: string, message: string}>}>}
 */
export async function discoverImageModels (providers, listModels) {
  const models = []
  const errors = []
  // 并行拉取：一个提供方慢或挂了，不该拖住整个面板。
  const settled = await Promise.all((providers || []).map(async (entry) => {
    const provider = providerIdOf(entry)
    if (!provider) return { provider: '', models: [] }
    try {
      return { provider, models: (await listModels(provider)) || [] }
    } catch (error) {
      return { provider, models: [], error: String(error && error.message ? error.message : error) }
    }
  }))
  for (const row of settled) {
    if (row.error) errors.push({ provider: row.provider, message: row.error })
    for (const m of row.models) {
      if (!isImageModel(m)) continue
      const model = String(m.id ?? m.model ?? '')
      if (!model) continue
      models.push({ provider: row.provider, model, name: String(m.name ?? model) })
    }
  }
  // 同一组 (提供方, 模型) 只留一条，顺序沿用目录顺序。
  const seen = new Set()
  const unique = models.filter((m) => {
    const key = `${m.provider}\u0000${m.model}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { models: unique, errors }
}

/** 面板下拉用的标签：提供方 + 模型名，避免同名模型分不清。 */
export function labelOf (entry) {
  return entry ? `${entry.provider} / ${entry.name}` : ''
}

/** 按 key（provider\u0000model）找一条；找不到返回 null。 */
export function pickEntry (models, key) {
  if (!key) return null
  return (models || []).find((m) => `${m.provider}\u0000${m.model}` === key) || null
}
