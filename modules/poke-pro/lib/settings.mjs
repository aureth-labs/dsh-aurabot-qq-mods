/**
 * 设置解析：把面板里的多行文本 / 列表解析成模块内部用的结构。
 *
 * Aurabot 的 settings 表单只会给出字符串、数字、布尔，列表和多行文本都要自己解析。
 * 所有解析函数对脏数据都要**宽容**：宁可丢掉一行坏的，也不让整个模块起不来。
 */

import { parsePokeTargets } from './weighted.mjs'

/** 把一串 OneBot 表情 ID 解析出来（支持逗号、空格、换行分隔）。 */
export function parseIdList(input) {
  const text = Array.isArray(input) ? input.join(',') : String(input ?? '')
  const out = []
  for (const part of text.split(/[,，\s]+/)) {
    const n = Number(part)
    if (Number.isInteger(n) && n >= 0) out.push(n)
  }
  return out
}

/** 把一行一条的文字列表解析出来，丢掉空行。 */
export function parseLineList(input) {
  const text = Array.isArray(input) ? input.join('\n') : String(input ?? '')
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

/**
 * 把 `群号:QQ号` 列表解析出来。
 * 注意：面板的 list 类型可能是数组，也可能是逗号串，这里都接受。
 */
export function parseTargets(input) {
  if (Array.isArray(input)) return parsePokeTargets(input)
  const text = String(input ?? '')
  const parts = text.split(/[\n,，]+/)
  return parsePokeTargets(parts)
}

/**
 * 解析命令池。参考项目里命令是「盒」「捣」这类，不带前导斜杠——
 * Aurabot 的命令需要 `/`，但这里是**替用户发一条消息**，不是调自己的命令，
 * 所以保持原文即可（对方插件收到的是普通消息/它自己的命令）。
 */
export function parseCommandPool(input) {
  return parseLineList(input || ',').flatMap((l) => l.split(/[,，]+/)).map((s) => s.trim()).filter(Boolean)
}

/** 归一化一个 0~1 的概率。 */
export function clampProbability(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/** 归一化一个正整数并夹在区间内。 */
export function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 动作权重的默认值。与参考项目的默认值保持一致，方便迁移。
 * weight 为 0 等于关闭该动作。
 */
export const DEFAULT_WEIGHTS = {
  antipoke: 10,
  llm: 10,
  face: 10,
  meme: 30,
  record: 0,
  ban: 10,
  command: 10,
}

/** 动作的中文名，用于日志和命令输出。 */
export const ACTION_LABELS = {
  antipoke: '反戳',
  llm: 'LLM 回复',
  face: 'QQ 表情',
  meme: '表情包',
  record: '语音',
  ban: '禁言',
  command: '触发命令',
}

/**
 * 组装所有动作的权重表，供 pickWeighted 使用。
 * @param {Record<string, number>} weights
 */
export function buildActionList(weights) {
  return Object.entries(weights).map(([id, weight]) => ({
    id,
    weight: typeof weight === 'number' && weight > 0 ? weight : 0,
  }))
}
