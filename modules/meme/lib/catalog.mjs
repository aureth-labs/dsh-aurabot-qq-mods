import { UserError } from './errors.mjs';
// One entry gate for generation, queries and administration.
export function readRequest(input, direct = false, explicit = false) {
  const source = String(input || '').trim();
  const sharp = /^[#＃]/u.test(source);
  if (!sharp && !direct && !explicit) return null;
  return { sharp, text: (sharp ? source.slice(1) : source).trim() };
}
export const words = value => String(value || '').split(/[\s,，]+/u).filter(Boolean);
export function buildIndex(items, aliases = {}) {
  const index = new Map();
  for (const item of items) {
    for (const word of [item.key, ...item.keywords]) if (!index.has(word.toLowerCase())) index.set(word.toLowerCase(), { item });
    for (const shortcut of item.shortcuts || []) for (const word of (/^[^()[\]{}?*+|\\^$]+$/u.test(shortcut.pattern) ? [shortcut.pattern] : [])) {
      if (!index.has(word.toLowerCase())) index.set(word.toLowerCase(), { item, shortcut });
    }
  }
  for (const [word, key] of Object.entries(aliases)) {
    const item = items.find(x => x.key === key);
    if (item) index.set(word.toLowerCase(), { item });
  }
  index.shortcuts = items.flatMap(item => (item.shortcuts || []).map(shortcut => ({ item, shortcut, pattern: new RegExp('^' + shortcut.pattern.replace(/\(\?P</g, '(?<') + '(?=\\s|$)', 'iu') })));
  index.sorted = [...index.keys()].sort((a, b) => b.length - a.length);
  return index;
}
export function matchTemplate(text, index, direct = false) {
  // Require a boundary for raw triggers to avoid swallowing ordinary conversation.
  for (const keyword of index.sorted) {
    if (!text.toLowerCase().startsWith(keyword)) continue;
    const rest = text.slice(keyword.length);
    if (rest && !/^\s/.test(rest)) continue;
    return { ...index.get(keyword), rest: rest.trim(), keyword, direct };
  }
  for (const entry of index.shortcuts || []) {
    const match = text.slice(0, 2000).match(entry.pattern);
    if (!match) continue;
    const substitute = s => String(s).replace(/\{(\w+)\}/g, (_, name) => match.groups?.[name] || '');
    return { item: entry.item, rest: text.slice(match[0].length).trim(), shortcut: { ...entry.shortcut,
      texts: entry.shortcut.texts.map(substitute),
      options: Object.fromEntries(Object.entries(entry.shortcut.options).map(([key, value]) => [key, { ...value, field0: typeof value.field0 === 'string' ? substitute(value.field0) : value.field0 }])) }, direct };
  }
  return null;
}
export function parseInput(text, item, shortcut, fallbackText = '你好') {
  const options = { ...(shortcut?.options || {}) };
  const defs = item.params.options || [];
  const nameMap = new Map();
  for (const d of defs) for (const n of [d.field0.name, ...(d.field0.parserFlags?.shortAliases || []), ...(d.field0.parserFlags?.longAliases || [])]) nameMap.set(n, d);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/gu) || [];
  const rest = [];
  for (let i = 0; i < tokens.length; i++) {
    const match = tokens[i].match(/^(?:--|#)([^=]+)(?:=(.*))?$/u);
    if (!match) { rest.push(tokens[i]); continue; }
    const d = nameMap.get(match[1]);
    if (!d) throw new UserError(`不支持参数 ${match[1]}；发送“#表情详情 ${item.keywords[0]}”查看参数`);
    let raw = match[2];
    if (raw === undefined && d.type === 'Boolean' && !/^(true|false|0|1)$/i.test(tokens[i + 1] || '')) raw = 'true';
    else if (raw === undefined) raw = tokens[++i];
    if (raw === undefined) throw new UserError(`参数 ${match[1]} 缺少值`);
    raw = raw.replace(/^(["'])(.*)\1$/s, '$2');
    let value = raw;
    if (d.type === 'Boolean') { if (!/^(true|false|1|0)$/i.test(raw)) throw new UserError('开关参数须为 true 或 false'); value = /^(true|1)$/i.test(raw); }
    if (['Integer', 'Float'].includes(d.type)) {
      value = Number(raw);
      if (!Number.isFinite(value) || (d.type === 'Integer' && !Number.isInteger(value)) || (d.field0.minimum !== undefined && value < d.field0.minimum) || (d.field0.maximum !== undefined && value > d.field0.maximum)) throw new UserError(`参数 ${match[1]} 超出允许范围`);
    }
    options[d.field0.name] = { type: d.type, field0: value };
  }
  const content = rest.join(' ').trim();
  const texts = content ? content.split(/\s*\/\s*/u).map(s => s.replace(/^(["'])(.*)\1$/s, '$2')) : [...(shortcut?.texts?.length ? shortcut.texts : item.params.defaultTexts || [])];
  const p = item.params;
  while (texts.length < p.minTexts) texts.push(p.defaultTexts?.[texts.length % (p.defaultTexts.length || 1)] || fallbackText || '你好');
  if (texts.length < p.minTexts || texts.length > p.maxTexts) throw new UserError(`“${item.keywords[0]}”需要 ${p.minTexts}–${p.maxTexts} 段文字，用 / 分隔；发送“#表情详情 ${item.keywords[0]}”查看用法`);
  if (texts.some(t => t.length > 1000)) throw new UserError('每段文字最多 1000 字');
  return { texts, options };
}
export function describe(item, aliases = []) {
  const p = item.params;
  const range = (min, max) => min === max ? String(min) : `${min}–${max}`;
  const shortcuts = (item.shortcuts || []).map(s => s.humanized || (/^[^()[\]{}?*+|\\^$]+$/u.test(s.pattern) ? s.pattern : '')).filter(Boolean);
  const lines = [item.keywords[0], `触发词：${[...item.keywords, ...aliases].join(' / ')}`];
  if (shortcuts.length) lines.push('快捷用法：' + shortcuts.join(' / '));
  if (p.maxImages) lines.push(`图片：${range(p.minImages, p.maxImages)} 张，可 @某人、附图或引用图片`);
  if (p.maxTexts) lines.push(`文字：${range(p.minTexts, p.maxTexts)} 段${p.maxTexts > 1 ? '，用 / 分隔' : ''}`);
  if (p.defaultTexts.length) lines.push('默认文字：' + p.defaultTexts.join(' / '));
  if (p.options.length) lines.push('可选参数：', ...p.options.map(o => {
    const v = o.field0;
    const type = { Boolean: 'true 或 false', String: '文字', Integer: '整数', Float: '数字' }[o.type];
    const bounds = v.minimum !== undefined || v.maximum !== undefined ? `；范围 ${v.minimum ?? '不限'}–${v.maximum ?? '不限'}` : '';
    return `--${v.name}：${v.description || type}（${type}${bounds}${v.default !== undefined ? `；默认 ${v.default}` : ''}）`;
  }));
  lines.push(`示例：#${item.keywords[0]}${p.minImages ? ' @某人' : ''}${p.minTexts ? ' ' + (p.defaultTexts.join(' / ') || '文字') : ''}`);
  return lines.join('\n');
}
