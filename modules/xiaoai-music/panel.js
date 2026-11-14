const { useState, useEffect, useRef } = React;
const flex = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };
const ALL_SONGS = '__all__';
const phaseNames = { idle: '空闲', preparing: '准备播放', playing: '正在播放', pausing: '正在暂停', paused: '已暂停',
  stopping: '正在停止', stopped: '已停止', completed: '本轮已结束', failed: '播放未完成' };
return function Panel({ settings = {}, draftSettings, setSettings, toast = () => {}, reload } = {}) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [setupRoot, setSetupRoot] = useState('');
  const [networks, setNetworks] = useState([]);
  const onboarding = state?.onboarding;
  const needsSetup = Boolean(onboarding && !onboarding.complete);
  const features = onboarding?.features;
  const [connection, setConnection] = useState(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginImageVersion, setLoginImageVersion] = useState(0);
  const [loginImageError, setLoginImageError] = useState(false);
  const [loginStatusError, setLoginStatusError] = useState('');
  const login = state?.login;
  const loginPending = ['preparing', 'waiting', 'verifying', 'select-device'].includes(login?.phase);
  const loginVisible = loginOpen || (login?.phase && login.phase !== 'idle');
  const startLogin = async () => {
    setLoginOpen(true); setLoginImageError(false); setLoginStatusError('');
    setLoginImageVersion(Date.now()); setBusy(true);
    setState(previous => ({ ...previous, login: { phase: 'preparing', message: '正在生成登录二维码…' } }));
    try {
      const result = await call('/speaker/login/start', {});
      setState(previous => ({ ...previous, login: result.login || { phase: 'failed', message: result.message || '未能生成二维码，请重试。' } }));
    } catch {
      setState(previous => ({ ...previous, login: { phase: 'failed', message: '暂时无法开始登录，请重新生成二维码。' } }));
    } finally { setBusy(false); }
  };
  const [voiceOptions, setVoiceOptions] = useState(null);
  const [playlistId, setPlaylistId] = useState('');
  const [directoryId, setDirectoryId] = useState('');
  const [directoryPath, setDirectoryPath] = useState('');
  const [directoryManage, setDirectoryManage] = useState(false);
  const [listName, setListName] = useState('');
  const [listIds, setListIds] = useState([]);
  const [newName, setNewName] = useState('');
  const [creatingList, setCreatingList] = useState(false);
  const [targetListId, setTargetListId] = useState('');
  const [deleteSong, setDeleteSong] = useState(null);
  const [draggingId, setDraggingId] = useState('');
  const [dropId, setDropId] = useState('');
  const dragRef = useRef(null);
  const [savedQuery, setSavedQuery] = useState('');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [songId, setSongId] = useState('');
  const [songMode, setSongMode] = useState('cover');
  const [songVoice, setSongVoice] = useState('');
  const [chosenVersions, setChosenVersions] = useState({});
  const [versionMenu, setVersionMenu] = useState('');
  const addSongRef = useRef(null);
  const [reminders, setReminders] = useState([]);
  const [reminderSession, setReminderSession] = useState(null);
  const [reminderError, setReminderError] = useState(null);
  const [reminderPreview, setReminderPreview] = useState('');
  const [reminderText, setReminderText] = useState('');
  const [reminderMode, setReminderMode] = useState('periodic');
  const [reminderDate, setReminderDate] = useState('');
  const [reminderFrequency, setReminderFrequency] = useState('daily');
  const [reminderTime, setReminderTime] = useState('08:00');
  const [reminderDays, setReminderDays] = useState([1]);
  const [reminderMonthDay, setReminderMonthDay] = useState(1);
  const rootRef = useRef(null);
  const [navigationHeight, setNavigationHeight] = useState(88);
  const localAudioRef = useRef(null);
  const localQueueRef = useRef({ ids: [], index: 0 });
  const [localSong, setLocalSong] = useState('');
  const [wakeNames, setWakeNames] = useState('');
  const [wakePrimary, setWakePrimary] = useState('');
  const [wakeAcknowledgement, setWakeAcknowledgement] = useState('');
  const [wakeAudio, setWakeAudio] = useState({ phase: 'idle' });
  const [wakeSaving, setWakeSaving] = useState(false);
  const [wakeSaved, setWakeSaved] = useState(null);
  const wakeAudioRef = useRef(null);
  const [wakeSuggestion, setWakeSuggestion] = useState(null);
  const [wakeSuggesting, setWakeSuggesting] = useState(false);
  const [storageTarget, setStorageTarget] = useState('');
  const [storageVerification, setStorageVerification] = useState({ phase: 'idle' });
  const config = draftSettings || settings;
  const connectionDirty = ['networkInterface', 'speakerDevice', 'motherVoice'].some(key => String(config[key] || '') !== String(settings[key] || ''));
  const lists = state?.playlists || [];
  const entries = state?.songs?.entries || [];
  const directories = state?.songs?.directories || [];
  const selectedDirectory = directories.find(item => item.id === directoryId);
  const activeList = lists.find(list => list.id === playlistId);
  const showAll = playlistId === ALL_SONGS;
  const targetList = lists.find(list => list.id === targetListId) || lists[0];
  const listDirty = Boolean(activeList && (listName !== activeList.name || JSON.stringify(listIds) !== JSON.stringify(activeList.ids)));
  const generating = state?.songs?.jobs?.some(job => ['queued', 'generating'].includes(job.state));
  const currentEntry = entries.find(entry => entry.id === state?.playback?.current);
  const displayedSongs = showAll ? entries.filter(entry => !directoryId || entry.directoryIds?.includes(directoryId)) : listIds.map(id => entries.find(entry => entry.id === id) ||
    { id, title: '找不到的歌曲', artists: '', sourceId: '', mode: 'local', voice: '', available: false, readOnly: true });
  const filtered = displayedSongs.filter(entry => (entry.title + ' ' + entry.artists).toLowerCase().includes(savedQuery.trim().toLowerCase()));
  const loadOptions = async () => { const result = await call('/settings/options'); if (result.ok) setVoiceOptions(result.voices); };
  useEffect(() => {
    const nav = rootRef.current?.closest('.ab-root')?.querySelector('.ab-nav');
    if (!nav) return;
    const update = () => setNavigationHeight(Math.ceil(nav.getBoundingClientRect().height));
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(nav);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  const loadReminders = async () => {
    try {
      const result = await call('/reminders');
      if (!result.ok) throw new Error();
      setReminders(result.reminders); setReminderSession(result.session); setReminderError(result.error);
    } catch { setReminderError({ message: '提醒列表刷新未完成，显示的可能是旧状态；请刷新列表，不要重复保存。' }); }
  };
  const applyWake = (result, preserveDraft = false) => {
    const next = { ...result.wake, acknowledgement: result.wake.acknowledgement || '' };
    if (preserveDraft) {
      setWakePrimary(draft => draft === wakeSaved.names[0] ? (next.names[0] || '') : draft);
      setWakeNames(draft => draft === wakeSaved.names.slice(1).join('，') ? next.names.slice(1).join('，') : draft);
      setWakeAcknowledgement(draft => draft === wakeSaved.acknowledgement ? next.acknowledgement : draft);
    } else {
      setWakePrimary(next.names[0] || '');
      setWakeNames(next.names.slice(1).join('，'));
      setWakeAcknowledgement(next.acknowledgement);
      setWakeSuggestion(null);
    }
    setWakeSaved(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    setWakeAudio(result.acknowledgementAudio || { phase: 'idle' });
  };
  const loadWake = async () => {
    const result = await call('/speaker/wake');
    if (result.ok) applyWake(result);
  };
  const canPreviewWake = !wakeSaving && wakeAudio.phase === 'ready' &&
    wakeAcknowledgement.trim() === wakeSaved?.acknowledgement;
  useEffect(() => {
    const audio = wakeAudioRef.current;
    return () => audio?.pause();
  }, [canPreviewWake, wakeAudio.id]);
  const previewWake = () => {
    const audio = wakeAudioRef.current;
    if (!audio || !wakeAudio.id) return;
    audio.currentTime = 0;
    audio.play().catch(() => toast('试听未能开始，请重新保存称呼后再试。'));
  };
  const playLocalAt = index => {
    const queue = localQueueRef.current;
    const audio = localAudioRef.current;
    if (!audio || index < 0 || index >= queue.ids.length) {
      audio?.pause(); localQueueRef.current = { ids: [], index: 0 }; setLocalSong(''); return;
    }
    queue.index = index;
    const id = queue.ids[index];
    const song = entries.find(item => item.id === id);
    setLocalSong(song ? song.title + ' · ' + song.voice : '本地歌曲');
    audio.src = '/aurabot/api/ext/xiaoai-music/songs/local-audio?id=' + encodeURIComponent(id);
    audio.play().catch(() => toast('电脑本地播放未能开始，请检查音频设备。'));
  };
  const startLocal = (ids, random = false) => {
    const queue = [...ids];
    if (!queue.length) return;
    if (random) for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
    localQueueRef.current = { ids: queue, index: 0 };
    playLocalAt(0);
  };
  const localTime = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  const loadLibrary = async () => {
    const result = await call('/songs/check', {});
    if (!result.ok) { toast(result.message || '歌曲库读取未完成。'); return; }
    setState(result); const first = result.playlists?.[0];
    if (first) { setPlaylistId(first.id); setListName(first.name); setListIds(first.ids); setTargetListId(first.id); }
    else setPlaylistId(ALL_SONGS);
  };
  useEffect(() => {
    call('/status').then(async result => {
      setState(result);
      if (result.onboarding && !result.onboarding.complete) return;
      await loadLibrary();
      loadOptions().catch(() => toast('音色选项读取未完成。'));
      loadReminders();
      loadWake().catch(() => toast('称呼读取未完成。'));
      call('/storage/verification').then(value => {
        if (value.ok && value.verification && value.verification.phase !== 'idle') {
          setStorageVerification(value.verification); setStorageTarget(value.verification.targetRoot || '');
        }
      }).catch(() => {});
    }).catch(() => toast('模块读取未完成，请刷新。'));
  }, []);
  useEffect(() => {
    if (!onboarding?.storageReady || !needsSetup) return;
    loadOptions().catch(() => toast('音色选项读取未完成。'));
    loadWake().catch(() => toast('称呼读取未完成。'));
    call('/onboarding/networks').then(result => { if (result.ok) setNetworks(result.networks); }).catch(() => toast('网卡列表读取未完成，可手动填写。'));
  }, [onboarding?.storageReady, needsSetup]);
  useEffect(() => { const audio = localAudioRef.current; return () => { audio?.pause(); }; }, []);
  useEffect(() => {
    if (!wakeSaved || wakeSaving) return;
    let active = true;
    let reading = false;
    const timer = setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const result = await call('/speaker/wake');
        if (!active || !result.ok) return;
        if (JSON.stringify(result.wake) !== JSON.stringify(wakeSaved)) applyWake(result, true);
        else setWakeAudio(result.acknowledgementAudio || { phase: 'idle' });
      } catch {} finally { reading = false; }
    }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [wakeSaved, wakeSaving]);
  useEffect(() => {
    if (storageVerification.phase !== 'checking') return;
    const timer = setInterval(() => { call('/storage/verification').then(result => {
      if (result.ok) setStorageVerification(result.verification);
    }).catch(() => {}); }, 1000);
    return () => clearInterval(timer);
  }, [storageVerification.phase]);
  useEffect(() => {
    if (!reminders.some(item => item.state === 'active')) return;
    const timer = setInterval(() => { loadReminders().catch(() => {}); }, 10000);
    return () => clearInterval(timer);
  }, [reminders.some(item => item.state === 'active')]);
  useEffect(() => {
    if (!generating && !['preparing', 'playing'].includes(state?.playback?.phase) && !state?.listener?.enabled && !loginPending) return;
    const timer = setInterval(async () => { try { setState(await call('/status')); setLoginStatusError(''); } catch { if (loginPending) setLoginStatusError('暂时无法获取登录状态，正在重试。'); } }, 1500);
    return () => clearInterval(timer);
  }, [generating, state?.playback?.phase, state?.listener?.enabled, loginPending]);
  useEffect(() => {
    if (busy || !directories.length) return;
    let active = true;
    const timer = setInterval(() => { call('/songs/directories').then(result => { if (active && result.ok) setState(result); }).catch(() => {}); }, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [busy, directories.length]);
  const run = async (path, body) => {
    setBusy(true);
    try { const result = await call(path, body);
      if (typeof result.playback === 'object' || result.listener) setState(result);
      else {
        if (path === '/speaker/check') setConnection(result);
        try { setState(await call('/status')); }
        catch {
          toast(result.ok ? '操作已完成，但状态刷新未完成；请刷新查看，不要重复提交。' : result.message || '操作未完成');
          return result;
        }
      }
      toast(result.ok ? result.message || '已完成' : result.message || '操作未完成'); return result;
    } catch { toast('操作未完成，请刷新状态。'); }
    finally { setBusy(false); }
  };
  const openList = list => {
    if (busy) return;
    if (listDirty) { toast('请先保存或取消当前歌单修改。'); return; }
    setDirectoryId('');
    setPlaylistId(list?.id || ALL_SONGS); setListName(list?.name || ''); setListIds([...(list?.ids || [])]);
    if (list) setTargetListId(list.id);
    setSavedQuery(''); setDeleteSong(null); setChosenVersions({}); setVersionMenu(''); dragRef.current = null; setDraggingId(''); setDropId('');
  };
  const chooseDirectory = id => {
    if (busy || listDirty) { toast('请先保存或取消当前歌单修改。'); return; }
    openList(null); setDirectoryId(id);
  };
  const modeOf = entry => entry.mode || (entry.voice === '原曲' ? 'original' : 'cover');
  const versionLabel = entry => (modeOf(entry) === 'local' ? '本地音乐' : modeOf(entry) === 'original' ? '原曲' : '翻唱 · ' + (entry.voice || '默认音色')) +
    (entry.pitch > 0 ? ' · 升' + entry.pitch + '调' : entry.pitch < 0 ? ' · 降' + -entry.pitch + '调' : '');
  const chooseVersion = (row, id) => {
    if (!id) { setVersionMenu(''); return; }
    if (activeList) {
      if (listIds.includes(id)) { toast('该版本已在歌单中。'); return; }
      setListIds(listIds.map(value => value === row.id ? id : value));
      toast('已切换版本，请保存歌单修改。');
    } else setChosenVersions({ ...chosenVersions, [row.id]: id });
    setVersionMenu('');
  };
  const prepareMissingVersion = (entry, mode) => {
    setQuery(entry.title); setCandidates([{ id: entry.sourceId, title: entry.title, artists: entry.artists }]);
    setSongId(entry.sourceId); setSongMode(mode); setSongVoice(''); setVersionMenu('');
    toast(mode === 'original' ? '尚无原曲，请在上方保存原曲。' : '尚无翻唱，请在上方选择音色后生成。');
    addSongRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const resetList = () => { if (activeList) { setListName(activeList.name); setListIds([...activeList.ids]); } };
  const reorder = (id, target) => {
    if (busy || !activeList || id === target) return;
    const from = listIds.indexOf(id), to = listIds.indexOf(target);
    if (from < 0 || to < 0) return;
    const next = [...listIds]; next.splice(from, 1); next.splice(to, 0, id); setListIds(next);
  };
  const startDrag = (event, id) => {
    if (busy || !activeList || event.button !== 0) return;
    dragRef.current = { id, listId: activeList.id, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, moved: false, target: '' };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const endDrag = () => { dragRef.current = null; setDraggingId(''); setDropId(''); };
  const moveDrag = event => {
    const drag = dragRef.current;
    if (!drag || busy || drag.listId !== activeList?.id || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.moved = true; event.preventDefault(); setDraggingId(drag.id);
    const over = document.elementFromPoint(event.clientX, event.clientY);
    const row = over?.closest('[data-song-id]');
    const remove = over?.closest('[aria-label="拖拽移出歌单"]');
    drag.target = row && rootRef.current?.contains(row) ? row.getAttribute('data-song-id')
      : remove && rootRef.current?.contains(remove) ? '__remove__' : '';
    setDropId(drag.target);
  };
  const finishDrag = event => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!busy && activeList?.id === drag.listId && drag.moved) {
      if (drag.target === '__remove__') setListIds(listIds.filter(id => id !== drag.id));
      else if (drag.target) reorder(drag.id, drag.target);
    }
    endDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const addToList = async entry => {
    if (!targetList || busy) return;
    const result = await run('/songs/playlist/update', { id: targetList.id, name: targetList.name, ids: [...targetList.ids, entry.id] });
    if (result?.ok) toast('已加入“' + result.playlist.name + '”。');
  };
  const navigate = tab => {
    if (busy) return;
    if (listDirty || reminderText.trim()) { toast('请先保存或取消本模块的编辑；提醒内容可保存或清空。'); return; }
    const destination = { song: ['表达', '翻唱'] }[tab];
    if (!destination) return;
    const app = rootRef.current?.closest('.ab-root');
    const group = Array.from(app?.querySelectorAll('button.ab-grp') || []).find(button => button.textContent.trim() === destination[0]);
    if (!group) { toast('请在 AuraBot 上方选择“' + destination.join(' → ') + '”。'); return; }
    group.click();
    requestAnimationFrame(() => {
      const target = Array.from(app.querySelectorAll('button[role="tab"]')).find(button => button.textContent.trim() === destination[1]);
      if (target) target.click();
    });
  };
  const field = (key, value) => setSettings?.({ [key]: value });
  const voiceSelect = (key, label) => h(ui.Row, { label }, h('select', { className: 'ab-input', value: config[key] || '',
    'aria-label': label, onChange: event => field(key, event.target.value), disabled: busy || !voiceOptions },
    ...(voiceOptions?.options || [{ id: '', label: '读取音色中…' }]).map(option => h('option', { key: option.id, value: option.id }, option.label)),
    config[key] && !voiceOptions?.options?.some(option => option.id === config[key])
      ? h('option', { value: config[key], disabled: true }, '原音色不可用，请重新选择') : null));

  const setupNotice = needsSetup && h('div', { className: 'ab-note err', role: 'alert',
    style: { color: '#c5222e', fontWeight: 600 } },
  '首次配置尚未完成，暂不能开启小爱音响接入。' + (!onboarding.storageReady ? '请先确认保存位置。'
    : !onboarding.speakerVerified ? '请先检查登录与连接。'
    : !onboarding.wakeSaved ? '请先保存主要称呼。' : '请点击下方「完成配置，进入模块」。'));
  if (onboarding && !onboarding.storageReady) return h('div', { className: 'ab-grid' },
    setupNotice,
    h(ui.Card, { title: '首次配置 · 1. 选择保存位置', desc: '先确定歌曲和模块资料的保存目录，再配置音箱。建议使用非 C 盘、有足够空间的专用文件夹。' },
      h(ui.Row, { label: '保存目录', hint: '输入完整路径；确认前不会在默认位置生成歌曲、歌单或会话数据。此步骤不搬迁或覆盖已有资料。' },
        h('input', { className: 'ab-input', 'aria-label': '首次保存目录', value: setupRoot || onboarding.resourceRoot || '',
          placeholder: '例如 D:\\XiaoaiMusic', disabled: busy || Boolean(onboarding.resourceRoot), onChange: event => setSetupRoot(event.target.value) })),
      h(ui.Btn, { disabled: busy || !(setupRoot || onboarding.resourceRoot).trim(), onClick: () => run('/onboarding/storage', { root: setupRoot || onboarding.resourceRoot }) },
        onboarding.resourceRoot ? '重试初始化' : '确认位置并继续')));

  return h('div', { ref: rootRef, className: 'ab-grid' },
    setupNotice,
    h(ui.Card, { title: needsSetup ? '首次配置 · 2. 音箱连接' : '小爱音响接入',
      desc: '小爱音箱接入与音乐播放；对话跟随 Aurabot 当前人设。',
      right: h(ui.Switch, { on: Boolean(state?.listener?.enabled), disabled: busy || loginPending || needsSetup || features?.dialogue === false || !state,
        title: '小爱音响接入开关', onChange: on => run(on ? '/speaker/listener/start' : '/speaker/end', {}) }) },
      h(ui.Row, { label: '模块资料位置', hint: '歌单、称呼、提醒和会话资料保存在这里。歌曲目录可在下方“音乐目录”中单独管理。' },
        h('span', null, state?.storage?.root || config.resourceRoot || '读取中')),
      !needsSetup && h('details', null, h('summary', { style: { cursor: 'pointer', margin: '10px 0' } }, '数据管理（复制核验）'),
      h(ui.Row, { label: '手动复制目标位置', hint: '仅核验本资料位置下的原歌曲文件夹和模块资料；不含此位置以外的音乐目录，也不含会话工作区和临时文件。不会搬迁或切换位置，请保留原数据。' },
        h('input', { className: 'ab-input', value: storageTarget, 'aria-label': '手动复制目标位置',
          disabled: busy || storageVerification.phase === 'checking', onChange: event => {
            setStorageTarget(event.target.value); setStorageVerification({ phase: 'idle' });
          } })),
      h(ui.Btn, { disabled: busy || !storageTarget.trim() || storageVerification.phase === 'checking', onClick: async () => {
        const result = await call('/storage/verify', { targetRoot: storageTarget });
        if (result.ok) setStorageVerification(result.verification); else toast(result.message || '核验未能开始。');
      } }, '核验手动复制'),
      storageVerification.phase !== 'idle' && h('div', { className: 'ab-small', role: 'status', style: { margin: '8px 0' } },
        h('progress', { max: Math.max(storageVerification.total || 0, 1), value: storageVerification.checked || 0 }),
        ' ' + (storageVerification.checked || 0) + ' / ' + (storageVerification.total || 0) + ' 个文件 · ' +
          ({ checking: '正在核验', matched: '核验时文件一致，尚未切换', mismatch: '存在缺失或不一致，未切换', failed: storageVerification.message || '核验未完成' }[storageVerification.phase] || '') +
          (storageVerification.phase === 'mismatch' ? '（缺失 ' + storageVerification.missing + '，不一致 ' + storageVerification.conflicts + '，额外 ' + storageVerification.extra + '）' : ''))),
      h(ui.Row, { label: '小米账号登录', hint: '先保存当前网卡，再用音箱所属账号的米家 App 扫码。首次使用可直接登录；已有账号更新须使用同一账号。多台时选择在线 L05C，验证通过后保存。' },
        h(ui.Btn, { disabled: busy || connectionDirty || (loginPending && login?.phase !== 'select-device' && !loginImageError), onClick: startLogin },
          login?.phase === 'preparing' ? '正在生成二维码…' : loginImageError || ['expired', 'failed', 'verification-required', 'select-device'].includes(login?.phase) ? '重新生成二维码' : '扫码登录 / 更新登录'),
        h(ui.Btn, { disabled: busy || connectionDirty || loginPending, onClick: () => run('/speaker/check', {}) }, '检查登录与连接')),
      connectionDirty && h('p', { className: 'ab-note' }, '连接或音色设置尚未保存，请先点击“保存连接与音色设置”。'),
      loginVisible && h('div', { className: 'ab-note', 'aria-label': '扫码登录状态', style: { margin: '8px 0 16px' } },
        h('p', { role: 'status', 'aria-live': 'polite' }, loginStatusError || login?.message || '正在读取登录状态…'),
        login?.phase === 'waiting' && !loginImageError && h('img', {
          src: '/aurabot/api/ext/xiaoai-music/speaker/login/qr?v=' + loginImageVersion,
          alt: '小米音箱登录二维码', style: { display: 'block', width: 280, maxWidth: '100%', height: 'auto', background: '#fff', padding: 12, boxSizing: 'border-box', margin: '12px 0' },
          onError: () => setLoginImageError(true),
        }),
        loginImageError && login?.phase === 'waiting' && h('p', { role: 'alert' }, '二维码图片加载失败，请点击“重新生成二维码”。'),
        login?.phase === 'select-device' && h('div', null, ...(login.devices || []).map(device =>
          h('div', { key: device.id, style: flex }, h('span', null, device.name + ' · ' + device.model + (device.online ? ' · 在线' : ' · 离线')),
            h(ui.Btn, { disabled: busy || !device.supported || !device.online, onClick: async () => {
              setBusy(true);
              try { const result = await call('/speaker/login/select', { id: device.id });
                setState(previous => ({ ...previous, login: result.login }));
                if (result.ok) reload?.(); else toast(result.login?.message || '设备选择未完成。');
              } catch { toast('设备选择结果未能读取，请检查登录状态。'); }
              finally { setBusy(false); }
            } }, device.supported ? '选择此音箱' : '暂不支持')))),
        h('p', { className: 'ab-small ab-muted' }, '扫码后请在手机确认。验证账号和音箱连接通过后，才会更新本机保存的登录凭据。')),
      connection && h('p', { className: 'ab-small' }, connection.ok && connection.historyReadable ? '登录与连接正常，语音记录可读。' : connection.message || '连接检查未通过。'),
      h(ui.Row, { label: '音箱所在电脑网卡', hint: '选择与音箱在同一局域网的网卡，保存后再扫码。' },
        needsSetup && networks.length > 0 && h('select', { className: 'ab-input', 'aria-label': '可用网卡', value: config.networkInterface || '', disabled: busy, onChange: event => field('networkInterface', event.target.value) },
          h('option', { value: '' }, '请选择网卡'), ...networks.map(item => h('option', { key: item.name, value: item.name }, item.name + ' · ' + item.addresses.join('、')))), h('input', { className: 'ab-input', value: config.networkInterface || '',
        'aria-label': '音箱所在电脑网卡', disabled: busy, onChange: event => field('networkInterface', event.target.value) })),
      h(ui.Row, { label: '音箱设备标识', hint: '填写小米设备列表中的设备 ID，不是 L05C、L05B、LX06、OH2P 等型号名。当前已适配 L05C；仅一台时可留空。' },
        h('input', { className: 'ab-input', value: config.speakerDevice || '', placeholder: '手动填写设备标识',
          'aria-label': '音箱设备标识', disabled: busy, onChange: event => field('speakerDevice', event.target.value) })),
      voiceSelect('motherVoice', '儿歌翻唱音色'),
      h('p', { className: 'ab-small ab-muted' }, '默认跟随 AuraBot「表达 → 翻唱」。已保存成品保持原来的音色。',
        voiceOptions?.singing?.configured === false ? ' 尚未选择音色，请先前往设置。' : ''),
      h('div', { style: flex },
        h(ui.Btn, { small: true, onClick: () => navigate('song') }, '去表达模块设置翻唱'),
        h(ui.Btn, { disabled: busy, onClick: async () => {
          const result = await run('/settings/save', { networkInterface: config.networkInterface || '', speakerDevice: config.speakerDevice || '',
            motherVoice: config.motherVoice || '' });
          if (result?.ok) { await loadOptions(); reload?.(); }
        } }, '保存连接与音色设置'))),
    h(ui.Card, { title: needsSetup ? '首次配置 · 3. 语音称呼' : '语音称呼' },
      h(ui.Row, { label: '主要称呼', hint: '填写并保存你希望使用的称呼，AI 补足可跳过。配置完成后打开页面顶部的“小爱音响接入”开关。每次先说“小爱同学”唤醒音箱，再说“称呼＋问题或指令”。例如称呼填“小伴”，就说“小伴，今天天气怎么样”或“小伴，播放小星星”。称呼不能替代音箱唤醒词，无需先说“你好”。' },
        h('input', { className: 'ab-input', value: wakePrimary, disabled: busy || wakeSuggesting, 'aria-label': '主要称呼', onChange: e => { setWakePrimary(e.target.value); setWakeSuggestion(null); } })),
      h(ui.Row, { label: '同音词与识别变体', hint: '逗号分隔，可手动增删；AI 每次至少给出 10 个候选，不会直接保存。' },
        h('textarea', { className: 'ab-textarea', value: wakeNames, rows: 3, disabled: busy || wakeSuggesting, 'aria-label': '同音词与识别变体', onChange: e => { setWakeNames(e.target.value); setWakeSuggestion(null); } })),
      h(ui.Btn, { disabled: busy || wakeSuggesting || features?.model === false || !wakePrimary.trim(), onClick: async () => {
        setWakeSuggesting(true); setWakeSuggestion(null);
        try {
          const r = await call('/speaker/wake/suggest', { primary: wakePrimary.trim(), existing: wakeNames.split(/[，,、;；\n]+/u).map(x => x.trim()).filter(Boolean) });
          if (r.ok) setWakeSuggestion(r); else toast(r.message || '同音词生成未完成。');
        } catch { toast('同音词生成未完成，请重试。'); } finally { setWakeSuggesting(false); }
      } }, wakeSuggesting ? 'AI 补足中…' : 'AI 补足同音词'),
      wakeSuggestion && h('div', { className: 'ab-note', role: 'status' },
        h('p', null, 'AI 候选（' + wakeSuggestion.names.length + ' 个）：' + wakeSuggestion.names.join('，')),
        h(ui.Btn, { disabled: busy, onClick: () => { setWakeNames([...new Set([...wakeNames.split(/[，,、;；\n]+/u).map(x => x.trim()).filter(Boolean), ...wakeSuggestion.names])].join('，')); setWakeSuggestion(null); } }, '采用候选到草稿'),
        h(ui.Btn, { disabled: busy, onClick: () => setWakeSuggestion(null) }, '保留原稿')),
      h(ui.Row, { label: '称呼应答', hint: '只说称呼时播报这句话。留空使用默认的“我在”。保存后可在电脑上试听。' },
        h('input', { className: 'ab-input', value: wakeAcknowledgement, maxLength: 160, disabled: busy,
          'aria-label': '称呼应答', onChange: e => {
            wakeAudioRef.current?.pause();
            setWakeAcknowledgement(e.target.value);
          } }),
        (wakeSaving || wakeAudio.phase === 'generating') && h('span', { role: 'status', className: 'ab-small' }, '生成中…'),
        !wakeSaving && wakeAudio.phase === 'failed' && h('p', { role: 'status', className: 'ab-small' },
          wakeAudio.message || '生成失败，请再次保存称呼。'),
        canPreviewWake &&
          h('div', null,
            h('audio', { ref: wakeAudioRef, preload: 'none', src: '/aurabot/api/ext/xiaoai-music/speaker/wake/audio?id=' + encodeURIComponent(wakeAudio.id) }),
            h(ui.Btn, { small: true, disabled: busy, onClick: previewWake }, '试听'))),
      h(ui.Btn, { disabled: busy || wakeSuggesting || Boolean(wakeSuggestion), onClick: async () => {
        const split = value => value.split(/[，,、;；\n]+/u).map(item => item.trim()).filter(Boolean);
        setWakeSaving(true);
        try {
          const result = await run('/speaker/wake/save', { names: [...new Set([wakePrimary.trim(), ...split(wakeNames)])],
            greetingNames: [], acknowledgement: wakeAcknowledgement.trim(), expectedWake: wakeSaved || undefined });
          if (result?.ok) applyWake(result);
          else if (result?.code === 'WAKE_SETTINGS_CHANGED' && result.wake) applyWake(result, Boolean(wakeSaved));
        } finally { setWakeSaving(false); }
      } }, '保存称呼'),
      state?.listener?.error && h('p', { className: 'ab-note err' }, state.listener.error.message)),
    !needsSetup && h(ui.Card, { title: '歌曲与歌单' },
      h('div', { ref: addSongRef, style: { paddingBottom: 14, borderBottom: '1px solid var(--ab-line)' } },
        h('div', { style: { ...flex, justifyContent: 'space-between' } },
          h('strong', null, '添加新歌曲'),
          state?.storage?.songs && h('span', { className: 'ab-small ab-muted' }, '歌曲目录：' + state.storage.songs)),
        h('p', { className: 'ab-small ab-muted' }, '搜索和下载跟随「表达 → 翻唱 → 网易云」中的登录配置。选择歌曲版本后，可保存原曲或生成翻唱；已有成品直接复用。'),
        h('div', { style: flex },
          h('input', { className: 'ab-input', value: query, placeholder: '搜索新歌曲', 'aria-label': '搜索新歌曲',
            disabled: busy, onChange: event => setQuery(event.target.value) }),
          h(ui.Btn, { disabled: busy || !query.trim(), onClick: async () => { const result = await run('/songs/search', { query });
            if (result?.ok) { setCandidates(result.candidates || []); setSongId(''); }
          } }, '搜索版本'),
          candidates.length > 0 && h('select', { className: 'ab-input', value: songId, disabled: busy,
            'aria-label': '选择歌曲版本', onChange: event => setSongId(event.target.value) },
            h('option', { value: '' }, '请选择版本'), ...candidates.map(song => h('option', { key: song.id, value: song.id }, song.title + ' — ' + song.artists))),
          h('select', { className: 'ab-input', value: songMode, disabled: busy,
            'aria-label': '歌曲方式', onChange: event => setSongMode(event.target.value) },
            h('option', { value: 'original' }, '原曲'), h('option', { value: 'cover' }, '生成翻唱')),
          songMode === 'cover' && h('select', { className: 'ab-input', value: songVoice, disabled: busy || !voiceOptions,
            'aria-label': '本次生成音色', onChange: event => setSongVoice(event.target.value) },
            h('option', { value: '' }, '使用本页默认翻唱音色'),
            ...(voiceOptions?.options || []).filter(option => option.id).map(option => h('option', { key: option.id, value: option.id }, option.label))),
          h(ui.Btn, { disabled: busy || !songId || (songMode === 'cover' && (!voiceOptions || (!songVoice && features?.singing === false))),
            onClick: () => run('/songs/generate', { songId, pitch: 0, play: false, mode: songMode, voice: songMode === 'cover' ? songVoice : '' }) },
            songMode === 'original' ? '保存原曲' : '生成并保存'),
          h(ui.Btn, { disabled: busy || !songId || (songMode === 'cover' && (!voiceOptions || (!songVoice && features?.singing === false))),
            onClick: () => run('/songs/generate', { songId, pitch: 0, play: true, mode: songMode, voice: songMode === 'cover' ? songVoice : '' }) },
            songMode === 'original' ? '保存并播放原曲' : '生成并播放到小爱')),
        ...(state?.songs?.jobs || []).map(job => h('p', { key: job.id, className: 'ab-small' }, job.title + '：' +
          ({ queued: '等待生成', generating: job.stage, ready: '完整成品已保存', failed: job.error?.message || '生成未完成' }[job.state] || job.state)))),
      h('div', { style: { ...flex, padding: '14px 0', borderBottom: '1px solid var(--ab-line)' } },
        h('strong', null, '当前播放'),
        h('span', { role: 'status', style: { flex: 1, minWidth: 130 } },
          (phaseNames[state?.playback?.phase] || '读取状态中') +
            (currentEntry ? ' · ' + currentEntry.title + ' · ' + currentEntry.voice : state?.playback?.current === 'sister-dialogue' ? ' · 音箱对话'
            : state?.playback?.current?.startsWith('family-reminder:') ? ' · 定时提醒' : '') +
          (state?.playback?.playlist ? ' · ' + (state.playback.playlist.index + 1) + '/' + state.playback.playlist.total : '')),
        h(ui.Btn, { small: true, disabled: busy, onClick: () => run('/songs/pause', {}) }, '暂停播放'),
        h(ui.Btn, { small: true, disabled: busy || !state?.playback?.playlist, onClick: () => run('/songs/next', {}) }, '下一首'),
        h(ui.Btn, { small: true, disabled: busy, onClick: () => run('/songs/stop', {}) }, '停止播放')),
      state?.playback?.error && h('p', { className: 'ab-note err' }, state.playback.error.message),
      h('div', { style: { ...flex, padding: '12px 0' } },
        h('strong', null, '电脑本地播放'),
        h('span', { className: 'ab-small ab-muted' }, localSong || '未播放'),
        h('audio', { ref: localAudioRef, controls: true, 'aria-label': '电脑本地播放器',
          onEnded: () => playLocalAt(localQueueRef.current.index + 1),
          onError: () => toast('电脑本地音频读取失败。') }),
        h(ui.Btn, { small: true, onClick: () => playLocalAt(localQueueRef.current.index + 1) }, '本地下一首'),
        h(ui.Btn, { small: true, onClick: () => { localAudioRef.current?.pause(); localQueueRef.current = { ids: [], index: 0 }; setLocalSong(''); } }, '停止本地播放')),
      h('section', { 'aria-label': '音乐目录管理', style: { borderTop: '1px solid var(--ab-line)', padding: '12px 0' } },
        h('div', { style: flex }, h('strong', null, '音乐目录'),
          h('select', { className: 'ab-input', 'aria-label': '查看音乐目录', value: directoryId, disabled: busy || listDirty,
            onChange: event => chooseDirectory(event.target.value) },
            h('option', { value: '' }, '全部目录'), ...directories.map(dir => h('option', { key: dir.id, value: dir.id },
              (dir.primary ? '新增歌曲保存目录 · ' : '') + dir.path + '（' + dir.count + ' 首）'))),
          h(ui.Btn, { small: true, onClick: () => setDirectoryManage(!directoryManage) }, directoryManage ? '收起目录管理' : '添加 / 管理目录'),
          h(ui.Btn, { small: true, disabled: busy || !directoryId, onClick: () => run('/songs/directories/refresh', { id: directoryId }) }, '刷新所选目录')),
        h('p', { className: 'ab-small ab-muted' }, '本地音乐直接读取，不复制文件。支持 MP3、WAV、OGG；新增原曲和翻唱仍保存到“新增歌曲保存目录”。称呼、提醒等模块资料保持原位置。'),
        state?.songs?.indexError && h('p', { className: 'ab-note err' }, state.songs.indexError + ' 请刷新曲库后重试。'),
        ...directories.filter(dir => dir.phase !== 'ready' || dir.missing || dir.skipped).map(dir => h('p', { key: dir.id, className: 'ab-note' },
          dir.path + '：' + (dir.phase === 'missing' ? '目录已离线或搬走，找不到原歌曲；请连接磁盘或重新添加目录。' : dir.phase === 'invalid' ? '曲库记录与文件不一致，请检查原文件后刷新。' : dir.phase !== 'ready' ? '目录已恢复，请刷新核对文件。' : '') +
          (dir.missing ? ' 缺失 ' + dir.missing + ' 条记录，歌单关联仍保留。' : '') +
          (dir.skipped ? ' 有 ' + dir.skipped + ' 个音频未能读取，请检查文件和翻唱环境中的 ffmpeg。' : ''))),
        directoryManage && h('div', { className: 'ab-note' },
          h('div', { style: flex }, h('input', { className: 'ab-input', 'aria-label': '添加音乐目录路径', value: directoryPath, disabled: busy,
            placeholder: '输入已有音乐文件夹的完整路径', onChange: event => setDirectoryPath(event.target.value) }),
            h(ui.Btn, { disabled: busy || !directoryPath.trim(), onClick: async () => { const result = await run('/songs/directories/add', { path: directoryPath.trim() }); if (result?.ok) setDirectoryPath(''); } }, '添加目录')),
          h('p', { className: 'ab-small' }, '目录搬走后请重新添加现有目录，再按需整理歌单。本模块不搬家、不更新旧目录路径。')),
        h('div', { style: flex }, h(ui.Btn, { disabled: busy || listDirty, onClick: async () => {
          const result = await run('/songs/missing/clear', {});
          if (result?.ok && activeList) { const list = result.playlists.find(item => item.id === activeList.id); setListIds(list?.ids || []); }
        } }, '一键清除失效歌曲'),
          h('span', { className: 'ab-small ab-muted' }, '清除所有目录中找不到文件的曲库记录及歌单引用，不删除磁盘文件。请先连接移动硬盘；临时离线的歌曲也会被清除。'))),
      h('div', { className: 'family-music-layout', style: { display: 'grid', gridTemplateColumns: '190px minmax(0, 1fr)', gap: 18, marginTop: 16 } },
        h('aside', { 'aria-label': '歌单列表', style: { minWidth: 0, borderRight: '1px solid var(--ab-line)', paddingRight: 12 } },
          h('button', { type: 'button', className: 'ab-li', disabled: busy, 'aria-pressed': showAll && !directoryId, onClick: () => openList(null),
            style: { width: '100%', textAlign: 'left', color: 'inherit', cursor: 'pointer',
              background: showAll ? 'var(--ab-foam-2)' : 'transparent', border: 0, padding: '10px 8px', borderRadius: 8, marginBottom: 16 } },
            h('span', { style: { flex: 1 } }, '♫ 全部歌曲'), h('span', { className: 'ab-muted ab-small' }, entries.length)),
          h('div', { style: { ...flex, justifyContent: 'space-between', marginBottom: 8 } },
            h('strong', { className: 'ab-small' }, '我的歌单 · ' + lists.length),
            h(ui.Btn, { small: true, disabled: busy || listDirty, title: '新建歌单', onClick: () => setCreatingList(!creatingList) }, '+')),
          creatingList && h('div', { style: { marginBottom: 12 } },
            h('input', { className: 'ab-input', value: newName, placeholder: '新歌单名称', 'aria-label': '新歌单名称',
              disabled: busy, style: { width: '100%', boxSizing: 'border-box', marginBottom: 8 }, onChange: event => setNewName(event.target.value) }),
            h(ui.Btn, { small: true, disabled: busy || !newName.trim() || listDirty, onClick: async () => {
              const result = await run('/songs/playlist/create', { name: newName.trim() });
              if (result?.ok) { setPlaylistId(result.playlist.id); setListName(result.playlist.name); setListIds(result.playlist.ids);
                setTargetListId(result.playlist.id); setNewName(''); setCreatingList(false); setSavedQuery(''); }
            } }, '创建歌单')),
          h('div', { className: 'ab-list' },
            ...lists.map(list => h('button', { key: list.id, type: 'button', className: 'ab-li', disabled: busy,
              'aria-pressed': list.id === playlistId, onClick: () => openList(list),
              style: { width: '100%', textAlign: 'left', color: 'inherit', cursor: 'pointer', gap: 8, border: 0, padding: '10px 8px', borderRadius: 8,
                background: list.id === playlistId ? 'var(--ab-foam-2)' : 'transparent' } },
              h('span', { style: { display: 'grid', placeItems: 'center', width: 30, height: 34, flexShrink: 0,
                background: 'var(--ab-foam-2)', borderRadius: 5 } }, '♪'),
              h('span', { style: { minWidth: 0, flex: 1, overflowWrap: 'anywhere' } }, list.name),
              h('span', { className: 'ab-muted ab-small' }, list.ids.length)))),
          !lists.length && h('p', { className: 'ab-small ab-muted' }, '点击 + 创建歌单。')),
        h('section', { 'aria-label': showAll ? '全部歌曲内容' : '歌单歌曲内容', style: { minWidth: 0 } },
          h('div', { style: { ...flex, justifyContent: 'space-between' } },
            h('h4', { style: { margin: 0 } }, showAll ? selectedDirectory?.path || '全部歌曲' : activeList?.name || '选择歌单'),
            h('span', { className: 'ab-small ab-muted' }, displayedSongs.length + ' 首歌曲')),
          activeList && h('div', { className: 'family-playlist-toolbar', style: { ...flex, marginTop: 10,
            position: 'sticky', top: navigationHeight + 8, zIndex: 4, padding: '10px',
            background: 'var(--ab-card, #fff)', border: '1px solid var(--ab-line)', borderRadius: 10,
            boxShadow: '0 4px 12px rgba(0,0,0,.12)' } },
            h('input', { className: 'ab-input', value: listName, disabled: busy, 'aria-label': '当前歌单名称',
              onChange: event => setListName(event.target.value) }),
            h(ui.Btn, { small: true, disabled: busy || !listDirty || !listName.trim(), onClick: async () => {
              const result = await run('/songs/playlist/update', { id: activeList.id, name: listName.trim(), ids: listIds });
              if (result?.ok) { setListName(result.playlist.name); setListIds(result.playlist.ids); }
            } }, '保存修改'),
            h(ui.Btn, { small: true, disabled: busy || !listDirty, onClick: resetList }, '取消修改'),
            h(ui.Btn, { small: true, disabled: busy || listDirty, onClick: async () => {
              const result = await run('/songs/playlist/delete', { id: activeList.id });
              if (result?.ok) { const first = result.playlists?.[0]; setPlaylistId(first?.id || ALL_SONGS);
                setListName(first?.name || ''); setListIds(first?.ids || []); setTargetListId(first?.id || ''); setSavedQuery(''); }
            } }, '删除歌单')),
          h('div', { style: { ...flex, marginTop: 12 } },
            h('input', { className: 'ab-input', value: savedQuery, placeholder: showAll ? '搜索全部歌曲' : '搜索歌单内歌曲',
              'aria-label': '搜索已保存歌曲', onChange: event => setSavedQuery(event.target.value) }),
            !activeList && h(ui.Btn, { small: true, disabled: busy || !filtered.length,
              onClick: () => startLocal(filtered.filter(entry => entry.available !== false).map(entry => chosenVersions[entry.id] || entry.id)) }, '本地顺序播放'),
            !activeList && h(ui.Btn, { small: true, disabled: busy || !filtered.length,
              onClick: () => startLocal(filtered.filter(entry => entry.available !== false).map(entry => chosenVersions[entry.id] || entry.id), true) }, '本地随机播放'),
            activeList ? h(React.Fragment, null,
              h(ui.Btn, { small: true, disabled: busy || listDirty || !activeList.ids.length,
                onClick: () => run('/songs/playlist/play', { id: activeList.id, mode: 'sequential' }) }, '顺序播放一轮'),
              h(ui.Btn, { small: true, disabled: busy || listDirty || !activeList.ids.length,
                onClick: () => run('/songs/playlist/play', { id: activeList.id, mode: 'random' }) }, '随机播放一轮'),
              h(ui.Btn, { small: true, disabled: busy || listDirty || !activeList.ids.length,
                onClick: () => startLocal(activeList.ids) }, '本地顺序播放'),
              h(ui.Btn, { small: true, disabled: busy || listDirty || !activeList.ids.length,
                onClick: () => startLocal(activeList.ids, true) }, '本地随机播放'),
              h(ui.Btn, { small: true, disabled: busy || listDirty, onClick: () => openList(null) }, '添加歌曲'))
              : h('label', { className: 'ab-small', style: flex }, '加入到',
                h('select', { className: 'ab-input', value: targetList?.id || '', disabled: busy || !lists.length,
                  'aria-label': '加入目标歌单', onChange: event => setTargetListId(event.target.value) },
                  !lists.length ? h('option', { value: '' }, '请先创建歌单') :
                    lists.map(list => h('option', { key: list.id, value: list.id }, list.name))))),
          activeList && h('p', { className: 'ab-small ab-muted' }, listDirty ? '有未保存修改，保存后生效。'
            : '按住歌曲左侧 ⠿ 拖拽排序；也可聚焦拖动柄后用上下方向键调整。移出歌单会保留音频。'),
          deleteSong && h('div', { className: 'ab-note err', role: 'group', 'aria-label': '删除歌曲确认', style: { marginTop: 12 } },
            h('p', null, '从曲库删除《' + deleteSong.title + '》（' + deleteSong.voice + '）？音频文件和歌曲记录会被删除，并从所有歌单移除。'),
            h('div', { style: flex },
              h(ui.Btn, { disabled: busy, onClick: async () => {
                const result = await run('/songs/delete', { id: deleteSong.id, directoryId });
                if (result?.ok) setDeleteSong(null);
              } }, '确认删除歌曲'),
              h(ui.Btn, { disabled: busy, onClick: () => setDeleteSong(null) }, '取消删除'))),
          h('div', { className: 'ab-list', style: { marginTop: 12, maxHeight: 540, overflowY: 'auto' } },
            ...filtered.map(row => { const entry = showAll ? entries.find(item => item.id === chosenVersions[row.id]) || row : row;
              const versions = entries.filter(item => item.sourceId && item.sourceId === entry.sourceId);
              const hasOriginal = versions.some(item => modeOf(item) === 'original');
              const hasCover = versions.some(item => modeOf(item) === 'cover');
              return h('div', { key: row.id, className: 'ab-li', 'data-song-id': row.id,
              style: { gap: 10, alignItems: 'center', opacity: draggingId === entry.id ? 0.45 : 1,
                borderTop: dropId === entry.id ? '2px solid var(--ab-accent, #79baff)' : '2px solid transparent' },
               },
              activeList && h('button', { type: 'button', className: 'ab-btn', disabled: busy,
                title: '拖动排序：' + entry.title, 'aria-label': '拖动排序：' + entry.title,
                onPointerDown: event => startDrag(event, entry.id), onPointerMove: moveDrag, onPointerUp: finishDrag,
                onPointerCancel: endDrag, onLostPointerCapture: endDrag,
                onKeyDown: event => {
                  if (!['ArrowUp', 'ArrowDown'].includes(event.key) || busy) return;
                  event.preventDefault(); const at = listIds.indexOf(entry.id), to = at + (event.key === 'ArrowUp' ? -1 : 1);
                  if (to >= 0 && to < listIds.length) reorder(entry.id, listIds[to]);
                }, style: { cursor: busy ? 'default' : draggingId === entry.id ? 'grabbing' : 'grab',
                  touchAction: 'none', userSelect: 'none', padding: '5px 7px', flexShrink: 0 } }, '⠿'),
              h('div', { style: { flex: 1, minWidth: 100, overflowWrap: 'anywhere' } },
                h('div', null, entry.title + (entry.available === false ? '（找不到或无法读取，请重新添加）' : '')), h('div', { style: { ...flex, marginTop: 4 } },
                  h('span', { className: 'ab-small ab-muted' }, entry.artists),
                  h('span', { className: 'family-song-version', style: { display: 'inline-block', padding: '1px 8px',
                    border: '2px solid ' + (modeOf(entry) === 'original' ? '#2373b7' : '#b57413'), borderRadius: 6,
                    background: modeOf(entry) === 'original' ? '#e8f4ff' : '#fff1d6',
                    color: modeOf(entry) === 'original' ? '#154d7a' : '#714500', fontSize: 12, fontWeight: 700 } },
                    modeOf(entry) === 'local' ? '本地音乐' : modeOf(entry) === 'original' ? '原曲' : '翻唱 · ' + (entry.voice || '默认音色')))),
              h('span', { className: 'ab-small ab-muted' }, Math.floor(Math.round(entry.duration) / 60) + ':' + String(Math.round(entry.duration) % 60).padStart(2, '0')),
              h(ui.Btn, { small: true, disabled: busy || entry.available === false, title: '播放' + entry.title,
                onClick: () => run('/songs/play', { id: entry.id }) }, '播放'),
              h(ui.Btn, { small: true, disabled: busy || entry.available === false, title: '本地播放' + entry.title,
                onClick: () => startLocal([entry.id]) }, '本地播放'),
              h(ui.Btn, { small: true, disabled: busy || entry.mode === 'local', onClick: () => setVersionMenu(versionMenu === row.id ? '' : row.id) }, '切换版本'),
              versionMenu === row.id && h('div', { style: flex },
                h('select', { className: 'ab-input', value: entry.id, disabled: busy, 'aria-label': '选择歌曲版本',
                  onChange: event => chooseVersion(row, event.target.value) },
                  ...versions.map(item => h('option', { key: item.id, value: item.id }, versionLabel(item)))),
                !hasOriginal && h(ui.Btn, { small: true, disabled: busy, onClick: () => prepareMissingVersion(entry, 'original') }, '保存原曲'),
                !hasCover && h(ui.Btn, { small: true, disabled: busy, onClick: () => prepareMissingVersion(entry, 'cover') }, '生成翻唱')),
              activeList ? h(ui.Btn, { small: true, disabled: busy, title: '移出' + entry.title,
                onClick: () => setListIds(listIds.filter(id => id !== entry.id)) }, '移出')
                : h(React.Fragment, null,
                  h(ui.Btn, { small: true, disabled: busy || !targetList || targetList.ids.includes(entry.id),
                    title: '加入' + entry.title, onClick: () => addToList(entry) }, targetList?.ids.includes(entry.id) ? '已加入' : '加入歌单'),
                  h(ui.Btn, { small: true, disabled: busy || entry.readOnly || entry.available === false || (directoryId !== 'primary' && entry.directoryIds?.some(id => id !== 'primary')), title: entry.readOnly || (directoryId !== 'primary' && entry.directoryIds?.some(id => id !== 'primary')) ? '外部目录只读；删除主目录副本请先选择新增歌曲保存目录' : '删除' + entry.title, onClick: () => setDeleteSong(entry) }, '删除'))); })),
          !filtered.length && h('p', { className: 'ab-small ab-muted' }, savedQuery.trim() ? '没有匹配的歌曲。'
            : showAll ? '还没有已保存歌曲，可在顶部搜索生成。' : '歌单是空的，点击“添加歌曲”从全部歌曲加入。'),
          activeList && h('div', { 'aria-label': '拖拽移出歌单',
            style: { marginTop: 12, border: '1px dashed var(--ab-line)', borderRadius: 8, textAlign: 'center', padding: 12,
              background: dropId === '__remove__' ? 'var(--ab-foam-2)' : 'transparent' } },
            h('span', { className: 'ab-small ab-muted' }, '将歌曲拖到这里移出歌单'))))),
    !needsSetup && h(ui.Card, { title: '定时提醒', desc: '按北京时间设置周期或一次提醒。周期可选每天、每周、每月；一次可选日期和时间，执行后结束。到时 AuraBot 按当前人设和提示词组织话语，经小爱播报；播放繁忙时等空闲。' },
      h('div', { style: flex },
        h('label', { style: flex }, '类型', h('select', { className: 'ab-input', value: reminderMode, disabled: busy,
          'aria-label': '提醒类型', onChange: event => setReminderMode(event.target.value) },
          h('option', { value: 'periodic' }, '周期'), h('option', { value: 'once' }, '一次'))),
        reminderMode === 'once' && h('label', { style: flex }, '日期', h('input', { className: 'ab-input', type: 'date', value: reminderDate, disabled: busy,
          'aria-label': '一次提醒日期', onChange: event => setReminderDate(event.target.value) })),
        reminderMode === 'periodic' && h('label', { style: flex }, '周期', h('select', { className: 'ab-input', value: reminderFrequency, disabled: busy,
          'aria-label': '提醒周期', onChange: event => setReminderFrequency(event.target.value) },
          h('option', { value: 'daily' }, '每天'), h('option', { value: 'weekly' }, '每周'), h('option', { value: 'monthly' }, '每月'))),
        h('label', { style: flex }, '时间', h('input', { className: 'ab-input', type: 'time', value: reminderTime, disabled: busy,
          'aria-label': '提醒时间', onChange: event => setReminderTime(event.target.value) })),
        reminderMode === 'periodic' && reminderFrequency === 'monthly' && h('label', { style: flex }, '每月', h('input', { className: 'ab-input', type: 'number', min: 1, max: 31,
          value: reminderMonthDay, disabled: busy, style: { width: 72 }, 'aria-label': '每月提醒日期',
          onChange: event => setReminderMonthDay(Number(event.target.value)) }), '日')),
      reminderMode === 'periodic' && reminderFrequency === 'weekly' && h('div', { style: { ...flex, marginTop: 12 } }, ...['一', '二', '三', '四', '五', '六', '日'].map((label, index) =>
        h('label', { key: label, style: flex }, h('input', { type: 'checkbox', disabled: busy, checked: reminderDays.includes(index + 1),
          onChange: event => setReminderDays(event.target.checked ? [...reminderDays, index + 1].sort((a, b) => a - b) : reminderDays.filter(day => day !== index + 1)) }), '周' + label))),
      reminderMode === 'periodic' && reminderFrequency === 'monthly' && reminderMonthDay > 28 && h('p', { className: 'ab-small ab-muted' }, '某个月没有所选日期时，跳过该月。'),
      h('textarea', { className: 'ab-textarea', rows: 3, maxLength: 500, value: reminderText, disabled: busy, 'aria-label': '提醒提示词',
        style: { width: '100%', boxSizing: 'border-box', marginTop: 12 }, placeholder: '例如：提醒妈妈忙完休息一下，用轻松关心的语气说，不要说教。',
        onChange: event => { setReminderText(event.target.value); setReminderPreview(''); } }),
      h('div', { style: { ...flex, marginTop: 10 } },
        h(ui.Btn, { disabled: busy || features?.dialogue === false || !reminderText.trim() || !reminderTime || (reminderMode === 'once' && !reminderDate) || (reminderMode === 'periodic' && reminderFrequency === 'weekly' && !reminderDays.length), onClick: async () => {
          const schedule = reminderMode === 'once' ? { frequency: 'once', date: reminderDate, time: reminderTime } : { frequency: reminderFrequency, time: reminderTime,
            ...(reminderFrequency === 'weekly' ? { weekdays: reminderDays } : {}),
            ...(reminderFrequency === 'monthly' ? { monthDay: reminderMonthDay } : {}) };
          const result = await run('/reminders/create', { text: reminderText, schedule });
          if (result?.ok) { setReminderText(''); await loadReminders(); }
        } }, reminderMode === 'once' ? '保存一次提醒' : '保存周期提醒'),
        h(ui.Btn, { disabled: busy || features?.dialogue === false || !reminderText.trim(), onClick: async () => {
          const result = await run('/reminders/preview', { text: reminderText });
          if (result?.ok) { setReminderPreview(result.preview); await loadReminders(); }
        } }, '生成预览（不播报）'),
        h(ui.Btn, { disabled: busy, onClick: async () => { await run('/reminders/session/open', {}); await loadReminders(); } }, '创建 / 检查提醒会话'),
        h(ui.Btn, { disabled: busy, onClick: () => loadReminders().catch(() => toast('提醒读取未完成。')) }, '刷新提醒')),
      h('p', { className: 'ab-small ab-muted' }, '独立会话：小爱音响接入 · 小爱 → ' + (reminderSession?.title || '小爱音响接入 · 提醒')),
      reminderPreview && h('p', { className: 'ab-note' }, '文字预览：' + reminderPreview),
      h('p', { className: 'ab-small ab-muted' }, '提醒独立于语音入口开关，停止提醒请取消计划。暂停时可播提醒，播完不恢复旧歌曲。'),
      reminderError && h('p', { className: 'ab-note err' }, reminderError.message),
      h('div', { className: 'ab-list', style: { maxHeight: 360, overflowY: 'auto' } }, ...reminders.filter(item => item.state === 'active' || item.state === 'completed').map(item =>
        h('div', { className: 'ab-li', key: item.id }, h('div', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } },
          h('div', null, item.text),
          h('div', { className: 'ab-small ab-muted' },
            (item.schedule.frequency === 'once' ? '一次 ' + item.schedule.date : item.schedule.frequency === 'daily' ? '每天' : item.schedule.frequency === 'weekly'
              ? '每周 ' + item.schedule.weekdays.map(day => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、')
              : '每月 ' + item.schedule.monthDay + ' 日') + ' ' + item.schedule.time + (item.state === 'completed' ? ' · 已结束' : ' · 下次 ' + localTime(item.nextAt))),
          item.lastRun && h('div', { className: 'ab-small ab-muted' }, '上次：' + ({ sending: '正在组织或投送', sent: '已提交播报',
            failed: '投送失败，本次不自动重试', interrupted: '已中断，本次不重播' }[item.lastRun.state] || item.lastRun.state)),
          item.state === 'active' && item.lastRun?.state !== 'sending' && new Date(item.nextAt).getTime() <= Date.now() && h('div', { className: 'ab-small ab-muted' }, '等待音箱空闲或连接恢复。')),
        item.state === 'active' && h(ui.Btn, { small: true, disabled: busy || item.lastRun?.state === 'sending', onClick: async () => {
          await run('/reminders/cancel', { id: item.id }); await loadReminders();
        } }, '取消提醒')))),
      !reminders.some(item => item.state === 'active') && h('p', { className: 'ab-small ab-muted' }, '还没有待执行的提醒。')),
    onboarding && h(ui.Card, { title: needsSetup ? '首次配置 · 4. 功能检查与完成' : '功能配置状态',
      desc: '按需配置功能。原曲播放不要求翻唱音色；AI 补词可跳过。这里检查配置，不会试播音箱。' },
      ...[['original', '原曲搜索与保存', '请配置表达 → 翻唱 → 网易云'], ['model', 'AI 补词', '请配置 AuraBot 当前模型'],
        ['dialogue', '语音对话与提醒', '需要当前模型及表达 → 语音'], ['singing', '翻唱', '需要表达 → 翻唱中的音色及生成环境']].map(([key, name, guide]) =>
        h('p', { key, className: 'ab-small' }, name + '：' + (features?.[key] ? '已配置（实际下载、合成或播放仍需验证）' : '待配置 · ' + guide))),
      h('p', { className: 'ab-small ab-muted' }, '电脑与 AuraBot 需要保持运行。提醒按北京时间执行，关闭语音接入不会取消提醒；到期离线的提醒可能在恢复后补播。'),
      needsSetup && h('p', { className: 'ab-small' }, '基础配置：' + (onboarding.speakerVerified ? '音箱连接已检查' : '请点击“检查登录与连接”') + '；' + (onboarding.wakeSaved ? '称呼已保存' : '请保存主要称呼')),
      needsSetup && h(ui.Btn, { disabled: busy || connectionDirty || !onboarding.speakerVerified || !onboarding.wakeSaved, onClick: async () => {
        const result = await run('/onboarding/complete', {});
        if (result?.ok) { await loadLibrary(); await loadReminders(); }
      } }, '完成配置，进入模块'))
);
};
