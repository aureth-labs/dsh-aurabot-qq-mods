// panel.js —— 喂食面板 v3.2
// 上一版把文字颜色写死成 rgba(255,255,255,…)，面板是浅色主题时整块看不见。
// 这一版只用继承色 + 中性灰，浅色/深色主题都能读；数据全部来自 /status、/curve、/preview。
const { useState, useEffect, useMemo } = React;

const C = {
  muted: '#8a919e',
  faint: '#b6bcc7',
  line: 'rgba(120,130,150,.22)',
  box: 'rgba(120,130,150,.08)',
  accent: '#4f7cff',
  accentSoft: 'rgba(79,124,255,.10)',
  green: '#2f9e6b',
  amber: '#d68910',
  red: '#d9534f',
};

const PORTIONS = ['一小口', '半份', '一份', '管饱'];

const pad2 = (n) => (n < 10 ? '0' : '') + n;
const clock = (ts) => {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 饿度色：0 绿 → 100 红，浅底深底都够对比
function hungerColor(h) {
  const hue = 145 - clamp01(h / 100) * 145;
  return 'hsl(' + Math.round(hue) + ' 62% 42%)';
}

function untilText(hours) {
  if (!isFinite(hours) || hours <= 0) return '';
  const mins = Math.round(hours * 60);
  if (mins < 60) return mins + ' 分钟';
  return Math.floor(mins / 60) + ' 小时' + (mins % 60 ? ' ' + (mins % 60) + ' 分' : '');
}

function bar(pct, color, height) {
  return h('div', { style: { height: height || 6, borderRadius: 99, background: C.line, overflow: 'hidden' } },
    h('div', {
      style: {
        width: Math.max(0, Math.min(100, pct)) + '%',
        height: '100%', borderRadius: 99, background: color,
        transition: 'width .45s ease',
      },
    }));
}

if (!window.__feedPanelCss) {
  window.__feedPanelCss = true;
  try {
    const style = document.createElement('style');
    style.textContent = '.feed-panel button:focus-visible,.feed-panel input:focus-visible,.feed-panel select:focus-visible{outline:2px solid rgba(79,124,255,.55);outline-offset:1px}';
    document.head.appendChild(style);
  } catch (e) { /* 拿不到 document 就少一条焦点样式，不影响面板 */ }
}

function chip(label, active, onClick, extra) {
  return h('button', {
    type: 'button',
    onClick: onClick,
    style: Object.assign({
      padding: '5px 10px', borderRadius: 99, cursor: 'pointer',
      border: '1px solid ' + (active ? 'rgba(79,124,255,.65)' : C.line),
      background: active ? C.accentSoft : 'transparent',
      color: 'inherit', fontSize: 12, lineHeight: 1.45,
      transition: 'background .15s, border-color .15s',
    }, extra || {}),
  }, label);
}

function primaryBtn(label, onClick, disabled) {
  return h('button', {
    type: 'button', onClick: onClick, disabled: disabled,
    style: {
      width: '100%', padding: '10px 14px', borderRadius: 10, border: 'none',
      background: disabled ? 'rgba(120,130,150,.22)' : C.accent,
      color: disabled ? C.muted : '#fff', fontSize: 13.5, fontWeight: 600,
      cursor: disabled ? 'default' : 'pointer', transition: 'filter .15s',
    },
  }, label);
}

// 24 小时目标曲线 + 此刻的真实点
function chart(curve, st) {
  const W = 340, H = 136, PL = 26, PR = 8, PT = 10, PB = 20;
  const X = (t) => PL + (Math.max(0, Math.min(24, t)) / 24) * (W - PL - PR);
  const Y = (v) => PT + (1 - Math.max(0, Math.min(100, v)) / 100) * (H - PT - PB);
  const raw = (curve && curve.points) || [];
  const pts = raw.filter((p) => p && p.t <= 24).map((p) => ({ t: Number(p.t), v: Number(p.v) }));
  if (!pts.length) pts.push({ t: 0, v: 50 }, { t: 24, v: 50 });
  if (pts[pts.length - 1].t < 24) pts.push({ t: 24, v: pts[pts.length - 1].v });
  let d = '';
  for (let i = 0; i < pts.length; i++) {
    d += (i ? 'L' : 'M') + X(pts[i].t).toFixed(1) + ' ' + Y(pts[i].v).toFixed(1) + ' ';
  }
  const area = d + 'L' + X(24).toFixed(1) + ' ' + Y(0).toFixed(1) + ' L' + X(0).toFixed(1) + ' ' + Y(0).toFixed(1) + ' Z';
  const nowT = curve && curve.now != null ? curve.now : (st ? st.now : 0);
  const nowV = st ? st.hunger : (curve ? curve.hunger : 0);
  const hc = hungerColor(nowV);
  const markers = (st && st.mealsPlan) || (curve && curve.meals) || [];
  return h('svg', {
    viewBox: '0 0 ' + W + ' ' + H,
    style: { width: '100%', height: 'auto', display: 'block', overflow: 'visible' },
  },
    h('defs', null,
      h('linearGradient', { id: 'feedPanelFill', x1: '0', y1: '0', x2: '0', y2: '1' },
        h('stop', { offset: '0%', stopColor: hc, stopOpacity: 0.22 }),
        h('stop', { offset: '100%', stopColor: hc, stopOpacity: 0.01 }))),
    [0, 50, 100].map((v) => h('g', { key: 'g' + v },
      h('line', { x1: PL, y1: Y(v), x2: W - PR, y2: Y(v), stroke: C.line, strokeWidth: 0.6, strokeDasharray: v === 50 ? '3 4' : '' }),
      h('text', { x: 2, y: Y(v) + 3, fontSize: 8, fill: C.faint }, String(v)))),
    markers.map((m) => h('g', { key: 'meal-' + m.id },
      h('line', { x1: X(m.at), y1: PT, x2: X(m.at), y2: Y(0), stroke: C.line, strokeWidth: 0.8, strokeDasharray: '2 3' }),
      h('text', { x: X(m.at), y: PT + 1, fontSize: 8.5, fill: C.faint, textAnchor: 'middle' }, m.key ? m.key[0] : ''))),
    h('path', { d: area, fill: 'url(#feedPanelFill)' }),
    h('path', { d: d, fill: 'none', stroke: 'rgba(120,130,150,.75)', strokeWidth: 1.4, strokeLinejoin: 'round', strokeLinecap: 'round' }),
    h('line', { x1: X(nowT), y1: PT, x2: X(nowT), y2: Y(0), stroke: hc, strokeWidth: 0.8, strokeDasharray: '2 2', opacity: 0.55 }),
    h('circle', { cx: X(nowT), cy: Y(nowV), r: 4, fill: hc, stroke: '#fff', strokeWidth: 1.5 }),
    [0, 6, 12, 18, 24].map((t) => h('text', {
      key: 'x' + t, x: X(t), y: H - 6, fontSize: 8, fill: C.faint,
      textAnchor: t === 0 ? 'start' : t === 24 ? 'end' : 'middle',
    }, t + '时')));
}

function mealBox(m, rec, active) {
  const full = rec && rec.v != null ? Math.round(100 - rec.v) : null;
  return h('div', {
    key: m.id,
    style: {
      flex: '1 1 0', minWidth: 0, padding: '7px 8px', borderRadius: 9,
      background: active ? C.accentSoft : C.box,
      border: '1px solid ' + (active ? 'rgba(79,124,255,.45)' : 'transparent'),
    },
  },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 4, fontSize: 10.5, color: C.muted } },
      h('span', null, m.key), h('span', null, m.atText || '')),
    h('div', {
      style: { marginTop: 3, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      title: rec ? rec.food : '',
    }, rec ? rec.food : '还没吃'),
    h('div', { style: { fontSize: 10.5, color: rec ? C.muted : C.faint, marginTop: 2 } },
      rec ? ('饱食 ' + full + '%') : (active ? '就现在' : '—')));
}

