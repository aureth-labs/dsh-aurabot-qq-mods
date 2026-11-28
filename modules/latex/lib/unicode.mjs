// 把手机上能手打出来的 Unicode 数学符号转成 LaTeX：
// x² → x^{2}、√2 → \sqrt{2}、α+β → \alpha+\beta、∫₀¹ → \int_{0}^{1}。
// 只做纯文本替换，不猜语义；转不了的字符原样留着。

const SUP_FROM = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱˣʸᵃᵇᶜᵈᵉᶠᵍʰʲᵏˡᵐᵒᵖʳˢᵗᵘᵛʷᶻ'
const SUP_TO = '0123456789+-=()nixyabcdefghjklmoprstuvwz'
const SUB_FROM = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₔₕₖₗₘₙₚₛₜᵢᵣᵤᵥ'
const SUB_TO = '0123456789+-=()aeoxhklmnpstiruv'

const pair = (from, to) => {
  const map = new Map()
  const a = [...from]
  const b = [...to]
  for (let i = 0; i < a.length; i++) map.set(a[i], b[i] ?? a[i])
  return map
}

const SUP = pair(SUP_FROM, SUP_TO)
const SUB = pair(SUB_FROM, SUB_TO)

// 单个符号 → 命令。键都是 Unicode，不会碰到已经写好的 \pi。
const SYMBOLS = {
  '√': '\\sqrt{}',
  '×': '\\times', '÷': '\\div', '±': '\\pm', '∓': '\\mp', '⋅': '\\cdot', '·': '\\cdot', '∗': '\\ast',
  '≠': '\\neq', '≤': '\\leq', '≥': '\\geq', '⩽': '\\leq', '⩾': '\\geq', '≈': '\\approx',
  '≡': '\\equiv', '≅': '\\cong', '∼': '\\sim', '∝': '\\propto', '≪': '\\ll', '≫': '\\gg',
  '∞': '\\infty', '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '∂': '\\partial', '∇': '\\nabla', '∆': '\\Delta',
  '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq',
  '∪': '\\cup', '∩': '\\cap', '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists', '¬': '\\neg', '∧': '\\wedge', '∨': '\\vee',
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow',
  '↑': '\\uparrow', '↓': '\\downarrow', '↦': '\\mapsto',
  '∠': '\\angle', '⊥': '\\perp', '∥': '\\parallel', '△': '\\triangle',
  '°': '^\\circ', '′': "'", '″': "''", '…': '\\ldots', '⋯': '\\cdots',
  'ℝ': '\\mathbb{R}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}',
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\epsilon', 'ϵ': '\\epsilon',
  'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ϑ': '\\vartheta', 'ι': '\\iota', 'κ': '\\kappa',
  'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi', 'ο': 'o', 'π': '\\pi', 'ϖ': '\\varpi',
  'ρ': '\\rho', 'σ': '\\sigma', 'ς': '\\varsigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\phi',
  'ϕ': '\\phi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi', 'Π': '\\Pi',
  'Σ': '\\Sigma', 'Υ': '\\Upsilon', 'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  '½': '\\frac{1}{2}', '⅓': '\\frac{1}{3}', '⅔': '\\frac{2}{3}', '¼': '\\frac{1}{4}', '¾': '\\frac{3}{4}',
}

/** 上下标都是一串连续字符，攒成一组再包起来。 */
function groupScripts(text, chars, wrap) {
  let out = ''
  let run = ''
  const flush = () => {
    if (!run) return
    out += wrap + '{' + [...run].join('') + '}'
    run = ''
  }
  for (const ch of text) {
    const mapped = chars.get(ch)
    if (mapped) {
      run += mapped
      continue
    }
    flush()
    out += ch
  }
  flush()
  return out
}

/** √ 后面接一个括号组、一个字母数字、或者一条命令，都塞进 \sqrt{…}。 */
function expandRoots(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] !== '√') {
      out += text[i]
      i += 1
      continue
    }
    let j = i + 1
    while (text[j] === ' ') j += 1
    const open = text[j]
    if (open === '(' || open === '{' || open === '[') {
      const close = open === '(' ? ')' : open === '{' ? '}' : ']'
      let depth = 0
      let k = j
      for (; k < text.length; k++) {
        if (text[k] === open) depth += 1
        else if (text[k] === close) {
          depth -= 1
          if (depth === 0) break
        }
      }
      if (k < text.length) {
        out += '\\sqrt{' + text.slice(j + 1, k) + '}'
        i = k + 1
        continue
      }
    }
    if (/[A-Za-z0-9]/.test(text[j] || '')) {
      out += '\\sqrt{' + text[j] + '}'
      i = j + 1
      continue
    }
    if (text[j] === '\\') {
      const hit = /^\\[A-Za-z]+/.exec(text.slice(j))
      if (hit) {
        out += '\\sqrt{' + hit[0] + '}'
        i = j + hit[0].length
        continue
      }
    }
    out += '\\sqrt{}'
    i = j
  }
  return out
}

/** 这段里有没有能转的东西（用来判断值不值得转一遍）。 */
export function hasUnicodeMath(text) {
  const s = String(text ?? '')
  if (!s) return false
  for (const ch of s) {
    if (SUP.has(ch) || SUB.has(ch) || SYMBOLS[ch]) return true
    if (ch === '√' || ch === '²' || ch === '³') return true
  }
  return false
}

/** Unicode 数学符号 → LaTeX。已经是 LaTeX 的部分原样保留。 */
export function unicodeToLatex(text) {
  let s = String(text ?? '')
  if (!s) return ''
  s = expandRoots(s)
  s = groupScripts(s, SUB, '_')
  s = groupScripts(s, SUP, '^')
  let out = ''
  let afterCommand = false
  for (const ch of s) {
    const rep = SYMBOLS[ch]
    if (rep !== undefined) {
      out += rep
      // \pi 后面紧跟字母会粘成 \pir，补一个空格断开
      afterCommand = /[A-Za-z]$/.test(rep)
      continue
    }
    if (afterCommand && /[A-Za-z]/.test(ch)) out += ' '
    afterCommand = false
    out += ch
  }
  return out
}
