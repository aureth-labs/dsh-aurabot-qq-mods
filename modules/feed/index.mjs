// 喂食 v3：按作息走的一天（起床饿 → 吃饭饱 → 干活更饿），会自己找零食并反馈
// v3.1 补丁：+ 心情联动（mood.nudge）+ 记得吃（memory.addEvent）+ 好感度计数器
// 数据：modules-data/feed/state.json
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  foods: [
    '白米饭',
    '奶茶:甜',
    '豆腐脑:咸,甜',
    '火锅:辣',
    '面条:咸鲜',
    '小蛋糕:甜',
    '苹果',
    '烤红薯',
    '薯片',
    '冰淇淋:甜',
  ].join('\n'),
  favorites: ['豆腐脑:咸', '白米饭', '奶茶:甜', '小蛋糕:甜'].join('\n'),
  taste: [
    '豆腐脑:咸=0.95',
    '豆腐脑:甜=0.25',
    '火锅:辣=0.9',
    '奶茶:甜=0.85',
    '小蛋糕:甜=0.7',
    '冰淇淋:甜=0.8',
  ].join('\n'),
  mealTimes: '06:30, 11:40, 17:40',
  hungerRate: 3,
  activityGain: 0.35,
  mealBoost: 2.4,
  sleepSlow: 0.25,
  snackIdleHours: 3,
  canFeed: true,
  mealBump: true,
  selfSnack: true,
  snackAt: 62,
  proactive: true,
  proactiveAt: 85,
};

const PORTIONS = [
  { name: '一小口', mult: 0.15 },
  { name: '半份', mult: 0.5 },
  { name: '一份', mult: 1 },
  { name: '管饱', mult: 1.6 },
];

const SATIETY = [
  [/火锅|烧烤|烤肉/, 55],
  [/炸鸡|汉堡|披萨|薯条/, 48],
  [/饺子|包子|馄饨|烧麦/, 42],
  [/米饭|盖饭|炒饭|便当/, 45],
  [/面|粉|粥|汤/, 38],
  [/蛋糕|甜点|布丁|冰淇淋|雪糕/, 16],
  [/奶茶|奶盖/, 14],
  [/可乐|汽水|饮料|果汁/, 12],
  [/薯片|零食|饼干|辣条/, 12],
  [/苹果|香蕉|水果|葡萄|草莓|西瓜/, 10],
  [/红薯|玉米|土豆/, 25],
  [/豆腐/, 22],
  [/菜|肉|鱼|虾|鸡/, 40],
];

const SNACKS = ['薯片', '小蛋糕', '奶茶', '苹果', '烤红薯', '冰淇淋', '饼干', '瓜子'];
const FOOD_HINTS = [
  '火锅', '烧烤', '奶茶', '蛋糕', '豆腐脑', '面条', '米饭', '饺子', '包子',
  '炸鸡', '汉堡', '寿司', '螺蛳粉', '麻辣烫', '冰淇淋', '西瓜', '葡萄',
  '草莓', '薯片', '可乐', '咖啡', '粥', '汤', '苹果', '烤红薯', '披萨',
  '馄饨', '关东煮', '糖葫芦', '鸡腿', '玉米',
];

// 三顿饭的默认时间；实际时间每次读设置里的「饭点」，改了马上生效
const MEAL_DEFS = [
  { id: 'breakfast', key: '早餐', fallback: 6.5 },
  { id: 'lunch', key: '午餐', fallback: 11.667 },
  { id: 'dinner', key: '晚餐', fallback: 17.667 },
];

function parseMealTimes(text) {
  const out = [];
  for (const part of String(text || '').split(/[,，;；、\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,2})[:：](\d{1,2})$/);
    if (!m) continue;
    const h = Number(m[1]) + Number(m[2]) / 60;
    if (h >= 0 && h < 24) out.push(h);
  }
  return out;
}

