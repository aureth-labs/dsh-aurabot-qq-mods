/**
 * Aurabot 桌宠「小屋场景窗」渲染端（pet 模块 pet-client/house.js）。
 *
 * 来源 / 许可：
 *   · 结构与坐标体系移植自 zizic04/dsh-pet-home（MIT）的 room.js / room.html；
 *   · 场景素材（底图 / 姿势帧 / 栏杆 / 补丁）来自 dsh-pet-home 仓库，CC BY-NC-SA 4.0，禁止商用；本机自用。
 *
 * 与参考实现的差异（本机环境约定）：
 *   · 本页由主进程 loadFile(house.html, { query: { base, token } }) 打开，nodeIntegration:true；
 *   · 插件 API 请求一律 fetch(base + 路径, { headers: { 'x-pet-token': token } })；
 *   · 素材 URL 一律 base + '/asset/house/' + encodeURIComponent(文件名) + '?token=' + token（token 走 query）；
 *   · 动画 webm 地址表由主进程在窗 ready 后注入：window.__setAssets(table)，收表前动画请求先排队；
 *   · 只有 1 只宠物，无换装 / 音效 / 多宠 / 小游戏 / 活动条，参考实现里相关代码一律未移植；
 *   · 与主进程只走 IPC（pet:house:ready / pet:house:exit / pet:house:say / pet:house:command），
 *     不引用 main.js 的任何内部函数。
 *
 * @module pet-client/house
 */
'use strict';

const { ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// 运行参数：query 里的 base（插件服务地址）与 token（鉴权令牌）
// ---------------------------------------------------------------------------
const QS = new URLSearchParams(location.search);
const BASE = String(QS.get('base') || 'http://127.0.0.1:53210').replace(/\/+$/, '');
const TOKEN = String(QS.get('token') || '');

/** 插件 API 请求（带 token 头）；所有调用方自带 catch，这里只保证不抛未捕获异常。 */
async function apiGet(pathname) {
  const res = await fetch(BASE + pathname, {
    headers: { 'x-pet-token': TOKEN },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
/** 素材地址：/asset/house/<文件>?token=…（<img>/<video> 带不了自定义头，token 走查询参数）。 */
function assetUrl(file) {
  return BASE + '/asset/house/' + encodeURIComponent(file) + '?token=' + encodeURIComponent(TOKEN);
}

// ---------------------------------------------------------------------------
// 动画地址表：主进程窗 ready 后经 window.__setAssets(table) 注入（{ 动画名: 完整URL }）。
// 收表前的动画请求先排队；收表后按兜底链取第一个存在的名字，全没有返回 null（停在待机首帧，不报错）。
// ---------------------------------------------------------------------------
let assets = null; // null = 还没收到表
const pendingPlays = []; // 收表前排队的 { names, opts, resolve }
/** 动画名兜底链。 */
const ANIM = {
  walk: ['螃蟹走路'],
  idle: ['待机呼吸休闲'],
  wander: ['东张西望', '超大伸懒腰', '悠闲哼歌', '深度思考碎碎念'],
  drag: ['被鼠标拖拽悬空反馈'],
};
/** 按兜底链查可用动画名；assets 未就绪返回 undefined（调用方排队），就绪但没有返回 null。 */
function pickAsset(names) {
  const chain = Array.isArray(names) ? names : [names];
  for (const n of chain) if (assets && Object.prototype.hasOwnProperty.call(assets, n)) return n;
  return assets ? null : undefined;
}
window.__setAssets = (table) => {
  assets = table && typeof table === 'object' ? table : {};
  const q = pendingPlays.splice(0, pendingPlays.length);
  for (const item of q) item.resolve(playAnim(item.names, item.opts));
};

// ---------------------------------------------------------------------------
// 房屋几何（底图像素 1672×941，照抄参考实现 room.js 的坐标清单）
// ---------------------------------------------------------------------------
const WORLD = { w: 1672, h: 941 };
/** 动画画布里人物身高（顶 61 → 脚 330）与脚底锚点。 */
const FIG_H = 268;
const ANCHOR = { x: 318, y: 330 };
const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
const DRAG_THRESHOLD = 5;

/** 一楼可走路网（节点 = 脚底点；边 = 直线可走，不穿家具）。 */
const NODES = {
  stair: { x: 235, y: 905 }, // 楼梯口（扶手立柱右前方）
  f1: { x: 430, y: 884 },
  f2: { x: 760, y: 890 },
  f3: { x: 1110, y: 884 },
  kitchen: { x: 445, y: 712 },
  corridor: { x: 1112, y: 760 },
  balcony: { x: 1100, y: 640 },
};
const EDGES = [
  ['stair', 'f1'],
  ['f1', 'f2'],
  ['f2', 'f3'],
  ['f1', 'kitchen'],
  ['f3', 'corridor'],
  ['corridor', 'balcony'],
];
/** 楼梯：一楼楼梯口沿踏步中线上到二楼平台。 */
const STAIRS = { bottom: { x: 48, y: 862 }, top: { x: 286, y: 200 } };
/** 最后一级台阶正前方的地板：上下楼都先从这里直着迈上 / 下台阶。 */
const STAIR_FOOT = { x: 62, y: 915 };
/** 一楼站立身高随深度：靠墙 y=630 → 196，最前 y=925 → 236。 */
const heightAt = (y) => 196 + ((Math.min(925, Math.max(630, y)) - 630) / 295) * 40;
/** 二楼（阁楼卧室，楼梯井在左下、栏杆围着）：可走地板范围。 */
const FLOOR2 = { x0: 570, x1: 1560, y0: 760, y1: 925 };
/** 二楼楼梯：淡入 / 淡出点 → 最上一级 → 栏杆出入口 → 栏杆后地板 → 进房间。 */
const STAIR2 = {
  up: { x: 180, y: 800 },
  top: { x: 186, y: 706 },
  gap: { x: 266, y: 693 },
  behind: { x: 545, y: 696 },
  enter: { x: 680, y: 820 },
};
const height2 = (y) => 215 + (Math.min(935, Math.max(700, y)) - 745) * 0.75;
/** 一楼楼梯：上楼走到第 5 级左右（栏杆后面）就切到二楼镜头。 */
const STAIR1_MID = { x: 120, y: 690 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (arr, not) => {
  const pool = arr.filter((a) => a !== not);
  const src = pool.length ? pool : arr;
  return src[Math.floor(Math.random() * src.length)];
};
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const inRect = (r, x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
/** 走路速度：基础 0.62 个身高 / 秒。 */
const walkSpeed = () => 0.62;

/** 状态：floor = 在哪层；node = 从哪个路网节点进入；pose = 姿势帧名（无 = 原版动画就地播）。 */
const STATES = {
  sofa: {
    label: '沙发玩手机', floor: 1, node: 'f2', at: { x: 700, y: 872 }, pose: 'sofa',
    variants: ['sofa', 'sofaCube', 'sofaDrink'], weight: 20,
    say: ['刷会儿手机～', '沙发最舒服啦', '嘿嘿，看看有什么好玩的'],
  },
  cube: {
    label: '沙发玩魔方', floor: 1, node: 'f2', at: { x: 700, y: 872 }, pose: 'sofaCube', weight: 0,
    say: ['看我三十秒还原！'],
  },
  drink: {
    label: '沙发喝水', floor: 1, node: 'f2', at: { x: 700, y: 872 }, pose: 'sofaDrink', weight: 0,
    say: ['咕嘟咕嘟～'],
  },
  dine: {
    label: '餐桌吃饭', floor: 1, node: 'corridor', at: { x: 1118, y: 800 }, pose: 'dine', weight: 12,
    say: ['开饭啦！', '今天的饭好香～', '吃饱饱才有力气干活'],
  },
  desk: {
    label: '书桌办公', floor: 1, node: 'balcony', at: { x: 1130, y: 650 }, pose: 'desk', weight: 14,
    say: ['开工开工！', '让我看看今天的任务', '专心敲代码中…'],
  },
  kitchen: {
    label: '厨房找吃的', floor: 1, node: 'kitchen',
    // 厨房没有画姿势帧：就地站着播闲逛动作池（参考实现的厨房专用动画不在默认包 106 段池里）
    anims: () => ANIM.wander, weight: 12,
    say: ['去厨房找点吃的～', '冰箱里有什么呢', '偷偷吃一口零食'],
  },
  balcony: {
    label: '阳台吹风', floor: 1, node: 'balcony', pose: 'balcony', weight: 8,
    say: ['风好舒服～', '外面天气真好'],
  },
  bedphone: {
    label: '床上玩手机', floor: 2, at: { x: 960, y: 800 }, pose: 'bedphone', weight: 9,
    say: ['躺着玩一会儿手机', '就玩五分钟！'],
  },
  sleep: { label: '睡觉', floor: 2, at: { x: 960, y: 800 }, pose: 'bedsleep', weight: 6, sleep: true },
  wardrobe: {
    label: '衣柜前照镜子', floor: 2, at: { x: 1420, y: 790 }, pose: 'wardrobe', weight: 5,
    say: ['今天穿哪件好呢？'],
  },
  upstairs: { label: '二楼溜达', floor: 2, at: { x: 900, y: 840 }, weight: 6 },
  play: { label: '客厅玩耍', floor: 1, node: 'f2', weight: 19 },
};

/** 拖拽松手 / 单击落点（看光标）→ 状态。一楼镜头里二楼只是天花板；拖到楼梯井 = 上二楼。 */
const DROP_ZONES = [
  { state: 'upstairs', x0: 180, y0: 90, x1: 390, y1: 330 },
  { state: 'desk', x0: 1340, y0: 380, x1: 1672, y1: 640 },
  { state: 'dine', x0: 1150, y0: 600, x1: 1672, y1: 941 },
  { state: 'sofa', x0: 495, y0: 560, x1: 940, y1: 810 },
  { state: 'balcony', x0: 940, y0: 320, x1: 1220, y1: 610 },
  { state: 'kitchen', x0: 370, y0: 300, x1: 830, y1: 640 },
];
const DROP_ZONES2 = [
  { state: 'bedphone', x0: 650, y0: 330, x1: 1260, y1: 720 },
  { state: 'wardrobe', x0: 1290, y0: 240, x1: 1560, y1: 800 },
  { state: 'play', x0: 0, y0: 640, x1: 500, y1: 941 },
];

/** 路网最短路（BFS，节点少）。 */
function route(from, to) {
  if (from === to) return [to];
  const adj = {};
  for (const [a, b] of EDGES) {
    (adj[a] = adj[a] || []).push(b);
    (adj[b] = adj[b] || []).push(a);
  }
  const prev = { [from]: null };
  const q = [from];
  while (q.length) {
    const n = q.shift();
    if (n === to) break;
    for (const m of adj[n] || []) {
      if (!(m in prev)) { prev[m] = n; q.push(m); }
    }
  }
  const path = [];
  for (let n = to; n; n = prev[n]) path.unshift(n);
  return path[0] === from ? path : [to];
}
/** 最近的路网节点。 */
function nearestNode(x, y) {
  let best = 'f2';
  let bd = Infinity;
  for (const [k, n] of Object.entries(NODES)) {
    const d = Math.hypot(n.x - x, (n.y - y) * 1.6);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 场景缩放：世界整体等比铺满窗口（照参考实现 layout()）
// ---------------------------------------------------------------------------
const worldEl = document.getElementById('world');
const actorsEl = document.getElementById('actors');
let vp = { s: 1, ox: 0, oy: 0 };
function layout() {
  const s = Math.max(window.innerWidth / WORLD.w, window.innerHeight / WORLD.h);
  vp = { s, ox: (window.innerWidth - WORLD.w * s) / 2, oy: (window.innerHeight - WORLD.h * s) / 2 };
  worldEl.style.transform = `translate(${vp.ox}px, ${vp.oy}px) scale(${s})`;
}
const toWorld = (cx, cy) => ({ x: (cx - vp.ox) / vp.s, y: (cy - vp.oy) / vp.s });
window.addEventListener('resize', layout);
layout();

// ---------------------------------------------------------------------------
// 场景素材：manifest（姿势帧 / 栏杆 / 补丁坐标）+ 日夜底图
// ---------------------------------------------------------------------------
let poses = {};
let railing = null;
let stairfront = null;
let stairfront2 = null;
let sceneReady = false;

function mountBackgrounds() {
  const map = {
    'bg-day': 'day.jpg',
    'bg-night': 'night.jpg',
    'bg2-day': 'floor2-day.jpg',
    'bg2-night': 'floor2-night.jpg',
  };
  for (const [id, file] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.style.backgroundImage = `url("${assetUrl(file)}")`;
  }
}

async function loadPoses() {
  const m = await apiGet('/asset/house/' + encodeURIComponent('manifest.json'));
  poses = m.poses || {};
  railing = m.railing || null;
  stairfront = m.stairfront || null;
  stairfront2 = m.stairfront2 || null;
  mountRailing();
}
/** 素材没就绪（manifest 404 / 解析失败）：居中提示，不白屏不抛错。 */
function showFatal(text) {
  const box = document.getElementById('fatal');
  const tip = document.getElementById('fatal-text');
  if (!box || !tip) return;
  tip.textContent = text;
  box.style.display = 'flex';
}
/** 重试成功后收掉错误层（showFatal 的逆操作）。 */
function hideFatal() {
  const box = document.getElementById('fatal');
  if (box) box.style.display = 'none';
}
/** 收掉默认可见的「加载幕」（#boot）：boot 出结果（成功渲染 / 失败转错误层）时调。 */
function hideBoot() {
  const box = document.getElementById('boot');
  if (box) box.style.display = 'none';
}

// ---------------------------------------------------------------------------
// 两个镜头：一楼全景 / 二楼广角。镜头跟着她在哪层
// ---------------------------------------------------------------------------
let view = 1;
function setView(v) {
  if (v === view) return;
  view = v;
  document.body.dataset.view = String(v);
}
document.body.dataset.view = '1';
function setNight(v) {
  document.body.classList.toggle('night', !!v);
}

// ---------------------------------------------------------------------------
// 屋里的那只宠物（参考实现 RoomPet 的单宠精简版：
// 无外观 / 换装 / 音效 / 多宠 / 小游戏 / 活动条）
// ---------------------------------------------------------------------------
class RoomPet {
  constructor() {
    this.x = NODES.f2.x;
    this.y = NODES.f2.y;
    this.h = heightAt(this.y);
    this.lift = 0;
    this.squash = 1;
    this.facing = 'left';
    this.state = null;
    this.where = 'f2';
    this.floor = 1;
    this.mode = 'free'; // free（站 / 走 / 姿势共用）| drag
    this.token = 0; // 打断代际：interrupt() 后旧异步链全部失效
    this.front = 0;

    // 站立 / 走路：原版透明动画 video（A/B 双缓冲，首帧就绪才翻面）
    this.el = document.createElement('div');
    this.el.className = 'rp';
    this.shadow = document.createElement('div');
    this.shadow.className = 'rp-shadow';
    this.fig = document.createElement('div');
    this.fig.className = 'rp-figure';
    this.flip = document.createElement('div');
    this.flip.className = 'rp-flip';
    this.videos = [0, 1].map((i) => {
      const v = document.createElement('video');
      v.className = 'rp-video' + (i === 0 ? ' is-front' : '');
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      this.flip.appendChild(v);
      return v;
    });
    this.hit = document.createElement('div');
    this.hit.className = 'rp-hit';
    Object.assign(this.hit.style, {
      left: HIT_BOX.x0 + 'px',
      top: HIT_BOX.y0 + 'px',
      width: HIT_BOX.x1 - HIT_BOX.x0 + 'px',
      height: HIT_BOX.y1 - HIT_BOX.y0 + 'px',
    });
    this.fig.append(this.flip, this.hit);
    this.el.append(this.shadow, this.fig);
    actorsEl.appendChild(this.el);

    // 坐 / 躺：姿势帧层（最多 4 张 img 交替；外层负责呼吸起伏与淡入淡出）
    this.poseEl = document.createElement('div');
    this.poseEl.className = 'rp-pose';
    this.poseImgs = [0, 1, 2, 3].map(() => {
      const img = document.createElement('img');
      img.className = 'rp-pose-img';
      img.draggable = false;
      this.poseEl.appendChild(img);
      return img;
    });
    actorsEl.appendChild(this.poseEl);
    this.poseHit = document.createElement('div');
    this.poseHit.className = 'rp-pose-hit';
    actorsEl.appendChild(this.poseHit);

    this.bubble = document.createElement('div');
    this.bubble.className = 'rp-bubble';
    actorsEl.appendChild(this.bubble);

    this.bindInput(this.hit);
    this.bindInput(this.poseHit);
    this.render();
  }

  dispose() {
    this.interrupt();
    this.el.remove();
    this.poseEl.remove();
    this.poseHit.remove();
    this.bubble.remove();
  }

  // ---- 绘制 ----
  render() {
    const k = this.h / FIG_H;
    const sq = this.squash;
    const kx = k * (1 + (1 - sq) * 0.5);
    const ky = k * sq;
    this.fig.style.transform = `translate(${this.x - ANCHOR.x * kx}px, ${this.y - this.lift - ANCHOR.y * ky}px) scale(${kx}, ${ky})`;
    this.flip.className = 'rp-flip' + (this.facing === 'right' ? ' right' : '');
    const sw = this.h * 0.6 * Math.max(0.45, 1 - this.lift / 300);
    Object.assign(this.shadow.style, {
      left: this.x - sw / 2 + 'px',
      top: this.y - sw * 0.09 + 'px',
      width: sw + 'px',
      height: sw * 0.18 + 'px',
      opacity: String(Math.max(0.25, 1 - this.lift / 240)),
    });
    // 拎在手里时盖过所有场景层；放下后按脚底 y 排序（3000 < 菜单 9000，不盖 UI）。
    this.el.style.zIndex = this.mode === 'drag' ? '3000' : String(Math.round(this.y));
    if (this.bubble.classList.contains('show')) this.placeBubble();
  }
  placeBubble() {
    let bx = this.x;
    let by = this.y - this.lift - this.h * 0.98;
    if (this.mode !== 'drag' && this.poseBox) {
      bx = this.poseBox.x + this.poseBox.w / 2;
      by = this.poseBox.y - 6;
    }
    this.bubble.style.left = bx + 'px';
    this.bubble.style.top = by + 'px';
  }

  // ---- 播放：A/B 双缓冲，首帧就绪才翻面；素材表未到先排队 ----
  /**
   * 播一段动画。names 是兜底链（数组按序退，单个名字也包成数组）。
   * 返回 'playing'（循环）/ 'ended'（播完）/ 'stale'（被打断）/ 'missing'（链上全没有素材）。
   */
  play(names, { loop = false, from = 0 } = {}) {
    if (assets === null) {
      // 收表前排队：__setAssets 到达后按顺序重放（要带上本实例的视频引用）
      return new Promise((resolve) =>
        pendingPlays.push({
          names,
          opts: { loop, from },
          resolve: () => resolve(playAnim(names, { loop, from, videos: this.videos, frontRef: this })),
        }),
      );
    }
    return playAnim(names, { loop, from, videos: this.videos, frontRef: this, flipEl: this.flip });
  }
  async playOnce(names) {
    const t = this.token;
    const r = await this.play(names);
    return r === 'ended' && t === this.token;
  }

  interrupt() {
    this.token++;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.poseTimer);
  }

  tween(fn, ms) {
    const t = this.token;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (t !== this.token) return resolve(false);
        const p = Math.min(1, (now - t0) / ms);
        fn(p);
        this.render();
        if (p < 1) this.raf = requestAnimationFrame(tick);
        else resolve(true);
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  // ---- 走路：螃蟹走路循环，按身高匀速（身高插值 hFn 照抄坐标） ----
  async walkSeg(tx, ty, hFn) {
    const t = this.token;
    if (Math.hypot(tx - this.x, ty - this.y) < 4) return true;
    this.facing = tx > this.x ? 'right' : 'left';
    if (this.anim !== '螃蟹走路') await this.play(ANIM.walk, { loop: true, from: 2 });
    if (t !== this.token) return false;
    // 链上没有走路素材：留在原地待机，不报错
    if (this.anim !== '螃蟹走路') return true;
    const v = this.videos[this.front];
    v.playbackRate = 1.5;
    const sx = this.x;
    const sy = this.y;
    const total = Math.hypot(tx - sx, ty - sy);
    let done = 0;
    return new Promise((resolve) => {
      let last = performance.now();
      const step = (now) => {
        if (t !== this.token) return resolve(false);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        done = Math.min(total, done + this.h * walkSpeed() * dt);
        const p = done / total;
        this.x = sx + (tx - sx) * p;
        this.y = sy + (ty - sy) * p;
        this.h = hFn ? hFn(p) : this.floor === 2 ? height2(this.y) : heightAt(this.y);
        if (v.currentTime > 7.9 || v.currentTime < 1.9) v.currentTime = 2.05;
        this.render();
        if (p >= 1) return resolve(true);
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    });
  }

  /** 沿路网走到节点；在二楼时先下楼。 */
  async walkToNode(target) {
    const t = this.token;
    if (this.floor === 2 && !(await this.stairs(false))) return false;
    let from = this.where in NODES ? this.where : nearestNode(this.x, this.y);
    if (!(this.where in NODES)) {
      const n = NODES[from];
      if (!(await this.walkSeg(n.x, n.y))) return false;
    }
    for (const key of route(from, target).slice(1)) {
      const n = NODES[key];
      if (!(await this.walkSeg(n.x, n.y))) return false;
      this.where = key;
      from = key;
    }
    this.where = target;
    return t === this.token;
  }

  /** 上 / 下楼梯：一楼楼梯口 ↔ 二楼平台，沿踏步中线走，身高按高度变化，镜头切换带淡入淡出。 */
  async stairs(up) {
    if (up && this.floor === 2) return true;
    if (!up && this.floor === 1) return true;
    const t = this.token;
    const B = STAIRS.bottom;
    const M = STAIR1_MID;
    if (up) {
      if (!(await this.walkToNode('stair'))) return false;
      if (!(await this.walkSeg(STAIR_FOOT.x, STAIR_FOOT.y))) return false;
      if (!(await this.walkSeg(B.x, B.y))) return false;
      // 上几级台阶（始终在栏杆后面），然后淡出、切到二楼镜头
      if (!(await this.walkSeg(M.x, M.y, (p) => 236 - p * 26))) return false;
      await this.fadeFigure(false);
      if (t !== this.token) return false;
      this.floor = 2;
      this.where = 'stairTop';
      setView(2);
      this.x = STAIR2.up.x;
      this.y = STAIR2.up.y;
      this.h = height2(this.y);
      this.render();
      await this.fadeFigure(true);
      for (const p of [STAIR2.top, STAIR2.gap, STAIR2.behind, STAIR2.enter]) {
        if (!(await this.walkSeg(p.x, p.y))) return false;
      }
    } else {
      this.showFigure(true);
      for (const p of [STAIR2.enter, STAIR2.behind, STAIR2.gap, STAIR2.top, STAIR2.up]) {
        if (!(await this.walkSeg(p.x, p.y))) return false;
      }
      await this.fadeFigure(false);
      if (t !== this.token) return false;
      this.floor = 1;
      setView(1);
      this.x = M.x;
      this.y = M.y;
      this.h = 210;
      this.render();
      await this.fadeFigure(true);
      if (!(await this.walkSeg(B.x, B.y, (p) => 210 + p * 26))) return false;
      if (!(await this.walkSeg(STAIR_FOOT.x, STAIR_FOOT.y))) return false;
      if (!(await this.walkSeg(NODES.stair.x, NODES.stair.y))) return false;
      this.where = 'stair';
    }
    return t === this.token;
  }

  /** 菜单 / 命令「在家做什么」：不走过去，闪一下直接出现在目的地（换楼层也直接切镜头）。 */
  async blinkTo(st) {
    const dest = st.floor === 2 ? st.at || STAIR2.enter : st.at || NODES[st.node];
    if (!dest) return true;
    this.showFigure(true);
    await this.fadeFigure(false);
    this.floor = st.floor === 2 ? 2 : 1;
    setView(this.floor);
    this.x = dest.x;
    this.y = dest.y;
    this.h = this.floor === 2 ? height2(dest.y) : heightAt(dest.y);
    this.where = this.floor === 2 ? 'stairTop' : st.node || nearestNode(dest.x, dest.y);
    this.render();
    await this.fadeFigure(true);
    return true;
  }

  fadeFigure(on) {
    this.el.style.transition = 'opacity 0.35s ease';
    this.el.style.opacity = on ? '1' : '0';
    return sleepMs(360).then(() => {
      this.el.style.transition = '';
    });
  }

  // ---- 姿势帧 ----
  showFigure(on) {
    this.el.style.opacity = on ? '1' : '0';
    this.hit.style.pointerEvents = on ? 'auto' : 'none';
  }
  setPoseFrame(img, f) {
    img.style.cssText = `left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px;opacity:${img.style.opacity || '0'}`;
    img.src = assetUrl(f.src);
  }
  /** 进入姿势：站立人物淡出、姿势帧淡入；之后 A/B(/C) 轮播 + 呼吸。 */
  async enterPose(name) {
    const pose = poses[name];
    if (!pose || !pose.frames || !pose.frames.length) return false;
    const t = this.token;
    const gen = (this.poseGen = (this.poseGen || 0) + 1);
    const alive = () => t === this.token && gen === this.poseGen;
    // 拿起茶几上的东西（魔方 / 杯子）：茶几上那一小块换成「东西已被拿走」的桌面
    for (const el of this.patchEls || []) el.remove();
    this.patchEls = [];
    if (pose.patch) {
      for (const tod of ['day', 'night']) {
        if (!pose.patch[tod]) continue;
        const im = document.createElement('img');
        im.className = 'rp-patch rp-patch-' + tod;
        im.src = assetUrl(pose.patch[tod]);
        // 放在姿势层外面：夜里姿势层会整体压暗，而补丁本身已经是夜景像素
        im.style.cssText = `left:${pose.patch.x}px;top:${pose.patch.y}px;width:${pose.patch.w}px;height:${pose.patch.h}px;z-index:${Math.round(pose.patch.y + pose.patch.h)}`;
        actorsEl.appendChild(im);
        this.patchEls.push(im);
      }
    }
    this.poseImgs.forEach((img, i) => {
      img.style.opacity = i === 0 ? '1' : '0';
      if (pose.frames[i]) this.setPoseFrame(img, pose.frames[i]);
      else img.removeAttribute('src');
      img.style.display = pose.frames[i] ? '' : 'none';
    });
    const x0 = Math.min(...pose.frames.map((f) => f.x));
    const y0 = Math.min(...pose.frames.map((f) => f.y));
    const x1 = Math.max(...pose.frames.map((f) => f.x + f.w));
    const y1 = Math.max(...pose.frames.map((f) => f.y + f.h));
    this.poseBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    this.poseEl.style.zIndex = String(Math.round(y1));
    // 呼吸的 transform-origin 在帧盒底部中点（脚不动、胸口起伏）
    this.poseEl.style.transformOrigin = `${(x0 + x1) / 2}px ${y1}px`;
    this.poseEl.style.animationDuration = pose.breath || '3.6s';
    this.poseEl.classList.add('show');
    Object.assign(this.poseHit.style, {
      display: 'block',
      left: x0 + 'px',
      top: y0 + 'px',
      width: x1 - x0 + 'px',
      height: y1 - y0 + 'px',
      zIndex: String(Math.round(y1) + 1),
    });
    this.showFigure(false);
    this.render();
    // 循环动图：有 frameMs 的姿势按帧序列一直轮播（a→b→a→c…，帧时长带随机抖动），像 GIF；
    // 其余姿势（睡觉 / 办公）大部分时间停在 a，偶尔切一下别的帧（眨帧）。
    const show = (k) => this.poseImgs.forEach((img, i) => (img.style.opacity = i === k ? '1' : '0'));
    const cycle = async () => {
      if (pose.frames.length < 2) return;
      if (pose.frameMs) {
        const n = pose.frames.length;
        const seq = n === 2 ? [0, 1] : n === 3 ? [0, 1, 0, 2] : [0, 1, 2, 3];
        for (let i = 0; alive(); i++) {
          show(seq[i % seq.length]);
          await sleepMs(pose.frameMs * (0.8 + Math.random() * 0.4));
        }
        return;
      }
      while (alive()) {
        await sleepMs(2600 + Math.random() * 3800);
        if (!alive()) return;
        show(1 + Math.floor(Math.random() * (pose.frames.length - 1)));
        await sleepMs(pose.holdB || 900 + Math.random() * 900);
        if (!alive()) return;
        show(0);
      }
    };
    void cycle();
    return true;
  }
  leavePose() {
    if (this.poseEl && !this.poseEl.classList.contains('show')) return;
    for (const el of this.patchEls || []) el.remove();
    this.patchEls = [];
    this.poseEl.classList.remove('show');
    this.poseHit.style.display = 'none';
    this.poseBox = null;
    this.showFigure(true);
  }

  // ---- 状态 ----
  async goState(key, { user = false, blink = false } = {}) {
    const st = STATES[key];
    if (!st) return;
    this.interrupt();
    const t = this.token;
    const fromPose = !!this.poseBox;
    this.leavePose();
    if (fromPose && this.exitPoint) {
      // 回到进姿势前的出口点（家具旁的地板上）
      Object.assign(this, {
        x: this.exitPoint.x,
        y: this.exitPoint.y,
        h: this.exitPoint.h,
        floor: this.exitPoint.floor,
      });
      this.where = this.exitPoint.where;
      this.render();
    }
    this.state = key;
    if (blink && !(await this.blinkTo(st))) return;
    if (st.floor === 2) {
      if (!(await this.stairs(true))) return;
      if (st.at && !(await this.walkSeg(st.at.x, st.at.y))) return;
    } else {
      if (st.node && !(await this.walkToNode(st.node))) return;
      if (st.at && !(await this.walkSeg(st.at.x, st.at.y))) return;
    }
    if (t !== this.token) return;
    if (st.say && Math.random() < (user ? 0.8 : 0.45)) this.say(pick(st.say), 3200);
    if (st.pose) {
      this.exitPoint = {
        x: this.x,
        y: this.y,
        h: this.h,
        floor: this.floor,
        where: st.floor === 2 ? 'stairTop' : st.node,
      };
      const variants = (st.variants || [st.pose]).filter((v) => poses[v] && poses[v].frames);
      let cur = variants.length > 1 ? pick(variants) : st.pose;
      if (!(await this.enterPose(cur))) {
        // 姿势素材缺失（404 等）：退回客厅玩耍，不卡死
        void this.goState('play');
        return;
      }
      if (st.sleep) return; // 睡觉：叫醒（点击 / 菜单 / 命令）才起来
      const stay = user ? 90000 + Math.random() * 60000 : 25000 + Math.random() * 35000;
      const until = Date.now() + stay;
      const swap = () => {
        if (t !== this.token) return;
        if (Date.now() >= until) return void this.autoNext();
        if (variants.length > 1) {
          cur = pick(variants, cur);
          const lines = { sofaCube: '玩会儿魔方～', sofaDrink: '喝口水歇歇', sofa: '再刷会儿手机' };
          if (Math.random() < 0.5 && lines[cur]) this.say(lines[cur], 2600);
          void this.enterPose(cur);
        }
        this.poseTimer = setTimeout(swap, 14000 + Math.random() * 10000);
      };
      this.poseTimer = setTimeout(swap, variants.length > 1 ? 14000 + Math.random() * 10000 : stay);
      return;
    }
    if (key === 'upstairs') {
      // 二楼溜达：在二楼地板上随便走几步、做点小动作
      for (let i = 0; i < 3 && t === this.token; i++) {
        await this.walkSeg(
          FLOOR2.x0 + Math.random() * (FLOOR2.x1 - FLOOR2.x0),
          FLOOR2.y0 + Math.random() * (FLOOR2.y1 - FLOOR2.y0),
        );
        if (t === this.token) await this.playOnce(ANIM.wander);
      }
      if (t === this.token) void this.autoNext();
      return;
    }
    if (key === 'play') {
      // 客厅玩耍：走几步 + 闲逛动作池
      const n = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n && t === this.token; i++) {
        await this.walkSeg(clamp(this.x + (Math.random() * 400 - 200), 240, 1140), clamp(this.y + (Math.random() * 60 - 30), 840, 925));
        if (t === this.token) await this.playOnce(ANIM.wander);
      }
      if (t === this.token) this.poseTimer = setTimeout(() => t === this.token && void this.autoNext(), 12000);
      return;
    }
    // 其余站姿状态（厨房等）：闲逛动作池就地播几段
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n && t === this.token; i++) {
      await this.playOnce((st.anims && st.anims()) || ANIM.wander);
    }
    if (t === this.token) void this.autoNext();
  }

  /** 自己挑下一个状态：饭点偏吃饭、深夜偏睡觉（workStatus 一期不管）。 */
  autoNext() {
    const h = new Date().getHours();
    const w = {};
    for (const [k, st] of Object.entries(STATES)) w[k] = st.weight;
    if ((h >= 7 && h < 9) || (h >= 11 && h < 13) || (h >= 18 && h < 20)) w.dine *= 4;
    if (h >= 23 || h < 7) w.sleep *= 8;
    if (h >= 9 && h < 18) w.desk *= 2;
    if (this.state) w[this.state] = 0;
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (const [k, v] of Object.entries(w)) {
      r -= v;
      if (r <= 0) return void this.goState(k);
    }
    return void this.goState('play');
  }

  // ---- 拖拽 / 点击 / 右键（站立人物与姿势层共用） ----
  bindInput(target) {
    let down = null;
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { target.setPointerCapture(e.pointerId); } catch { /* 已释放时忽略 */ }
      down = { cx: e.clientX, cy: e.clientY, moved: false };
    });
    target.addEventListener('pointermove', (e) => {
      if (!down) return;
      if (!down.moved && Math.hypot(e.clientX - down.cx, e.clientY - down.cy) < DRAG_THRESHOLD) return;
      const w = toWorld(e.clientX, e.clientY);
      if (!down.moved) {
        down.moved = true;
        this.startDrag(w);
      }
      // 拎着身体：光标在身体中部，脚底在光标下方半个身高
      this.x = clamp(w.x, 0, WORLD.w);
      this.y = clamp(w.y + this.h * 0.5, 0, WORLD.h + 200);
      this.render();
    });
    const up = (e) => {
      if (!down) return;
      const d = down;
      down = null;
      if (!d.moved) {
        void this.onClick();
        return;
      }
      // 拖到窗口外松手 = 出屋（主进程负责把桌面窗显示在光标处）
      const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
      if (outside) {
        ipcRenderer.send('pet:house:exit');
        return;
      }
      void this.dropAt(toWorld(e.clientX, e.clientY));
    };
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    target.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY);
    });
  }

  startDrag(w) {
    this.interrupt();
    this.leavePose();
    this.state = null;
    this.mode = 'drag';
    this.h = this.floor === 2 ? height2(Math.max(w.y, 600)) : heightAt(Math.max(w.y, 700));
    this.hideBubble();
    this.hit.classList.add('dragging');
    void this.play(ANIM.drag, { loop: true });
  }

  /** 松手：光标落在家具上 → 那件家具的状态；空地 → 竖直落到地板 + Q 弹。 */
  async dropAt(p) {
    this.interrupt();
    const t = this.token;
    this.mode = 'free';
    this.hit.classList.remove('dragging');
    const zone = (view === 2 ? DROP_ZONES2 : DROP_ZONES).find((z) => inRect(z, p.x, p.y));
    if (zone && view === 2 && zone.state === 'play') {
      // 二楼镜头里拖到楼梯口：下楼去客厅
      this.floor = 2;
      this.x = STAIR2.enter.x;
      this.y = STAIR2.enter.y;
      this.h = height2(this.y);
      this.render();
      return this.goState('play', { user: true });
    }
    if (zone) {
      const st = STATES[zone.state];
      if (st.floor === 2) {
        // 一楼镜头里拖到二楼区域：直接换到二楼镜头、落在床 / 衣柜前
        this.floor = 2;
        this.where = 'stairTop';
        setView(2);
        const at = st.at || STAIR2.enter;
        this.x = at.x;
        this.y = at.y;
        this.h = height2(at.y);
      } else {
        const at = st.at || NODES[st.node];
        this.floor = 1;
        this.x = at.x;
        this.y = at.y;
        this.h = heightAt(at.y);
        this.where = st.node;
      }
      this.render();
      return this.goState(zone.state, { user: true });
    }
    const on2 = view === 2;
    // 空地：落到光标正下方的地板（一楼避开楼梯和扶手，落在楼梯口右边）
    const footY = on2 ? clamp(p.y + this.h * 0.5, FLOOR2.y0, FLOOR2.y1) : clamp(p.y + this.h * 0.5, 840, 925);
    const footX = on2 ? clamp(p.x, FLOOR2.x0, FLOOR2.x1) : clamp(p.x, 240, 1140);
    const liftFrom = Math.max(0, footY - (p.y + this.h * 0.5));
    this.x = footX;
    this.y = footY;
    this.floor = on2 ? 2 : 1;
    this.h = on2 ? height2(footY) : heightAt(footY);
    this.where = on2 ? 'stairTop' : nearestNode(footX, footY);
    this.lift = liftFrom;
    this.render();
    if (liftFrom > 2) {
      await this.tween(
        (q) => {
          this.lift = liftFrom * (1 - q * q);
        },
        clamp(Math.sqrt(liftFrom) * 38, 180, 650),
      );
      this.lift = 0;
    }
    if (t !== this.token) return;
    const depth = clamp(0.86 - liftFrom / 2000, 0.7, 0.86);
    await this.tween((q) => {
      this.squash = depth + (1 - depth) * (1 + 2.2 * Math.pow(q - 1, 3) + 1.2 * Math.pow(q - 1, 2));
    }, 380);
    this.squash = 1;
    if (t === this.token) void this.goState(on2 ? 'upstairs' : 'play');
  }

  /** 点地板走过去：点在家具上 = 去那件家具；点在空地 = 走到那里站着。 */
  async walkTo(p) {
    const zone = (view === 2 ? DROP_ZONES2 : DROP_ZONES).find((z) => inRect(z, p.x, p.y));
    if (zone) return this.goState(zone.state, { user: true });
    this.interrupt();
    const t = this.token;
    const fromPose = !!this.poseBox;
    this.leavePose();
    if (fromPose && this.exitPoint) {
      Object.assign(this, {
        x: this.exitPoint.x,
        y: this.exitPoint.y,
        h: this.exitPoint.h,
        floor: this.exitPoint.floor,
      });
      this.where = this.exitPoint.where;
    }
    this.state = 'walk';
    if (view === 2) {
      if (this.floor === 1 && !(await this.stairs(true))) return;
      if (!(await this.walkSeg(clamp(p.x, FLOOR2.x0, FLOOR2.x1), clamp(p.y, FLOOR2.y0, FLOOR2.y1)))) return;
    } else {
      const tx = clamp(p.x, 240, 1140);
      const ty = clamp(p.y, 840, 925);
      if (!(await this.walkToNode(nearestNode(tx, ty)))) return;
      if (!(await this.walkSeg(tx, ty))) return;
      this.where = nearestNode(tx, ty);
    }
    if (t !== this.token) return;
    await this.playOnce(ANIM.wander.slice(0, 2)); // 走到了：东张西望一下
    if (t === this.token) this.poseTimer = setTimeout(() => t === this.token && void this.autoNext(), 12000);
  }

  async onClick() {
    if (this.state === 'sleep') {
      // 睡觉点了叫醒
      this.say('唔……起了起了', 2200);
      void this.goState('bedphone', { user: true });
      return;
    }
    if (this.poseBox) {
      this.say(pick(['嗯？', '在呢在呢～', '别戳啦，我在忙！', '嘿嘿']), 2600);
      return;
    }
    const resume = this.state;
    this.interrupt();
    const ok = await this.playOnce(ANIM.wander);
    if (ok) void (resume ? this.goState(resume) : this.autoNext());
  }

  /** 气泡：显示几秒；互动台词同时上报主进程（转发服务端记回执，一期只 send 不等回）。 */
  say(text, ms) {
    const t = String(text || '').trim();
    if (!t) return;
    this.bubble.replaceChildren(document.createTextNode(t));
    this.bubble.classList.add('show');
    this.placeBubble();
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => this.hideBubble(), ms || 10000);
    try { ipcRenderer.send('pet:house:say', t); } catch { /* IPC 不可用就只画气泡 */ }
  }
  hideBubble() {
    this.bubble.classList.remove('show');
  }
}

/**
 * 播一段动画（独立于实例的底层实现，play() 排队解除后也走这里）。
 * names 兜底链 → 地址表取 URL → A/B 双缓冲首帧就绪翻面。
 * 全链没有素材时：若地址表里有待机就停在待机首帧，否则保持画面不动，都不报错。
 */
function playAnim(names, opts) {
  const { loop = false, from = 0 } = opts || {};
  const name = pickAsset(names);
  if (!name) {
    // 兜底：停在待机首帧（表里有没有待机都安静返回，不抛错）
    const idleName = pickAsset(ANIM.idle);
    if (idleName && opts.videos && opts.frontRef) {
      return staticFirstFrame(opts.videos, opts.frontRef, assets[idleName]);
    }
    return Promise.resolve('missing');
  }
  const videos = opts.videos;
  const frontRef = opts.frontRef;
  if (!videos || !frontRef) return Promise.resolve('missing');
  const my = (frontRef.playGen = (frontRef.playGen || 0) + 1);
  frontRef.anim = name;
  const back = videos[frontRef.front === 0 ? 1 : 0];
  const front = videos[frontRef.front];
  return new Promise((resolve) => {
    back.dataset.anim = name;
    back.playbackRate = 1;
    back.loop = loop;
    back.onended = null;
    back.src = assets[name];
    const go = () => {
      back.removeEventListener('loadeddata', go);
      back.onerror = null;
      if (frontRef.playGen !== my) return resolve('stale');
      if (from) { try { back.currentTime = from; } catch { /* 时长不够就从头播 */ } }
      void back.play().catch(() => undefined);
      back.classList.add('is-front');
      front.classList.remove('is-front');
      frontRef.front = frontRef.front === 0 ? 1 : 0;
      setTimeout(() => {
        if (frontRef.playGen === my) front.pause();
      }, 220);
      if (loop) resolve('playing');
      else back.onended = () => resolve('ended');
    };
    // 素材 404 / 解码失败：静默退回待机首帧
    back.onerror = () => {
      back.removeEventListener('loadeddata', go);
      back.onerror = null;
      if (frontRef.playGen !== my) return resolve('stale');
      resolve(staticFirstFrame(videos, frontRef, assets[name]));
    };
    back.addEventListener('loadeddata', go);
    back.load();
  });
}
/** 停在某段素材的首帧（加载失败 / 无可播素材时的「站着不动」兜底）。 */
function staticFirstFrame(videos, frontRef, url) {
  if (!url) return 'missing';
  const v = videos[frontRef.front];
  v.loop = false;
  v.onended = null;
  v.src = url;
  return new Promise((resolve) => {
    const done = () => {
      v.removeEventListener('loadeddata', done);
      v.onerror = null;
      try { v.pause(); v.currentTime = 0; } catch { /* 忽略 */ }
      v.classList.add('is-front');
      videos[frontRef.front === 0 ? 1 : 0].classList.remove('is-front');
      resolve('playing');
    };
    v.onerror = () => { v.onerror = null; resolve('missing'); };
    v.addEventListener('loadeddata', done);
    v.load();
  });
}

// ---------------------------------------------------------------------------
// 楼梯扶手前景层：她上下楼时在栏杆后面（参考实现 mountRailing / mountStairFront）
// ---------------------------------------------------------------------------
function mountRailing() {
  if (railing && !document.getElementById('rail-day')) {
    for (const k of ['day', 'night']) {
      const r = railing[k];
      if (!r) continue;
      const img = document.createElement('img');
      img.id = 'rail-' + k;
      img.className = 'rail rail-' + k;
      img.src = assetUrl('railing-' + k + '.png');
      img.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;z-index:${railing.z || 870}`;
      actorsEl.appendChild(img);
    }
  }
  mountStairFront();
}
/** 楼梯前景层：竖向分条，每条 z = 该列落地处的 y（manifest 分段线性）——她脚底比它靠里就被盖住。 */
function mountStairFront() {
  for (const [key, f] of [
    ['stairfront', stairfront],
    ['stairfront2', stairfront2],
  ]) {
    if (!f || document.querySelector('.' + key)) continue;
    const pts = f.z || [[f.x, 941]];
    const baseY = (x) => {
      if (x <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        const [xa, za] = pts[i - 1];
        const [xb, zb] = pts[i];
        if (x <= xb) return za + ((zb - za) * (x - xa)) / Math.max(1, xb - xa);
      }
      return pts[pts.length - 1][1];
    };
    const STRIP = 8;
    for (const k of ['day', 'night']) {
      for (let sx = 0; sx < f.w; sx += STRIP) {
        const el = document.createElement('div');
        el.className = `rail-${k} ${key} ${f.view === 2 ? 'sf2' : 'rail'}`;
        const w = Math.min(STRIP, f.w - sx);
        el.style.cssText =
          `position:absolute;left:${f.x + sx}px;top:${f.y}px;width:${w}px;height:${f.h}px;pointer-events:none;` +
          `background:url("${assetUrl(key + '-' + k + '.png')}") ${-sx}px 0/${f.w}px ${f.h}px no-repeat;` +
          `z-index:${Math.round(baseY(f.x + sx + w / 2))}`;
        actorsEl.appendChild(el);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 窗内自绘右键菜单（两级 div，不依赖 Electron Menu）
// ---------------------------------------------------------------------------
let menuOpen = false;
function closeMenu() {
  const m = document.getElementById('menu');
  const sub = document.getElementById('menu-sub');
  if (m) m.style.display = 'none';
  if (sub) sub.style.display = 'none';
  menuOpen = false;
}
function menuItem(label, onClick, arrow) {
  const d = document.createElement('div');
  d.className = 'mi';
  const s = document.createElement('span');
  s.textContent = label;
  d.appendChild(s);
  if (arrow) {
    const a = document.createElement('span');
    a.className = 'arrow';
    a.textContent = '▶';
    d.appendChild(a);
  }
  d.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    if (onClick) onClick();
  });
  return d;
}
function menuSep() {
  const d = document.createElement('div');
  d.className = 'sep';
  return d;
}
function placeFixed(el, x, y) {
  el.style.display = 'block';
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
  el.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
}
function openMenu(x, y) {
  const p = pet;
  const m = document.getElementById('menu');
  const sub = document.getElementById('menu-sub');
  if (!m || !sub || !p) return;
  m.replaceChildren();
  sub.replaceChildren();
  const sleeping = p.state === 'sleep';
  // 「在家做什么」二级：全部状态
  const openState = (k) => () => void p.goState(k, { user: true, blink: true });
  for (const [k, st] of Object.entries(STATES)) {
    const label = k === 'sleep' && sleeping ? st.label + '（叫醒）' : st.label;
    sub.appendChild(menuItem(label, k === 'sleep' && sleeping ? openState('bedphone') : openState(k)));
  }
  // 「在家做什么」主项：点击在主菜单右侧展开子菜单（列出全部状态）
  const statesItem = document.createElement('div');
  statesItem.className = 'mi';
  const stLabel = document.createElement('span');
  stLabel.textContent = '在家做什么';
  statesItem.appendChild(stLabel);
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = '▶';
  statesItem.appendChild(arrow);
  statesItem.addEventListener('click', (e0) => {
    e0.stopPropagation();
    sub.replaceChildren();
    for (const [k, stx] of Object.entries(STATES)) {
      const label = k === 'sleep' && sleeping ? stx.label + '（叫醒）' : stx.label;
      sub.appendChild(menuItem(label, openState(k)));
    }
    placeFixed(sub, Math.min(x + 150, window.innerWidth - 170), y);
  });
  m.appendChild(statesItem);
  m.appendChild(menuSep());
  m.appendChild(menuItem('到屋外玩', () => ipcRenderer.send('pet:house:exit')));
  m.appendChild(menuItem(sleeping ? '醒来' : '睡觉', sleeping ? openState('bedphone') : openState('sleep')));
  m.appendChild(menuItem(night ? '白天' : '夜晚', () => setNight(!night)));
  m.appendChild(menuItem('回桌面', () => ipcRenderer.send('pet:house:exit')));
  menuOpen = true;
  placeFixed(m, x, y);
}
// 全局兜底：点空白处 / 右键空白处也打开菜单（整窗都是场景），点场景走走路
worldEl.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.rp-hit,.rp-pose-hit')) return;
  e.preventDefault();
  openMenu(e.clientX, e.clientY);
});
window.addEventListener('pointerdown', (e) => {
  if (menuOpen && !e.target.closest('#menu,#menu-sub')) closeMenu();
}, true);
window.addEventListener('blur', closeMenu);

// ---------------------------------------------------------------------------
// 场景主体：一只宠物 + 点地板走路 + 日夜 + 自动轮换
// ---------------------------------------------------------------------------
let pet = null;
let night = false;

worldEl.addEventListener('click', (e) => {
  if (!pet || pet.mode === 'drag' || menuOpen) return;
  if (e.target.closest('.rp-hit,.rp-pose-hit')) return;
  const w = toWorld(e.clientX, e.clientY);
  // 点击处留个小涟漪，告诉用户她要去哪
  const r = document.createElement('div');
  r.className = 'rp-ripple';
  r.style.left = w.x + 'px';
  r.style.top = w.y + 'px';
  actorsEl.appendChild(r);
  setTimeout(() => r.remove(), 700);
  void pet.walkTo(w);
});

// ---------------------------------------------------------------------------
// 主进程命令：{cmd:'night', on} / {cmd:'state', key} / {cmd:'exit'}
// ---------------------------------------------------------------------------
ipcRenderer.on('pet:house:command', (_e, cmd) => {
  try {
    const c = cmd || {};
    if (c.cmd === 'night') {
      night = !!c.on;
      setNight(night);
      if (pet) pet.say(night ? '关灯啦，晚安～' : '开灯！亮堂堂～', 2800);
    } else if (c.cmd === 'state' && STATES[c.key]) {
      if (pet) void pet.goState(c.key, { user: true, blink: true });
    } else if (c.cmd === 'exit') {
      ipcRenderer.send('pet:house:exit');
    }
  } catch { /* 命令处理一律不抛 */ }
});

// ---------------------------------------------------------------------------
// 主进程动画地址表注入
// ---------------------------------------------------------------------------
// window.__setAssets 在「动画地址表」一节已定义（收表前排队）；
// 这里再接一层主进程 executeJavaScript 的调用入口兜底（重复注入不报错）。

// ---------------------------------------------------------------------------
// 启动：载 manifest → 背景与前景层 → 建宠物 → 报 ready → 进第一个状态
// ---------------------------------------------------------------------------
document.getElementById('hint').textContent = '拖她到家具上就去那儿；拖到窗口外就出门玩。';

// 小屋白屏兜底（2026-11-07）：白屏根因是 BASE 指向的插件此刻不在——模块没开 / 插件重启中 /
// host.json 端口陈旧 / 插件离线，manifest 拉不到 → 场景永远不渲染，窗口留一块深色空板。
// 兜底：启动拉 manifest 失败就亮错误层 + 每 3s 重试，最多 20 次（60s）；期间任何一次成功就
// 收掉错误层正常渲染；重试耗尽改口「连不上，重开试试」并停（不再无限打网络）。
const BOOT_RETRY_MS = 3000;
const BOOT_RETRY_MAX = 20;
async function boot() {
  for (let attempt = 1; ; attempt++) {
    try {
      await loadPoses(); // apiGet 自带不抛语义之外的错误在这里统一接住
      sceneReady = true;
      hideBoot(); // 加载完成：先收幕，露出正常场景
      hideFatal(); // 之前失败亮过错误层的话一并收掉
      break;
    } catch (e) {
      console.warn('[pet house] manifest 读取失败：', e && e.message);
      hideBoot(); // 第一次失败就收幕换错误层（重试期间错误层显示失败次数）
      if (attempt >= BOOT_RETRY_MAX) {
        showFatal('小屋连不上插件，把桌宠关掉重开试试'); // 重试耗尽：改口 + 停，不再打网络
        break;
      }
      showFatal(`小屋暂时连不上插件（可能在插件重启中）——正在重试…（第 ${attempt}/${BOOT_RETRY_MAX} 次）`);
      await new Promise((r) => setTimeout(r, BOOT_RETRY_MS));
    }
  }
  mountBackgrounds();
  if (sceneReady) {
    pet = new RoomPet();
    void pet.goState('sofa'); // 入屋默认先坐沙发（参考实现 enter() 的默认行为）
  }
  try { ipcRenderer.send('pet:house:ready'); } catch { /* 主进程不在也照常渲染 */ }
}
void boot();

// 全局异常兜底：渲染循环里的意外不许白屏 / 关窗
window.addEventListener('error', (e) => {
  console.warn('[pet house] 未捕获异常：', e && e.message);
  e.preventDefault();
});
window.addEventListener('unhandledrejection', (e) => {
  console.warn('[pet house] 未处理的 Promise 拒绝：', e && e.reason);
  e.preventDefault();
});

// 调试句柄（控制台 / 主进程 executeJavaScript 都能摸到）
window.__house = { pet: () => pet, STATES, NODES, setNight, setView, toWorld };
