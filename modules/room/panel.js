// 小鱼小屋 · 面板
// 环境提供：React、h、ui、call
const { useState, useEffect, useRef } = React

const INK = '#16324F'
const WOOD = '#B07A4A'
const WOOD_D = '#8C5E36'
const CREAM = '#F6EFE4'
const TEAL = '#2E8B7E'
const GLOW = '#FBE3A1'

// 每件家具画在以 (0,0) 为底部中心的位置
function Shape({ kind, level = 0.7 }) {
  switch (kind) {
    case 'rug':
      return h('g', null,
        h('ellipse', { cx: 0, cy: -18, rx: 250, ry: 82, fill: '#E7D8C0', opacity: 0.9 }),
        h('ellipse', { cx: 0, cy: -18, rx: 250, ry: 82, fill: 'none', stroke: '#D9C6AA', strokeWidth: 3 }))
    case 'desk':
      return h('g', null,
        h('rect', { x: -150, y: -176, width: 300, height: 22, rx: 10, fill: WOOD }),
        h('rect', { x: -140, y: -158, width: 280, height: 96, rx: 8, fill: WOOD }),
        h('rect', { x: -136, y: -128, width: 272, height: 40, rx: 6, fill: WOOD_D, opacity: 0.35 }),
        h('circle', { cx: 0, cy: -108, r: 6, fill: WOOD_D }),
        h('rect', { x: -132, y: -62, width: 14, height: 62, rx: 5, fill: WOOD_D }),
        h('rect', { x: 118, y: -62, width: 14, height: 62, rx: 5, fill: WOOD_D }),
        h('rect', { x: -120, y: -204, width: 42, height: 26, rx: 6, fill: CREAM }),
        h('path', { d: 'M -78 -192 q 10 8 0 16', stroke: CREAM, strokeWidth: 6, fill: 'none' }),
        h('rect', { x: -50, y: -198, width: 84, height: 18, rx: 4, fill: CREAM }))
    case 'sofa':
      return h('g', null,
        h('rect', { x: -150, y: -200, width: 300, height: 156, rx: 46, fill: INK }),
        h('rect', { x: -126, y: -180, width: 252, height: 112, rx: 34, fill: '#2C5170' }),
        h('rect', { x: -170, y: -108, width: 62, height: 108, rx: 26, fill: INK }),
        h('rect', { x: 108, y: -108, width: 62, height: 108, rx: 26, fill: INK }),
        h('rect', { x: -130, y: -62, width: 260, height: 62, rx: 24, fill: '#122A42' }),
        h('rect', { x: 62, y: -160, width: 62, height: 84, rx: 18, fill: CREAM, opacity: 0.92 }))
    case 'lamp':
      return h('g', null,
        h('ellipse', { cx: 0, cy: -44, rx: 58, ry: 44, fill: INK }),
        h('ellipse', { cx: -6, cy: -32, rx: 40, ry: 24, fill: '#EAF1F6' }),
        h('circle', { cx: 16, cy: -54, r: 7, fill: '#EAF1F6' }),
        h('circle', { cx: 18, cy: -54, r: 3.4, fill: INK }),
        h('path', { d: 'M 30 -78 C 96 -140 150 -148 168 -110', stroke: INK, strokeWidth: 16, fill: 'none', strokeLinecap: 'round' }),
        h('path', { d: 'M 168 -110 q 34 -26 52 -4 q -22 -6 -30 14 q -4 18 -22 -10 z', fill: INK }),
        h('line', { x1: 178, y1: -98, x2: 178, y2: -66, stroke: '#123', strokeWidth: 4 }),
        h('circle', { cx: 178, cy: -52, r: 22, fill: level > 0.45 ? GLOW : '#C9DAE8' }),
        h('circle', { cx: 178, cy: -52, r: 22, fill: 'none', stroke: '#E3B95C', strokeWidth: 3 }),
        h('circle', { cx: 178, cy: -52, r: 62, fill: level > 0.45 ? GLOW : '#D5E2EE', opacity: 0.08 + 0.3 * level }))
    case 'bed':
      return h('g', null,
        // 床腿
        h('rect', { x: -118, y: -18, width: 16, height: 18, rx: 5, fill: WOOD_D }),
        h('rect', { x: 102, y: -18, width: 16, height: 18, rx: 5, fill: WOOD_D }),
        // 床架横挡
        h('rect', { x: -130, y: -34, width: 260, height: 20, rx: 8, fill: WOOD }),
        // 床垫
        h('rect', { x: -126, y: -150, width: 252, height: 122, rx: 16, fill: '#FBF6EC' }),
        h('rect', { x: -126, y: -60, width: 252, height: 30, rx: 14, fill: '#EFE4D2', opacity: 0.8 }),
        // 床头板
        h('rect', { x: -140, y: -248, width: 28, height: 216, rx: 12, fill: WOOD }),
        h('rect', { x: -134, y: -238, width: 16, height: 196, rx: 8, fill: WOOD_D, opacity: 0.35 }),
        // 枕头
        h('rect', { x: -104, y: -146, width: 60, height: 36, rx: 14, fill: '#FFFFFF' }),
        h('rect', { x: -98, y: -138, width: 48, height: 12, rx: 6, fill: '#E9E1D4', opacity: 0.7 }),
        // 毯子（深蓝，跟沙发一套）
        h('rect', { x: -40, y: -142, width: 162, height: 110, rx: 16, fill: '#3E6E93' }),
        h('rect', { x: -40, y: -142, width: 162, height: 24, rx: 12, fill: '#4E82AC' }),
        h('rect', { x: -40, y: -58, width: 162, height: 18, rx: 9, fill: '#33608A', opacity: 0.85 }),
        // 毯尾一道折痕
        h('line', { x1: 40, y1: -136, x2: 40, y2: -40, stroke: '#33608A', strokeWidth: 3, opacity: 0.5 }))
    case 'snacks':
      return h('g', { opacity: 0.4 + 0.6 * level },
        h('rect', { x: -74, y: -66, width: 148, height: 66, rx: 8, fill: '#C89A6A' }),
        h('rect', { x: -74, y: -66, width: 148, height: 14, rx: 5, fill: '#B4875A' }),
        h('rect', { x: -52, y: -108, width: 46, height: 44, rx: 8, fill: '#E2725B' }),
        h('rect', { x: -46, y: -100, width: 34, height: 12, rx: 4, fill: '#F7C9A9' }),
        h('rect', { x: 2, y: -104, width: 44, height: 40, rx: 8, fill: '#F2C14E' }),
        h('rect', { x: 8, y: -96, width: 32, height: 10, rx: 4, fill: '#FDF1CF' }),
        h('circle', { cx: 60, cy: -112, r: 12, fill: '#F2A0B5' }),
        h('line', { x1: 60, y1: -100, x2: 60, y2: -64, stroke: '#D9C6AA', strokeWidth: 4 }),
        h('rect', { x: -46, y: -34, width: 92, height: 16, rx: 6, fill: CREAM, opacity: 0.9 }))
    case 'frame':
      return h('g', null,
        h('rect', { x: -62, y: -86, width: 124, height: 86, rx: 6, fill: '#FFFDF7', stroke: '#DCCDB4', strokeWidth: 4 }),
        h('ellipse', { cx: -4, cy: -44, rx: 30, ry: 20, fill: '#9CC3E0' }),
        h('path', { d: 'M -34 -44 l -18 -13 v 26 z', fill: '#9CC3E0' }),
        h('circle', { cx: 12, cy: -48, r: 3.4, fill: INK }))
    case 'plant':
      return h('g', null,
        h('path', { d: 'M -26 -46 h 52 l -8 46 h -36 z', fill: '#C97B5A' }),
        h('rect', { x: -30, y: -56, width: 60, height: 14, rx: 5, fill: '#B3694B' }),
        h('path', { d: 'M 0 -56 C -6 -106 -30 -122 -46 -130 C -30 -92 -18 -72 0 -56', fill: TEAL, opacity: 0.9 }),
        h('path', { d: 'M 0 -56 C 8 -112 34 -126 48 -134 C 32 -90 16 -70 0 -56', fill: '#3AA391', opacity: 0.9 }),
        h('path', { d: 'M 0 -56 C -2 -96 2 -116 4 -138', stroke: '#2A7A6C', strokeWidth: 4, fill: 'none' }))
    case 'shelf':
      return h('g', null,
        h('rect', { x: -78, y: -212, width: 12, height: 212, rx: 5, fill: WOOD }),
        h('rect', { x: 66, y: -212, width: 12, height: 212, rx: 5, fill: WOOD }),
        h('rect', { x: -84, y: -218, width: 168, height: 16, rx: 6, fill: WOOD_D }),
        h('rect', { x: -72, y: -78, width: 144, height: 10, rx: 3, fill: WOOD_D }),
        h('rect', { x: -72, y: -146, width: 144, height: 10, rx: 3, fill: WOOD_D }),
        h('rect', { x: -72, y: -208, width: 144, height: 10, rx: 3, fill: WOOD_D }),
        h('rect', { x: -62, y: -124, width: 12, height: 46, rx: 2, fill: '#E2725B' }),
        h('rect', { x: -46, y: -116, width: 10, height: 38, rx: 2, fill: '#F2C14E' }),
        h('rect', { x: -32, y: -126, width: 14, height: 48, rx: 2, fill: '#3AA391' }),
        h('rect', { x: -14, y: -114, width: 9, height: 36, rx: 2, fill: '#2C5170' }),
        h('rect', { x: 4, y: -90, width: 54, height: 12, rx: 3, fill: '#C97B5A' }),
        h('rect', { x: -60, y: -192, width: 11, height: 46, rx: 2, fill: '#2C5170' }),
        h('rect', { x: -45, y: -184, width: 13, height: 38, rx: 2, fill: '#E2725B' }),
        h('rect', { x: -28, y: -194, width: 10, height: 48, rx: 2, fill: '#F2C14E' }),
        h('circle', { cx: 30, cy: -186, r: 14, fill: '#9CC3E0' }),
        h('rect', { x: 52, y: -198, width: 12, height: 52, rx: 3, fill: '#3AA391', opacity: 0.85 }))
    case 'fishtank':
      return h('g', null,
        h('rect', { x: -64, y: -34, width: 128, height: 12, rx: 4, fill: WOOD }),
        h('rect', { x: -54, y: -22, width: 10, height: 22, rx: 3, fill: WOOD_D }),
        h('rect', { x: 44, y: -22, width: 10, height: 22, rx: 3, fill: WOOD_D }),
        h('rect', { x: -60, y: -156, width: 120, height: 124, rx: 12, fill: '#E4F1F7' }),
        h('rect', { x: -56, y: -116, width: 112, height: 80, rx: 9, fill: '#8FC6DE', opacity: 0.8 }),
        h('line', { x1: -56, y1: -116, x2: 56, y2: -116, stroke: '#6FAECB', strokeWidth: 3 }),
        h('path', { d: 'M -34 -54 C -30 -84 -44 -96 -40 -114', stroke: '#3AA391', strokeWidth: 7, fill: 'none', strokeLinecap: 'round' }),
        h('path', { d: 'M -18 -54 C -14 -80 -24 -92 -20 -110', stroke: '#2E8B7E', strokeWidth: 6, fill: 'none', strokeLinecap: 'round' }),
        h('ellipse', { cx: 18, cy: -86, rx: 18, ry: 12, fill: '#F2A03D' }),
        h('path', { d: 'M 36 -86 l 14 -10 v 20 z', fill: '#F2A03D' }),
        h('circle', { cx: 8, cy: -89, r: 3, fill: INK }),
        h('circle', { cx: -4, cy: -124, r: 4, fill: '#FFFFFF', opacity: 0.85 }),
        h('circle', { cx: 4, cy: -136, r: 3, fill: '#FFFFFF', opacity: 0.7 }),
        h('rect', { x: -54, y: -150, width: 12, height: 104, rx: 6, fill: '#FFFFFF', opacity: 0.5 }))
    case 'mirror':
      return h('g', null,
        h('rect', { x: -54, y: -20, width: 108, height: 12, rx: 5, fill: WOOD }),
        h('rect', { x: -8, y: -150, width: 16, height: 136, rx: 4, fill: WOOD_D }),
        h('ellipse', { cx: 0, cy: -152, rx: 54, ry: 82, fill: '#E8F3F8', stroke: WOOD, strokeWidth: 9 }),
        h('path', { d: 'M -24 -196 q 16 34 6 76', stroke: '#FFFFFF', strokeWidth: 8, opacity: 0.65, fill: 'none', strokeLinecap: 'round' }),
        h('path', { d: 'M 12 -206 q 14 28 6 62', stroke: '#FFFFFF', strokeWidth: 5, opacity: 0.45, fill: 'none', strokeLinecap: 'round' }))
    case 'cushion':
      return h('g', null,
        h('ellipse', { cx: -20, cy: -10, rx: 46, ry: 16, fill: '#E9D6BE' }),
        h('rect', { x: -58, y: -46, width: 62, height: 44, rx: 16, fill: '#F2A0B5' }),
        h('rect', { x: -26, y: -74, width: 58, height: 42, rx: 14, fill: '#F2C14E' }),
        h('rect', { x: 4, y: -52, width: 60, height: 44, rx: 15, fill: '#9CC3E0' }),
        h('circle', { cx: -30, cy: -30, r: 4, fill: '#FFFFFF', opacity: 0.6 }))
    case 'clock':
      return h('g', null,
        h('circle', { cx: 0, cy: -48, r: 42, fill: '#FFFDF7', stroke: INK, strokeWidth: 6 }),
        h('circle', { cx: 0, cy: -48, r: 4.5, fill: INK }),
        h('line', { x1: 0, y1: -48, x2: 0, y2: -74, stroke: INK, strokeWidth: 5, strokeLinecap: 'round' }),
        h('line', { x1: 0, y1: -48, x2: 18, y2: -38, stroke: INK, strokeWidth: 4, strokeLinecap: 'round' }),
        h('circle', { cx: -24, cy: -48, r: 3, fill: '#C9B79A' }),
        h('circle', { cx: 24, cy: -48, r: 3, fill: '#C9B79A' }),
        h('circle', { cx: 0, cy: -92, r: 6, fill: INK }),
        h('rect', { x: -3, y: -104, width: 6, height: 12, rx: 3, fill: INK }))
    case 'lights':
      return h('g', null,
        h('path', { d: 'M -150 -34 Q -76 -2 0 -28 Q 76 -54 150 -22', stroke: '#C9B79A', strokeWidth: 3, fill: 'none' }),
        h('circle', { cx: -118, cy: -14, r: 14, fill: GLOW, opacity: 0.35 }),
        h('circle', { cx: -118, cy: -14, r: 7, fill: GLOW }),
        h('circle', { cx: -62, cy: -6, r: 14, fill: GLOW, opacity: 0.35 }),
        h('circle', { cx: -62, cy: -6, r: 7, fill: GLOW }),
        h('circle', { cx: -4, cy: -22, r: 14, fill: GLOW, opacity: 0.35 }),
        h('circle', { cx: -4, cy: -22, r: 7, fill: GLOW }),
        h('circle', { cx: 52, cy: -34, r: 14, fill: GLOW, opacity: 0.35 }),
        h('circle', { cx: 52, cy: -34, r: 7, fill: GLOW }),
        h('circle', { cx: 104, cy: -28, r: 14, fill: GLOW, opacity: 0.35 }),
        h('circle', { cx: 104, cy: -28, r: 7, fill: GLOW }),
        h('circle', { cx: 144, cy: -20, r: 12, fill: GLOW, opacity: 0.3 }),
        h('circle', { cx: 144, cy: -20, r: 6, fill: GLOW }))
    case 'tv':
      return h('g', null,
        h('rect', { x: -118, y: -140, width: 236, height: 134, rx: 10, fill: '#12263A' }),
        h('rect', { x: -108, y: -130, width: 216, height: 114, rx: 6, fill: '#1E4C6E' }),
        h('ellipse', { cx: -12, cy: -72, rx: 34, ry: 22, fill: '#9CC3E0', opacity: 0.92 }),
        h('path', { d: 'M 24 -72 l 18 -14 v 28 z', fill: '#9CC3E0', opacity: 0.92 }),
        h('circle', { cx: -28, cy: -78, r: 4, fill: '#12263A' }),
        h('path', { d: 'M -108 -130 L -58 -130 L -108 -56 Z', fill: '#FFFFFF', opacity: 0.07 }),
        h('circle', { cx: 100, cy: -14, r: 3, fill: '#5C7A96' }))
    case 'pc':
      return h('g', null,
        h('rect', { x: -88, y: -66, width: 176, height: 66, rx: 6, fill: WOOD }),
        h('rect', { x: -88, y: -66, width: 176, height: 10, rx: 4, fill: WOOD_D }),
        h('rect', { x: -78, y: -22, width: 30, height: 18, rx: 4, fill: WOOD_D }),
        h('rect', { x: -58, y: -154, width: 114, height: 82, rx: 6, fill: '#12263A' }),
        h('rect', { x: -52, y: -148, width: 102, height: 68, rx: 3, fill: '#2E6F94' }),
        h('rect', { x: -44, y: -140, width: 42, height: 6, rx: 3, fill: '#BFE0F0', opacity: 0.9 }),
        h('rect', { x: -44, y: -128, width: 68, height: 5, rx: 2, fill: '#BFE0F0', opacity: 0.6 }),
        h('rect', { x: -44, y: -116, width: 52, height: 5, rx: 2, fill: '#BFE0F0', opacity: 0.5 }),
        h('rect', { x: -6, y: -74, width: 12, height: 12, rx: 3, fill: '#0E1E2E' }),
        h('rect', { x: 64, y: -130, width: 34, height: 66, rx: 5, fill: '#1B2A38' }),
        h('circle', { cx: 81, cy: -114, r: 4, fill: '#7FD1C1' }),
        h('rect', { x: 70, y: -102, width: 22, height: 4, rx: 2, fill: '#33506B' }),
        h('rect', { x: 70, y: -92, width: 22, height: 4, rx: 2, fill: '#33506B' }),
        h('rect', { x: -44, y: -72, width: 78, height: 10, rx: 3, fill: '#E9E1D4' }),
        h('ellipse', { cx: 48, cy: -67, rx: 7, ry: 5, fill: '#E9E1D4' }))
    case 'washer':
      return h('g', null,
        h('rect', { x: -56, y: -166, width: 112, height: 166, rx: 12, fill: '#F4F6F8', stroke: '#D7DEE5', strokeWidth: 3 }),
        h('rect', { x: -56, y: -166, width: 112, height: 30, rx: 10, fill: '#E3EAEF' }),
        h('circle', { cx: -34, cy: -151, r: 8, fill: '#B9C6D1' }),
        h('rect', { x: 0, y: -158, width: 40, height: 14, rx: 4, fill: '#CBD7E1' }),
        h('circle', { cx: 0, cy: -82, r: 42, fill: '#DDE8F0' }),
        h('circle', { cx: 0, cy: -82, r: 32, fill: '#CFE4F3', stroke: '#A8C6DC', strokeWidth: 3 }),
        h('path', { d: 'M -18 -94 q 16 -12 30 2', stroke: '#FFFFFF', strokeWidth: 6, opacity: 0.75, fill: 'none', strokeLinecap: 'round' }),
        h('circle', { cx: 42, cy: -150, r: 4, fill: '#7FD1C1' }),
        h('rect', { x: -48, y: -6, width: 12, height: 6, rx: 3, fill: '#C6D0D8' }),
        h('rect', { x: 36, y: -6, width: 12, height: 6, rx: 3, fill: '#C6D0D8' }))
    case 'cooker':
      return h('g', null,
        h('rect', { x: -48, y: -36, width: 96, height: 12, rx: 4, fill: WOOD }),
        h('rect', { x: -40, y: -24, width: 10, height: 24, rx: 3, fill: WOOD_D }),
        h('rect', { x: 30, y: -24, width: 10, height: 24, rx: 3, fill: WOOD_D }),
        h('rect', { x: -34, y: -104, width: 68, height: 68, rx: 14, fill: '#F6F2EC' }),
        h('rect', { x: -34, y: -104, width: 68, height: 20, rx: 10, fill: '#E8E1D6' }),
        h('ellipse', { cx: 0, cy: -104, rx: 34, ry: 9, fill: '#DCD3C4' }),
        h('rect', { x: -10, y: -116, width: 20, height: 12, rx: 5, fill: '#C9BFAE' }),
        h('circle', { cx: 0, cy: -74, r: 5, fill: '#E2725B' }),
        h('rect', { x: -20, y: -60, width: 40, height: 8, rx: 4, fill: '#E8E1D6' }),
        h('path', { d: 'M -14 -126 q 8 -12 0 -24', stroke: '#D9CFC0', strokeWidth: 5, fill: 'none', strokeLinecap: 'round', opacity: 0.85 }),
        h('path', { d: 'M 8 -128 q 8 -12 0 -22', stroke: '#D9CFC0', strokeWidth: 5, fill: 'none', strokeLinecap: 'round', opacity: 0.7 }))
    case 'fish':
      return h('g', null,
        h('ellipse', { cx: 0, cy: -4, rx: 34, ry: 9, fill: '#000000', opacity: 0.1 }),
        h('path', { d: 'M -30 -60 q -28 -10 -38 12 q 24 12 38 12 z', fill: '#3E86BE' }),
        h('ellipse', { cx: 0, cy: -76, rx: 40, ry: 32, fill: '#4A9AD4' }),
        h('path', { d: 'M 4 -106 q 18 -16 26 -4 q -12 6 -18 16 z', fill: '#3E86BE' }),
        h('ellipse', { cx: -2, cy: -62, rx: 26, ry: 15, fill: '#CFE7F5' }),
        h('circle', { cx: 16, cy: -84, r: 8, fill: '#FFFFFF' }),
        h('circle', { cx: 18, cy: -84, r: 4, fill: INK }),
        level > 0.55
          ? h('path', { d: 'M 8 -66 q 8 6 16 0', stroke: INK, strokeWidth: 3, fill: 'none', strokeLinecap: 'round' })
          : h('line', { x1: 8, y1: -66, x2: 24, y2: -66, stroke: INK, strokeWidth: 3, strokeLinecap: 'round' }),
        level > 0.62 && h('circle', { cx: 4, cy: -70, r: 6, fill: '#F2A0B5', opacity: 0.55 }))
    default:
      return h('rect', { x: -30, y: -60, width: 60, height: 60, fill: '#ccc' })
  }
}

