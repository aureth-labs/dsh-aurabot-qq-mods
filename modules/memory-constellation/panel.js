const { useState, useEffect, useRef } = React;

const REGION = {
  person: { label: '人物', color: '#6ee7ff' },
  event: { label: '经历', color: '#ff9ecd' },
  core: { label: '核心', color: '#ffd166' },
  knowledge: { label: '知识', color: '#a9bcd8' },
  outdated: { label: '已过时', color: '#5b6678' },
  archived: { label: '已归档', color: '#8b93a7' },
};
const TIER_LABEL = { short: '临时', long: '长期', core: '永久' };
// 关系线统一成淡淡的白色细线；类型只在相关记忆列表里用文字区分。
const EDGE_KIND = {
  person: { label: '同一个人' },
  tag: { label: '同标签' },
  similar: { label: '内容相似' },
  conflict: { label: '冲突' },
  assoc: { label: '联想' },
};
const EDGE_WHITE = '220, 230, 245';
const edgeMeta = (kind) => EDGE_KIND[kind] || EDGE_KIND.tag;
const EDGE_KINDS = ['person', 'tag', 'similar', 'conflict', 'assoc'];
// 四档用量模式只切换回答侧和联想参数，不改任何记忆数据。
const TOKEN_MODES = {
  panel: {
    label: '只看星图',
    desc: '不注册召回工具、不注入联想提示，星图、层级和归档照常可用。',
    estimate: '0 额外 token',
    patch: { llmOn: false, assocOn: false, autoAssoc: false, nameChance: 0, autoChance: 0, maxItems: 3, maxHops: 1, threshold: 0.35 },
  },
  saver: {
    label: '省 Token',
    desc: '只认名字联想，不跑问题向量联想；回复最多 3 行、总共 300 字左右。',
    estimate: '约 8～12 万/月（每天 300 条）',
    patch: { llmOn: true, assocOn: true, autoAssoc: false, nameChance: 40, autoChance: 0, maxItems: 3, maxHops: 1, threshold: 0.35 },
  },
  standard: {
    label: '标准',
    desc: '名字联想 + 问题联想，回复最多 3 行；日常推荐。',
    estimate: '约 15～25 万/月（每天 300 条）',
    patch: { llmOn: true, assocOn: true, autoAssoc: true, nameChance: 40, autoChance: 30, maxItems: 3, maxHops: 1, threshold: 0.35 },
  },
  deep: {
    label: '深度',
    desc: '提高名字/问题联想概率，最多 5 条；重要阶段再开。',
    estimate: '约 30～50 万/月（每天 300 条）',
    patch: { llmOn: true, assocOn: true, autoAssoc: true, nameChance: 50, autoChance: 40, maxItems: 5, maxHops: 1, threshold: 0.3 },
  },
};
const TOKEN_MODE_ORDER = ['panel', 'saver', 'standard', 'deep'];
// 老配置没有 tokenMode 时按现有参数推断；不写回，只用于面板高亮。
const inferTokenMode = (cfg = {}) => {
  if (cfg.llmOn === false) return 'panel';
  if (cfg.assocOn === false) return 'saver';
  const nameChance = Number(cfg.nameChance ?? 100);
  const autoChance = Number(cfg.autoChance ?? 60);
  const maxItems = Number(cfg.maxItems ?? 5);
  if (nameChance > 45 || autoChance > 35 || maxItems > 4) return 'deep';
  if (cfg.autoAssoc === false || autoChance <= 0) return 'saver';
  return 'standard';
};