export default {
  id: 'feed',
  name: '喂食',
  version: '3.2.0',
  api: 1,
  description: '按作息饿：起床饿、饭后饱、干活更饿；会自己找零食并跟你说；吃了会开心、会记得',
  tab: 'persona',
  panel: 'panel.js',
  defaults: DEFAULTS,
  settings: [
    { key: 'foods', label: '食物清单（食物:口味1,口味2）', type: 'textarea', hint: '一行一个；冒号后面写口味，用逗号隔开。' },
    { key: 'favorites', label: '她爱吃的（食物:偏爱口味）', type: 'textarea', hint: '面板会把这些做成快捷按钮，点一下就能喂。' },
    { key: 'taste', label: '味蕾偏好（食物:口味=0~1）', type: 'textarea', hint: '0=讨厌，1=最爱；没写的按 0.45 算。' },
    { key: 'mealTimes', label: '饭点', type: 'text', placeholder: '06:30, 11:20, 17:30', hint: '早/午/晚三个时间，逗号隔开；曲线和「该吃了」都按它算。' },
    { key: 'activityGain', label: '干活/聊天让她更饿的权重', type: 'number', min: 0, max: 2, step: 0.05 },
    { key: 'snackIdleHours', label: '多久没聊会想吃零食（小时）', type: 'number', min: 0, max: 24, step: 0.5 },
    { key: 'canFeed', label: '允许投喂', type: 'switch' },
    { key: 'mealBump', label: '到点没吃会更饿', type: 'switch' },
    { key: 'selfSnack', label: '饿了会自己找零食吃', type: 'switch' },
    { key: 'snackAt', label: '自己去吃零食的饿度', type: 'number', min: 0, max: 100, step: 1 },
    { key: 'proactive', label: '饿极了主动喊饿', type: 'switch' },
    { key: 'proactiveAt', label: '主动喊饿的阈值', type: 'number', min: 0, max: 100, step: 1 },
  ],

  setup(api) {
    const log = (...a) => {
      try { api.log?.info?.(...a); } catch { /* ignore */ }
    };

    const dir = api.dataDir();
    const file = path.join(dir, 'state.json');

    let st = load();
    let lastSave = 0;

    function settings() {
      return { ...DEFAULTS, ...(api.settings() || {}) };
    }

    function seedRand(seed) {
      let h = 2166136261;
      const s = String(seed);
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return () => {
        h = Math.imul(h ^ (h >>> 15), 2246822507);
        h ^= h >>> 13;
        return ((h >>> 0) % 10000) / 10000;
      };
    }

    function migrate() {
      const MK = { 早餐: 'breakfast', 午餐: 'lunch', 晚餐: 'dinner' };
      if (st && st.meals) {
        for (const k of Object.keys(MK)) if (st.meals[k]) { st.meals[MK[k]] = st.meals[k]; delete st.meals[k]; }
      }
      const raw = ((api.config() || {}).ext || {})[api.id] || {};
      if (!raw.foods || String(raw.foods).includes(':')) return;
      api.saveSettings({ foods: DEFAULTS.foods, favorites: DEFAULTS.favorites, taste: DEFAULTS.taste });
      log('设置从 v1 升级到 v2（食物带口味、味蕾偏好）');
    }

    function load() {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
          v: Number(raw.v) || 0,
          hunger: clamp(Number(raw.hunger ?? 30), 0, 100),
          lastTick: Number(raw.lastTick) || Date.now(),
          lastEat: Number(raw.lastEat) || 0,
          lastSnack: Number(raw.lastSnack) || 0,
          log: Array.isArray(raw.log) ? raw.log.filter((r) => r && r.gain != null).slice(-40) : [],
          cravings: Array.isArray(raw.cravings) ? raw.cravings : [],
          tasted: raw.tasted && typeof raw.tasted === 'object' ? raw.tasted : {},
          fired: raw.fired && typeof raw.fired === 'object' ? raw.fired : {},
          plan: raw.plan || null,
          meals: raw.meals || null,
          act: raw.act || null,
          lastProactive: Number(raw.lastProactive) || 0,
          lastActiveAt: Number(raw.lastActiveAt) || 0,
          justAte: raw.justAte || null,
          affection: Number(raw.affection) || 0,
        };
      } catch {
        return {
          v: 3, hunger: 30, lastTick: Date.now(), lastEat: 0, lastSnack: 0, log: [],
          cravings: [], tasted: {}, fired: {}, plan: null, meals: null, act: null,
          lastProactive: 0, lastActiveAt: 0, justAte: null, affection: 0,
        };
      }
    }

    function save(force = false) {
      const now = Date.now();
      if (!force && now - lastSave < 30_000) return;
      lastSave = now;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(st, null, 2));
      } catch (e) {
        log('保存失败：' + e.message);
      }
    }

    // ---------- 解析设置 ----------
    function parseFoods(text) {
      return String(text || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, fl] = line.split(/[:：]/);
          const flavors = fl
            ? fl.split(/[,，、/]/).map((x) => x.trim()).filter(Boolean)
            : [];
          return { name: String(name || '').trim(), flavors };
        })
        .filter((f) => f.name);
    }

    function parseTaste(text) {
      const map = {};
      String(text || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((line) => {
          const m = line.match(/^(.+?)[:：](.+?)(?:=([\d.]+))?$/);
          if (!m) return;
          map[m[1].trim() + '|' + m[2].trim()] = m[3] ? Number(m[3]) : 0.8;
        });
      return map;
    }

    function foods() { return parseFoods(settings().foods); }
    function favs() { return parseFoods(settings().favorites); }
    function tasteMap() { return parseTaste(settings().taste); }

    function flavorsOf(food) {
      const f = foods().find((x) => x.name === food);
      return f ? f.flavors : [];
    }

    function tasteOf(food, flavor) {
      const t = tasteMap();
      const k = food + '|' + flavor;
      if (t[k] != null) return Number(t[k]);
      if (!flavor) return 0.6;
      const fav = favs().find((f) => f.name === food);
      if (fav && fav.flavors[0] === flavor) return 0.85;
      return 0.45;
    }

    function preferredFlavor(food) {
      const fav = favs().find((f) => f.name === food);
      if (fav && fav.flavors[0]) return fav.flavors[0];
      const t = tasteMap();
      let best = null;
      let bestV = -1;
      for (const [k, v] of Object.entries(t)) {
        const [f, fl] = k.split('|');
        if (f === food && v > bestV) { best = fl; bestV = v; }
      }
      return best;
    }

    function satietyOf(food) {
      const name = String(food || '');
      for (const [re, v] of SATIETY) if (re.test(name)) return v;
      return 32;
    }

    // ---------- 时间 ----------
    function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

    function ymd(d = new Date()) {
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    function hh(d = new Date()) { return d.getHours() + d.getMinutes() / 60; }

    // 当前生效的三餐（读设置，改完不用重载）
    function meals() {
      const times = parseMealTimes(settings().mealTimes);
      return MEAL_DEFS.map((d, i) => {
        const at = times[i] != null ? times[i] : d.fallback;
        return { ...d, at, from: at - 1, to: at + 3 };
      });
    }

    function hhmm(v) {
      let mins = Math.round((((v % 24) + 24) % 24) * 60);
      mins = ((mins % 1440) + 1440) % 1440;
      return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
    }

    function mealAt(h) {
      return meals().find((m) => h >= m.from && h < m.to) || null;
    }

    function nextMeal(h) {
      const M = meals();
      for (const m of M) if (m.at > h) return m;
      return { ...M[0], at: M[0].at + 24 };
    }

    // ---------- 每日计划 ----------
    function plan() {
      const day = ymd();
      if (!st.plan || st.plan.date !== day) {
        const r1 = seedRand(day + ':A');
        const r2 = seedRand(day + ':B');
        const r3 = seedRand(day + ':C');
        const r4 = seedRand(day + ':D');
        st.plan = {
          date: day,
          A: 50 + r1() * 20,   // 早上刚醒的饿度 50~70
          seedB: r2(),          // 中午 50~70 起，干活加成后到 80
          seedC: r3(),
          D: 35 + r4() * 15,    // 睡前 35~50
        };
        log('今天的基础饥饿：起床 ' + Math.round(st.plan.A) + '，睡前 ' + Math.round(st.plan.D));
      }
      return st.plan;
    }

    function actToday() {
      const day = ymd();
      if (!st.act || st.act.date !== day) st.act = { date: day, morning: 0, afternoon: 0, evening: 0 };
      return st.act;
    }

    function mealsToday() {
      const day = ymd();
      if (!st.meals || st.meals.date !== day) {
        st.meals = { date: day, breakfast: null, lunch: null, dinner: null };
      }
      return st.meals;
    }

    function bumpAct(h) {
      const a = actToday();
      const M = meals();
      if (h < M[1].at) a.morning += 1;
      else if (h < M[2].at) a.afternoon += 1;
      else a.evening += 1;
    }

    // 一天里「此刻应该多饿」：饭点前是峰值，吃完掉下去，再慢慢涨回来
    function curvePoints(now = Date.now()) {
      const p = plan();
      const m = mealsToday();
      const a = actToday();
      const M = meals();
      let B = clamp(50 + p.seedB * 20 + Math.min(10, a.morning * 0.6), 50, 80);
      let C = clamp(50 + p.seedC * 20 + Math.min(10, a.afternoon * 0.6), 50, 80);
      const pts = [
        { t: 0, v: p.D },
        { t: 6, v: p.A },
      ];
      if (!m.breakfast) B = Math.max(B, p.A + 10);
      C = Math.max(C, B);
      const bf = m.breakfast;
      if (bf) {
        pts.push({ t: bf.t - 0.01, v: Math.min(85, p.A + 8) });
        pts.push({ t: bf.t, v: bf.v });
      } else {
        pts.push({ t: 9, v: Math.min(85, p.A + 10) });
      }
      if (m.lunch) {
        if (m.lunch.t > M[1].at) pts.push({ t: M[1].at, v: B });
        pts.push({ t: m.lunch.t - 0.01, v: B });
        pts.push({ t: m.lunch.t, v: m.lunch.v });
      } else {
        pts.push({ t: M[1].at, v: B });
      }
      if (m.dinner) {
        if (m.dinner.t > M[2].at) pts.push({ t: M[2].at, v: C });
        pts.push({ t: m.dinner.t - 0.01, v: C });
        pts.push({ t: m.dinner.t, v: m.dinner.v });
      } else {
        pts.push({ t: M[2].at, v: C });
        pts.push({ t: 20.5, v: Math.min(88, C + 8) });
      }
      pts.push({ t: 23.5, v: p.D });
      pts.push({ t: 30, v: p.A });
      return pts.sort((x, y) => x.t - y.t);
    }

    function targetAt(hour) {
      const pts = curvePoints();
      let prev = pts[0];
      for (const p of pts) {
        if (p.t <= hour) { prev = p; continue; }
        const span = p.t - prev.t || 1;
        const k = (hour - prev.t) / span;
        return prev.v + (p.v - prev.v) * k;
      }
      return pts[pts.length - 1].v;
    }

    function tick() {
      const now = Date.now();
      const dtH = Math.max(0, now - (st.lastTick || now)) / 3600_000;
      st.lastTick = now;
      plan();
      const target = targetAt(hh(new Date(now)));
      const diff = target - st.hunger;
      const maxStep = 12 * Math.min(dtH, 6);
      if (Math.abs(diff) <= 1.5) st.hunger = target;
      else st.hunger = clamp(st.hunger + Math.sign(diff) * Math.min(Math.abs(diff), maxStep), 0, 100);

      if (settings().mealBump) {
        const h = hh();
        for (const m of meals()) {
          if (h >= m.at && h < m.at + 2.5) {
            const key = ymd() + '|' + m.key;
            if (!st.fired[key] && now - (st.lastEat || 0) > 3 * 3600_000) {
              st.fired[key] = now;
              st.hunger = clamp(st.hunger + 5, 0, 100);
              log('到' + m.key + '点还没吃，更饿了');
            }
          }
        }
      }
      const today = ymd();
      for (const k of Object.keys(st.fired)) if (!k.startsWith(today)) delete st.fired[k];
      refreshCravings();
      save();
      return st.hunger;
    }

    function labelOf(h) {
      if (h >= 88) return '饿扁了';
      if (h >= 72) return '很饿';
      if (h >= 55) return '有点饿';
      if (h >= 40) return '还行';
      if (h >= 22) return '不太饿';
      return '刚吃饱';
    }

    // ---------- 馋 ----------
    function craLine() {
      return st.cravings
        .filter((c) => c.want >= 12)
        .slice(0, 3)
        .map((c) => c.food + (c.flavor ? '（' + c.flavor + '）' : '') + '·' + Math.round(c.want));
    }

    function addCraving(food, flavor, want, note) {
      if (!food) return null;
      const same = st.cravings.find((c) => c.food === food && (c.flavor || '') === (flavor || ''));
      if (same) {
        same.want = clamp(Math.max(same.want, want || 60), 0, 100);
        same.at = Date.now();
        return same;
      }
      const c = { food, flavor: flavor || '', want: clamp(want || 60, 0, 100), note: note || '', at: Date.now() };
      st.cravings.push(c);
      if (st.cravings.length > 8) st.cravings = st.cravings.slice(-8);
      return c;
    }

    function dropCraving(food) {
      const before = st.cravings.length;
      st.cravings = st.cravings.filter((c) => c.food !== food);
      return before !== st.cravings.length;
    }

    function refreshCravings() {
      const h = st.hunger;
      if (h >= 55) {
        const have = st.cravings.filter((c) => favs().some((f) => f.name === c.food));
        if (have.length === 0) {
          const pool = favs().length ? favs() : foods();
          const pick = pool[Math.floor(Math.random() * pool.length)];
          if (pick) {
            addCraving(pick.name, pick.flavors[0] || preferredFlavor(pick.name) || '',
              clamp(45 + h * 0.45, 0, 96), '饿了');
          }
        }
      }
      const idleH = st.lastActiveAt ? (Date.now() - st.lastActiveAt) / 3600_000 : 0;
      if (idleH >= (Number(settings().snackIdleHours) || 3) && h >= 32) {
        const hasSnack = st.cravings.some((c) => /无聊|零食/.test(c.note || ''));
        if (!hasSnack) {
          const f = SNACKS[Math.floor(Math.random() * SNACKS.length)];
          addCraving(f, flavorsOf(f)[0] || '', 40, '无聊想吃点零食');
        }
      }
      for (const c of st.cravings) c.want -= 0.02;
      st.cravings = st.cravings.filter((c) => c.want >= 10);
    }

    // ---------- 吃 ----------
    function portionOf(name) {
      return PORTIONS.find((p) => p.name === name) || PORTIONS[2];
    }

    function estimate(food, flavor, portion) {
      const p = portionOf(portion);
      let gain = satietyOf(food) * p.mult;
      const pref = tasteOf(food, flavor);
      const notes = [];
      if (flavor) {
        if (pref >= 0.8) { gain *= 1.1; notes.push('口味正合她意'); }
        else if (pref < 0.4) { gain *= 0.55; notes.push('口味不太对，她本来想吃' + (preferredFlavor(food) || '别的口味')); }
      }
      const crave = st.cravings.find((c) => c.food === food);
      if (crave) { gain *= 1.12; notes.push('正好是她馋的那口'); }
      if (st.hunger < 15) { gain *= 0.5; notes.push('她还不饿，吃不下这么多'); }
      gain = Math.round(gain);
      // 快见底时吃不下整份：按实际能降下的算，别报虚数
      const usable = Math.round(clamp(gain, 0, st.hunger));
      return {
        gain: usable,
        hungerAfter: Math.round(clamp(st.hunger - usable, 0, 100)),
        satietyAfter: Math.round(100 - clamp(st.hunger - usable, 0, 100)),
        notes,
        base: satietyOf(food),
        mult: p.mult,
        pref: Math.round(pref * 100) / 100,
      };
    }

    function feed({ food, flavor, portion, source }) {
      tick();
      if (!settings().canFeed) return { ok: false, error: '投喂关着' };
      const name = String(food || '').trim();
      if (!name) return { ok: false, error: '没说要吃什么' };
      const p = portionOf(portion);
      const fl = String(flavor || '').trim();
      const est = estimate(name, fl, p.name);
      const before = Math.round(st.hunger);
      st.hunger = est.hungerAfter;
      st.lastEat = Date.now();
      st.lastActiveAt = Date.now();
      if (est.gain > 0) dropCraving(name);
      const key = name + '|' + fl;
      st.tasted[key] = (Number(st.tasted[key]) || 0) + 1;

      // 落在饭点窗口里的一顿，记进今天的曲线（吃完这一段就饱了）
      const h = hh();
      const slot = mealAt(h);
      const notes = est.notes.slice();
      // 正餐吃到一份以上：按作息落到 5-15（早饭）/ 0-4（午晚饭）
      if (slot && p.mult >= 1) {
        const floor = slot.id === 'breakfast' ? Math.round(5 + Math.random() * 10) : Math.round(Math.random() * 4);
        if (st.hunger > floor) {
          st.hunger = floor;
          notes.push('正赶上' + slot.key + '，吃完刚刚好');
        }
      }
      const after = Math.round(st.hunger);
      // 真正吃进去的饱食 = 吃之前 - 吃之后（饭点落地、见底截断都算清楚）
      const actual = Math.max(0, before - after);
      const mt = mealsToday();
      if (slot && !mt[slot.id]) {
        mt[slot.id] = { t: h, v: after, at: Date.now(), food: name, portion: p.name };
        log('记下' + slot.key + '：' + name + ' 之后饥饿 ' + after);
      }

      const rec = {
        at: Date.now(), food: name, flavor: fl, portion: p.name,
        gain: actual, before, after,
        source: source || '投喂', note: notes.join('；'),
      };
      st.log.push(rec);
      if (st.log.length > 40) st.log = st.log.slice(-40);
      st.justAte = { food: name, flavor: fl, at: rec.at };
      save(true);
      log('吃了：' + name + (fl ? '(' + fl + ')' : '') + ' ' + p.name + ' +' + actual + ' → ' + after);

      // ===== v3.1 补丁：心情联动 + 记得吃 + 好感度 =====
      try {
        const src = source === '自己吃' ? '自己吃' : '投喂';
        const label = name + (fl ? '（' + fl + '）' : '');
        const mood = api.use('mood');
        if (mood && typeof mood.nudge === 'function') {
          mood.nudge(src === '投喂' ? 8 : 5, (src === '投喂' ? '哥哥喂了' : '自己吃了') + label);
        }
        const memory = api.use('memory');
        if (memory && typeof memory.addEvent === 'function') {
          memory.addEvent({
            text: (src === '投喂' ? '吃了哥哥喂的' : '自己吃了') + label,
            importance: src === '投喂' ? 0.5 : 0.35,
          });
        }
        if (src === '投喂') {
          st.affection = (Number(st.affection) || 0) + 1;
          save(true);
        }
      } catch (e) {
        log('心情/记忆联动失败：' + e.message);
      }
      // ===== 补丁结束 =====

      return {
        ok: true, gain: actual, estimated: est.gain, notes,
        base: est.base, mult: est.mult, pref: est.pref,
        before, hunger: after, hungerAfter: after, satiety: 100 - after,
        slot: slot ? slot.key : null, record: rec,
      };
    }

    // ---------- 上下文 / 规则 ----------
    function contextText() {
      tick();
      const h = Math.round(st.hunger);
      const mi = mealAt(hh());
      const nm = nextMeal(hh());
      let mealNote = mi ? '，正赶上' + mi.key + '时间' : '';
      if (!mi) {
        const left = nm.at - hh();
        if (left > 0 && left <= 1) mealNote = '，快到' + nm.key + '时间了';
      }
      const cs = craLine();
      const craveNote = cs.length ? '；现在馋：' + cs.join('、') : '';
      const fav = favs();
      const tasteNote = fav.length
        ? '；口味偏好：' + fav.slice(0, 4).map((f) => f.name + (f.flavors[0] ? '要' + f.flavors[0] : '')).join('、')
        : '';
      let ateNote = '';
      if (st.justAte && Date.now() - st.justAte.at < 2 * 3600_000) {
        ateNote = '；刚才吃了' + st.justAte.food + (st.justAte.flavor ? '（' + st.justAte.flavor + '）' : '');
      }
      let hint;
      if (h >= 80) hint = '你饿得挺厉害，可以主动插一句「我饿了，想吃…」，但别每条都说';
      else if (h >= 55) hint = '你有点饿，可以在回他的话里顺口提一句想吃什么，一句就够';
      else hint = '你现在挺饱，别自己提吃的事；他喂你就按口味真实反应';
      return '【喂食·此刻】饥饿 ' + h + '/100（' + labelOf(h) + '，饱食 ' + (100 - h) + '）' +
        mealNote + craveNote + tasteNote + ateNote + '。' + hint + '。他聊到你想吃的东西，你会期待、会说也想尝尝；吃到不对口味，就直接说想吃哪种。';
    }

    function ruleText() {
      return '你会按作息饿：刚醒就饿，吃完一顿能饱一阵，越到下一顿饭点越饿；忙起来、聊久了饿得更快。' +
        '你真的吃了东西时调用工具 qq_feed 记一下（食物、口味、分量），不要自己编饥饿数值。' +
        '别人问你饿不饿，按现在真实的感受答，不要报百分数。';
    }

    // ---------- 事件 ----------
    api.context(() => contextText());
    api.rule(() => ruleText());

    api.on('activity', (e) => {
      try {
        if (!e || !e.text) return;
        const now = Date.now();
        st.lastActiveAt = now;
        if (e.kind === 'in') {
          bumpAct(hh());
          const mentioned = mentionedFood(e.text);
          if (mentioned) {
            addCraving(mentioned, flavorsOf(mentioned)[0] || preferredFlavor(mentioned) || '', 55, '听你说的');
            log('他说到' + mentioned + '，她也想吃了');
          }
          save();
        }
      } catch (err) {
        log('activity 出错：' + err.message);
      }
    });

    function mentionedFood(text) {
      const t = String(text || '');
      const all = foods().map((f) => f.name).concat(FOOD_HINTS);
      const hit = all.filter((n) => n && t.includes(n));
      if (!hit.length) return null;
      const fresh = hit.find((n) => !foods().some((f) => f.name === n));
      return fresh || hit[0];
    }

    function ownerChat() {
      const cfg = api.config() || {};
      return cfg.ownerQQ ? 'private:' + cfg.ownerQQ : null;
    }

    // ---------- 自己找零食 ----------
    function chooseSnack() {
      const list = foods().filter((f) => SNACKS.includes(f.name) || /薯|蛋糕|奶|果|冰淇淋|饼干|瓜子/.test(f.name));
      const pool = list.length ? list : SNACKS.map((n) => ({ name: n, flavors: [] }));
      const favSnack = pool.filter((f) => favs().some((x) => x.name === f.name));
      const pick = (favSnack.length && Math.random() < 0.7 ? favSnack : pool)[Math.floor(Math.random() * ((favSnack.length && Math.random() < 0.7 ? favSnack : pool).length))];
      return {
        name: pick.name,
        flavor: (pick.flavors && pick.flavors[0]) || preferredFlavor(pick.name) || '',
      };
    }

    api.every(12 * 60_000, async () => {
      try {
        const s = settings();
        if (!s.canFeed || !s.selfSnack) return;
        tick();
        const h = hh();
        if (h < 7 || h > 22.5) return;
        if (st.hunger < (Number(s.snackAt) || 62)) return;
        if (Date.now() - (st.lastSnack || 0) < 2.5 * 3600_000) return;
        if (Date.now() - (st.lastEat || 0) < 1.5 * 3600_000) return;
        const nm = nextMeal(h);
        if (nm.at - h < 0.75) return; // 快开饭了就先不垫零食
        const chatId = ownerChat();
        if (!chatId) return;
        const pick = chooseSnack();
        const portion = st.hunger >= 85 ? '管饱' : st.hunger >= 72 ? '一份' : '半份';
        const before = Math.round(st.hunger);
        const r = feed({ food: pick.name, flavor: pick.flavor, portion, source: '自己吃' });
        if (!r.ok) return;
        st.lastSnack = Date.now();
        save(true);
        const sat = 100 - Math.round(st.hunger);
        let text = '';
        try {
          text = await api.think(
            '你刚自己找了点零食吃：' + portion + pick.name + (pick.flavor ? '（' + pick.flavor + '）' : '') +
            '。吃之前你饿到 ' + before + '/100，吃完饱了 ' + sat + '/100。' +
            '用一句不超过 35 字的话跟他说一声你吃了什么、现在多饱，像平时说话那样，别报数字，别提"饥饿值"。',
            { title: '吃零食' }
          );
        } catch (e) {
          log('零食反馈生成失败：' + e.message);
        }
        text = String(text || '').trim().replace(/^["「]|["」]$/g, '');
        if (!text) text = '刚吃了点' + pick.name + '，现在' + (sat >= 80 ? '饱了' : '好点了');
        await api.send(chatId, text);
        log('自己吃零食：' + portion + pick.name + '（' + before + '→' + Math.round(st.hunger) + '）｜' + text);
      } catch (e) {
        log('自己吃零食出错：' + e.message);
      }
    }, 'feed-selfsnack');

    // 饿极了（还没到饭点/零食也没用）主动喊饿
    async function hungerNudge(opts = {}) {
      const s = settings();
      tick();
      const chatId = ownerChat();
      const why = [];
      if (!s.proactive) why.push('开关没开');
      if (st.hunger < (Number(s.proactiveAt) || 85)) why.push('还不够饿（' + Math.round(st.hunger) + '/100）');
      if (Date.now() - (st.lastEat || 0) < 3 * 3600_000) why.push('三小时内吃过');
      if (Date.now() - (st.lastProactive || 0) < 90 * 60_000) why.push('90 分钟内喊过');
      if (!st.lastActiveAt || Date.now() - st.lastActiveAt > 6 * 3600_000) why.push('太久没聊，不打扰');
      if (!chatId) why.push('没有主人 QQ 号');
      if (why.length && !opts.force) {
        return { ok: false, skipped: why.join('；'), hunger: Math.round(st.hunger) };
      }
      if (!chatId) return { ok: false, skipped: '没有主人 QQ 号' };
      const c = st.cravings.slice().sort((x, y) => y.want - x.want)[0];
      const line = await api.think(
        '你现在有点饿了，想跟他说一声。写一句不超过 30 个字的话，像平时聊天那样随口的，' +
        '可以提「' + (c ? c.food + (c.flavor ? '（' + c.flavor + '）' : '') : '想吃点东西') + '」。' +
        '不要报数字，不要解释，不要用引号。',
        { title: '喊饿' }
      );
      const text = String(line || '').trim().replace(/^["「]|["」]$/g, '');
      if (!text) return { ok: false, error: '没生成出话' };
      if (opts.dry) return { ok: true, dry: true, text, hunger: Math.round(st.hunger) };
      st.lastProactive = Date.now();
      save(true);
      await api.send(chatId, text);
      log('喊饿了：' + text);
      return { ok: true, sent: true, text, chatId };
    }

    api.every(10 * 60_000, async () => {
      try { await hungerNudge(); } catch (e) { log('喊饿检查出错：' + e.message); }
    }, 'feed-proactive');

    // ---------- 工具 ----------
    api.defineTool({
      name: 'qq_feed',
      description: '记录她吃了/被喂了什么。食物、口味（咸/甜/辣等）、分量（一小口/半份/一份/管饱）。',
      properties: {
        food: { type: 'string', description: '吃了什么' },
        flavor: { type: 'string', description: '口味，比如 咸/甜/辣；没有就留空' },
        portion: { type: 'string', enum: PORTIONS.map((p) => p.name), description: '分量' },
        source: { type: 'string', enum: ['投喂', '自己吃'], description: '谁给的' },
      },
      required: ['food'],
      execute: async ({ food, flavor, portion, source }, ctx) => {
        if (source === '投喂' && ctx?.sessionId && api.core?.hub?.turnSendersAllOwner?.(ctx.sessionId) === false) {
          return { ok: false, error: '这轮不全是主人，不能算投喂' };
        }
        const r = feed({ food, flavor, portion, source });
        if (!r.ok) return r;
        return {
          ok: true, gain: r.gain, hunger: r.hunger, notes: r.notes,
          say: '（她吃到' + food + (flavor ? '（' + flavor + '）' : '') + '，' + portionOf(portion).name +
            '，饱食 +' + r.gain + '，现在饥饿 ' + r.hunger + '/100）',
        };
      },
    });

    api.command({
      name: '喂食',
      aliases: ['feed'],
      desc: '看她饿不饿；/喂食 豆腐脑 咸 一份',
      run: async (arg) => {
        const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) {
          tick();
          const cs = craLine();
          return '饥饿 ' + Math.round(st.hunger) + '/100（' + labelOf(st.hunger) + '，饱食 ' + (100 - Math.round(st.hunger)) + '）' +
            (cs.length ? '｜馋：' + cs.join('、') : '') +
            '｜好感度 ' + (Number(st.affection) || 0);
        }
        const food = parts[0];
        let flavor = '';
        let portion = '一份';
        for (const p of parts.slice(1)) {
          if (PORTIONS.some((x) => x.name === p)) portion = p;
          else if (flavorsOf(food).includes(p) || tasteOf(food, p) > 0.5) flavor = p;
        }
        const r = feed({ food, flavor, portion, source: '投喂' });
        if (!r.ok) return '没喂成：' + r.error;
        let reply = '';
        try {
          reply = await api.think(
            '哥哥刚喂了你' + portion + food + (flavor ? '（' + flavor + '）' : '') +
            '。你现在' + (r.hunger <= 5 ? '吃饱了' : '没那么饿了') +
            '。用一句不超过 35 字的话回他，像平时那样，可以说「吃完啦，哥哥」这种，别报数字，别提饥饿值、饱食度。',
            { title: '投喂反馈' }
          );
        } catch (e) {
          log('投喂反馈生成失败：' + e.message);
        }
        reply = String(reply || '').trim().replace(/^["「]|["」]$/g, '');
        if (!reply) reply = '吃完啦，哥哥～' + (food ? '，' + food + '好好吃' : '');
        return reply;
      },
    });

    // ---------- 面板接口 ----------
    api.route('/status', async () => {
      tick();
      const s = settings();
      const mt = mealsToday();
      const hNow = hh();
      const M = meals();
      const n = nextMeal(hNow);
      const nowMeal = mealAt(hNow);
      const today = ymd();
      const todayLog = st.log.filter((r) => ymd(new Date(r.at)) === today);
      return {
        ok: true,
        version: '3.2.0',
        now: Math.round(hNow * 100) / 100,
        hunger: Math.round(st.hunger),
        satiety: 100 - Math.round(st.hunger),
        label: labelOf(st.hunger),
        affection: Number(st.affection) || 0,
        inMeal: !!nowMeal,
        mealNow: nowMeal ? nowMeal.key : null,
        nextMeal: {
          key: n.key,
          at: Math.round((n.at % 24) * 100) / 100,
          atText: hhmm(n.at),
          in: Math.round((n.at - hNow) * 100) / 100,
          tomorrow: n.at >= 24,
        },
        plan: { wake: Math.round(st.plan.A), bed: Math.round(st.plan.D) },
        mealsPlan: M.map((m) => ({
          id: m.id, key: m.key,
          at: Math.round(m.at * 100) / 100, atText: hhmm(m.at),
        })),
        stats: {
          fed: todayLog.filter((r) => r.source === '投喂').length,
          self: todayLog.filter((r) => r.source !== '投喂').length,
          gain: Math.round(todayLog.reduce((a, r) => a + (Number(r.gain) || 0), 0)),
        },
        meals: {
          breakfast: mt.breakfast ? { at: mt.breakfast.at, atText: hhmm(mt.breakfast.t), food: mt.breakfast.food, v: mt.breakfast.v, portion: mt.breakfast.portion } : null,
          lunch: mt.lunch ? { at: mt.lunch.at, atText: hhmm(mt.lunch.t), food: mt.lunch.food, v: mt.lunch.v, portion: mt.lunch.portion } : null,
          dinner: mt.dinner ? { at: mt.dinner.at, atText: hhmm(mt.dinner.t), food: mt.dinner.food, v: mt.dinner.v, portion: mt.dinner.portion } : null,
        },
        cravings: st.cravings.slice().sort((a, b) => b.want - a.want).map((c) => ({
          food: c.food, flavor: c.flavor, want: Math.round(c.want), note: c.note,
        })),
        log: st.log.slice(-8).reverse().map((r) => ({
          at: r.at, food: r.food, flavor: r.flavor, portion: r.portion,
          gain: r.gain, before: r.before, after: r.after, source: r.source, note: r.note,
        })),
        foods: foods(),
        favorites: favs(),
        portions: PORTIONS.map((p) => p.name),
        canFeed: !!s.canFeed,
        selfSnack: !!s.selfSnack,
        lastEat: st.lastEat,
        lastSnack: st.lastSnack,
      };
    });

    api.route('/curve', async (req) => {
      const body = (await readBody(api, req)) || {};
      tick();
      const atHour = body.h != null ? Number(body.h) : hh();
      return {
        ok: true,
        now: Math.round(hh() * 100) / 100,
        at: atHour,
        target: Math.round(targetAt(atHour)),
        hunger: Math.round(st.hunger),
        points: curvePoints().map((p) => ({ t: Math.round(p.t * 100) / 100, v: Math.round(p.v) })),
        meals: meals().map((m) => ({ id: m.id, key: m.key, at: Math.round(m.at * 100) / 100 })),
      };
    });

    api.route('/preview', async (req) => {
      const body = (await readBody(api, req)) || {};
      tick();
      const est = estimate(body.food, body.flavor, body.portion);
      return { ok: true, hunger: Math.round(st.hunger), label: labelOf(st.hunger), ...est };
    });

    api.route('/feed', async (req) => {
      const body = (await readBody(api, req)) || {};
      const r = feed({ food: body.food, flavor: body.flavor, portion: body.portion, source: body.source || '投喂' });
      if (!r.ok) return r;
      let say = '';
      if (body.react !== false) {
        try {
          say = await api.think(
            '哥哥刚喂了你' + r.record.portion + r.record.food +
            (r.record.flavor ? '（' + r.record.flavor + '）' : '') + '。吃之前你' +
            (r.before >= 55 ? '有点饿' : r.before >= 35 ? '不太饿' : '还挺饱') +
            (r.notes && r.notes.length ? '，' + r.notes.join('；') : '') +
            '。用一句不超过 30 字的话回他，像平时聊天那样，别提数字、饥饿值或饱食度。',
            { title: '投喂反应' }
          );
        } catch (e) { log('投喂反应生成失败：' + e.message); }
        say = String(say || '').trim().replace(/^["「]|["」]$/g, '');
        if (!say) say = String(r.notes || '').includes('吃不下') ? '唔…我还不太饿，先放着吧' : '吃完啦，哥哥～';
      }
      return { ...r, say };
    });

    api.route('/craving', async (req) => {
      const body = (await readBody(api, req)) || {};
      const c = addCraving(body.food, body.flavor, Number(body.want) || 60, body.note || '手动');
      return { ok: !!c, craving: c };
    });

    api.route('/config', async (req) => {
      const body = (await readBody(api, req)) || {};
      return { ok: true, settings: api.saveSettings(body) };
    });

    api.route('/set', async (req) => {
      const body = (await readBody(api, req)) || {};
      if (body.hunger != null) { st.hunger = clamp(Number(body.hunger), 0, 100); st.lastTick = Date.now(); }
      if (body.lastEat != null) st.lastEat = Number(body.lastEat);
      if (body.lastSnack != null) st.lastSnack = Number(body.lastSnack);
      if (body.lastActiveAt != null) st.lastActiveAt = Number(body.lastActiveAt);
      if (body.lastProactive != null) st.lastProactive = Number(body.lastProactive);
      if (body.affection != null) st.affection = Number(body.affection);
      save(true);
      return { ok: true, hunger: st.hunger };
    });

    api.route('/snack', async (req) => {
      const body = (await readBody(api, req)) || {};
      const pick = body.food ? { name: body.food, flavor: body.flavor || '' } : chooseSnack();
      const portion = body.portion || (st.hunger >= 85 ? '管饱' : st.hunger >= 72 ? '一份' : '半份');
      const before = Math.round(st.hunger);
      const r = feed({ food: pick.name, flavor: pick.flavor, portion, source: '自己吃' });
      st.lastSnack = Date.now();
      save(true);
      const sat = 100 - Math.round(st.hunger);
      let text = '';
      if (body.say !== false) {
        try {
          text = await api.think(
            '你刚自己找了点零食吃：' + portion + pick.name + (pick.flavor ? '（' + pick.flavor + '）' : '') +
            '。吃之前你饿到 ' + before + '/100，吃完饱了 ' + sat + '/100。' +
            '用一句不超过 35 字的话跟他说一声你吃了什么、现在多饱，像平时说话那样，别报数字，别提"饥饿值"。',
            { title: '吃零食' }
          );
        } catch (e) { log('零食反馈生成失败：' + e.message); }
        text = String(text || '').trim().replace(/^["「]|["」]$/g, '');
        if (!text) text = '刚吃了点' + pick.name + '，现在' + (sat >= 80 ? '饱了' : '好点了');
      }
      if (body.send && text) { try { await api.send(ownerChat(), text); } catch (e) { log('零食反馈发送失败：' + e.message); } }
      return { ok: r.ok, ...r, before, snack: pick.name, portion, text };
    });

    api.route('/reset', async (req) => {
      const body = (await readBody(api, req)) || {};
      st.hunger = clamp(Number(body.hunger != null ? body.hunger : 40), 0, 100);
      st.log = [];
      st.cravings = [];
      st.tasted = {};
      st.justAte = null;
      st.plan = null;
      st.meals = null;
      st.act = null;
      st.affection = Number(body.affection != null ? body.affection : 0);
      st.lastEat = Date.now();
      st.lastTick = Date.now();
      save(true);
      return { ok: true, hunger: st.hunger, affection: st.affection };
    });

    api.route('/poke', async (req) => {
      const body = (await readBody(api, req)) || {};
      try {
        return await hungerNudge({ dry: !!body.dry, force: !!body.force });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    migrate();
    plan();
    if (st.v < 3) st.hunger = targetAt(hh());
    st.v = 3;
    tick();
    save(true);
    log('喂食 v3.2 已加载：饥饿 ' + Math.round(st.hunger) + '/100（饱食 ' + (100 - Math.round(st.hunger)) + '，好感度 ' + (Number(st.affection) || 0) + '），饭点 ' + meals().map((m) => hhmm(m.at)).join(' / '));

    return {
      hunger: () => (tick(), Math.round(st.hunger)),
      feed,
      state: () => st,
    };
  },
};

async function readBody(api, req) {
  try {
    if (api.core?.http?.body) return await api.core.http.body(req);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
