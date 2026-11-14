// 小游戏合集 · 面板：看她玩。
const { useState, useEffect, useRef } = React

const C2048 = {
  0: '#2a2f38', 2: '#eee4da', 4: '#ede0c8', 8: '#f2b179', 16: '#f59563',
  32: '#f67c5f', 64: '#f65e3b', 128: '#edcf72', 256: '#edcc61', 512: '#edc850',
  1024: '#edc53f', 2048: '#edc22e',
}

function Board2048({ frame }) {
  if (!frame) return null
  return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 74px)', gap: 8 } },
    frame.b.flatMap((row, r) => row.map((v, c) =>
      h('div', {
        key: `${r}-${c}`,
        style: {
          width: 74, height: 74, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: C2048[v] || '#3c3a32', color: v && v <= 4 ? '#776e65' : '#f9f6f2',
          fontSize: v >= 1024 ? 22 : v >= 128 ? 26 : 30, fontWeight: 700,
        },
      }, v || ''))))
}

function BoardSnake({ frame }) {
  if (!frame) return null
  const n = 12
  const occ = new Map(frame.snake.map((p, i) => [p[0] * n + p[1], i]))
  const food = frame.food ? frame.food[0] * n + frame.food[1] : -1
  return h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${n}, 26px)`, gap: 2, background: '#11151c', padding: 6, borderRadius: 8 } },
    Array.from({ length: n * n }, (_, i) => h('div', {
      key: i,
      style: {
        width: 26, height: 26, borderRadius: 4,
        background: occ.has(i) ? (occ.get(i) === 0 ? '#7fd4ff' : '#3a7fb5') : i === food ? '#ff5f6d' : '#1b2230',
      },
    })))
}

function BoardMines({ frame }) {
  if (!frame) return null
  const n = 9
  const rev = new Map(frame.rev.map(([i, v]) => [i, v]))
  const flags = new Set(frame.flags)
  const numColor = ['', '#7fd4ff', '#7ce38b', '#ffd166', '#ff9f6e', '#ff6b6b', '#e07bff', '#ffffff', '#cccccc']
  return h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${n}, 34px)`, gap: 3 } },
    Array.from({ length: n * n }, (_, i) => {
      if (rev.has(i)) {
        const v = rev.get(i)
        return h('div', {
          key: i,
          style: { width: 34, height: 34, borderRadius: 5, background: '#20262f', display: 'flex', alignItems: 'center', justifyContent: 'center', color: numColor[v] || '#ddd', fontWeight: 700, fontSize: 16 },
        }, v || '')
      }
      if (flags.has(i)) return h('div', { key: i, style: { width: 34, height: 34, borderRadius: 5, background: '#3a2026', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 } }, '🚩')
      return h('div', { key: i, style: { width: 34, height: 34, borderRadius: 5, background: '#39424e' } })
    }))
}

function Viewer({ live, idx }) {
  if (!live || !live.frames || !live.frames.length) {
    return h('div', { className: 'ab-muted', style: { padding: '18px 0' } }, '还没有对局。点上面让她玩一局，就能看现场。')
  }
  const f = live.frames[Math.min(idx, live.frames.length - 1)]
  const board = live.id === 'snake' ? h(BoardSnake, { frame: f }) : live.id === 'minesweeper' ? h(BoardMines, { frame: f }) : h(Board2048, { frame: f })
  return h('div', null, board)
}

return function Panel({ settings, save, toast }) {
  const [live, setLive] = useState(null)
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const timer = useRef(null)

  const refresh = async () => {
    try { const r = await call('/live'); setLive(r) } catch (e) { /* ignore */ }
  }

  useEffect(() => {
    refresh()
    timer.current = setInterval(refresh, 500)
    return () => clearInterval(timer.current)
  }, [])

  // 正在玩 → 跟着最新一帧；刚玩完 → 从头回放
  useEffect(() => {
    if (!live) return
    if (live.playing) setIdx(Math.max(0, (live.frames || []).length - 1))
    else if (live.frames && live.frames.length) {
      let i = 0
      const t = setInterval(() => {
        i += 1
        if (i >= live.frames.length - 1) { clearInterval(t); i = live.frames.length - 1 }
        setIdx(i)
      }, live.id === 'minesweeper' ? 120 : 40)
      return () => clearInterval(t)
    }
  }, [live && live.at])

  const play = async (game) => {
    setBusy(true)
    try {
      const r = await call('/play' + (game ? `?game=${game}` : ''))
      toast(`${r.title || '小游戏'}：${r.detail || ''}`)
      await refresh()
    } catch (e) { toast('没玩成：' + e.message) } finally { setBusy(false) }
  }

  const setEnabled = async (on) => {
    try {
      const r = await call('/enabled', { on })
      if (r?.ok) toast(on ? '她自己玩的开关开了' : '自动玩关了——还能手动叫她玩') 
      else toast(r?.message || '没切成功')
    } catch (e) { toast('出错了：' + (e.message || e)) }
  }

  const g = live && live.id
  const rec = (live && live.byGame && live.byGame[g]) || { plays: 0, wins: 0, best: 0 }

  return h('div', null,
    h(ui.Card, { title: '小游戏 · 看她玩', desc: '她自己定时玩；也可以点下面的按钮让她当场玩一局，这里能看现场。' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' } },
        h('button', {
          onClick: () => setEnabled(!(live && live.enabled)),
          style: {
            fontSize: 14, padding: '6px 16px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
            border: '1px solid ' + (live && live.enabled ? 'rgba(46,125,50,.5)' : 'rgba(128,128,128,.4)'),
            background: live && live.enabled ? 'rgba(46,125,50,.12)' : 'transparent',
            color: 'inherit',
          },
        }, live && live.enabled ? '⏸ 暂停她自己玩' : '▶ 让她自己玩'),
        h('span', { className: 'ab-small ab-muted', style: { flex: 1, minWidth: 180 } },
          live && live.enabled
            ? '开着——她会自己定时玩一局（输赢进心情）'
            : '关着——不自动玩，但随时可以手动叫她玩一局'),
      ),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 } },
        h(ui.Btn, { small: true, disabled: busy, onClick: () => play('2048') }, '玩 2048'),
        h(ui.Btn, { small: true, disabled: busy, onClick: () => play('snake') }, '玩贪吃蛇'),
        h(ui.Btn, { small: true, disabled: busy, onClick: () => play('minesweeper') }, '玩扫雷'),
        h(ui.Btn, { small: true, disabled: busy, onClick: () => play() }, '随便玩一局')),
      h('div', { className: 'ab-muted ab-small', style: { marginBottom: 10 } },
        live ? `${live.title || '—'} · ${live.playing ? '正在玩' : '上一局'} · 第 ${Math.min(idx + 1, (live.frames || []).length)} / ${(live.frames || []).length} 步 · 总共玩了 ${live.total} 局，赢 ${live.wins} 局` : '加载中…'),
      h(Viewer, { live, idx }),
      live && live.result ? h('div', { style: { marginTop: 12 } },
        h('b', null, live.result.won ? '赢了：' : '没赢：'), ' ', live.result.detail,
      ) : null),
    h(ui.Card, { title: '战绩', desc: '每个游戏单独记。' },
      h('div', { className: 'ab-muted' },
        Object.entries((live && live.byGame) || {}).map(([id, s]) =>
          h('div', { key: id, style: { marginBottom: 4 } }, `${id}：玩了 ${s.plays} 局，赢 ${s.wins} 局，最好 ${s.best} 分`)))),
  )
}

