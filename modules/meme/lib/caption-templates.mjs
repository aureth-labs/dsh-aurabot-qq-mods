import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from './errors.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const units = char => /^\s$/u.test(char) ? 0.35 : /^[a-z0-9]$/u.test(char) ? 0.65 : 1;
export function fitCaption(text, box) {
  for (let size = box.maxSize; size >= box.minSize; size--) {
    const lines = [];
    for (const paragraph of text.replace(/\\n/g, '\n').split('\n')) {
      let line = '', width = 0;
      for (const {segment} of segmenter.segment(paragraph)) {
        const next = units(segment) * size;
        if (width + next > box.width && line) {
          // Prefer a sentence/word boundary over splitting a phrase mid-line.
          const boundary = line.match(/^(.*[，。！？；、,!?;:：\s])(.*)$/u);
          const measure = value => [...segmenter.segment(value)].reduce((sum, x) => sum + units(x.segment) * size, 0);
          if (boundary && measure(boundary[1]) >= box.width * 0.35) {
            lines.push(boundary[1].trim()); line = boundary[2]; width = measure(line);
          } else { lines.push(line.trim()); line = ''; width = 0; }
        }
        line += segment; width += next;
      }
      lines.push(line.trim());
    }
    const lineHeight = size * box.lineHeight;
    if (lines.length * lineHeight <= box.height) return {lines, size, lineHeight};
  }
  throw new UserError('文字太长，放不下啦，请缩短后再试');
}
export function captionSvg(template, text, imageData) {
  const box = template.textBox, {lines, size, lineHeight} = fitCaption(text, box);
  const top = box.y + (box.height - lines.length * lineHeight) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${template.width}" height="${template.height}">
<image width="${template.width}" height="${template.height}" href="data:image/jpeg;base64,${imageData}"/>
<g font-family="Noto Sans SC" font-size="${size}" text-anchor="middle" fill="${box.color}" stroke="#172027" stroke-width="1" paint-order="stroke">${lines.map((line,i)=>`<text x="${box.x + box.width/2}" y="${top + size + i*lineHeight}">${escape(line)}</text>`).join('')}</g></svg>`;
}
export function createCaptionTemplates(root, renderSvg) {
  const templates = JSON.parse(readFileSync(join(root,'assets/templates.json'),'utf8'));
  const definitions = new Map(templates.map(t=>[t.key,t])), images = new Map();
  const items = templates.map(t=>({key:t.key,keywords:t.keywords,tags:t.tags,shortcuts:t.shortcuts || [],params:{minImages:0,maxImages:0,minTexts:1,maxTexts:1,defaultTexts:[t.defaultText],options:t.variants ? [{type:'String',field0:{name:t.variants.option,description:Object.keys(t.variants.images).join(' / '),default:t.variants.default,parserFlags:{longAliases:[],shortAliases:[]}}}] : []}}));
  return {
    items,
    has: key => definitions.has(key),
    async render(key, texts, options = {}) {
      const t = definitions.get(key);
      if (!t) throw new UserError('模板不存在');
      let file = t.image;
      if (t.variants) {
        const value = options[t.variants.option]?.field0 ?? t.variants.default;
        if (!Object.hasOwn(t.variants.images, value)) throw new UserError(`${t.variants.option}可选：${Object.keys(t.variants.images).join('、')}`);
        file = t.variants.images[value];
      }
      if (!images.has(file)) images.set(file,readFileSync(join(root,'assets',file)).toString('base64'));
      const result = await renderSvg(captionSvg(t,texts?.[0]?.trim() || t.defaultText,images.get(file)));
      return result.buffer;
    }
  };
}
