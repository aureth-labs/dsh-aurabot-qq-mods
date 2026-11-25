// 生图提示词模块（fish-draw-prompt）
//
// **这是给别的模块用的源代码模块，不是给用户直接打开的。**
// 从市场装上之后，面板里不会多出一个「生图提示词」页面 —— 它没有 UI。
// 作用只有一个：让多个生图入口共用同一份提示词，改一处四处同步。
//
// 起因：同一段「三步走 + 元素清单」原来在四个生图入口里各抄一份（约 255 行），
// 改一处漏三处。合并成一份源代码之后，四个入口都用它。
//
// 用法（在别的模块里）：
//
//   const dp = api.use('fish-draw-prompt')
//
//   // ① 拼提示词
//   const prompt = dp.buildDrawPrompt({
//     scene: 'avatar',        // avatar / chat / qzone —— 决定「用途」那段怎么说
//     context: ['你要给自己换个头像。', '心情 70 分'],   // 这个入口独有的上下文
//     wantParseFormat: true,   // 要不要她按三行回
//   })
//
//   // ② 解析她回的三行
//   const { hasSelf, ref, prompt: body } = dp.parseDrawAnswer(她回的原话)
//   //   hasSelf  这张画里有没有她自己
//   //   ref      她自己选的参考图（self:1~4 / null）
//   //   prompt   摘掉标记行之后的画面描述
//
//   // ③ 关键特征（代码生成 prompt 的场景直接用）
//   console.log(dp.ANCHOR)   // "深海蓝渐变长发（深蓝到发梢浅蓝）、头顶呆毛、鲸鱼鳍状耳朵、鲸鱼大尾巴、蓝色大眼睛"

import * as core from './lib/draw-prompt.js'

export default {
  id: 'fish-draw-prompt',
  name: '生图提示词（三步走）',
  version: '1.0.1',
  api: 1,
  description: '拼生图提示词的唯一一份源代码（用途 + 三步走 + 元素清单 + 关键特征）',

  setup(api) {
    // 纯函数，没有副作用、不碰网络、不读配置 —— 所以直接转出去就行。
    return {
      buildDrawPrompt: core.buildDrawPrompt,
      parseDrawAnswer: core.parseDrawAnswer,
      ANCHOR: core.ANCHOR,
    }
  },
}