const DAY = 86_400_000;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const CHILD_TINTS = ['255, 159, 200', '127, 212, 255', '255, 209, 102', '167, 139, 250', '134, 239, 172', '240, 166, 202', '159, 182, 216'];
// 父团各自固定一个色相（按 id 哈希，不随数量排序变化），左侧清单、核心星、光环、标签都用它。
const GROUP_TINTS = ['255, 209, 102', '134, 239, 172', '127, 212, 255', '255, 159, 200', '167, 139, 250', '255, 160, 122', '159, 182, 216', '248, 113, 113'];
const tintIndexOf = (groupId) => {
  const text = String(groupId || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % GROUP_TINTS.length;
};
// 先按 id 哈希取色，撞色时顺延到下一个空位，保证当前这批模块颜色互不相同。
const tintMapOf = (groups = []) => {
  const map = new Map();
  const used = new Set();
  groups.forEach((group) => {
    let index = tintIndexOf(group.id);
    for (let step = 0; step < GROUP_TINTS.length; step += 1) {
      const candidate = (index + step) % GROUP_TINTS.length;
      if (!used.has(candidate)) { index = candidate; break; }
    }
    used.add(index);
    map.set(group.id, GROUP_TINTS[index]);
  });
  return map;
};

const starMatches = (star, query, typeFilter, quickFilter, now = Date.now()) => {
  if (typeFilter && star.region !== typeFilter) return false;
  if (quickFilter === 'dim' && (star.invalidAt || star.archivedAt || star.brightness >= 0.35)) return false;
  if (quickFilter === 'recent' && (!star.lastHit || now - star.lastHit > 7 * DAY)) return false;
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const text = [star.text, star.aboutName, ...(Array.isArray(star.tags) ? star.tags : [])]
    .filter(Boolean).join(' ').toLowerCase();
  return text.includes(q);
};

const shortText = (value, length = 12) => {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
};

const DUST = Array.from({ length: 140 }, (_, i) => {
  const a = Math.imul(i + 3, 1103515245) >>> 0;
  const b = Math.imul(i + 11, 12345) >>> 0;
  return { x: (a % 1000) / 1000, y: (b % 1000) / 1000, size: 0.6 + ((a >>> 8) % 100) / 100 * 1.2 };
});

// 会缓慢流动的远景星场：不同深度、不同速度，像一片在飘的星空。
const FLOW = Array.from({ length: 160 }, (_, i) => {
  const a = Math.imul(i + 7, 2654435761) >>> 0;
  const b = Math.imul(i + 19, 40503) >>> 0;
  const c = Math.imul(i + 31, 1103515245) >>> 0;
  const z = 0.35 + ((a >>> 8) % 100) / 100 * 0.65;
  return {
    x: (a % 1000) / 1000,
    y: (b % 1000) / 1000,
    z,
    size: 0.5 + (((c >>> 8) % 100) / 100) * 1.1,
    speed: 0.006 + z * 0.022,
    warm: (c % 100) > 78,
  };
});

const fmtNext = (ms) => (ms <= 0 ? '该复习了' : `${Math.round(ms / DAY)} 天后`);

const timeText = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

return function Panel({ settings, draftSettings, setSettings, toast }) {
  const [data, setData] = useState(null);
  const [day, setDay] = useState(0);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [quickFilter, setQuickFilter] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [tierListOpen, setTierListOpen] = useState(false);
  const [mapSettingsOpen, setMapSettingsOpen] = useState(false);
  const [enhanceOpen, setEnhanceOpen] = useState(false);
  const [enhanceTab, setEnhanceTab] = useState('vector');
  const [ast, setAst] = useState(null);
  const [vst, setVst] = useState(null);
  const [pst, setPst] = useState(null);
  const [vcfg, setVcfg] = useState({ floor: 0.42, hintCount: 2, recallCount: 6 });
  const [vectorQuery, setVectorQuery] = useState('');
  const [assocQuery, setAssocQuery] = useState('');
  const [vtest, setVtest] = useState(null);
  const [atest, setAtest] = useState(null);
  const [enhanceBusy, setEnhanceBusy] = useState('');
  const [listTier, setListTier] = useState('long');
  const [tierPage, setTierPage] = useState(0);
  const [tierQuery, setTierQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({ text: '', importance: 0.5, tags: '' });
  const [rowEditing, setRowEditing] = useState(null);
  const [rowConfirm, setRowConfirm] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [hover, setHover] = useState('');
  const [hoverGroup, setHoverGroup] = useState('');
  const [groupSelected, setGroupSelected] = useState('');
  const [groupChild, setGroupChild] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // 左侧模块清单：和参考视频一样常驻，点模块直接聚焦；窄屏时可以收起。
  const [legendOpen, setLegendOpen] = useState(true);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const hitsRef = useRef([]);
  const groupHitsRef = useRef([]);
  const childHitsRef = useRef([]);
  const bgRef = useRef(null);
  const glowRef = useRef(null);
  const loadSeqRef = useRef(0);
  // 悬停和标签避让在绘制循环里读取 ref，不进入 React 依赖：
  // 指针每动一下都重建画布，会让全量渲染的星点在相邻帧之间跳变。
  const hoverRef = useRef('');
  const hoverGroupRef = useRef('');
  const labelSeenRef = useRef(new Map());
  const viewRef = useRef({
    yaw: 0.45, pitch: 0.32, zoom: 1, targetZoom: 1, vYaw: 0, vPitch: 0,
    dragging: false, lastX: 0, lastY: 0, downT: 0, moved: 0, init: false,
    focusId: null, fYaw: 0, fPitch: 0,
    // 相机可以真正「飞进」星团/子星云：cam 是镜头看的位置，camScale 是镜头距离，
    // 只靠 zoom 放大没法把一个小星云拉近，必须把镜头挪过去。
    cam: { x: 0, y: 0, z: 0 }, camTarget: { x: 0, y: 0, z: 0 }, camScale: 1, camScaleTarget: 1,
  });

  const cfg = draftSettings || settings;
  const editable = typeof setSettings === 'function';
  const dirty = Object.keys({ ...settings, ...cfg }).some((key) => JSON.stringify(settings[key]) !== JSON.stringify(cfg[key]));
  const set = (key, value) => { if (editable) setSettings({ [key]: value }); else toast('请更新 Aurabot 面板以支持底部统一保存。'); };
  const enabled = cfg.enabled !== false;
  const spin = cfg.spin !== false;
  const glow = cfg.glow !== false;
  const edgeOn = cfg.edgeOn !== false;
  const edgeMode = cfg.edgeMode === 'subtle' || cfg.edgeMode === 'normal' ? cfg.edgeMode : 'focus';
  const edgeStrength = clamp(Number(cfg.edgeStrength ?? 0.3), 0, 1);
  const edgeMax = clamp(Number(cfg.edgeMax ?? 30), 10, 120);
  const edgeKinds = Array.isArray(cfg.edgeKinds) ? cfg.edgeKinds : EDGE_KINDS;
  const edgeKindsKey = edgeKinds.join(',');
  const enhanceOn = cfg.assocOn !== false;
  const reinforceOn = cfg.reinforce !== false;
  const tokenMode = String(cfg.tokenMode || inferTokenMode(cfg));
  const tokenPreset = TOKEN_MODES[tokenMode] || null;
  const tokenModeDirty = tokenPreset
    ? Object.keys(tokenPreset.patch).some((key) => JSON.stringify(cfg[key]) !== JSON.stringify(tokenPreset.patch[key]))
    : true;
  const applyTokenMode = (mode) => {
    const preset = TOKEN_MODES[mode];
    if (!preset) return;
    if (!editable) { toast('请更新 Aurabot 面板以支持底部统一保存。'); return; }
    setSettings({ tokenMode: mode, ...preset.patch });
    toast(`已切到「${preset.label}」，点底部保存后生效。`);
  };
  const toggleEdgeKind = (kind) => {
    const next = edgeKinds.includes(kind) ? edgeKinds.filter((item) => item !== kind) : [...edgeKinds, kind];
    set('edgeKinds', next);
  };
  const motion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : true;

  const load = async (offset = day) => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    try {
      const r = await call('/graph', { day: offset });
      // 切回看日期或自动刷新时可能有多个请求在跑，旧请求晚到就丢掉，别覆盖新数据。
      if (seq !== loadSeqRef.current) return null;
      setData(r);
      setError('');
      // 被聚焦的星已经不在库里时（例如在内置记忆面板里被删掉），把镜头锁一并解除。
      if (viewRef.current.focusId && !(r.stars || []).some((s) => s.id === viewRef.current.focusId)) viewRef.current.focusId = null;
      // 用函数式更新，避免定时刷新拿到旧的 selected，误清刚选中的星。
      setSelected((cur) => (cur && !(r.stars || []).some((s) => s.id === cur) ? '' : cur));
      setGroupSelected((cur) => (cur && (r.layout?.groups || []).some((g) => g.id === cur) ? cur : ''));
      return r;
    } catch (e) {
      if (seq === loadSeqRef.current) setError(e.message);
      return null;
    }
  };

  useEffect(() => { load(day); }, [day]);
  useEffect(() => { setEditing(null); setConfirming(false); }, [selected, day]);
  // 取消选中时解除镜头锁定，让自动旋转按新规则立即恢复。
  useEffect(() => { if (!selected) viewRef.current.focusId = null; }, [selected]);
  // 换星团时重置子模块筛选和团内子星云选择，避免旧的标签过滤落到新星团上。
  useEffect(() => { setGroupChild(''); }, [groupSelected]);
  const starCount = data?.stars?.length || 0;
  const autoRefreshMs = starCount > 12000 ? 10 * 60_000 : starCount > 5000 ? 5 * 60_000 : 60_000;
  useEffect(() => {
    if (day !== 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') load(0);
    }, autoRefreshMs);
    return () => clearInterval(timer);
  }, [day, autoRefreshMs]);

  const loadEnhance = async (init = false) => {
    try {
      const [assocState, vectorState, pipelineState] = await Promise.all([
        call('/assoc/state', {}),
        call('/vector/state', {}),
        call('/pipeline/state', {}),
      ]);
      setAst(assocState);
      setVst(vectorState);
      setPst(pipelineState);
      if (init && vectorState?.ok) {
        setVcfg({
          floor: vectorState.floor,
          hintCount: vectorState.hintCount,
          recallCount: vectorState.recallCount,
        });
      }
    } catch (e) {
      setAst({ ok: false, message: e.message });
      setPst({ ok: false, message: e.message });
    }
  };
  useEffect(() => { loadEnhance(true); }, []);
  // 模块清单和层级列表的滚动条改成很淡的蓝灰细线，避免默认白条在深色画布上太抢眼。
  useEffect(() => {
    const id = 'memory-center-thin-scroll';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      .mc-thin-scroll { scrollbar-width: thin; scrollbar-color: rgba(120, 160, 220, 0.28) transparent; }
      .mc-thin-scroll::-webkit-scrollbar { width: 5px !important; height: 5px !important; }
      .mc-thin-scroll::-webkit-scrollbar-track { background: transparent !important; }
      .mc-thin-scroll::-webkit-scrollbar-thumb { background: rgba(120, 160, 220, 0.26) !important; border-radius: 999px !important; }
      .mc-thin-scroll::-webkit-scrollbar-thumb:hover { background: rgba(120, 160, 220, 0.45) !important; }
      .mc-thin-scroll::-webkit-scrollbar-corner { background: transparent !important; }
    `;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const saveVector = async (patch) => {
    setEnhanceBusy('vector');
    try {
      const r = await call('/vector/config', patch);
      setVst(r);
      if (r?.ok) {
        setVcfg({ floor: r.floor, hintCount: r.hintCount, recallCount: r.recallCount });
        toast('已保存');
      } else {
        toast(r?.message || '保存失败');
      }
    } catch (e) { toast(e.message); }
    finally { setEnhanceBusy(''); }
  };
  const runVectorTest = async () => {
    const text = String(vectorQuery || '').trim();
    if (!text) { toast('先写一句想试的话'); return; }
    setEnhanceBusy('vtest');
    try { setVtest(await call('/vector/try?q=' + encodeURIComponent(text), {})); }
    catch (e) { toast(e.message); }
    finally { setEnhanceBusy(''); }
  };
  const rebuildVector = async (force) => {
    setEnhanceBusy('vrebuild');
    try {
      const r = await call('/vector/rebuild', { force });
      toast(r?.message || (r?.ok ? '好了' : '重建失败'));
      await loadEnhance(false);
    } catch (e) { toast(e.message); }
    finally { setEnhanceBusy(''); }
  };
  const runAssocTest = async () => {
    const text = String(assocQuery || '').trim();
    if (!text) { toast('先写一个名字或一句话'); return; }
    setEnhanceBusy('atest');
    try { setAtest(await call('/assoc/try?q=' + encodeURIComponent(text), {})); }
    catch (e) { toast(e.message); }
    finally { setEnhanceBusy(''); }
  };
  const rebuildAssoc = async () => {
    setEnhanceBusy('arebuild');
    try {
      const r = await call('/assoc/rebuild', {});
      toast(r?.message || (r?.ok ? '建好了' : '重建失败'));
      await loadEnhance(false);
    } catch (e) { toast(e.message); }
    finally { setEnhanceBusy(''); }
  };
  const loadPipeline = async () => {
    try { setPst(await call('/pipeline/state', {})); } catch (e) { setPst({ ok: false, message: e.message }); }
  };
  const runPipeline = async (path, tag, okText) => {
    if (dirty) { toast('请先点击底部“保存设置”，再执行提炼或归档。'); return; }
    setEnhanceBusy(tag);
    try {
      const r = await call(path, {});
      toast(r.message || okText);
      await loadPipeline();
      await load(0);
    } catch (e) { toast(e.message); }
    finally { setEnhanceBusy(''); }
  };

  const stars = data?.stars || [];
  const layoutGroups = data?.layout?.groups || [];
  const selectedStar = stars.find((s) => s.id === selected);
  const relatedStars = (() => {
    if (!selectedStar || !Array.isArray(data?.edges)) return [];
    const seen = new Set();
    return data.edges
      .filter((edge) => edge.a === selectedStar.id || edge.b === selectedStar.id)
      .map((edge) => ({
        otherId: edge.a === selectedStar.id ? edge.b : edge.a,
        kind: edge.kind,
        weight: Number(edge.weight) || 0,
      }))
      .filter((edge) => edge.otherId)
      .sort((a, b) => b.weight - a.weight)
      .filter((edge) => {
        if (seen.has(edge.otherId)) return false;
        seen.add(edge.otherId);
        return true;
      })
      .slice(0, 5)
      .map((edge) => ({ ...edge, star: stars.find((star) => star.id === edge.otherId) }))
      .filter((edge) => edge.star);
  })();
  const selectedGroup = selectedStar ? layoutGroups.find((group) => group.id === selectedStar.cluster) : null;
  const groupInfo = groupSelected ? layoutGroups.find((group) => group.id === groupSelected) : null;
  const groupChildInfo = groupChild && groupInfo ? (groupInfo.childClusters || []).find((child) => child.id === groupChild) : null;
  const groupTints = tintMapOf(layoutGroups);
  const tierCounts = { short: 0, long: 0, core: 0 };
  for (const star of stars) if (!star.archivedAt && tierCounts[star.tier] !== undefined) tierCounts[star.tier] += 1;
  // 底部层级列表：和画布共用同一份 stars，不另外请求。
  const LIST_PAGE = 30;
  const tierKeyword = String(tierQuery || '').trim().toLowerCase();
  const listItems = stars
    .filter((star) => !star.archivedAt && star.tier === listTier)
    .filter((star) => !tierKeyword || [star.text, star.aboutName, ...(star.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(tierKeyword))
    .slice()
    .sort((a, b) => (b.brightness || 0) - (a.brightness || 0) || (b.lastHit || 0) - (a.lastHit || 0));
  const pageCount = Math.max(1, Math.ceil(listItems.length / LIST_PAGE));
  const pageSafe = Math.min(tierPage, pageCount - 1);
  const pageItems = listItems.slice(pageSafe * LIST_PAGE, pageSafe * LIST_PAGE + LIST_PAGE);
  const activeFilter = Boolean(String(query || '').trim() || typeFilter || quickFilter || tierFilter);
  const matches = activeFilter
    ? stars.filter((star) => (!tierFilter || (star.tier === tierFilter && !star.archivedAt)) && starMatches(star, query, typeFilter, quickFilter, Date.now()))
    : [];

  const pick = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best = null;
    let bestD = Infinity;
    // 星星优先：星团命中区域很大，不能让整片区域把团里的星盖住。
    for (const hit of hitsRef.current) {
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d <= hit.r && d < bestD) { best = { type: 'star', id: hit.id }; bestD = d; }
    }
    if (best) return best;
    // 团内小星云在父团点击区里面，必须先于父团命中，否则点不到子模块。
    for (const hit of childHitsRef.current) {
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d <= hit.r && d < bestD) { best = { type: 'child', id: hit.id, group: hit.group, point: hit.point }; bestD = d; }
    }
    if (best) return best;
    for (const hit of groupHitsRef.current) {
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d <= hit.r && d < bestD) { best = { type: 'group', id: hit.id }; bestD = d; }
    }
    return best;
  };

  const zoomBy = (factor) => {
    const v = viewRef.current;
    v.targetZoom = clamp(v.targetZoom * factor, 0.55, 6);
  };

  const focusOn = (star) => {
    if (!star) return;
    const v = viewRef.current;
    v.focusId = star.id;
    v.camTarget = { x: star.x || 0, y: star.y || 0, z: star.z || 0 };
    v.camScaleTarget = 0.5;
    // 镜头已经移到星星上，保持当前朝向就行，别让旧的角度目标把视角拽走。
    v.fYaw = v.yaw;
    v.fPitch = v.pitch;
    v.targetZoom = 2.6;
    v.vYaw = 0;
    v.vPitch = 0;
  };

  // 团和子星云没有 id 可跟随时，把镜头平滑推到目标点，同时拉近到目标尺度。
  const focusPoint = (point, zoom, camScale = 0.45) => {
    if (!point) return;
    const v = viewRef.current;
    v.focusId = null;
    v.camTarget = { x: point.x || 0, y: point.y || 0, z: point.z || 0 };
    v.camScaleTarget = clamp(camScale, 0.2, 1);
    v.targetZoom = clamp(zoom || 2, 1, 4);
    v.vYaw = 0;
    v.vPitch = 0;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event) => {
      event.preventDefault();
      const v = viewRef.current;
      v.targetZoom = clamp(v.targetZoom * Math.exp(-event.deltaY * 0.0015), 0.55, 6);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [data]);

  useEffect(() => {
    if (!data) return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const v = viewRef.current;
    if (!v.init) { v.init = true; v.yaw = 0.45; v.pitch = 0.32; v.zoom = 1.7; v.targetZoom = 1; }
    let raf = 0;
    let last = performance.now();
    // 背景层和辉光层跨重绘复用：搜索、选中、悬停都会重建这个 effect，
    // 如果每次新建 canvas，背景的渐变和星尘就要整块重画。
    const bgCanvas = bgRef.current || (bgRef.current = document.createElement('canvas'));
    const glowCanvas = glowRef.current || (glowRef.current = document.createElement('canvas'));

    const starsById = new Map(stars.map((star) => [star.id, star]));
    const nowMs = Date.now();
    const active = Boolean(String(query || '').trim() || typeFilter || quickFilter || tierFilter);
    const matchedIds = new Set(active ? stars.filter((star) => (!tierFilter || (star.tier === tierFilter && !star.archivedAt)) && starMatches(star, query, typeFilter, quickFilter, nowMs)).map((star) => star.id) : []);
    const matchedClusters = new Set();
    const clusterRanked = new Map();
    const childRanked = new Map();
    // 代表星用「被想起的次数」排序：重要度和亮度在现有记忆里几乎一致，
    // 用 hits 才能看出哪些是常用记忆，而且排序只在数据变化时算一次，不会逐帧换人。
    const rankOf = (star) => (
      clamp(Number(star.hits) || 0, 0, 60) / 60 * 0.62
      + clamp(star.brightness, 0, 1) * 0.24
      + clamp(star.importance, 0, 1) * 0.14
    );
    for (const star of stars) {
      if (active && matchedIds.has(star.id) && star.cluster) matchedClusters.add(star.cluster);
      const rank = rankOf(star);
      const list = clusterRanked.get(star.cluster) || [];
      list.push({ id: star.id, rank });
      clusterRanked.set(star.cluster, list);
      if (star.child) {
        const childList = childRanked.get(star.child) || [];
        childList.push({ id: star.id, rank });
        childRanked.set(star.child, childList);
      }
    }
    for (const list of clusterRanked.values()) {
      list.sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1));
    }
    for (const list of childRanked.values()) {
      list.sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1));
    }
    // 子星云配色表：星的填充色跟它所在的小星云一致，284 条经历不再是一片同色粉点。
    const childTints = new Map();
    for (const group of layoutGroups) {
      (group.childClusters || []).forEach((child, index) => {
        childTints.set(child.id, CHILD_TINTS[index % CHILD_TINTS.length]);
      });
    }
    const colorOf = (star) => {
      const tint = star.child ? childTints.get(star.child) : '';
      return tint ? `rgb(${tint})` : (REGION[star.region] || REGION.knowledge).color;
    };
    // 固定亮星：每个小星云 top3、没有子星云的团 top5。这个集合不随缩放变化，
    // 全量渲染时由它提供层次，其余星星永远以细小尘埃点常驻，不会成批闪烁。
    const highlightIds = new Set();
    for (const group of layoutGroups) {
      const children = group.childClusters || [];
      if (children.length) {
        for (const child of children) {
          (childRanked.get(child.id) || []).slice(0, 3).forEach((entry) => highlightIds.add(entry.id));
        }
      } else {
        (clusterRanked.get(group.id) || []).slice(0, 5).forEach((entry) => highlightIds.add(entry.id));
      }
    }
    // 永久记忆永远用最亮的一档画，不参与亮度衰减。
    for (const star of stars) if (star.tier === 'core') highlightIds.add(star.id);
    // 固定绘制顺序：尘埃/普通/亮星/永久依次叠上去，同一档内按 id 固定。
    // 不再每帧按 depth 排序，避免两颗重叠星在旋转时互相盖住造成“跳一下”。
    const starOrder = [...stars].sort((a, b) => {
      const tierOf = (s) => (s.tier === 'core' ? 3 : highlightIds.has(s.id) ? 2 : 1);
      const ta = a.invalidAt ? 0 : tierOf(a);
      const tb = b.invalidAt ? 0 : tierOf(b);
      return ta - tb || (a.id < b.id ? -1 : 1);
    });
    // 关系线索引：选中/悬停时只查这颗星的一跳边，不再每帧扫全部边。
    const edgeAllowed = (edge) => edgeKinds.includes(edge.kind);
    const edgeIndex = new Map();
    for (const edge of data.edges || []) {
      if (!edgeAllowed(edge)) continue;
      const listA = edgeIndex.get(edge.a) || [];
      listA.push(edge);
      edgeIndex.set(edge.a, listA);
      const listB = edgeIndex.get(edge.b) || [];
      listB.push(edge);
      edgeIndex.set(edge.b, listB);
    }
    const activeEdges = active ? (data.edges || []).filter((edge) => edgeAllowed(edge) && matchedIds.has(edge.a) && matchedIds.has(edge.b)) : [];
    const conflictEdges = (data.edges || []).filter((edge) => edge.kind === 'conflict' && edgeAllowed(edge));
    // 跨星团关系：按设置决定是否常驻，以及最多画多少条。
    const clusterOfStar = new Map(stars.map((star) => [star.id, star.cluster || '']));
    const crossLimit = edgeMode === 'subtle' ? Math.min(edgeMax, 30) : edgeMax;
    const crossEdges = (data.edges || [])
      .filter((edge) => {
        if (!edgeAllowed(edge)) return false;
        const ca = clusterOfStar.get(edge.a);
        const cb = clusterOfStar.get(edge.b);
        return ca && cb && ca !== cb;
      })
      .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
      .slice(0, crossLimit);
    const crossKeys = new Set(crossEdges.map((edge) => `${edge.a}-${edge.b}-${edge.kind}`));
    const idleEdges = !edgeOn ? [] : edgeMode === 'focus'
      ? conflictEdges
      : crossEdges.concat(conflictEdges.filter((edge) => !crossKeys.has(`${edge.a}-${edge.b}-${edge.kind}`))).slice(0, edgeMax);
    const focusGroup = groupSelected ? layoutGroups.find((group) => group.id === groupSelected) : null;
    const focusChildren = focusGroup?.childClusters || [];
    const childFocus = Boolean(focusGroup && focusChildren.length);

    const draw = (now) => {
      const W = Math.max(320, Math.round(wrap.clientWidth));
      const H = Math.max(340, Math.round(W * 0.6));
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.floor(W * dpr);
      const ph = Math.floor(H * dpr);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const labelBoxes = [];
      const groupHits = [];
      const childHits = [];
      const boxHit = (x, y, w, h) => labelBoxes.some((box) => Math.abs(box.x - x) < (box.w + w) / 2 && Math.abs(box.y - y) < (box.h + h) / 2);

      if (bgCanvas.width !== W || bgCanvas.height !== H) {
        bgCanvas.width = W;
        bgCanvas.height = H;
        const bg = bgCanvas.getContext('2d');
        bg.fillStyle = '#050a14';
        bg.fillRect(0, 0, W, H);
        const blobs = [
          [0.3, 0.28, 0.55, 72, 98, 210, 0.18],
          [0.74, 0.2, 0.4, 132, 74, 186, 0.12],
          [0.58, 0.8, 0.6, 40, 112, 168, 0.1],
        ];
        for (const [x, y, r, cr, cg, cb, alpha] of blobs) {
          const g = bg.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * Math.min(W, H));
          g.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha})`);
          g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
          bg.fillStyle = g;
          bg.fillRect(0, 0, W, H);
        }
        for (const d of DUST) {
          bg.fillStyle = `rgba(150,180,230,${0.05 + d.size * 0.1})`;
          bg.fillRect(d.x * W, d.y * H, d.size, d.size);
        }
      }
      ctx.drawImage(bgCanvas, 0, 0);
      if (motion) {
        // 背景不再逐帧闪：星尘固定亮度，流动星场只保留很慢的漂移，透明度不动。
        // 之前 160 颗背景星一直在正弦闪烁，整块画面都在“呼吸”，看起来就是抖。
        for (let i = 0; i < DUST.length; i += 5) {
          const d = DUST[i];
          ctx.fillStyle = 'rgba(190,214,245,0.16)';
          ctx.fillRect(d.x * W, d.y * H, 1.2, 1.2);
        }
        const T = now * 0.001;
        for (const f of FLOW) {
          const x = (((f.x + T * f.speed * 0.35) % 1) + 1) % 1;
          const y = (((f.y + T * f.speed * 0.1) % 1) + 1) % 1;
          const alpha = 0.1 + 0.16 * f.z;
          const px = x * W;
          const py = y * H;
          if (f.z > 0.9 && f.size > 1.2) {
            ctx.strokeStyle = `rgba(190,214,245,${alpha * 0.3})`;
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(px - f.speed * W * 0.2, py - f.speed * H * 0.05);
            ctx.stroke();
          }
          ctx.fillStyle = f.warm
            ? `rgba(255,226,190,${alpha})`
            : `rgba(190,214,245,${alpha})`;
          ctx.fillRect(px, py, f.size, f.size);
        }
      }

      const R = data.layout?.radius || 470;
      // 镜头会随聚焦目标移动并拉近，camScale 越小离得越近，子星云才能真正铺开。
      const camZ = R * 3 * v.camScale;
      const camX = v.cam.x;
      const camY = v.cam.y;
      const camFocusZ = v.cam.z;
      const cyw = Math.cos(v.yaw);
      const syw = Math.sin(v.yaw);
      const cp = Math.cos(v.pitch);
      const sp = Math.sin(v.pitch);
      const focal = Math.min(W, H) * 0.95;
      const project = (p) => {
        const worldX = p.x - camX;
        const worldY = p.y - camY;
        const worldZ = p.z - camFocusZ;
        const x1 = worldX * cyw + worldZ * syw;
        const z1 = -worldX * syw + worldZ * cyw;
        const y2 = worldY * cp - z1 * sp;
        const z2 = worldY * sp + z1 * cp;
        const depth = camZ - z2;
        if (depth < 60) return null;
        const k = focal * v.zoom / depth;
        return { x: W / 2 + x1 * k, y: H / 2 - y2 * k, k, depth, t: clamp((z2 / R + 1) / 2, 0, 1) };
      };

      const proj = new Map();
      for (const star of stars) {
        const p = project(star);
        if (p) proj.set(star.id, p);
      }

      // 全量渲染：每一颗星每帧都画，不再按缩放抽取子集。
      // 层次只由固定的亮星集合和连续的尺寸/透明度决定，所以旋转、缩放时不会有成批圆点突然出现或消失。
      const edgeEndpoint = (id) => {
        const p = proj.get(id);
        if (!p) return null;
        if (p.x < -40 || p.x > W + 40 || p.y < -30 || p.y > H + 30) return null;
        return p;
      };

      // 关系线：搜索时画命中之间的线；选中/悬停时画这颗星的一跳关系；平时画跨团线和冲突线。
      const edgeFocusId = selected || hoverRef.current;
      const edgeList = !edgeOn ? [] : active ? activeEdges : edgeFocusId ? (edgeIndex.get(edgeFocusId) || []) : idleEdges;
      // 白色细线：透明度随 zoom 线性变化，缩到最小时几乎看不见。
      const zoomGain = clamp(v.zoom, 0.55, 3);
      const edgeWidth = clamp(0.35 + 0.25 * zoomGain, 0.35, 1.1);
      const baseAlpha = active ? 0.2 : edgeFocusId ? 0.35 : 0.06 * (edgeMode === 'subtle' ? 0.6 : 1);
      for (const edge of edgeList) {
        const a = edgeEndpoint(edge.a);
        const b = edgeEndpoint(edge.b);
        if (!a || !b) continue;
        const alpha = clamp(baseAlpha * zoomGain * edgeStrength, 0, 0.65);
        if (alpha <= 0) continue;
        ctx.strokeStyle = `rgba(${EDGE_WHITE}, ${alpha})`;
        ctx.lineWidth = edgeWidth;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // 半分辨率辉光层模拟后处理 bloom：先画亮点，再模糊叠加，形成太空感的柔光。
      if (glow && typeof ctx.filter === 'string') {
        const gw = Math.max(160, Math.floor(W / 2));
        const gh = Math.max(170, Math.floor(H / 2));
        if (glowCanvas.width !== gw || glowCanvas.height !== gh) { glowCanvas.width = gw; glowCanvas.height = gh; }
        const gc = glowCanvas.getContext('2d');
        gc.setTransform(1, 0, 0, 1, 0, 0);
        gc.clearRect(0, 0, gw, gh);
        gc.setTransform(0.5, 0, 0, 0.5, 0, 0);
        // 只有固定亮星、搜索命中和当前聚焦的星参与辉光；381 颗全叠辉光会糊成一团。
        for (const star of stars) {
          if (star.invalidAt) continue;
          const lit = highlightIds.has(star.id) || star.id === selected || star.id === hoverRef.current || (active && matchedIds.has(star.id));
          if (!lit) continue;
          const p = proj.get(star.id);
          if (!p) continue;
          if (p.x < -40 || p.x > W + 40 || p.y < -30 || p.y > H + 30) continue;
          const b = clamp(star.brightness, 0, 1);
          gc.globalAlpha = p.t * (0.22 + 0.55 * b);
          gc.fillStyle = colorOf(star);
          gc.beginPath();
          gc.arc(p.x, p.y, 2.4 + b * 1.6, 0, Math.PI * 2);
          gc.fill();
        }
        gc.globalAlpha = 0.7;
        gc.fillStyle = '#ffd166';
        gc.beginPath();
        gc.arc(W / 2, H / 2, Math.max(10, Math.min(W, H) * 0.025), 0, Math.PI * 2);
        gc.fill();
        gc.globalAlpha = 1;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.85;
        ctx.filter = 'blur(6px)';
        ctx.drawImage(glowCanvas, 0, 0, W, H);
        ctx.restore();
      }

      // 星团光环和标签
      const font = '-apple-system, "Noto Sans SC", sans-serif';
      ctx.textAlign = 'center';
      for (const group of data.layout?.groups || []) {
        const p = project(group);
        if (!p) continue;
        if (p.x < -60 || p.x > W + 60 || p.y < -40 || p.y > H + 40) continue;
        // 字号跟纵深走：靠近镜头的团字大一点，远处的字小一点，叠在透视缩放上更立体。
        const fs = Math.round(clamp(10 + p.t * 3, 10, 13));
        ctx.font = `${fs}px ${font}`;
        const fading = group.id === 'fading';
        const archived = group.id === 'archived';
        const tint = fading ? '255, 190, 122' : archived ? '139, 147, 167' : (groupTints.get(group.id) || GROUP_TINTS[0]);
        const rr = (group.r || 0) * p.k;
        const groupActive = groupSelected === group.id || hoverGroupRef.current === group.id;
        // 层级射线：中枢 → 父团核心。参考视频里就是靠这条长线把“这团归谁管”讲清楚的。
        ctx.globalAlpha = groupActive ? 0.2 + 0.12 * p.t : (archived ? 0.03 : 0.04 + 0.05 * p.t);
        ctx.strokeStyle = `rgba(${tint},1)`;
        ctx.lineWidth = groupActive ? 1.3 : 1;
        ctx.beginPath();
        ctx.moveTo(W / 2, H / 2);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        if (rr > 4) {
          ctx.globalAlpha = groupActive ? 0.26 + 0.24 * p.t : (fading ? 0.12 : archived ? 0.06 : 0.05) + 0.1 * p.t;
          ctx.strokeStyle = groupActive ? '#ffd166' : fading ? '#ffbe7a' : archived ? '#8b93a7' : `rgb(${tint})`;
          ctx.lineWidth = groupActive ? 1.8 : 1;
          ctx.setLineDash(fading || archived ? [5, 5] : []);
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          // 外圈虚线环：和视频里的双环一样，让模块边界更像一个“系统”而不是一个圈。
          if (!fading && !archived && rr > 12) {
            ctx.globalAlpha = (groupActive ? 0.22 : 0.06) * (0.5 + 0.5 * p.t);
            ctx.setLineDash([2, 5]);
            ctx.beginPath();
            ctx.arc(p.x, p.y, rr * 1.12, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.globalAlpha = 1;
        }
        // 短辐条：核心 → 本团最亮的几颗代表星，让星看起来是“挂在核心上”的。
        const spokes = (clusterRanked.get(group.id) || [])
          .filter((entry) => proj.has(entry.id))
          .slice(0, 5);
        for (const entry of spokes) {
          const sp = proj.get(entry.id);
          ctx.globalAlpha = (0.07 + 0.1 * p.t) * (groupActive ? 2 : 1);
          ctx.strokeStyle = `rgba(${tint},1)`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(sp.x, sp.y);
          ctx.stroke();
        }
        // 模块核心星：比普通星大且带光晕，是这一团的视觉锚点。
        const coreR = clamp((2.6 + Math.log10(Math.max(10, group.total)) * 1.05) * clamp(p.k / 0.35, 0.9, 2.4), 2.6, 14);
        ctx.globalAlpha = (groupActive ? 0.2 : 0.08) * p.t;
        ctx.fillStyle = `rgba(${tint},1)`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, coreR * 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.9 * p.t;
        ctx.beginPath();
        ctx.arc(p.x, p.y, coreR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.95 * p.t;
        ctx.fillStyle = '#fff8e6';
        ctx.beginPath();
        ctx.arc(p.x, p.y, coreR * 0.42, 0, Math.PI * 2);
        ctx.fill();
        // 星团整体可点：点击「经历」这种聚合团就是查看子模块的入口。
        groupHits.push({ id: group.id, x: p.x, y: p.y, r: Math.max(14, rr) });
      }
      groupHitsRef.current = groupHits;

      // 星团标签单独画一遍：按团大小固定优先级，并给避让加一点“粘滞”。
      // 旋转时两个标签偶尔重叠，不会立刻消失又出现，避免标签一闪一闪被当成抖动。
      const labelGroups = [...(data.layout?.groups || [])]
        .sort((a, b) => (b.total || 0) - (a.total || 0) || (a.id < b.id ? -1 : 1));
      for (const group of labelGroups) {
        const p = project(group);
        if (!p) continue;
        if (p.x < -60 || p.x > W + 60 || p.y < -40 || p.y > H + 40) continue;
        const fs = Math.round(clamp(10 + p.t * 3, 10, 13));
        ctx.font = `${fs}px ${font}`;
        const fading = group.id === 'fading';
        const archived = group.id === 'archived';
        const tint = fading ? '255, 190, 122' : archived ? '139, 147, 167' : (groupTints.get(group.id) || GROUP_TINTS[0]);
        const rr = (group.r || 0) * p.k;
        const hot = matchedClusters.has(group.id) || groupSelected === group.id || hoverGroupRef.current === group.id;
        const text = `${group.label} · ${group.total}`;
        const lx = clamp(p.x, 50, W - 50);
        const ly = clamp(p.y - Math.max(14, rr * 0.62), 14, H - 8);
        const tw = ctx.measureText(text).width + 8;
        const bh = fs + 3;
        const boxTop = ly - fs + 2;
        const seen = labelSeenRef.current;
        const collided = boxHit(lx, boxTop + bh / 2, tw, bh);
        if (collided && !hot) {
          const lastSeen = seen.get(group.id) || 0;
          if (now - lastSeen > 1200) continue;
        }
        const fade = collided ? 0.55 : 1;
        ctx.globalAlpha = fade;
        ctx.fillStyle = `rgba(5, 10, 20, ${(0.35 + 0.3 * p.t) * fade})`;
        ctx.fillRect(lx - tw / 2, boxTop, tw, bh);
        ctx.fillStyle = hot
          ? `rgba(255, 209, 102, ${(0.5 + 0.45 * p.t) * fade})`
          : fading
            ? `rgba(255, 190, 122, ${(0.3 + 0.6 * p.t) * fade})`
            : archived
              ? `rgba(139, 147, 167, ${(0.25 + 0.5 * p.t) * fade})`
              : `rgba(${tint}, ${(0.4 + 0.55 * p.t) * fade})`;
        ctx.fillText(text, lx, ly);
        ctx.globalAlpha = 1;
        labelBoxes.push({ x: lx, y: boxTop + bh / 2, w: tw, h: bh });
        seen.set(group.id, now);
      }

      ctx.textAlign = 'center';
      ctx.globalAlpha = 1;

      // 团内子星云：点开父团后，B站 会分成美食/游戏/萌宠/其他几个小星区，
      // 子模块之间用不同色相区分，点其中任意一个就展开该模块的星。
      for (const group of data.layout?.groups || []) {
        const children = group.childClusters || [];
        if (!children.length) continue;
        // 已经聚焦别的团时，其他团的子结构先不画，避免全图都是小标签。
        if (groupSelected && groupSelected !== group.id && hoverGroupRef.current !== group.id) continue;
        const groupActive = groupSelected === group.id || hoverGroupRef.current === group.id;
        // 没聚焦时子星云随缩放连续淡入，不再到 1.8 倍突然整片跳出来。
        const childFade = groupActive ? 1 : clamp((v.zoom - 1.02) / 0.55, 0, 1);
        if (!groupActive && childFade <= 0.01) continue;
        const groupP = project(group);
        const groupTint = groupTints.get(group.id) || GROUP_TINTS[0];
        children.forEach((child, index) => {
          const point = { x: group.x + child.x, y: group.y + child.y, z: group.z + child.z };
          const p = project(point);
          if (!p) return;
          if (p.x < -50 || p.x > W + 50 || p.y < -40 || p.y > H + 40) return;
          const rr = Math.max(2, child.r * p.k);
          const tint = CHILD_TINTS[index % CHILD_TINTS.length];
          const chosen = groupSelected === group.id && groupChild === child.id;
          // 父团核心 → 子星云核心的层级射线：只在聚焦这个团时亮，像视频里中枢射向长期记忆库的那束光。
          if (groupActive && groupP) {
            ctx.globalAlpha = (chosen ? 0.42 : 0.2) * p.t;
            ctx.strokeStyle = `rgba(${groupTint},1)`;
            ctx.lineWidth = chosen ? 1.6 : 1.1;
            ctx.beginPath();
            ctx.moveTo(groupP.x, groupP.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
          ctx.globalAlpha = (groupActive ? 0.06 + 0.1 * p.t : 0.03) * childFade;
          ctx.fillStyle = `rgba(${tint},1)`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 1.35, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = (chosen ? 0.55 : groupActive ? 0.24 : 0.12) * childFade;
          ctx.strokeStyle = chosen ? '#ffd166' : `rgb(${tint})`;
          ctx.lineWidth = chosen ? 1.8 : 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
          ctx.stroke();
          // 子星云核心 + 短辐条：和父团核心同一套语法，层级越深核心越小。
          const coreR = clamp(rr * 0.22, 1.6, 7);
          ctx.globalAlpha = (chosen ? 0.28 : 0.12) * p.t * childFade;
          ctx.fillStyle = `rgba(${tint},1)`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, coreR * 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.8 * p.t * childFade;
          ctx.beginPath();
          ctx.arc(p.x, p.y, coreR, 0, Math.PI * 2);
          ctx.fill();
          if (groupActive) {
            const kids = (childRanked.get(child.id) || [])
              .filter((entry) => proj.has(entry.id))
              .slice(0, 6);
            ctx.strokeStyle = `rgba(${tint},1)`;
            ctx.lineWidth = 1;
            for (const entry of kids) {
              const kp = proj.get(entry.id);
              ctx.globalAlpha = (chosen ? 0.26 : 0.12) * p.t;
              ctx.beginPath();
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(kp.x, kp.y);
              ctx.stroke();
            }
          }
          if (childFade > 0.15) {
            childHits.push({
              id: child.id,
              group: group.id,
              x: p.x,
              y: p.y,
              r: Math.max(14, rr),
              point,
            });
          }
          if (groupActive) {
            const text = `${child.label} · ${child.total}`;
            ctx.globalAlpha = 1;
            ctx.font = `${Math.round(clamp(9 + p.t * 2, 9, 11))}px ${font}`;
            const tw = ctx.measureText(text).width + 8;
            const ly = clamp(p.y - rr - 8, 12, H - 10);
            const boxTop = ly - 9;
            if (!chosen && boxHit(p.x, boxTop + 6, tw, 14)) return;
            ctx.fillStyle = 'rgba(5,10,20,0.66)';
            ctx.fillRect(p.x - tw / 2, boxTop, tw, 14);
            ctx.fillStyle = chosen ? 'rgba(255,209,102,0.95)' : `rgba(${tint},0.82)`;
            ctx.fillText(text, p.x, ly);
            labelBoxes.push({ x: p.x, y: boxTop + 6, w: tw, h: 14 });
          }
        });
      }
      childHitsRef.current = childHits;
      ctx.globalAlpha = 1;
      ctx.textAlign = 'center';

      // kBase 是「缩放 1、镜头距离 1、正好在中心」时的投影比例。
      // 星星尺寸和它连续相乘：缩小时沉成细点，放大时平滑长成大星，中间没有档位切换。
      const kBase = focal / (R * 3);
      const starLabelAlpha = clamp((v.zoom - 1.75) / 0.55, 0, 1);
      const hits = [];
      const labelCandidates = [];
      // 超过 6000 颗时，缩小的全景图里非重点星点用细尘埃代替圆弧；放大后恢复完整星点，保证还能逐颗点选。
      const huge = stars.length > 6000 && v.zoom < 1.7;
      const paintStar = (star, p, emphasized) => {
        const matched = active && matchedIds.has(star.id);
        const dim = active && !matched;
        const isFocus = star.id === selected || star.id === hoverRef.current;
        const b = clamp(star.brightness, 0, 1);
        const hitLevel = clamp(Math.log1p(Math.max(0, Number(star.hits) || 0)) / 4.2, 0, 1);
        const lit = highlightIds.has(star.id);
        const tier = star.tier === 'short' || star.tier === 'core' ? star.tier : 'long';
        const mag = Math.max(0.35, p.k / kBase);
        const baseR = 0.95 + 0.3 * b + 0.3 * hitLevel + (lit ? 0.55 : 0) + (tier === 'core' ? 0.3 : 0);
        const r = clamp(baseR * Math.pow(mag, 0.46), 0.9, 6.5);
        const depthFade = 0.72 + 0.28 * p.t;
        const color = colorOf(star);
        if (dim) {
          ctx.globalAlpha = 0.1 * p.t;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.8, r * 0.8), 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          return;
        }
        if (star.invalidAt) {
          ctx.globalAlpha = 0.3 * p.t;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.42 * p.t;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
          hits.push({ id: star.id, x: p.x, y: p.y, r: Math.max(6, r + 4) });
          return;
        }
        if (huge && !lit && !isFocus && !matched) {
          ctx.globalAlpha = clamp(p.t * 0.3, 0, 0.3);
          ctx.fillStyle = color;
          ctx.fillRect(p.x, p.y, 1.2, 1.2);
          ctx.globalAlpha = 1;
          return;
        }
        // 亮星光晕很轻，只负责把固定代表星托出来，不参与闪烁。
        if (lit || isFocus || matched) {
          ctx.globalAlpha = (0.04 + 0.09 * b) * p.t * depthFade;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        // 缩小时点本来就小，透明度再降一点，284 颗叠在一起是“星云纹理”而不是一坨实心噪点；
        // 放大后尺寸过线，透明度自然回到正常值。
        const sizeAlpha = clamp(r / 2.4, 0.55, 1);
        ctx.globalAlpha = clamp(p.t * (0.22 + 0.4 * b) * depthFade * sizeAlpha, 0, 0.72);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (isFocus) {
          const len = r * 4 + 3;
          ctx.globalAlpha = clamp(0.3 * p.t, 0, 0.4);
          ctx.strokeStyle = '#ffd166';
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(p.x - len, p.y);
          ctx.lineTo(p.x + len, p.y);
          ctx.moveTo(p.x, p.y - len);
          ctx.lineTo(p.x, p.y + len);
          ctx.stroke();
        }
        if (isFocus || matched) {
          ctx.globalAlpha = (emphasized ? 0.95 : 0.8) * p.t;
          ctx.strokeStyle = '#ffd166';
          ctx.lineWidth = emphasized ? 1.6 : 1.1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + (emphasized ? 5 : 4), 0, Math.PI * 2);
          ctx.stroke();
        } else if (tier === 'core') {
          // 永久记忆：金色常亮环，不随清晰度变暗。
          ctx.globalAlpha = 0.42 * p.t;
          ctx.strokeStyle = '#ffd166';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
          ctx.stroke();
        } else if (tier === 'short') {
          // 临时候选：虚线细环，提醒它随时可能被归档。
          ctx.globalAlpha = 0.32 * p.t;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.globalAlpha = 1;
        // 小到 1px 的尘埃点不参与命中：全景下整片星云都是可点区域，点哪都能进父团；
        // 放大到能看清一颗星时，它才变成可悬停、可点击的目标。
        if (r >= 2.05) hits.push({ id: star.id, x: p.x, y: p.y, r: Math.max(5, r + 3) });
        if (!star.invalidAt && starLabelAlpha > 0 && b >= 0.3) {
          labelCandidates.push({ star, x: p.x, y: p.y, r, rank: rankOf(star) + (isFocus ? 5 : 0) });
        }
      };
      // 先画普通星和亮星，再把搜索命中/选中/悬停放到最后，保证圆环和标签不被别的点盖住。
      const deferred = [];
      for (const star of starOrder) {
        const p = proj.get(star.id);
        if (!p) continue;
        if (p.x < -40 || p.x > W + 40 || p.y < -30 || p.y > H + 30) continue;
        if (star.id === selected || star.id === hoverRef.current || (active && matchedIds.has(star.id))) {
          deferred.push([star, p]);
          continue;
        }
        paintStar(star, p, false);
      }
      for (const [star, p] of deferred) paintStar(star, p, true);
      hitsRef.current = hits;

      // 记忆中枢：太阳状核心，星团金线汇聚在这里
      // 镜头飞进小星云时中枢会被压在画面正中，按镜头距离淡出，避免挡住子星云。
      const hubFade = clamp((v.camScale - 0.55) / 0.3, 0, 1);
      const pulse = motion ? 1 + Math.sin(now * 0.0007) * 0.018 : 1;
      const hubR = Math.max(7, Math.min(W, H) * 0.016) * pulse;
      if (motion && hubFade > 0) {
        for (let i = 0; i < 10; i += 1) {
          const angle = now * 0.00002 + i * Math.PI / 5;
          const len = hubR * (2.6 + (i % 4) * 0.5);
          ctx.globalAlpha = 0.5 * hubFade;
          ctx.strokeStyle = `rgba(255, 209, 102, ${0.05 + (i % 3) * 0.025})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(W / 2 + Math.cos(angle) * hubR * 1.2, H / 2 + Math.sin(angle) * hubR * 1.2);
          ctx.lineTo(W / 2 + Math.cos(angle) * len, H / 2 + Math.sin(angle) * len);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 0.05 * hubFade;
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, hubR * 4.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.12 * hubFade;
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, hubR * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.55 * hubFade;
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, hubR * 1.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.95 * hubFade;
      ctx.fillStyle = '#fff6d8';
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, hubR, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = hubFade;
      if (hubFade > 0.02) {
        ctx.fillStyle = 'rgba(255, 231, 163, 0.9)';
        ctx.font = `13px ${font}`;
        ctx.fillText('记忆中枢', W / 2, H / 2 - hubR - 12);
        ctx.fillStyle = 'rgba(255, 231, 163, 0.45)';
        ctx.font = `11px ${font}`;
        ctx.fillText(`${data.stats?.total || 0} 条记忆`, W / 2, H / 2 + hubR + 18);
      }

      // 放大后给清晰、重要的单星补标签；透明度随缩放连续出现，不会到某个倍数突然冒出来。
      if (labelCandidates.length && starLabelAlpha > 0) {
        labelCandidates.sort((a, b) => b.rank - a.rank || (a.star.id < b.star.id ? -1 : 1));
        ctx.font = `11px ${font}`;
        let shown = 0;
        for (const item of labelCandidates) {
          if (shown >= 12) break;
          const text = `${shortText(item.star.aboutName || (item.star.tags && item.star.tags[0]) || '记忆', 10)} · ${Math.round(item.star.brightness * 100)}%`;
          const width = ctx.measureText(text).width + 10;
          const left = clamp(item.x - width / 2, 6, W - width - 6);
          const top = clamp(item.y + item.r + 6, 12, H - 21);
          if (boxHit(left + width / 2, top + 7, width, 15)) continue;
          ctx.globalAlpha = starLabelAlpha;
          ctx.fillStyle = 'rgba(5, 10, 20, 0.72)';
          ctx.fillRect(left, top, width, 15);
          ctx.fillStyle = item.star.id === selected ? 'rgba(255, 209, 102, 0.95)' : 'rgba(198, 218, 244, 0.85)';
          ctx.textAlign = 'left';
          ctx.fillText(text, left + 5, top + 11);
          ctx.globalAlpha = 1;
          labelBoxes.push({ x: left + width / 2, y: top + 7, w: width, h: 15 });
          shown += 1;
        }
        ctx.textAlign = 'center';
      }

      const focus = hoverRef.current || selected;
      const fp = focus ? proj.get(focus) : null;
      const fs = focus ? starsById.get(focus) : null;
      if (fp && fs) {
        ctx.font = `11px ${font}`;
        const text = `${fs.aboutName || '杂项'} · ${Math.round(fs.brightness * 100)}%`;
        const width = ctx.measureText(text).width + 12;
        const left = clamp(fp.x - width / 2, 6, W - width - 6);
        const top = fp.y > 32 ? fp.y - 26 : Math.min(H - 22, fp.y + 16);
        ctx.fillStyle = 'rgba(16, 24, 40, 0.92)';
        ctx.fillRect(left, top, width, 18);
        ctx.fillStyle = 'rgba(226, 236, 250, 0.9)';
        ctx.textAlign = 'left';
        ctx.fillText(text, left + 6, top + 13);
      }
      ctx.globalAlpha = 0.38;
      ctx.fillStyle = '#9fb6d8';
      ctx.font = `11px ${font}`;
      ctx.textAlign = 'left';
      ctx.fillText('拖拽旋转 · 滚轮缩放 · 点星/星团查看', 12, H - 12);
      ctx.fillText(
        childFocus
          ? (groupChildInfo ? `子星云：${groupChildInfo.label}` : '团内子星云：点一个小星云展开')
          : tierFilter ? `只看${TIER_LABEL[tierFilter]}记忆 · ${matchedIds.size} 颗`
            : huge ? `大量记忆：${stars.length} 颗星，普通星点自动简化` : '全部星星常驻显示',
        12, H - 28,
      );
      ctx.textAlign = 'right';
      ctx.fillText(`×${v.zoom.toFixed(1)}`, W - 12, 18);
      ctx.fillText(`全部 ${stars.length} 颗`, W - 12, 34);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'center';
    };

    const tick = (time) => {
      const dt = Math.min(0.05, (time - last) / 1000);
      last = time;
      if (!v.dragging) {
        if (v.focusId) {
          const dy = ((v.fYaw - v.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
          v.yaw += dy * Math.min(1, dt * 4.5);
          v.pitch += (v.fPitch - v.pitch) * Math.min(1, dt * 4.5);
          v.vYaw = 0;
          v.vPitch = 0;
        } else {
          v.yaw += v.vYaw * dt * 60;
          v.pitch = clamp(v.pitch + v.vPitch * dt * 60, -1.25, 1.25);
          const decay = Math.pow(0.9, dt * 60);
          v.vYaw *= decay;
          v.vPitch *= decay;
          // 只有选中星星或星团时才暂停；拖动本身也会暂停，鼠标移动和缩放都继续转。
          if (spin && !selected && !groupSelected) v.yaw += dt * 0.05;
        }
      }
      v.zoom += (v.targetZoom - v.zoom) * Math.min(1, dt * 9);
      const camLerp = Math.min(1, dt * 3.6);
      v.cam.x += (v.camTarget.x - v.cam.x) * camLerp;
      v.cam.y += (v.camTarget.y - v.cam.y) * camLerp;
      v.cam.z += (v.camTarget.z - v.cam.z) * camLerp;
      v.camScale += (v.camScaleTarget - v.camScale) * camLerp;
      draw(time);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data, selected, groupSelected, groupChild, spin, glow, motion, query, typeFilter, quickFilter, tierFilter, edgeOn, edgeMode, edgeStrength, edgeMax, edgeKindsKey]);

  const resetView = () => {
    const v = viewRef.current;
    v.yaw = 0.45;
    v.pitch = 0.32;
    v.targetZoom = 1;
    v.vYaw = 0;
    v.vPitch = 0;
    v.focusId = null;
    v.camTarget = { x: 0, y: 0, z: 0 };
    v.camScaleTarget = 1;
  };

  const onPointerDown = (event) => {
    const v = viewRef.current;
    v.dragging = true;
    v.focusId = null;
    v.lastX = event.clientX;
    v.lastY = event.clientY;
    v.downT = performance.now();
    v.moved = 0;
    v.vYaw = 0;
    v.vPitch = 0;
    if (hoverRef.current) { hoverRef.current = ''; setHover(''); }
    if (hoverGroupRef.current) { hoverGroupRef.current = ''; setHoverGroup(''); }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    const v = viewRef.current;
    if (!v.dragging) {
      const hit = pick(event);
      const starId = hit?.type === 'star' ? hit.id : '';
      const clusterId = hit?.type === 'group' ? hit.id : '';
      if (starId !== hoverRef.current) { hoverRef.current = starId; setHover(starId); }
      if (clusterId !== hoverGroupRef.current) { hoverGroupRef.current = clusterId; setHoverGroup(clusterId); }
      return;
    }
    const dx = event.clientX - v.lastX;
    const dy = event.clientY - v.lastY;
    v.lastX = event.clientX;
    v.lastY = event.clientY;
    v.moved += Math.abs(dx) + Math.abs(dy);
    v.yaw += dx * 0.005;
    v.pitch = clamp(v.pitch + dy * 0.005, -1.25, 1.25);
    v.vYaw = dx * 0.0009;
    v.vPitch = dy * 0.0009;
  };

  const onPointerUp = (event) => {
    const v = viewRef.current;
    if (!v.dragging) return;
    v.dragging = false;
    if (v.moved >= 6 || performance.now() - v.downT >= 500) return;
    const hit = pick(event);
    if (!hit) {
      setSelected('');
      setGroupSelected('');
      setGroupChild('');
      resetView();
      return;
    }
    if (hit.type === 'star') {
      setSelected(hit.id);
      // 在已聚焦的团/子星云里点星，保留当前聚焦上下文，避免分级显示突然变密；
      // 普通点星（没聚焦任何团）仍然收起星团卡。
      const inFocus = Boolean(groupSelected) && stars.find((star) => star.id === hit.id)?.cluster === groupSelected;
      if (!inFocus) { setGroupSelected(''); setGroupChild(''); }
      return;
    }
    if (hit.type === 'child') {
      setSelected('');
      setGroupSelected(hit.group);
      setGroupChild(hit.id);
      focusPoint(hit.point, 2.6, 0.26);
      return;
    }
    setSelected('');
    setGroupSelected(hit.id);
    setGroupChild('');
    const group = layoutGroups.find((item) => item.id === hit.id);
    if (group) focusPoint(group, 1.9, 0.45);
  };

  const refresh = async () => {
    setBusy('sync');
    try { const r = await call('/sync', {}); if (r.message) toast(r.message); await load(day); }
    catch (e) { toast(e.message); }
    finally { setBusy(''); }
  };

  const optimizeLayout = async () => {
    if (day > 0) { toast('切回「现在」才能优化位置'); return; }
    setBusy('optimize');
    try { const r = await call('/optimize', {}); if (r.message) toast(r.message); await load(0); }
    catch (e) { toast(e.message); }
    finally { setBusy(''); }
  };

  const confirmReview = async () => {
    if (!selectedStar) return;
    if (dirty) { toast('请先点击底部“保存设置”，再确认还记得。'); return; }
    const id = selectedStar.id;
    const fromFading = selectedStar.cluster === 'fading';
    const following = viewRef.current.focusId === id;
    setBusy('review');
    try {
      const r = await call('/review', { id });
      toast(r.ok && fromFading ? '记住了，这颗星已回到原星团' : (r.message || (r.ok ? '记住了' : '没成功')));
      const next = await load(0);
      // 如果之前正聚焦这颗星，复习后跟着它回到原星团，别把镜头留在空的快忘区。
      const moved = r.ok && fromFading && following && next ? (next.stars || []).find((s) => s.id === id) : null;
      if (moved) focusOn(moved);
    } catch (e) { toast(e.message); }
    finally { setBusy(''); }
  };

  const changeTier = async (tier) => {
    if (!selectedStar) return;
    if (day !== 0) { toast('回看历史时不能改层级'); return; }
    setBusy('tier');
    try {
      const r = await call('/tier', { id: selectedStar.id, tier });
      toast(r?.ok ? (r.message || '已改层级') : (r?.message || '改不了层级'));
      if (r?.ok) await load(day);
    } catch (e) { toast(e?.message || '改不了层级'); }
    finally { setBusy(''); }
  };

  const chooseTier = (tier) => {
    setListTier(tier);
    setTierPage(0);
    setTierFilter(tier);
  };

  const focusRow = (star) => {
    if (!star) return;
    setSelected(star.id);
    setEditing(null);
    setConfirming(false);
    focusOn(star);
    try { wrapRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
  };

  const addMemory = async () => {
    if (day > 0) { toast('回看历史时不能新增'); return; }
    const text = String(addForm.text || '').trim();
    if (!text) { toast('内容不能为空'); return; }
    setBusy('add');
    try {
      const r = await call('/add', {
        text,
        importance: Number(addForm.importance) || 0.5,
        tags: String(addForm.tags || '').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean),
        tier: listTier,
      });
      toast(r?.ok ? (r.message || '已新增') : (r?.message || '新增失败'));
      if (r?.ok) {
        setAddForm({ text: '', importance: 0.5, tags: '' });
        setAdding(false);
        setTierFilter(listTier);
        await load(day);
      }
    } catch (e) { toast(e?.message || '新增失败'); }
    finally { setBusy(''); }
  };

  const saveRowEdit = async () => {
    if (!rowEditing) return;
    const text = String(rowEditing.text || '').trim();
    if (!text) { toast('内容不能为空'); return; }
    setBusy('row-edit');
    try {
      const r = await call('/update', { id: rowEditing.id, patch: { text, importance: Number(rowEditing.importance) || 0.5 } });
      toast(r?.ok ? (r.message || '已保存') : (r?.message || '保存失败'));
      if (r?.ok) { setRowEditing(null); await load(day); }
    } catch (e) { toast(e?.message || '保存失败'); }
    finally { setBusy(''); }
  };

  const removeRow = async (id) => {
    setBusy('row-remove');
    try {
      const r = await call('/remove', { id });
      toast(r?.ok ? (r.message || '已删除') : (r?.message || '删除失败'));
      if (r?.ok) { setRowConfirm(''); await load(day); }
    } catch (e) { toast(e?.message || '删除失败'); }
    finally { setBusy(''); }
  };

  const moveRowTier = async (id, tier) => {
    setBusy('row-tier');
    try {
      const r = await call('/tier', { id, tier });
      toast(r?.ok ? (r.message || '已换层') : (r?.message || '换层失败'));
      if (r?.ok) await load(day);
    } catch (e) { toast(e?.message || '换层失败'); }
    finally { setBusy(''); }
  };

  const startEdit = () => {
    if (!selectedStar) return;
    setConfirming(false);
    setEditing({ text: selectedStar.text, importance: selectedStar.importance });
  };

  const saveEdit = async () => {
    if (!selectedStar || !editing) return;
    const text = String(editing.text || '').trim();
    if (!text) { toast('内容不能为空'); return; }
    setBusy('edit');
    try {
      const r = await call('/update', { id: selectedStar.id, patch: { text, importance: editing.importance } });
      toast(r.message || (r.ok ? '已修改' : '没成功'));
      if (r.ok) setEditing(null);
      await load(day);
    } catch (e) { toast(e.message); }
    finally { setBusy(''); }
  };

  const deleteStar = async () => {
    if (!selectedStar || !enabled) return;
    setBusy('remove');
    try {
      const r = await call('/remove', { id: selectedStar.id });
      toast(r.message || (r.ok ? '已删除' : '没成功'));
      if (r.ok) { setSelected(''); setEditing(null); setConfirming(false); }
      await load(day);
    } catch (e) { toast(e.message); }
    finally { setBusy(''); }
  };

  const restoreStar = async () => {
    if (!selectedStar || !enabled || day > 0) return;
    const id = selectedStar.id;
    const following = viewRef.current.focusId === id;
    setBusy('restore');
    try {
      const r = await call('/restore', { id });
      toast(r.message || (r.ok ? '已恢复' : '没成功'));
      if (r.ok) {
        const next = await load(0);
        const moved = following && next ? (next.stars || []).find((star) => star.id === id) : null;
        if (moved) focusOn(moved);
      }
    } catch (e) { toast(e?.message || '恢复失败'); }
    finally { setBusy(''); }
  };

  const number = (key, min, max, step) => h('input', {
    className: 'ab-input', type: 'number', min, max, step: step || 1, value: cfg[key] ?? '',
    style: { width: 100 },
    onChange: (e) => set(key, e.target.value === '' ? '' : Number(e.target.value)),
    onBlur: (e) => set(key, Math.min(max, Math.max(min, Number(e.target.value) || min))),
  });

  const vnum = (key, min, max, step) => h('input', {
    className: 'ab-input', type: 'number', min, max, step: step || 1, value: vcfg[key] ?? '',
    style: { width: 100 },
    onChange: (e) => setVcfg((cur) => ({ ...cur, [key]: e.target.value === '' ? '' : Number(e.target.value) })),
    onBlur: (e) => saveVector({ [key]: Math.min(max, Math.max(min, Number(e.target.value) || min)) }),
  });

  const settingText = (key, placeholder) => h('input', {
    className: 'ab-input',
    value: cfg[key] ?? '',
    placeholder,
    style: { flex: '1 1 160px', minWidth: 140, boxSizing: 'border-box' },
    onChange: (e) => set(key, e.target.value),
  });

  const legend = Object.entries(REGION).map(([key, meta]) => h('span', { key, className: 'ab-small ab-muted', style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 12 } },
    h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: meta.color, opacity: 0.85 } }), meta.label));

  const hudBtn = (label, onClick, title) => h('button', {
    type: 'button', title, onClick,
    style: {
      width: 28, height: 28, borderRadius: 14, padding: 0, lineHeight: 1, cursor: 'pointer',
      border: '1px solid rgba(148,180,220,0.35)', background: 'rgba(10,18,32,0.72)', color: '#cfe1ff', fontSize: 14,
    },
  }, label);

  const chip = (label, on, onClick, title, key) => h(ui.Btn, {
    key,
    small: true,
    ...(on ? { kind: 'primary' } : {}),
    title,
    onClick,
  }, label);

  const stats = data?.stats;
  return h('div', { className: 'ab-grid' },
    !editable ? h('p', { className: 'ab-note' }, '当前 Aurabot 面板缺少草稿接口，请更新面板后使用底部统一保存。') : null,
    h(ui.Card, {
      title: '记忆中枢',
      right: h(ui.Switch, { on: enabled, disabled: !editable, title: '记忆中枢总开关；关闭后不提供星图和联想工具，也不能在面板里改记忆；内置记忆本身保留', onChange: (value) => set('enabled', value) }),
      desc: '读取内置记忆，不写第二套记忆库；星图看清晰度和层级，也能直接复习、改删、新增；联想与向量增强只给提示，不改记忆内容。',
    },
      h('div', { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
        h(ui.Btn, { small: true, onClick: () => setMapSettingsOpen((value) => !value) }, mapSettingsOpen ? '收起星图设置' : '展开星图设置'),
        h('span', { className: 'ab-small ab-muted' }, day === 0 ? '现在' : `回看 ${day} 天前`),
        h('span', { className: 'ab-small ab-muted' }, spin ? '自动旋转' : '已暂停旋转'),
        h('span', { className: 'ab-small ab-muted' }, edgeOn ? (edgeMode === 'focus' ? '关系线：只在选中' : edgeMode === 'subtle' ? '关系线：微光' : '关系线：标准') : '关系线关闭'),
        h('span', { className: 'ab-small ab-muted' }, `快照保留 ${Number(cfg.keepDays) || 30} 天`),
      ),
      mapSettingsOpen ? h('div', null,
        h(ui.Row, { label: '回看', hint: '拖动查看过去 30 天里这颗星有多亮；有快照的日期显示的是当时的亮度。' },
          h(ui.Range, { value: day, min: 0, max: 30, step: 1, onChange: setDay, fmt: (v) => (v === 0 ? '现在' : `${v} 天前`) })),
        h(ui.Row, { label: '快照保留', hint: '每天同步时存一份亮度快照，用来回看；7～60 天。' }, number('keepDays', 7, 60), ' 天'),
        h(ui.Row, { label: '自动旋转', hint: '只有选中星星/星团或拖动时暂停，其余时间一直慢慢转。' },
          h(ui.Switch, { on: spin, disabled: !editable, onChange: (value) => set('spin', value) })),
        h(ui.Row, { label: '辉光', hint: '星空柔光、亮星光晕和太阳脉动；觉得费性能可以关掉。' },
          h(ui.Switch, { on: glow, disabled: !editable, onChange: (value) => set('glow', value) })),
        h(ui.Row, { label: '关系线', hint: '总开关；关掉后选中也不画关系线。' },
          h(ui.Switch, { on: edgeOn, disabled: !editable, onChange: (value) => set('edgeOn', value) })),
        edgeOn ? h(ui.Row, { label: '显示模式', hint: '只在选中：平时不画跨团线；微光/标准：常驻显示。' },
          h('div', { className: 'ab-flex', style: { gap: 4, flexWrap: 'wrap' } },
            [['focus', '只在选中'], ['subtle', '微光常驻'], ['normal', '标准常驻']].map(([mode, label]) => chip(
              label,
              edgeMode === mode,
              () => set('edgeMode', mode),
              `关系线：${label}`,
              `mode-${mode}`,
            )))) : null,
        edgeOn ? h(ui.Row, { label: '线条强度', hint: '白色细线浓淡；随缩放线性变化，默认 30%。' },
          h(ui.Range, {
            value: edgeStrength, min: 0, max: 1, step: 0.05,
            onChange: (value) => set('edgeStrength', value),
            fmt: (value) => `${Math.round(value * 100)}%`,
          })) : null,
        edgeOn && edgeMode !== 'focus' ? h(ui.Row, { label: '最多常驻线', hint: '只影响常驻模式；选中线不受限。' },
          h(ui.Range, {
            value: edgeMax, min: 10, max: 120, step: 10,
            onChange: (value) => set('edgeMax', value),
            fmt: (value) => `${value} 条`,
          })) : null,
        edgeOn ? h(ui.Row, { label: '显示类型', hint: '关掉某一类就不画对应的线；联想线来自记忆增强。' },
          h('div', { className: 'ab-flex', style: { gap: 4, flexWrap: 'wrap' } },
            EDGE_KINDS.map((kind) => chip(
              EDGE_KIND[kind].label,
              edgeKinds.includes(kind),
              () => toggleEdgeKind(kind),
              `显示/隐藏${EDGE_KIND[kind].label}关系线`,
              `kind-${kind}`,
            )))) : null,
      ) : null,
      h('div', { className: 'ab-flex' }, legend,
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: refresh }, busy === 'sync' ? '同步中…' : '刷新')),
    ),
    h(ui.Card, {
      title: '星图',
      right: h('div', { className: 'ab-flex' },
        stats ? h('span', { className: 'ab-small ab-muted' }, `共 ${stats.total} 条 · ${stats.clusters || 0} 团 · 永久 ${stats.tiers?.core || 0} · 临时 ${stats.tiers?.short || 0} · 清晰 ${stats.bright} · 快忘了 ${stats.dim} · 已归档 ${stats.archived || 0} · 已过时 ${stats.outdated}`) : null,
        h(ui.Btn, {
          small: true,
          disabled: Boolean(busy) || day > 0,
          onClick: optimizeLayout,
          title: day > 0 ? '切回「现在」才能优化位置' : '让星团立即朝均匀分布收敛，不用等后台慢慢微调',
        }, busy === 'optimize' ? '优化中…' : '优化位置'),
        h(ui.Btn, { small: true, onClick: resetView, title: '回到初始角度和缩放' }, '复位视角')),
      desc: day > 0 ? `正在看 ${data?.day || ''} 的快照${data?.snapshotted ? '' : '（那天没有存快照，显示的是当前亮度）'}。` : '按人物、标签和时间自动聚成星团；亮度直接用记忆模块的遗忘曲线，低于 35% 进「快忘了」星团。永久记忆金色常亮、临时记忆虚线环，其余按层级正常衰减。所有星星常驻显示，缩小时是星云密度，放大后逐颗看清。拖拽旋转 · 滚轮缩放 · 点星查看。',
    },
      error ? h('div', { className: 'ab-note err' }, error) : null,
      data && stars.length ? h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
        h('input', {
          className: 'ab-input',
          value: query,
          placeholder: '搜索记忆、人物或标签',
          style: { flex: '1 1 180px', minWidth: 150, boxSizing: 'border-box' },
          onChange: (e) => setQuery(e.target.value),
        }),
        chip('全部', !activeFilter, () => { setQuery(''); setTypeFilter(''); setQuickFilter(''); setTierFilter(''); setGroupSelected(''); setGroupChild(''); }, '清空搜索和筛选，显示全部记忆'),
        Object.entries(REGION).map(([key, meta]) => chip(meta.label, typeFilter === key, () => {
          setTypeFilter(typeFilter === key ? '' : key);
          setQuickFilter('');
        }, `只看${meta.label}`, key)),
        chip('快忘了', quickFilter === 'dim', () => {
          setQuickFilter(quickFilter === 'dim' ? '' : 'dim');
          setTypeFilter('');
        }, '只看清晰度低于 35% 的记忆'),
        chip('最近', quickFilter === 'recent', () => {
          setQuickFilter(quickFilter === 'recent' ? '' : 'recent');
          setTypeFilter('');
        }, '只看 7 天内想起过的记忆'),
      ) : null,
      activeFilter && stars.length ? h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
        h('span', { className: 'ab-small ab-muted' }, `匹配 ${matches.length} 条`),
        matches.slice(0, 6).map((star) => h(ui.Btn, {
          key: star.id,
          small: true,
          onClick: () => { setSelected(star.id); setGroupSelected(''); setGroupChild(''); focusOn(star); },
          title: star.text,
        }, `${shortText(star.aboutName || (star.tags && star.tags[0]) || '记忆', 8)} · ${Math.round(star.brightness * 100)}%`)),
        matches.length > 6 ? h('span', { className: 'ab-small ab-muted' }, `另有 ${matches.length - 6} 条`) : null,
      ) : null,
      !data ? h(ui.Empty, { icon: '🌌', text: '正在读记忆库…' }) : stars.length === 0 ? h(ui.Empty, { icon: '🌑', text: data.message || '还没有可画的记忆。等内置记忆写入后再来。' }) :
        h('div', { ref: wrapRef, style: { position: 'relative', width: '100%', overflow: 'hidden', borderRadius: 10, touchAction: 'none' } },
          h('canvas', {
            ref: canvasRef,
            style: { display: 'block', cursor: hover || hoverGroup ? 'pointer' : 'grab', touchAction: 'none' },
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: () => { viewRef.current.dragging = false; },
            onPointerLeave: () => {
              hoverRef.current = '';
              hoverGroupRef.current = '';
              setHover('');
              setHoverGroup('');
            },
          }),
          // 左侧模块清单：常驻图例 + 导航，点父团/子星云直接聚焦，和画布点击是同一套行为。
          h('div', {
            className: 'mc-thin-scroll',
            style: {
              position: 'absolute', left: 10, top: groupInfo ? 46 : 10, width: 152, maxHeight: '52%',
              overflowY: 'auto', zIndex: 2, padding: '3px 4px',
              background: 'rgba(6, 11, 22, 0.6)', border: '1px solid rgba(120, 160, 220, 0.2)', borderRadius: 8,
            },
          },
          h('div', {
            onClick: () => setLegendOpen((value) => !value),
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 4px 4px', cursor: 'pointer' },
          },
          h('span', { style: { fontSize: 10, letterSpacing: 1, color: 'rgba(178, 204, 240, 0.7)' } }, '模块'),
          h('span', { style: { fontSize: 10, color: 'rgba(178, 204, 240, 0.6)' } }, legendOpen ? '－' : '＋')),
          h('div', {
            style: { padding: '0 0 6px', marginBottom: 4, borderBottom: '1px solid rgba(120, 160, 220, 0.18)' },
          },
          h('div', { style: { fontSize: 10, letterSpacing: 1, color: 'rgba(178, 204, 240, 0.7)', padding: '0 4px 4px' } }, '层级'),
          ['core', 'long', 'short'].map((tier) => {
            const active = tierFilter === tier;
            const tint = tier === 'core' ? '255, 209, 102' : tier === 'short' ? '159, 182, 216' : '143, 197, 255';
            return h('div', {
              key: tier,
              onClick: () => setTierFilter(active ? '' : tier),
              title: active ? '再点一次查看全部层级' : `只看${TIER_LABEL[tier]}记忆`,
              style: {
                display: 'flex', alignItems: 'center', gap: 6, padding: '2px 5px', borderRadius: 5, cursor: 'pointer',
                background: active ? 'rgba(255, 209, 102, 0.12)' : 'transparent',
              },
            },
            h('span', { style: { width: 7, height: 7, flex: '0 0 auto', borderRadius: '50%', background: `rgb(${tint})`, boxShadow: `0 0 6px rgba(${tint}, 0.7)` } }),
            h('span', { style: { flex: '1 1 auto', fontSize: 11, color: active ? '#ffd166' : 'rgba(226, 236, 255, 0.86)' } }, TIER_LABEL[tier]),
            h('span', { style: { fontSize: 10, color: 'rgba(178, 204, 240, 0.55)' } }, String(tierCounts[tier] || 0)));
          })),
          legendOpen ? layoutGroups.map((group) => {
            const tint = group.id === 'fading' ? '255, 190, 122' : group.id === 'archived' ? '139, 147, 167' : (groupTints.get(group.id) || GROUP_TINTS[0]);
            const active = groupSelected === group.id;
            const children = group.childClusters || [];
            return h('div', { key: group.id },
              h('div', {
                onClick: () => {
                  setSelected('');
                  setGroupSelected(group.id);
                  setGroupChild('');
                  focusPoint(group, 1.9, 0.45);
                },
                style: {
                  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 5px', borderRadius: 5, cursor: 'pointer',
                  background: active ? 'rgba(255, 209, 102, 0.12)' : 'transparent',
                },
              },
              h('span', {
                style: {
                  width: 7, height: 7, flex: '0 0 auto', borderRadius: '50%',
                  background: `rgb(${tint})`, boxShadow: `0 0 6px rgba(${tint}, 0.7)`,
                },
              }),
              h('span', {
                style: {
                  flex: '1 1 auto', minWidth: 0, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  color: active ? '#ffd166' : 'rgba(226, 236, 255, 0.86)',
                },
              }, shortText(group.label, 8)),
              h('span', { style: { fontSize: 10, color: 'rgba(178, 204, 240, 0.55)' } }, group.total)),
              active ? children.map((child, index) => {
                const childTint = CHILD_TINTS[index % CHILD_TINTS.length];
                return h('div', {
                  key: child.id,
                  onClick: (event) => {
                    event.stopPropagation();
                    setSelected('');
                    setGroupChild(child.id);
                    focusPoint({ x: group.x + child.x, y: group.y + child.y, z: group.z + child.z }, 2.6, 0.26);
                  },
                  style: {
                    display: 'flex', alignItems: 'center', gap: 6, padding: '2px 5px 2px 18px', borderRadius: 5, cursor: 'pointer',
                    background: groupChild === child.id ? 'rgba(255, 209, 102, 0.1)' : 'transparent',
                  },
                },
                h('span', {
                  style: {
                    width: 5, height: 5, flex: '0 0 auto', borderRadius: '50%',
                    background: `rgb(${childTint})`, boxShadow: `0 0 5px rgba(${childTint}, 0.7)`,
                  },
                }),
                h('span', {
                  style: {
                    flex: '1 1 auto', minWidth: 0, fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    color: groupChild === child.id ? '#ffd166' : 'rgba(214, 226, 245, 0.78)',
                  },
                }, shortText(child.label, 9)),
                h('span', { style: { fontSize: 9, color: 'rgba(178, 204, 240, 0.5)' } }, child.total));
              }) : null);
          }) : null),
          groupInfo ? h('div', {
            style: { position: 'absolute', left: 10, top: 10, display: 'flex', gap: 6, alignItems: 'center', zIndex: 2 },
          },
          h(ui.Btn, {
            small: true,
            onClick: () => { setGroupSelected(''); setGroupChild(''); resetView(); },
            title: '回到全部星团',
          }, '全部'),
          h('span', { className: 'ab-small ab-muted' }, '›'),
          h(ui.Btn, {
            small: true,
            onClick: () => { setGroupChild(''); focusPoint(groupInfo, 1.9, 0.45); },
            title: '返回父团，查看所有子星云',
          }, shortText(groupInfo.label, 10)),
          groupChildInfo ? h('span', { className: 'ab-small ab-muted' }, '›') : null,
          groupChildInfo ? h('span', { className: 'ab-small', style: { color: '#ffd166' } }, shortText(groupChildInfo.label, 10)) : null,
          ) : null,
          h('div', { style: { position: 'absolute', right: 10, bottom: 10, display: 'flex', gap: 6 } },
            hudBtn('＋', () => zoomBy(1.25), '放大'),
            hudBtn('－', () => zoomBy(0.8), '缩小'),
            hudBtn('⟲', resetView, '复位视角'))),
      data && stars.length ? h('p', { className: 'ab-note' }, `图里 ${stars.length} 颗星全部常驻显示，按模块和小星云分色分层；缩小时看星云密度，放大后逐颗看清。点星团或左侧清单可以钻进小星云。`) : null,
    ),
    h(ui.Card, {
      title: '记忆增强',
      desc: '一页管三件事：记忆向量（按意思找）、记忆联想（按名字串关系）和每日读写（默认关闭，需要时再打开）。写入和整理默认由内置记忆负责，中枢只读。用量模式只影响后续调用，不重写任何记忆。',
      right: h('div', { className: 'ab-flex' },
        enhanceOpen ? h(ui.Btn, { small: true, disabled: Boolean(enhanceBusy), onClick: () => loadEnhance(false) }, '刷新状态') : null,
        h(ui.Btn, { small: true, onClick: () => { setEnhanceOpen((value) => !value); if (!enhanceOpen) loadEnhance(false); } }, enhanceOpen ? '收起' : '展开')),
    },
      h('div', { className: 'ab-flex', style: { gap: 12, flexWrap: 'wrap', marginBottom: enhanceOpen ? 8 : 0 } },
        h('span', { className: 'ab-small ab-muted' }, !vst ? '向量读取中' : vst.ok ? `向量 ${vst.indexed} / ${vst.total}` : (vst.message || '向量未运行')),
        h('span', { className: 'ab-small ab-muted' }, !ast ? '联想读取中' : ast.ok ? `实体 ${ast.entities || 0} · 记忆边 ${ast.edges || 0} · 人物边 ${ast.personEdges || 0}` : (ast.message || '联想未运行')),
      ),
      h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } },
        h('span', { className: 'ab-small ab-muted' }, '用量模式'),
        TOKEN_MODE_ORDER.map((mode) => h(ui.Btn, {
          key: mode,
          small: true,
          kind: tokenMode === mode ? 'primary' : undefined,
          disabled: !editable,
          onClick: () => applyTokenMode(mode),
        }, TOKEN_MODES[mode].label)),
        tokenModeDirty ? h('span', { className: 'ab-badge' }, '自定义') : null,
      ),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 5, marginBottom: 8 } },
        tokenPreset
          ? `${tokenPreset.desc} 回答侧参考：${tokenPreset.estimate}${tokenModeDirty ? '（当前参数已手动调整）' : ''}`
          : '当前参数是手动组合，未套用四档预设。',
      ),
      h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8, marginBottom: 8 } },
        h('span', { className: 'ab-badge' }, ast?.recallTakeover ? '自动回忆：记忆中枢' : '自动回忆：内置记忆'),
        h('span', { className: 'ab-badge' }, '写入与整理：内置记忆'),
        h('span', { className: 'ab-badge' }, pst?.forgetActive ? '遗忘：记忆中枢' : '遗忘：内置记忆')),
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } },
        ast?.recallTakeover
          ? `当前由记忆中枢统一生成一段「你记得这些事」：直接召回 ${ast.directCount ?? cfg.directCount ?? 4} 条，再合并关系联想；内置不再单独召回。`
          : '内置记忆在提供直接召回；记忆中枢只做关系联想补充。'),
      h(ui.Row, { label: '自动回忆由记忆中枢接管', hint: '关闭内置记忆的每轮召回，由中枢统一做关键词+向量直接召回和关系联想。需要记忆（向量版）0.4.4+。' },
        h(ui.Switch, { on: cfg.takeoverRecall !== false, disabled: !editable, onChange: (value) => set('takeoverRecall', value) })),
      enhanceOpen ? h('div', null,
        h('div', { className: 'ab-flex', style: { gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
          h(ui.Btn, { small: true, kind: enhanceTab === 'vector' ? 'primary' : undefined, onClick: () => setEnhanceTab('vector') }, '记忆向量'),
          h(ui.Btn, { small: true, kind: enhanceTab === 'assoc' ? 'primary' : undefined, onClick: () => setEnhanceTab('assoc') }, '记忆联想'),
          h(ui.Btn, { small: true, kind: enhanceTab === 'pipeline' ? 'primary' : undefined, onClick: () => setEnhanceTab('pipeline') }, '每日读写'),
        ),
        enhanceTab === 'vector' ? h('div', null,
          h(ui.Row, { label: '按意思找', hint: '关掉就只用内置的字面检索。' },
            h(ui.Switch, { on: vst?.ok ? vst.enabled !== false : true, disabled: !editable || enhanceBusy === 'vector', onChange: (value) => saveVector({ enabled: value }) })),
          h(ui.Row, { label: '相似度门槛', hint: '0.1～0.95；低于这个不算想起来。' }, vnum('floor', 0.1, 0.95, 0.01)),
          h(ui.Row, { label: '每轮补几条', hint: '向量额外补进提示的条数，0～4。' }, vnum('hintCount', 0, 4, 1)),
          h(ui.Row, { label: '最多想起几条', hint: '内置记忆每轮总条数。' }, vnum('recallCount', 0, 12, 1)),
          h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h('input', {
              className: 'ab-input',
              value: vectorQuery,
              placeholder: '例如：她平时爱吃什么',
              style: { flex: '1 1 140px', boxSizing: 'border-box' },
              onChange: (e) => setVectorQuery(e.target.value),
            }),
            h(ui.Btn, { small: true, disabled: Boolean(enhanceBusy), onClick: runVectorTest }, enhanceBusy === 'vtest' ? '检索中…' : '检索测试'),
          ),
          h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h(ui.Btn, { small: true, disabled: Boolean(enhanceBusy), onClick: () => rebuildVector(false) }, enhanceBusy === 'vrebuild' ? '重算中…' : '补算向量'),
            h(ui.Btn, { small: true, disabled: Boolean(enhanceBusy), onClick: () => rebuildVector(true) }, '全部重算'),
          ),
          vtest?.ok ? h('div', { className: 'ab-note', style: { marginTop: 8 } },
            h('div', { className: 'ab-small ab-muted' }, `向量测试 ${vtest.ms || 0} ms`),
            (vtest.merged || []).slice(0, 3).map((item, index) => h('div', { key: index, className: 'ab-small', style: { marginTop: 3 } }, `${item.why || ''} ${String(item.text || '').slice(0, 80)}`)),
          ) : vtest && vtest.ok === false ? h('div', { className: 'ab-note' }, vtest.message || '检索失败') : null,
          vst?.ok === false ? h('div', { className: 'ab-note' }, vst.message || '向量未运行') : null,
          vst?.error ? h('div', { className: 'ab-note' }, '⚠ ' + vst.error) : null,
          vst?.bootstrap?.error ? h('div', { className: 'ab-note' }, '模型/运行时没准备好：' + vst.bootstrap.error) : null,
          vst?.memoryEnabled === false ? h('div', { className: 'ab-note' }, '主记忆总开关关着：这里开了也不会生效。') : null,
        ) : enhanceTab === 'assoc' ? h('div', null,
          h(ui.Row, { label: '按名字联想', hint: '聊天里认出名字时，把相关的人、关系和经历串成提示。' },
            h(ui.Switch, { on: enhanceOn, disabled: !editable, onChange: (value) => set('assocOn', value) })),
          h(ui.Row, { label: '联想加深记忆', hint: '被联想出来的条目按遗忘曲线强化；可关。' },
            h(ui.Switch, { on: reinforceOn, disabled: !editable, onChange: (value) => set('reinforce', value) })),
          h(ui.Row, { label: '名字联想概率', hint: '0～100%；100 = 每次认出名字都联想。' }, number('nameChance', 0, 100, 5), ' %'),
          h(ui.Row, { label: '问题联想概率', hint: '只在没认出名字的轮次里生效。' }, number('autoChance', 0, 100, 5), ' %'),
          h(ui.Row, { label: '问题联想门槛', hint: '相似度低于这个就不当种子。' }, number('autoFloor', 0.4, 0.9, 0.05)),
          h(ui.Row, { label: '问题联想最多几条', hint: '0 = 只查不补。' }, number('autoMax', 0, 4, 1)),
          h(ui.Row, { label: '问题联想', hint: '没认出名字时，也把问句的向量近邻当种子走一跳。' },
            h(ui.Switch, { on: cfg.autoAssoc !== false, disabled: !editable, onChange: (value) => set('autoAssoc', value) })),
          h(ui.Row, { label: '最多走几步', hint: '1 = 直接相关 + 一跳；2 = 再走一步。' }, number('maxHops', 1, 2, 1)),
          h(ui.Row, { label: '名字联想最多几条', hint: '事实、关系、经历、相近一起算。' }, number('maxItems', 3, 8, 1)),
          h(ui.Row, { label: '自动直接召回几条', hint: '接管内置回忆后，每轮先走关键词+向量混合召回，最多几条；0 = 不做直接召回。' }, number('directCount', 0, 8, 1), ' 条'),
          h(ui.Row, { label: '一轮注入上限', hint: '直接召回和联想合并后的总字数上限，默认 420。' }, number('injectMaxChars', 200, 800, 20), ' 字'),
          h(ui.Row, { label: '联想门槛', hint: '低于这个就不写进提示，越高越保守。' }, number('threshold', 0.1, 0.9, 0.01)),
          reinforceOn ? h(ui.Row, { label: '强化强度', hint: '0 = 不加深；0.6 左右比较稳。' }, number('strength', 0, 1, 0.05)) : null,
          h('div', { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap', marginTop: 8 } },
            settingText('ownerAliases', '主人额外称呼，逗号分隔'),
            settingText('botNames', '她的额外称呼，逗号分隔'),
            settingText('extraEntities', '额外实体，分号分实体'),
          ),
          h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h('input', {
              className: 'ab-input',
              value: assocQuery,
              placeholder: '例如：小夏 / 还记得项目甲吗',
              style: { flex: '1 1 140px', boxSizing: 'border-box' },
              onChange: (e) => setAssocQuery(e.target.value),
            }),
            h(ui.Btn, { small: true, disabled: Boolean(enhanceBusy), onClick: runAssocTest }, enhanceBusy === 'atest' ? '联想中…' : '联想测试'),
          ),
          h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h(ui.Btn, { small: true, disabled: Boolean(enhanceBusy), onClick: rebuildAssoc }, enhanceBusy === 'arebuild' ? '重建中…' : '重建联想图'),
          ),
          atest?.ok ? h('div', { className: 'ab-note', style: { marginTop: 8 } },
            h('div', { className: 'ab-small ab-muted' }, atest.entities?.length ? `认出：${atest.entities.map((ent) => ent.name).join('、')}` : (atest.auto ? '没认出名字，按问句向量关联' : '这句没找到可关联的记忆')),
            atest.reinforce?.length ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 4 } }, `这次会强化 ${atest.reinforce.length} 条（测试不会真的写入）`) : null,
            (atest.lines || []).slice(0, 4).map((line, index) => h('div', { key: index, className: 'ab-small', style: { marginTop: 4 } }, line.text)),
          ) : atest && atest.ok === false ? h('div', { className: 'ab-note' }, atest.message || '联想失败') : null,
          ast?.logs?.length ? h('div', { style: { marginTop: 8 } },
            h('div', { className: 'ab-small ab-muted' }, '最近联想'),
            ast.logs.slice(0, 3).map((log, index) => h('div', { key: index, className: 'ab-small ab-muted', style: { marginTop: 3 } },
              `${timeText(log.at)} ${log.query} → ${(log.entities || []).join('、') || (log.auto ? '（问句）' : '—')}${log.reinforced ? ` · 强化 ${log.reinforced} 条` : ''}`)),
          ) : null,
          ast?.ok === false ? h('div', { className: 'ab-note' }, ast.message || '联想未运行') : null,
          ast?.memoryRunning === false ? h('div', { className: 'ab-note' }, '记忆模块没在跑：联想读不到条目。') : null,
          ast?.lastError ? h('div', { className: 'ab-note' }, '⚠ ' + ast.lastError) : null,
        ) : h('div', null,
          !pst || pst.ok === false
            ? h(ui.Empty, { text: pst?.message || '正在读取读写进度…' })
            : h('div', null,
              pst.standby ? h('p', { className: 'ab-note' }, '检测到每日整理模块正在运行，每日读写待命，不会重复提炼。') : null,
              pst.enabled === false ? h('p', { className: 'ab-note' }, '每日读写默认关闭：新记忆的写入和整理由内置记忆负责；归档与删除仍由记忆中枢负责。需要中枢也提炼时，打开下面的总开关。') : null,
              pst.forgetManaged === false ? h('p', { className: 'ab-note' }, '内置记忆还没启用中枢接管，归档/删除仍由内置记忆负责。') : null,
              pst.forgetManaged !== false && pst.forgetActive === false ? h('p', { className: 'ab-note' }, '中枢遗忘扫描没开：检查记忆中枢总开关或下面的「归档与删除」。') : null,
              pst.mode === 'panel' ? h('p', { className: 'ab-note' }, '当前是「只看星图」模式，不会调用模型提炼；本地归档扫描仍然保留。') : null,
              h('div', {
                className: 'ab-small ab-muted',
                style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, margin: '6px 0 10px' },
              },
              h('span', null, '今天缓冲 ', h('b', null, pst.lines), ' 行'),
              h('span', null, '待提炼 ', h('b', null, pst.pending), ' 行'),
              h('span', null, '已提炼 ', h('b', null, pst.items), ' 条'),
              h('span', null, '已入记忆 ', h('b', null, pst.writtenToday ?? 0), ' 条'),
              h('span', null, '今日写入额度 ', h('b', null, pst.budget ?? 8), ' 条'),
              h('span', null, '重要度高另算 ', h('b', null, pst.highBudget ?? 8), ' 条'),
              h('span', null, '归档区 ', h('b', null, pst.archived), ' 条'),
              h('span', null, '清理 ', h('b', null, pst.deletedTotal), ' 条'),
              h('span', null, '上次提炼 ', timeText(pst.lastExtractAt)),
              h('span', null, '上次归档 ', timeText(pst.lastScan)),
              h('span', null, '触发门槛 ', h('b', null, pst.threshold), ' 行')),
              h('div', { className: 'ab-flex', style: { gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
                h(ui.Btn, {
                  kind: 'primary',
                  small: true,
                  disabled: Boolean(enhanceBusy) || pst.standby || pst.mode === 'panel' || pst.enabled === false,
                  onClick: () => runPipeline('/pipeline/extract', 'pextract', '提炼完成'),
                  title: pst.enabled === false ? '每日读写默认关闭，先打开总开关' : pst.standby ? '每日整理已在运行' : pst.mode === 'panel' ? '只看星图模式不调用模型' : '马上提炼今天还没处理的聊天和经历',
                }, enhanceBusy === 'pextract' ? '提炼中…' : '现在提炼'),
                h(ui.Btn, {
                  small: true,
                  disabled: Boolean(enhanceBusy) || pst.standby || pst.forgetActive === false,
                  onClick: () => runPipeline('/pipeline/scan', 'pscan', '归档扫描完成'),
                  title: pst.forgetActive === false ? (pst.forgetManaged === false ? '内置记忆未启用中枢接管' : '中枢遗忘扫描没开') : '立即扫描低清晰度记忆并归档/删除',
                }, enhanceBusy === 'pscan' ? '整理中…' : '立即整理归档')),
              h(ui.Row, { label: '总开关', hint: '默认关闭：写入和整理由内置记忆负责。打开后记忆中枢也会读取活动、提炼写入和归档。' },
                h(ui.Switch, { on: cfg.pipelineOn === true, disabled: !editable, onChange: (value) => set('pipelineOn', value) })),
              h(ui.Row, { label: '攒够多少条开始提炼', hint: '默认 20；深度模式会更早，省 Token 模式会更晚。' }, number('pipelineMinLines', 5, 100), ' 条'),
              h(ui.Row, { label: '每天最多写入几条', hint: '基础额度；聊天量大时自动提高，最多 30；重要度高另算。0 表示只归档不写入。' }, number('pipelineMaxWrites', 0, 30), ' 条'),
              h(ui.Row, { label: '每批提炼多少条', hint: '长聊天分批压成要点，默认 30。' }, number('pipelineBatchSize', 10, 60, 5), ' 条'),
              h(ui.Row, { label: '归档与删除（由记忆中枢负责）', hint: '中枢按清晰度判断并归档；归档满 30 天、过时满 180 天由中枢删除。内置记忆不再做这一步。' },
                h(ui.Switch, { on: cfg.pipelineScanOn !== false, disabled: !editable, onChange: (value) => set('pipelineScanOn', value) })),
              h(ui.Row, { label: '聊天素材保留几天', hint: '只影响每日读写自己的缓冲，不碰记忆正文。' }, number('pipelineKeepDays', 1, 7), ' 天'),
              h('p', { className: 'ab-note', style: { marginBottom: 0 } }, '刚写入的低重要内容会进临时层，两天没再提到就进归档星云；反复提到会升长期、再到永久。')
            )
        ),
      ) : null,
    ),
    groupInfo ? h(ui.Card, {
      title: '星团详情',
      desc: `${shortText(groupInfo.label, 12)} · ${groupInfo.total} 颗${(REGION[groupInfo.mainType] || REGION.knowledge).label === groupInfo.label ? '' : ` · ${(REGION[groupInfo.mainType] || REGION.knowledge).label}`}${(groupInfo.childClusters || []).length ? ' · 左侧清单可进小星云' : ''}`,
      right: h(ui.Btn, { small: true, onClick: () => { setGroupSelected(''); setGroupChild(''); } }, '收起'),
    },
      (groupInfo.childClusters || []).length
        ? h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' } },
          h('span', { className: 'ab-small ab-muted' }, '小星云'),
          groupInfo.childClusters.map((child) => h('span', { key: child.id, className: 'ab-badge' }, `${child.label} · ${child.total}`)))
        : (groupInfo.children || []).length
          ? h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' } },
            h('span', { className: 'ab-small ab-muted' }, '子模块'),
            groupInfo.children.map((child) => h('span', { key: child.label, className: 'ab-badge' }, `${child.label} · ${child.count}`)))
          : h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' } },
            h('span', { className: 'ab-small ab-muted' }, '主要标签'),
            (groupInfo.tags || []).map((tag) => h('span', { key: tag, className: 'ab-badge' }, tag)),
          ),
      h('p', { className: 'ab-note', style: { marginBottom: 0 } }, (groupInfo.childClusters || []).length
        ? '这个星团在画布上拆成了几个彩色小星云，点左侧清单或画布上的小星云可以钻进去。'
        : (groupInfo.children || []).length
          ? '这个星团按标签分成了几个子模块，上面列的是各模块的条数。'
          : '这个星团里的记忆没有再拆出更细的分模块。'),
    ) : null,
    selectedStar ? h(ui.Card, {
      title: '记忆详情',
      desc: `${selectedGroup ? `${shortText(selectedGroup.label, 12)} · ${selectedGroup.total} 颗 · ` : ''}${REGION[selectedStar.region]?.label || '知识'} · 重要度 ${Math.round(selectedStar.importance * 100)}%${selectedStar.archivedAt ? ' · 已归档' : ''}`,
      right: h('div', { className: 'ab-flex' },
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => focusOn(selectedStar) }, '聚焦这颗星'),
        h(ui.Btn, { small: true, onClick: () => setSelected('') }, '收起')),
    },
      editing ? h('div', { style: { marginBottom: 10 } },
        h('textarea', {
          className: 'ab-input',
          value: editing.text,
          rows: 4,
          maxLength: 200,
          placeholder: '记忆内容',
          style: { width: '100%', boxSizing: 'border-box', minHeight: 88, resize: 'vertical', lineHeight: 1.6, marginBottom: 10 },
          onChange: (e) => setEditing({ ...editing, text: e.target.value }),
        }),
        h(ui.Row, { label: '重要度', hint: '越高越亮、星点越大；0～100%。' },
          h(ui.Range, {
            value: editing.importance, min: 0, max: 1, step: 0.05,
            onChange: (value) => setEditing({ ...editing, importance: value }),
            fmt: (value) => `${Math.round(value * 100)}%`,
          })),
        h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 8 } },
          h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => setEditing(null) }, '取消'),
          h(ui.Btn, { kind: 'primary', disabled: Boolean(busy), onClick: saveEdit }, busy === 'edit' ? '保存中…' : '保存修改')),
      ) : h('p', { style: { lineHeight: 1.7, margin: '4px 0 10px' } }, selectedStar.invalidAt ? h('span', { className: 'ab-muted' }, selectedStar.text) : selectedStar.text),
      h('div', { className: 'ab-small ab-muted', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 10 } },
        h('span', null, '清晰度 ', h('b', { style: { color: selectedStar.brightness >= 0.7 ? '#ffd166' : selectedStar.brightness >= 0.35 ? '#a9bcd8' : '#6b7a90' } }, `${Math.round(selectedStar.brightness * 100)}%`)),
        h('span', null, '层级 ', TIER_LABEL[selectedStar.tier] || '长期'),
        h('span', null, '巩固度 ', Number(selectedStar.strength) ? selectedStar.strength.toFixed(1) : '—'),
        h('span', null, '复习 ', selectedStar.hits, ' 次'),
        h('span', null, '上次想起 ', timeText(selectedStar.lastHit)),
        h('span', null, '下次该复习 ', selectedStar.tier === 'core' ? '永久' : fmtNext(selectedStar.nextReview - Date.now())),
        h('span', null, '写入 ', timeText(selectedStar.at)),
        selectedStar.archivedAt ? h('span', null, '归档 ', timeText(selectedStar.archivedAt)) : null,
        h('span', null, '星团 ', selectedGroup ? `${shortText(selectedGroup.label, 8)} · ${selectedGroup.total} 颗` : '—'),
      ),
      h('div', { className: 'ab-flex', style: { gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' } },
        h('span', { className: 'ab-small ab-muted' }, '层级'),
        ['short', 'long', 'core'].map((tier) => h(ui.Btn, {
          key: tier,
          small: true,
          kind: selectedStar.tier === tier ? 'primary' : undefined,
          disabled: Boolean(busy) || !enabled || day > 0 || Boolean(selectedStar.archivedAt),
          title: selectedStar.archivedAt ? '先恢复这条记忆再改层级' : day > 0 ? '切回「现在」才能改层级' : `设为${TIER_LABEL[tier]}记忆`,
          onClick: () => changeTier(tier),
        }, busy === 'tier' ? '改中…' : TIER_LABEL[tier])),
      ),
      h('div', { style: { marginBottom: 10 } },
        h('div', { className: 'ab-small ab-muted', style: { marginBottom: 4 } }, '相关记忆'),
        relatedStars.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          relatedStars.map((rel) => h('div', {
            key: rel.otherId,
            onClick: () => focusRow(rel.star),
            title: rel.star.text,
            style: {
              display: 'flex', gap: 6, alignItems: 'center', padding: '3px 6px', borderRadius: 5, cursor: 'pointer',
              background: 'rgba(120, 160, 220, 0.07)',
            },
          },
          h('span', { style: { fontSize: 10, color: 'rgba(206, 220, 242, 0.78)', whiteSpace: 'nowrap' } }, edgeMeta(rel.kind).label),
          h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgba(226, 236, 255, 0.86)' } }, shortText(rel.star.text, 26)),
          h('span', { className: 'ab-small ab-muted' }, `${Math.round((rel.star.brightness || 0) * 100)}%`))),
        ) : h('div', { className: 'ab-small ab-muted' }, '暂时没有关联记忆'),
      ),
      selectedStar.tags?.length ? h('div', { className: 'ab-flex', style: { marginBottom: 10 } }, selectedStar.tags.map((tag) => h('span', { key: tag, className: 'ab-badge' }, tag))) : null,
      editing ? null : confirming ? h('div', { className: 'ab-flex', style: { gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
        h('span', { className: 'ab-small', style: { color: '#ff9ecd' } }, '确定从内置记忆里删除这条？'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => setConfirming(false) }, '取消'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: deleteStar }, busy === 'remove' ? '删除中…' : '确定删除'),
      ) : h('div', { className: 'ab-flex', style: { gap: 8, marginBottom: 10 } },
        h(ui.Btn, { small: true, disabled: Boolean(busy) || !enabled || day > 0, onClick: startEdit, title: day > 0 ? '切回「现在」才能修改' : '修改文字和重要度' }, '编辑'),
        h(ui.Btn, { small: true, disabled: Boolean(busy) || !enabled || day > 0, onClick: () => setConfirming(true), title: day > 0 ? '切回「现在」才能删除' : '从内置记忆里删除' }, '删除')),
      editing ? null : selectedStar.invalidAt ? h('p', { className: 'ab-note' }, '这条已经过时，只能作为历史参考，不能靠复习把它变回有效。') :
        selectedStar.archivedAt ? h('div', { style: { marginBottom: 10 } },
          h('p', { className: 'ab-note', style: { marginBottom: 8 } }, '已归档：不参与聊天召回，恢复后回到原星团并按当前层级重新计算清晰度。'),
          h(ui.Btn, { kind: 'primary', disabled: Boolean(busy) || !enabled || day > 0, onClick: restoreStar }, busy === 'restore' ? '恢复中…' : '恢复这条记忆')) :
        day > 0 ? h('p', { className: 'ab-note' }, '正在回看历史，切回「现在」才能确认还记得、修改或删除。') :
          h(ui.Btn, { kind: 'primary', disabled: Boolean(busy) || !enabled, onClick: confirmReview }, busy === 'review' ? '记录中…' : '我还记得'),
    ) : null,
    data && stars.length ? h(ui.Card, {
      title: '层级记忆',
      desc: '按层级查看全部记忆；点一行可以在画布上定位，也可以直接编辑、换层或删除。',
      right: h(ui.Btn, { small: true, onClick: () => setTierListOpen((value) => !value) }, tierListOpen ? '收起' : '展开'),
    },
    tierListOpen ? h('div', null,
      h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' } },
        ['short', 'long', 'core'].map((tier) => h(ui.Btn, {
          key: tier,
          small: true,
          kind: listTier === tier ? 'primary' : undefined,
          onClick: () => chooseTier(tier),
        }, `${TIER_LABEL[tier]} ${tierCounts[tier] || 0}`)),
        h(ui.Btn, {
          small: true,
          disabled: Boolean(busy) || !enabled || day > 0,
          onClick: () => setAdding((value) => !value),
        }, adding ? '取消新增' : '＋ 新增'),
      ),
      h('div', { className: 'ab-flex', style: { gap: 8, marginBottom: 8, alignItems: 'center' } },
        h('input', {
          className: 'ab-input',
          value: tierQuery,
          placeholder: `在${TIER_LABEL[listTier]}里搜索`,
          style: { flex: '1 1 220px', boxSizing: 'border-box' },
          onChange: (e) => { setTierQuery(e.target.value); setTierPage(0); },
        }),
        h('span', { className: 'ab-small ab-muted' }, `${listItems.length} 条`),
      ),
      adding ? h('div', { style: { padding: '8px 0 10px', borderBottom: '1px solid rgba(120, 160, 220, 0.18)' } },
        h('textarea', {
          className: 'ab-input',
          value: addForm.text,
          rows: 3,
          maxLength: 200,
          placeholder: '要记住的事，一句话写清楚',
          style: { width: '100%', boxSizing: 'border-box', minHeight: 72, resize: 'vertical', lineHeight: 1.6, marginBottom: 6 },
          onChange: (e) => setAddForm({ ...addForm, text: e.target.value }),
        }),
        h(ui.Row, { label: '重要度', hint: '越高越亮、越容易升层' },
          h(ui.Range, {
            value: addForm.importance, min: 0, max: 1, step: 0.05,
            onChange: (value) => setAddForm({ ...addForm, importance: value }),
            fmt: (value) => `${Math.round(value * 100)}%`,
          })),
        h('input', {
          className: 'ab-input',
          value: addForm.tags,
          placeholder: '标签，用逗号分隔（可选）',
          style: { width: '100%', boxSizing: 'border-box', marginTop: 6 },
          onChange: (e) => setAddForm({ ...addForm, tags: e.target.value }),
        }),
        h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h(ui.Btn, { small: true, onClick: () => { setAdding(false); setAddForm({ text: '', importance: 0.5, tags: '' }); } }, '取消'),
          h(ui.Btn, { small: true, kind: 'primary', disabled: Boolean(busy), onClick: addMemory }, busy === 'add' ? '保存中…' : `保存到${TIER_LABEL[listTier]}`),
          h('span', { className: 'ab-small ab-muted' }, '关于谁默认不填，归到知识区'),
        ),
      ) : null,
      pageItems.length ? h('div', {
        className: 'mc-thin-scroll',
        style: { maxHeight: 360, overflowY: 'auto', border: '1px solid rgba(120, 160, 220, 0.18)', borderRadius: 8, padding: '0 8px' },
      },
      pageItems.map((star) => {
        const editingThis = rowEditing && rowEditing.id === star.id;
        const confirmingThis = rowConfirm === star.id;
        return h('div', { key: star.id, style: { padding: '7px 0', borderBottom: '1px solid rgba(120, 160, 220, 0.12)' } },
          editingThis ? h('div', null,
            h('textarea', {
              className: 'ab-input',
              value: rowEditing.text,
              rows: 3,
              maxLength: 200,
              style: { width: '100%', boxSizing: 'border-box', minHeight: 68, resize: 'vertical', lineHeight: 1.55, marginBottom: 6 },
              onChange: (e) => setRowEditing({ ...rowEditing, text: e.target.value }),
            }),
            h(ui.Row, { label: '重要度' },
              h(ui.Range, {
                value: rowEditing.importance, min: 0, max: 1, step: 0.05,
                onChange: (value) => setRowEditing({ ...rowEditing, importance: value }),
                fmt: (value) => `${Math.round(value * 100)}%`,
              })),
            h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 6 } },
              h(ui.Btn, { small: true, onClick: () => setRowEditing(null) }, '取消'),
              h(ui.Btn, { small: true, kind: 'primary', disabled: Boolean(busy), onClick: saveRowEdit }, busy === 'row-edit' ? '保存中…' : '保存')),
          ) : h('div', null,
            h('div', { onClick: () => focusRow(star), style: { cursor: 'pointer' } },
              h('div', { style: { fontSize: 12, lineHeight: 1.55, color: 'rgba(226, 236, 255, 0.92)' } }, star.text),
              h('div', { className: 'ab-small ab-muted', style: { marginTop: 2 } },
                `${TIER_LABEL[star.tier]} · 清晰 ${Math.round((star.brightness || 0) * 100)}% · C ${Number(star.strength) ? Number(star.strength).toFixed(1) : '—'}${star.aboutName ? ` · ${star.aboutName}` : ''}${(star.tags || []).length ? ` · ${star.tags.join('/')}` : ''}`)),
            h('div', { className: 'ab-flex', style: { gap: 6, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' } },
              h(ui.Btn, {
                small: true,
                disabled: Boolean(busy) || !enabled || day > 0,
                onClick: () => setRowEditing({ id: star.id, text: star.text, importance: star.importance }),
              }, '编辑'),
              h('select', {
                className: 'ab-input',
                style: { fontSize: 11, padding: '1px 4px' },
                value: star.tier,
                title: '换层级',
                disabled: Boolean(busy) || !enabled || day > 0,
                onChange: (e) => moveRowTier(star.id, e.target.value),
              }, ['short', 'long', 'core'].map((tier) => h('option', { key: tier, value: tier }, TIER_LABEL[tier]))),
              h(ui.Btn, {
                small: true,
                disabled: Boolean(busy) || !enabled || day > 0,
                onClick: () => setRowConfirm(star.id),
              }, '删除')),
            confirmingThis ? h('div', { className: 'ab-flex', style: { gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { className: 'ab-small', style: { color: '#ff9ecd' } }, '确定删除这条？'),
              h(ui.Btn, { small: true, onClick: () => setRowConfirm('') }, '取消'),
              h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => removeRow(star.id) }, busy === 'row-remove' ? '删除中…' : '确定删除')) : null,
          ));
      })
      ) : h('div', { className: 'ab-small ab-muted', style: { padding: '10px 0' } }, '这一层还没有记忆'),
      pageCount > 1 ? h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 8, alignItems: 'center' } },
        h(ui.Btn, { small: true, disabled: pageSafe <= 0, onClick: () => setTierPage(pageSafe - 1) }, '上一页'),
        h('span', { className: 'ab-small ab-muted' }, `第 ${pageSafe + 1} / ${pageCount} 页`),
        h(ui.Btn, { small: true, disabled: pageSafe >= pageCount - 1, onClick: () => setTierPage(pageSafe + 1) }, '下一页')) : null,
    ) : null,
    ) : null,
    h('p', { className: 'ab-note' }, '说明：星图只是内置记忆的一层索引；修改和删除只作用于你选中的那条内置记忆，不会批量改动。关掉插件，记忆功能照常工作。'),
  );
};