return function Panel({ settings, toast }) {
  const [st, setSt] = useState(null);
  const [curve, setCurve] = useState(null);
  const [food, setFood] = useState('');
  const [flavor, setFlavor] = useState('');
  const [portion, setPortion] = useState('一份');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState(null);
  const alive = React.useRef(true);

  const load = async () => {
    try {
      const r = await Promise.all([call('/status'), call('/curve')]);
      if (!alive.current) return;
      if (r[0] && r[0].ok) setSt(r[0]);
      if (r[1] && r[1].ok) setCurve(r[1]);
    } catch (e) { /* 面板静默刷新，失败就等下一轮 */ }
  };

  useEffect(() => {
    alive.current = true;
    load();
    const timer = setInterval(load, 15000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    const name = food.trim();
    if (!name) { setPreview(null); return; }
    let dead = false;
    const timer = setTimeout(async () => {
      try {
        const r = await call('/preview', { food: name, flavor: flavor, portion: portion });
        if (!dead) setPreview(r && r.ok ? r : null);
      } catch (e) {
        if (!dead) setPreview(null);
      }
    }, 220);
    return () => { dead = true; clearTimeout(timer); };
  }, [food, flavor, portion, st && st.hunger]);

  const taste = useMemo(() => {
    const rows = [];
    String((settings && settings.taste) || '').split(/\r?\n/).forEach((line) => {
      const m = line.trim().match(/^(.+?)[:：](.+?)(?:=([\d.]+))?$/);
      if (!m) return;
      rows.push({ food: m[1].trim(), flavor: m[2].trim(), v: m[3] ? Number(m[3]) : 0.8 });
    });
    return rows.sort((a, b) => b.v - a.v).slice(0, 6);
  }, [settings && settings.taste]);

  const doFeed = async () => {
    const name = food.trim();
    if (!name || busy) return;
    setBusy(true);
    setSay(null);
    try {
      const r = await call('/feed', { food: name, flavor: flavor, portion: portion, source: '投喂', react: true });
      if (!r || !r.ok) {
        if (toast) toast((r && r.error) || '没喂成');
        return;
      }
      setSay({ text: r.say || '', gain: r.gain, before: r.before, after: r.hunger, food: name });
      if (toast) toast('喂了「' + name + '」，饱食 +' + r.gain);
      await load();
    } catch (e) {
      if (toast) toast('喂食失败：' + ((e && e.message) || e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (!st) {
    return h(ui.Card, { title: '喂食' },
      h('p', { className: 'ab-muted ab-small', style: { margin: 0 } }, '正在看她的状态…'));
  }

  const hc = hungerColor(st.hunger);
  const nm = st.nextMeal || {};
  const nextText = st.inMeal
    ? '正赶上' + (st.mealNow || '饭点') + '，可以喂一顿'
    : nm.key
      ? (nm.tomorrow ? '明天 ' + nm.key + ' ' + nm.atText : '下一顿 ' + nm.key + ' ' + nm.atText) + '（' + untilText(nm.in) + '后）'
      : '今天已经吃完了';
  const flavors = [''].concat(
    (((st.foods || []).find((f) => f.name === food) || {}).flavors || []),
    ['咸', '甜', '辣', '鲜', '酸']
  ).filter((v, i, arr) => arr.indexOf(v) === i);
  const tooFull = !!(preview && (preview.notes || []).some((n) => n.indexOf('吃不下') >= 0));
  const cravings = (st.cravings || []).slice(0, 3);
  const logs = (st.log || []).slice(0, 6);
  const stats = st.stats || { fed: 0, self: 0 };

  return h('div', { className: 'feed-panel', style: { display: 'grid', gap: 12, color: 'inherit' } },

    // —— 此刻 ——
    h(ui.Card, { title: '此刻的她' },
      h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
          h('span', {
            style: { fontSize: 44, fontWeight: 750, lineHeight: 1, color: hc, fontVariantNumeric: 'tabular-nums' },
          }, String(st.hunger)),
          h('span', { style: { fontSize: 12, color: C.muted, paddingBottom: 4 } }, '/100')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, paddingBottom: 4 } },
          h('span', {
            style: { fontSize: 14, fontWeight: 650, color: hc, display: 'inline-flex', alignItems: 'center', gap: 6 },
          },
            h('span', { style: { width: 7, height: 7, borderRadius: 99, background: hc, display: 'inline-block' } }),
            st.label),
          h('span', { style: { fontSize: 12, color: C.muted } },
            '饱食 ' + st.satiety + '% · 好感 ❤ ' + st.affection))),
      h('div', { style: { marginTop: 12 } }, bar(st.satiety, hc, 7)),
      h('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', gap: 10,
          marginTop: 9, fontSize: 11.5, color: C.muted, flexWrap: 'wrap',
        },
      },
        h('span', null, nextText),
        h('span', null, '今天被喂 ' + stats.fed + ' 次 · 自己吃 ' + stats.self + ' 次'))),

    // —— 一天的胃口 ——
    h(ui.Card, { title: '今天的胃口' },
      chart(curve, st),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 10 } },
        (st.mealsPlan || []).map((m) => mealBox(m, st.meals ? st.meals[m.id] : null, st.mealNow === m.key))),
      h('p', { className: 'ab-muted ab-small', style: { margin: '9px 0 0' } },
        '细线是按作息该饿到的位置，圆点是她此刻真实的样子；虚线是饭点。')),

    // —— 喂她 ——
    h(ui.Card, { title: '喂她' },
      cravings.length
        ? h('div', { style: { marginBottom: 9 } },
          h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 5 } }, '她现在馋：'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            cravings.map((c) => chip(
              '🔥 ' + c.food + (c.flavor ? '·' + c.flavor : '') + ' ' + c.want,
              food === c.food && flavor === (c.flavor || ''),
              () => { setFood(c.food); setFlavor(c.flavor || ''); setSay(null); }
            ))))
        : null,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 9 } },
        (st.favorites || []).map((f) => chip(
          f.name + (f.flavors[0] ? '·' + f.flavors[0] : ''),
          food === f.name && (!f.flavors[0] || flavor === f.flavors[0]),
          () => { setFood(f.name); setFlavor(f.flavors[0] || ''); setSay(null); }
        ))),
      h('div', { style: { display: 'flex', gap: 6 } },
        h('input', {
          className: 'ab-input',
          value: food,
          placeholder: '或手填别的吃的',
          list: 'feed-food-list',
          onChange: (e) => { setFood(e.target.value); setSay(null); },
          style: { flex: 1, minWidth: 0, padding: '7px 10px', fontSize: 13, boxSizing: 'border-box' },
        }),
        h('select', {
          className: 'ab-input',
          value: flavor,
          onChange: (e) => setFlavor(e.target.value),
          style: { width: 88, flex: 'none', padding: '7px 6px', fontSize: 12.5, boxSizing: 'border-box' },
        }, flavors.map((f) => h('option', { key: 'fl-' + f, value: f }, f || '口味'))),
        h('datalist', { id: 'feed-food-list' },
          (st.foods || []).map((f) => h('option', { key: 'fd-' + f.name, value: f.name })))),
      h('div', { style: { display: 'flex', gap: 5, marginTop: 8 } },
        PORTIONS.map((p) => chip(p, portion === p, () => setPortion(p), {
          flex: '1 1 0', padding: '6px 0', textAlign: 'center',
        }))),
      preview
        ? h('div', { style: { marginTop: 9, padding: '8px 10px', borderRadius: 9, background: C.box, fontSize: 12 } },
          h('div', null,
            h('span', { style: { color: C.muted } }, '现在 ' + preview.hunger + ' → '),
            h('span', { style: { fontWeight: 700, color: hungerColor(preview.hungerAfter) } }, String(preview.hungerAfter)),
            h('span', { style: { color: C.muted } }, '（饱食 +' + preview.gain + '）')),
          (preview.notes || []).length
            ? h('div', {
              style: { marginTop: 3, fontSize: 11.5, color: tooFull ? C.amber : C.muted, lineHeight: 1.5 },
            }, preview.notes.join(' · '))
            : null)
        : null,
      h('div', { style: { marginTop: 10 } },
        primaryBtn(
          busy ? '她在吃…' : (food.trim() ? '喂她吃「' + food.trim() + '」' : '先选点吃的'),
          doFeed,
          busy || !food.trim()
        )),
      say
        ? h('div', {
          style: {
            marginTop: 10, padding: '9px 11px', borderRadius: 10,
            background: C.accentSoft, borderLeft: '3px solid ' + C.accent,
          },
        },
          h('div', { style: { fontSize: 13, lineHeight: 1.55 } }, '她说：' + (say.text || '吃完了')),
          h('div', { style: { marginTop: 4, fontSize: 11, color: C.muted } },
            say.food + ' · 饱食 +' + say.gain + ' · ' + say.before + ' → ' + say.after))
        : null),

    // —— 最近吃过 ——
    h(ui.Card, { title: '最近吃过' },
      logs.length
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          logs.map((r) => h('div', { key: String(r.at) + r.food, style: { display: 'flex', alignItems: 'baseline', gap: 7 } },
            h('span', {
              style: { fontSize: 11, color: C.muted, width: 36, flex: 'none', fontVariantNumeric: 'tabular-nums' },
            }, clock(r.at)),
            h('span', {
              style: {
                fontSize: 10.5, padding: '1px 6px', borderRadius: 99, flex: 'none',
                background: r.source === '投喂' ? C.accentSoft : 'rgba(47,158,107,.12)',
                color: r.source === '投喂' ? C.accent : C.green,
              },
            }, r.source || '投喂'),
            h('span', {
              style: {
                flex: 1, minWidth: 0, fontSize: 12.5,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              },
            }, r.food + (r.flavor ? '·' + r.flavor : '') + ' ' + r.portion),
            h('span', {
              style: { fontSize: 11.5, color: C.muted, flex: 'none', fontVariantNumeric: 'tabular-nums' },
            }, '+' + Math.round(r.gain) + '  ' + Math.round(r.before) + '→' + Math.round(r.after)))))
        : h('p', { className: 'ab-muted ab-small', style: { margin: 0 } }, '今天还没吃过东西。')),

    // —— 她的味蕾 ——
    taste.length
      ? h(ui.Card, { title: '她的味蕾' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
          taste.map((t) => h('div', { key: t.food + '|' + t.flavor, style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { width: 96, flex: 'none', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
              t.food + '·' + t.flavor),
            h('span', { style: { flex: 1, minWidth: 0 } }, bar(t.v * 100, t.v >= 0.75 ? C.green : t.v >= 0.5 ? C.amber : C.muted, 5)),
            h('span', { style: { width: 30, flex: 'none', textAlign: 'right', fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' } },
              t.v.toFixed(2)))),
          h('p', { className: 'ab-muted ab-small', style: { margin: '2px 0 0' } }, '0 讨厌、1 最爱；喂的时候她会挑口味。')))
      : null,

    h('div', { style: { textAlign: 'center', fontSize: 10.5, color: C.faint } },
      '喂食 v' + (st.version || '3.2') + ' · 每 15 秒自己刷新'));
};
