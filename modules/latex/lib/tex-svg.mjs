// 本机把 LaTeX 排成 SVG：MathJax v3 的 TeX 输入 + SVG 输出，纯 JS，不联网、不装 TeX。
//
// mathjax-full 是 CommonJS 包，用默认导入再解构最稳（Node 的 ESM 和 esbuild 打包都认）。
// 引擎是懒加载的：第一次真要画图才初始化（加载 AllPackages + 字体，几百毫秒），之后每个公式几十毫秒。
import adaptorPkg from 'mathjax-full/js/adaptors/liteAdaptor.js'
import handlerPkg from 'mathjax-full/js/handlers/html.js'
import packagesPkg from 'mathjax-full/js/input/tex/AllPackages.js'
import texPkg from 'mathjax-full/js/input/tex.js'
import mathjaxPkg from 'mathjax-full/js/mathjax.js'
import svgPkg from 'mathjax-full/js/output/svg.js'

const { mathjax } = mathjaxPkg
const { TeX } = texPkg
const { SVG } = svgPkg
const { liteAdaptor } = adaptorPkg
const { RegisterHTMLHandler } = handlerPkg
const { AllPackages } = packagesPkg

let engine = null

function ready() {
  if (engine) return engine
  const adaptor = liteAdaptor()
  RegisterHTMLHandler(adaptor)
  const tex = new TeX({ packages: AllPackages })
  // fontCache: 'local' 让每张图自带字形定义，发出去的 SVG 不依赖别处
  const svg = new SVG({ fontCache: 'local' })
  const doc = mathjax.document('', { InputJax: tex, OutputJax: svg })
  engine = { adaptor, doc }
  return engine
}

/** 提前把引擎热起来（模块启动后调一次，第一条消息就不用等初始化）。 */
export function warmUp() {
  ready()
}

/**
 * LaTeX → SVG 文本。
 * 返回 { svg } 或 { error }：MathJax 遇到不认识的命令不会抛错，而是把错误信息排版成 merror 节点，
 * 这里把它挑出来当成失败，别把红字画进图里。
 */
export function texToSvg(latex, { display = true } = {}) {
  const { adaptor, doc } = ready()
  const source = String(latex ?? '').trim()
  if (!source) return { error: '公式是空的' }
  let node
  try {
    node = doc.convert(source, { display, em: 16, ex: 7, containerWidth: 100000 })
  } catch (error) {
    return { error: `排版失败：${error?.message || '未知原因'}` }
  }
  const svg = adaptor.outerHTML(node)
  // MathJax 不抛错，它把错误排进图里：缺括号这类给 merror 节点（带 data-mjx-error），
  // 不认识的命令则把原样命令排成 red 的 mtext。两种都算失败，别把错误画成"正常公式"。
  const bad = /data-mjx-error="([^"]*)"/.exec(svg)
  if (bad) return { error: `公式没排出来：${unescapeXml(bad[1])}` }
  if (/<g data-mml-node="mtext" fill="red"/.test(svg)) return { error: '公式里有它不认识的命令' }
  return { svg }
}

function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
