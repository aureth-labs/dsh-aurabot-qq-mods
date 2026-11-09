// 桌宠（pet）面板：多开（再养几只）+ 每一只自己的名字 / 形象 / 大小 / 人格。
//
// ⚠⚠ 这个文件**不会被执行**（2026-11-06 实测确认，留着只作参考） ⚠⚠
//
// 起因：本来打算绕开改插件本体的 host.js（改它要重启整个 DSH），走「模块自带面板」这条路。
// 当时的依据是 core/modules.js 的 panelSource(id)：只认 source==='user' 且 def.panel 的模块，
// pet 正好都符合，看起来热重载就能生效。
//
// 但这只是**一半**的真相。真正决定它渲不渲染的是 client.js 里的这一行：
//     const hasUi = (m) => m.running === 'user' && !m.builtin
//                       && !TABS.some((t) => t.id === m.id)   // ← pet 在这一步就被排除
//                       && ((m.settings || []).length || m.panel)
// TABS 里有 `{ id: 'pet', label: '桌宠' }`，所以 pet 模块的 panel.js 和全部 settings
// **永远不会被渲染**；「桌宠」页加载的是写死在 client.js 里的 PetPanel 组件。
//
// 另外两条路也不通：
//   · 面板里 call('/x') 拼的是 /ext/pet/x，但 pet 在 mods 的 STABLE_ROUTES 里（不带 /ext 前缀），
//     且模块所有路由都要求 x-pet-token —— 浏览器里根本拿不到那个令牌（实测 401）。
//
// 结论：真正的 UI 在 client/client.js 的 PetExtraCards（2026-11-06 加）。本文件保留，
// 是因为它把「每只一张卡」的信息结构写清楚了，将来若宿主改了 hasUi 的判定，可以直接复活。
//
// 契约（原样记录）：整份源码在受限作用域里执行，拿到 React/h/ui/call/toast，
// 最后 return 一个组件函数。
//
// 这里渲染的东西分三块：
//   ① 「多养几只」——数量（与设置表单里那个 petExtraCount 是同一个值，两处都显示、互相同步）
//   ② 每一只一张卡——名字 / 形象包 / 大小 / 人格 / 要不要自己说话
//   ③ 这会儿在桌面上的——id + 实时坐标（诊断用）

