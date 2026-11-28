/* dsh-image-studio 0.5.1 · lib/vision.js and lib/sheets.js
MIT License

Copyright (c) 2026 aa1355721445-lgtm

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
const FOCUS = {
  characters: {
    role: '角色设定整理助手',
    focus: '只描述人物外貌：脸型五官、发型与发色、瞳色、肤色、体型比例、年龄感、标志性特征（兽耳、尾巴、角、翅膀、饰品等），服装只用一句话概括。不要写姿势、表情神态（如「笑容」「脸红」）、动作和背景——这些每张图都会变，写进去会让以后每张图都长一个样。',
    name: '认得出是哪个角色就用角色名，否则按特征起名，如「蓝发鲸鱼娘」',
    tags: '画风、发色、体型、种族特征、气质等',
  },
  outfits: {
    role: '服装设计整理助手',
    focus: '只描述服装本身，完全忽略穿着者的长相、姿势和背景：服装类型与版型、长度、颜色搭配、面料材质、图案、领口 / 袖口 / 裙摆等结构细节、纽扣拉链蕾丝等装饰、鞋袜和配饰。图里有多件时描述整套穿搭（除非补充说明另有指定）。',
    name: '按款式起名，如「蓝白女仆装」「米色针织开衫」',
    tags: '风格（如 JK、洛丽塔、中式、通勤、运动）、季节、场合、主色、材质',
  },
  scenes: {
    role: '场景设定整理助手',
    focus: '只描述空间本身，忽略画面里的人物：空间类型与大小、布局、主要家具和陈设、材质、配色、光线与时间、时代与风格。',
    name: '按空间起名，如「暖光小卧室」「海边咖啡馆」',
    tags: '室内 / 室外、空间类型、风格、色调、氛围、适合做的事',
  },
  props: {
    role: '道具设计整理助手',
    focus: '只描述这个物品：类别、外形结构、尺寸感、颜色、材质、纹理图案和细节，忽略拿着它的手和背景。',
    name: '按物品起名，如「鲸鱼抱枕」「复古胶片相机」',
    tags: '类别、材质、颜色、风格、用途',
  },
}

function analyzePrompt(category, hint) {
  const f = FOCUS[category] || FOCUS.props
  return [
    `你是一名${f.role}。请仔细观察图片，为生图参考库整理一个条目。`,
    f.focus,
    '不要描述图片本身的版式（如「三视图」「设定图」「细节特写框」「排版」），只描述画的东西。',
    hint ? `用户的补充说明（优先遵守）：${hint}` : '',
    '只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：',
    '{',
    `  "name": "简短好记的中文名，2–10 个字；${f.name}",`,
    '  "aliases": ["0–3 个别名或常见叫法"],',
    `  "tags": ["5–10 个短标签：${f.tags}"],`,
    '  "description": "给生图模型看的外观描述，80–220 字，写具体可画的细节（颜色、形状、材质、位置关系），不写主观评价"',
    '}',
  ].filter(Boolean).join('\n')
}

const SHEET_ASPECT = { characters: '16:9', outfits: '16:9', props: '16:9', scenes: '4:3' }

const SHEET_PROMPTS = {
  characters: [
    '根据参考图中的角色，画一张标准的角色设定三视图（character turnaround sheet）。',
    '· 同一个角色的正面、侧面（面朝右）、背面三个全身像，从左到右横向等距排列；三个视图大小一致，头顶和脚底对齐，全身完整入画、不被裁切。',
    '· 姿势统一为自然站立的 A 字站姿：双臂自然下垂、微微离开身体，双脚与肩同宽；表情平静中性，目视前方。',
    '· 严格还原参考图中角色的脸型五官、发型发色、瞳色、肤色、体型比例和所有标志性特征（如兽耳、尾巴、饰品），以及身上的服装与配饰；参考图里看不到的部分（背面、侧面）按同一设计合理补全，三个视图之间保持完全一致。',
    '· 纯白背景；不要场景、道具、文字、标注、尺寸线或分格框线；均匀柔和的平光，没有强烈阴影。',
    '· 保持参考图原本的画风与上色方式。',
  ],
  outfits: [
    '根据参考图中的服装，画一张服装设计三视图（fashion design sheet）。',
    '· 只展示这套服装本身：把它穿在一个没有五官和发型的浅灰色素体人台上，不要出现参考图里模特的长相、姿势或背景。',
    '· 正面、侧面、背面三个全身视图从左到右横向等距排列，大小一致、上下对齐，整套服装完整入画。',
    '· 准确还原版型、长度、颜色、图案、面料质感和所有结构细节（领口、袖口、腰线、裙摆、褶裥、纽扣拉链、蕾丝花边等），连同鞋袜和配饰；参考图看不到的背面、侧面按同一款式合理补全。',
    '· 纯白背景；不要文字、标注或分格框线；均匀柔和的光照。',
  ],
  props: [
    '根据参考图中的物品，画一张道具设计三视图（prop design sheet）。',
    '· 只画这个物品本身，去掉拿着它的手、人物和周围的杂物。',
    '· 正面、侧面、背面三个视图，再加一个 45° 斜侧透视图，从左到右横向排列，比例一致、底部对齐。',
    '· 准确还原外形结构、比例、颜色、材质质感、纹理图案和细节；看不到的部分按同一设计合理补全。',
    '· 纯白背景，只保留极淡的接触阴影；不要文字、标注或分格框线；均匀柔和的光照。',
  ],
  scenes: [
    '根据参考图中的场景，画一张场景设定图（environment design sheet），之后会在这个场景里画角色。',
    '· 去掉画面里所有的人物和动物，只保留空间本身。',
    '· 版式：上方是一张宽幅的主视角全景；下方左边是从相反方向看过去的反向视角，右边是一张俯视的平面布局示意图（简洁的线条加色块）。三格之间用细白边分隔。',
    '· 准确还原空间结构、门窗位置、主要家具和陈设、材质、配色、光线氛围与时代风格；参考图看不到的部分按同一风格合理延伸，三个视角之间的家具位置要对得上。',
    '· 不要文字和标注；保持参考图的画风。',
  ],
}

function sheetPrompt(category, description, hint) {
  const lines = [...(SHEET_PROMPTS[category] || SHEET_PROMPTS.props)]
  if (description && description.trim()) lines.push(`参考描述（帮助还原细节）：${description.replace(/\s+/g, ' ').trim()}`)
  if (hint && hint.trim()) lines.push(`补充要求（优先遵守）：${hint.trim()}`)
  return lines.join('\n')
}
const categories = {identity:'characters', outfit:'outfits', scene:'scenes', object:'props'};
export function studioPromptPlan(kind, description, hint, referenceCount) {
  const category = categories[kind];
  return {
    source:'dsh-image-studio 0.5.1', aspect:SHEET_ASPECT[category], referenceCount,
    analysis:analyzePrompt(category, hint), sheet:sheetPrompt(category, description, hint),
  };
}