// 房间尺寸：加宽了，够摆更多东西（原来的 1000 太挤）
const W = 1240
const H = 700

function Room({ state, onMove, busy, level = 0.7 }) {
  const svgRef = useRef(null)
  const [drag, setDrag] = useState(null)   // { kind, x, y }

  const pos = (e) => {
    const r = svgRef.current.getBoundingClientRect()
    return {
      x: Math.max(2, Math.min(98, ((e.clientX - r.left) / r.width) * 100)),
      y: Math.max(6, Math.min(96, ((e.clientY - r.top) / r.height) * 100)),
    }
  }

  const down = (kind) => (e) => {
    if (busy) return
    e.preventDefault()
    setDrag({ kind, ...pos(e) })
  }
  const move = (e) => { if (drag) setDrag({ ...drag, ...pos(e) }) }
  const up = () => {
    if (drag && onMove) onMove(drag.kind, Math.round(drag.x), Math.round(drag.y))
    setDrag(null)
  }

  // 地毯永远最底；台灯和小鱼永远在最前
  const z = (it) => (it.kind === 'rug' ? -1000 + it.y : it.kind === 'lamp' ? it.y + 300 : it.kind === 'fish' ? it.y + 400 : it.y)
  const items = (state.items || []).slice().sort((a, b) => z(a) - z(b))

  return h('svg', {
    ref: svgRef,
    viewBox: `0 0 ${W} ${H}`,
    style: { width: '100%', height: 'auto', display: 'block', touchAction: 'none', cursor: drag ? 'grabbing' : 'default' },
    onPointerMove: move,
    onPointerUp: up,
    onPointerLeave: up,
  },
  h('defs', null,
    h('linearGradient', { id: 'wall', x1: '0', y1: '0', x2: '0', y2: '1' },
      h('stop', { offset: '0%', stopColor: '#F7F1E6' }),
      h('stop', { offset: '100%', stopColor: '#EFE4D3' }))),
  h('rect', { x: 0, y: 0, width: W, height: 470, fill: 'url(#wall)' }),
  h('rect', { x: 0, y: 470, width: W, height: 230, fill: '#EADCC6' }),
  h('line', { x1: 0, y1: 470, x2: W, y2: 470, stroke: '#DCCBB2', strokeWidth: 3 }),
  [0, 1, 2, 3, 4].map((i) => h('line', {
    key: 'f' + i, x1: 0, y1: 500 + i * 44, x2: W, y2: 500 + i * 44,
    stroke: '#E0D2BC', strokeWidth: 2,
  })),
  items.map((it) => {
    const isDrag = drag && drag.kind === it.kind
    const x = isDrag ? drag.x : it.x
    const y = isDrag ? drag.y : it.y
    return h('g', {
      key: it.kind,
      transform: `translate(${(x / 100) * W} ${(y / 100) * H}) scale(0.9)`,
      style: { cursor: 'grab' },
      onPointerDown: down(it.kind),
    }, h(Shape, { kind: it.kind, level }))
  }),
  level < 0.55 && h('rect', { x: 0, y: 0, width: W, height: H, fill: '#0B1B2B', opacity: Math.min(0.45, (0.55 - level) * 1.1) }),
  items.length === 0 && h('text', {
    x: W / 2, y: 350, textAnchor: 'middle', fill: '#A89880', fontSize: 26,
  }, '还什么都没有，去右边买点东西吧'))
}