return function PetPanel({ toast }) {
  const [stat, setStat] = React.useState(null)
  const [pets, setPets] = React.useState(null)   // /extra/pets：{ max, want, slots, packs, mainPack, mainScale, online }
  const [busy, setBusy] = React.useState('')
  const [openSlot, setOpenSlot] = React.useState(-1) // 哪一张卡的人格框是展开的

  const load = () => {
    call('/extra/status').then(setStat).catch((e) => toast(e.message, 'err'))
    call('/extra/pets').then(setPets).catch((e) => toast(e.message, 'err'))
  }
  React.useEffect(() => { load() }, [])

  const setCount = async (n) => {
    setBusy('count')
    try {
      const r = await call('/extra/count', { count: n })
      if (r.ok) {
        toast(n ? `现在一共 ${n + 1} 只` : '只留一只了', 'ok')
        setStat({ ...(stat || {}), want: n, have: (r.have ?? r.count) })
      } else {
        toast(r.message || '没改成', 'err')
      }
      load()
    } catch (e) { toast(e.message, 'err') }
    setBusy('')
  }

  /** 改一只的字段：只提交改到的那个键，别的三只原样不动。 */
  const patchSlot = async (slot, patch, okText) => {
    setBusy('slot-' + slot)
    try {
      const r = await call('/extra/pet', { slot, ...patch })
      if (!r.ok) { toast(r.message || '没存上', 'err'); return }
      setPets((p) => (p ? { ...p, slots: r.slots } : p))
      if (okText) toast(okText, 'ok')
    } catch (e) { toast(e.message, 'err') }
    setBusy('')
  }

  const cur = stat ? Number(stat.want || 0) : (pets ? Number(pets.want || 0) : 0)
  const have = stat ? Number(stat.have || 0) : 0
  const running = pets ? Boolean(pets.online) : (stat ? Boolean(stat.online) : false)
  const max = pets ? Number(pets.max || 4) : 4
  const slots = (pets && Array.isArray(pets.slots)) ? pets.slots : []
  const packList = (pets && Array.isArray(pets.packs)) ? pets.packs : []

  const card = { padding: '14px 16px', borderRadius: 12, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)', marginBottom: 12 }
  const muted = { opacity: 0.62, fontSize: 12, lineHeight: 1.7 }
  const subCard = { marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.07)' }
  const inputStyle = { width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,.16)', background: 'rgba(255,255,255,.06)', color: 'inherit', font: 'inherit', boxSizing: 'border-box' }
  const labelStyle = { ...muted, marginBottom: 4, display: 'block' }
  const rowStyle = { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }

  /** 形象包下拉：第一项是「跟随主宠物」，后面是真实扫到的包。 */
  const packOptions = [{ value: '', label: `跟随主宠物（${(pets && pets.mainPack) || '—'}）` }]
    .concat(packList.map((p) => ({ value: p.name, label: `${p.name}（${p.anims} 段动画）` })))

  /** 一只的卡。index 是槽位（0 起），只有 index < cur 的才真的在桌面上活着。 */
  const slotCard = (it, index) => {
    const alive = index < cur
    const name = String(it.name || '')
    const packName = String(it.pack || '')
    const scale = Number(it.scale) || 0
    const whisper = it.whisper !== false
    const persona = String(it.persona || '')
    const isOpen = openSlot === index
    const title = `第 ${index + 2} 只` + (name ? ` · ${name}` : '')
    const missing = packName && !packList.some((p) => p.name === packName)

    return h('div', { key: index, style: { ...subCard, opacity: alive ? 1 : 0.55 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, title),
        !alive ? h('div', { style: { ...muted, color: 'rgba(255,190,120,.85)' } }, '（没在桌面上，先把上面数量调大）') : null,
        h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: muted }, '自己说话'),
          h('button', {
            type: 'button',
            disabled: busy === 'slot-' + index,
            onClick: () => patchSlot(index, { whisper: !whisper }),
            title: '关掉之后这只不出声，只做动作',
            style: {
              width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
              background: whisper ? 'rgba(120,170,255,.85)' : 'rgba(255,255,255,.18)',
              position: 'relative', padding: 0,
            },
          }, h('span', {
            style: {
              position: 'absolute', top: 3, left: whisper ? 21 : 3, width: 16, height: 16, borderRadius: 8,
              background: '#fff', transition: 'left .15s',
            },
          })),
        ),
      ),

      h('div', { style: rowStyle },
        h('div', { style: { flex: '1 1 140px', minWidth: 120 } },
          h('label', { style: labelStyle }, '名字（气泡标签 / 自言自语里的自称）'),
          h('input', {
            style: inputStyle, value: name, placeholder: `留空 = 第 ${index + 2} 只`,
            onChange: (e) => {
              const v = e.target.value
              setPets((p) => (p ? { ...p, slots: p.slots.map((s, i) => (i === index ? { ...s, name: v } : s)) } : p))
            },
            onBlur: (e) => patchSlot(index, { name: e.target.value }),
          }),
        ),
        // 形象包：每只可以不一样（各自绑一个 packs/ 里的包）
        h('div', { style: { flex: '1 1 200px', minWidth: 160 } },
          h('label', { style: labelStyle }, '形象包'),
          h('select', {
            style: inputStyle,
            value: packName,
            disabled: busy === 'slot-' + index,
            onChange: (e) => patchSlot(index, { pack: e.target.value }, '形象换好了'),
          },
            ...packOptions.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
            // 选了一个已经不存在的包：保留它，别让下拉静默跳到「跟随主宠物」
            missing ? h('option', { key: '__missing', value: packName }, `${packName}（找不到这个包）`) : null,
          ),
          missing ? h('div', { style: { ...muted, color: 'rgba(255,150,150,.9)' } }, '这个包不在 packs/ 里了，暂时按跟随主宠物显示') : null,
        ),
        // 大小：0 = 跟随主宠物
        h('div', { style: { flex: '0 0 150px' } },
          h('label', { style: labelStyle }, `大小（0 = 跟随主宠物${pets && pets.mainScale ? ' ' + pets.mainScale + '×' : ''}）`),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'range', min: 0, max: 2, step: 0.05,
              value: scale,
              style: { flex: 1 },
              onChange: (e) => {
                const v = Number(e.target.value)
                setPets((p) => (p ? { ...p, slots: p.slots.map((s, i) => (i === index ? { ...s, scale: v } : s)) } : p))
              },
              onMouseUp: (e) => patchSlot(index, { scale: Number(e.target.value) }),
              onTouchEnd: (e) => patchSlot(index, { scale: Number(e.target.value) }),
            }),
            h('span', { style: { ...muted, minWidth: 34, textAlign: 'right' } }, scale > 0 ? `${scale.toFixed(2)}×` : '跟随'),
          ),
        ),
      ),

      // 人格：折叠起来，免得四只一起展开把面板拉得很长
      h('div', { style: { marginTop: 8 } },
        h('button', {
          type: 'button',
          onClick: () => setOpenSlot(isOpen ? -1 : index),
          style: {
            border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
            padding: 0, font: 'inherit', ...muted, fontSize: 12,
          },
        }, (isOpen ? '▾ ' : '▸ ') + '人格设定' + (persona.trim() ? `（已填 ${persona.trim().length} 字）` : '（留空 = 跟随全局人格）')),
        isOpen
          ? h('div', { style: { marginTop: 6 } },
              h('textarea', {
                style: { ...inputStyle, minHeight: 96, resize: 'vertical', lineHeight: 1.6 },
                value: persona,
                placeholder: '这一只自己的性格与说话方式。只写正文：名字和时间由程序自动加上，不要在这里重复。留空就用全局人格。',
                onChange: (e) => {
                  const v = e.target.value
                  setPets((p) => (p ? { ...p, slots: p.slots.map((s, i) => (i === index ? { ...s, persona: v } : s)) } : p))
                },
              }),
              h('div', { style: { marginTop: 6, display: 'flex', gap: 8 } },
                h('button', {
                  type: 'button',
                  disabled: busy === 'slot-' + index,
                  onClick: () => patchSlot(index, { persona }, '人格存好了，下次开口就用它'),
                  style: {
                    padding: '6px 14px', borderRadius: 8, cursor: 'pointer', font: 'inherit',
                    border: '1px solid rgba(120,170,255,.85)', background: 'rgba(120,170,255,.20)', color: 'inherit',
                  },
                }, '保存人格'),
                h('span', { style: { ...muted, alignSelf: 'center' } }, '只影响她自言自语，不改主宠物'),
              ),
            )
          : null,
      ),
    )
  }

  return h('div', null,
    // ① 数量
    h('div', { style: { ...card } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
        h('div', { style: { fontSize: 14, fontWeight: 600 } }, '多养几只'),
        h('div', { style: { ...muted, marginLeft: 'auto' } },
          running ? `桌宠在线 · 现在 ${have + 1} 只` : '桌宠没在线'),
      ),
      h('div', { style: { ...muted, marginBottom: 12 } },
        '额外那几只也会被拖着走、能甩出去、互相会撞，并且可以各自绑形象、各自有人格、各自定时碎碎念。',
        h('br'),
        '改完立刻生效；重启客户端 / DSH 后按这里的数量恢复。',
      ),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        Array.from({ length: max + 1 }, (_, n) => n).map((n) =>
          h('button', {
            key: n,
            disabled: busy === 'count' || !running,
            onClick: () => setCount(n),
            style: {
              minWidth: 64, padding: '8px 14px', borderRadius: 9, cursor: running ? 'pointer' : 'not-allowed',
              border: cur === n ? '1px solid rgba(120,170,255,.85)' : '1px solid rgba(255,255,255,.16)',
              background: cur === n ? 'rgba(120,170,255,.20)' : 'rgba(255,255,255,.06)',
              color: 'inherit', font: 'inherit',
            },
          }, n === 0 ? '只留一只' : `再养 ${n} 只`),
        ),
      ),
      !running ? h('div', { style: { ...muted, marginTop: 10, color: 'rgba(255,150,150,.9)' } }, '桌宠没在线，先在上面「启动桌宠」。') : null,
    ),

    // ② 每一只
    h('div', { style: { ...card } },
      h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '每一只'),
      h('div', { style: { ...muted, marginBottom: 10 } },
        '按位置认人：第几只就是第几只，换形象或改名字都原地生效，不会把她关掉再开一个。',
        h('br'),
        '「自己说话」关掉的那几只只做动作、不出声，也不费模型调用。',
      ),
      ...slots.map((it, i) => slotCard(it, i)),
      !slots.length ? h('div', { style: muted }, '正在读槽位…') : null,
    ),

    // ③ 在桌面上的（诊断）
    stat && Array.isArray(stat.list) && stat.list.length
      ? h('div', { style: { ...card } },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '这会儿在桌面上的'),
          ...stat.list.map((p) =>
            h('div', { key: p.id, style: { ...muted, fontFamily: 'monospace', fontSize: 12 } },
              `${p.id}  ${p.pack ? p.pack : '跟随主宠物'}  ${p.scale ? p.scale.toFixed(2) + '×' : ''}` +
              `  x=${p.bounds ? p.bounds.x : '?'}  y=${p.bounds ? p.bounds.y : '?'}` +
              (p.flying ? '  （正在飞）' : ''),
            ),
          ),
        )
      : null,
  )
}
