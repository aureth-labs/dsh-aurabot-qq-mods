// Directory layout only: no template previews or generation calls.
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function indexEntries(items, disabled = []) {
  const off = new Set(disabled);
  return [...items].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map((item, i) => ({
    number: i + 1, key: item.key,
    label: item.keywords.find(word => /\p{Script=Han}/u.test(word)) || item.keywords[0] || item.key,
    image: item.params.maxImages > 0, text: item.params.maxTexts > 0, disabled: off.has(item.key),
  }));
}
function wrap(text, limit = 14) {
  const lines = []; let line = '', width = 0;
  for (const char of text) {
    const units = /[\x20-\x7e]/.test(char) ? 0.62 : 1;
    if (line && width + units > limit) { lines.push(line); line = ''; width = 0; }
    line += char; width += units;
  }
  if (line) lines.push(line);
  return lines;
}
// A framed-landscape emoji-style pictogram, drawn as vectors so it looks the same on every OS.
const imageIcon = (x, y, muted = false) => `<g transform="translate(${x} ${y})"${muted ? ' opacity="0.4"' : ''}><rect width="28" height="28" rx="4" fill="#aa784e"/><rect x="3" y="3" width="22" height="22" rx="1" fill="#a8d9ee"/><circle cx="19" cy="9" r="3" fill="#fff1ac"/><path d="M3 22L11 11L18 22Z" fill="#4a9b75"/><path d="M10 25L19 14L25 22V25Z" fill="#28745d"/></g>`;
const textIcon = (x, y, muted = false) => `<g transform="translate(${x} ${y})"${muted ? ' opacity="0.4"' : ''}><rect width="28" height="28" rx="5" fill="#e1eaf9"/><path d="M7 7H21M14 7V22" stroke="#4266a0" stroke-width="3" fill="none"/></g>`;
export function buildIndexSvg(items, disabled = [], columnCount = 5) {
  const columns = [4, 5, 6, 7].includes(Number(columnCount)) ? Number(columnCount) : 5;
  const entries = indexEntries(items, disabled), rows = Math.ceil(entries.length / columns);
  const margin = 48, columnWidth = 512, gutter = 32, top = 220;
  const width = margin * 2 + columnWidth * columns + gutter * (columns - 1);
  const wrapped = entries.map(e => wrap(e.label));
  const heights = Array.from({ length: rows }, (_, row) => Math.max(48, ...Array.from({ length: columns }, (_, col) => (wrapped[col * rows + row]?.length || 1) * 30 + 16)));
  const offsets = [0]; for (const height of heights) offsets.push(offsets.at(-1) + height);
  const height = top + offsets.at(-1) + 48;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    '<g font-family="Noto Sans SC" fill="#203347">',
    `<text x="${margin}" y="96" font-size="54">表情目录</text>`,
    `<text x="${width - margin}" y="92" text-anchor="end" font-size="30" fill="#527168">${entries.length} 个模板</text>`,
    `<text x="${margin}" y="145" font-size="25" fill="#506374">发送 #触发词 制作表情 · #表情详情 触发词 查看用法</text>`,
    imageIcon(margin, 168), `<text x="${margin + 40}" y="191" font-size="23" fill="#506374">图片参数</text>`,
    textIcon(margin + 180, 168), `<text x="${margin + 220}" y="191" font-size="23" fill="#506374">文字参数</text>`,
    ...(entries.some(e => e.disabled) ? [`<text x="${margin + 390}" y="191" font-size="23" fill="#86939e">灰色条目已禁用</text>`] : []),
  ];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], col = Math.floor(i / rows), row = i % rows;
    const x = margin + col * (columnWidth + gutter), y = top + offsets[row], h = heights[row];
    parts.push(`<g data-key="${escape(entry.key)}">`, `<rect x="${x}" y="${y}" width="${columnWidth}" height="${h}" fill="${row % 2 ? '#ffffff' : '#f1f5f7'}"/>`,
      `<text x="${x + 12}" y="${y + 32}" font-size="21" fill="#7b8a96">${String(entry.number).padStart(3, '0')}</text>`);
    if (entry.image) parts.push(imageIcon(x + 72, y + 10, entry.disabled));
    if (entry.text) parts.push(textIcon(x + 108, y + 10, entry.disabled));
    wrapped[i].forEach((line, j) => parts.push(`<text x="${x + 150}" y="${y + 32 + j * 30}" font-size="24" fill="${entry.disabled ? '#a0a9b2' : '#203347'}">${escape(line)}</text>`));
    parts.push('</g>');
  }
  parts.push('</g></svg>');
  return { svg: parts.join(''), entries, width, height };
}