return function Panel({ settings, save, toast }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const r = await call('/state')
      if (r && r.ok) setSt(r)
    } catch (e) { toast('读不到房间：' + (e && e.message ? e.message : e)) }
  }

  useEffect(() => { refresh() }, [])

  const act = async (path, body, okText) => {
    setBusy(true)
    try {
      const r = await call(path, body)
      if (r && r.ok) {
        toast(okText || r.message || '好了')
        await refresh()
      } else {
        toast((r && r.message) || '没成')
      }
    } catch (e) {
      toast('出错了：' + (e && e.message ? e.message : e))
    } finally { setBusy(false) }
  }

  if (!st) return h(ui.Card, { title: '小鱼小屋' }, h('p', { className: 'ab-muted' }, '正在打开门……'))

  const coins = `${st.coins} ${st.coinName}`

  return h('div', null,
    h(ui.Card, { title: '小鱼小屋' },
      h(ui.Row, null,
        h('div', null,
          h('div', { style: { fontSize: 30, fontWeight: 700, color: INK } }, coins),
          h('div', { className: 'ab-small ab-muted' }, `今天已经挣了 ${st.earnToday} / ${st.earnPerDay}`),
          st.mood ? h('div', { className: 'ab-small ab-muted' }, `她的心情：${st.mood.label || '—'}（${st.mood.value}/100）`) : null),
        h(ui.Btn, { onClick: () => act('/preset', null, '按标准布置摆好了') }, '一键布置'),
        h(ui.Btn, { onClick: refresh }, '刷新')),
      h('p', { className: 'ab-note' }, '按住家具拖动就能挪位置，松手自动保存。'),

      h('div', { style: { marginTop: 12, background: '#FBF7F0', borderRadius: 14, overflow: 'hidden', border: '1px solid #E7DCCB' } },
        h(Room, {
          state: st,
          busy,
          level: Math.max(0, Math.min(1, ((st.mood && st.mood.value) || 65) / 100)),
          onMove: (kind, x, y) => act('/place', { kind, x, y }, '摆好了'),
        }))),

    h('div', { style: { height: 14 } }),

    h(ui.Card, { title: '置办家具' },
      (st.catalog || []).map((c) => h(ui.Row, { key: c.kind, style: { padding: '8px 0', borderBottom: '1px solid #EEE' } },
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontWeight: 600 } }, `${c.name}　${c.price} ${st.coinName}`),
          h('div', { className: 'ab-small ab-muted' }, c.hint)),
        c.owned
          ? h(ui.Btn, {
            onClick: () => act('/sell', { kind: c.kind }, '收起来了'),
          }, '收起')
          : h(ui.Btn, {
            onClick: () => act('/buy', { kind: c.kind }, '买下了'),
          }, st.coins >= c.price ? '买' : '钱不够'))))
  )
}
