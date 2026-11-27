const { useState, useEffect, useRef } = React;
const flex = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };
const ALL_SONGS = '__all__';
const songCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });
const listInput = { flex: '1 1 220px', width: '100%', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' };
const compactInput = { width: 'auto', minWidth: 0, maxWidth: 'min(100%, 320px)', boxSizing: 'border-box' };
const checkboxArea = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  gap: 8, minWidth: 44, minHeight: 44, flexShrink: 0, cursor: 'pointer' };
const checkboxSize = { width: 20, height: 20, margin: 0, cursor: 'inherit' };
const pendingJob = job => ['queued', 'generating'].includes(job?.state);
const splitWakeNames = value => [...new Set(value.split(/[，,、;；\n]+/u).map(name => name.trim()).filter(Boolean))];
const splitWakeReadings = value => value.split(/[，,]/u).map(reading => reading.trim());
const phaseNames = { idle: '空闲', preparing: '准备播放', playing: '正在播放', pausing: '正在暂停', paused: '已暂停',
  stopping: '正在停止', stopped: '已停止', completed: '本轮已结束', failed: '播放未完成' };
const messageFor = (result, fallback) => {
  const message = typeof result?.message === 'string' ? result.message.trim() : '';
  return message && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(message) ? message : fallback;
};
const musicLayoutCss = `
  .xiaoai-panel .xiaoai-song-actions > .ab-btn,
  .xiaoai-panel .xiaoai-track-actions > .ab-btn {
    box-sizing: border-box; min-height: 36px; max-width: 100%;
    justify-content: center; text-align: center; white-space: normal;
  }
  .xiaoai-panel .xiaoai-song-actions > .ab-btn { min-width: min(100%, 112px); }
  .xiaoai-panel .xiaoai-track-actions > .ab-btn { min-width: min(100%, 76px); }
  .xiaoai-panel .xiaoai-song-actions > select { min-height: 36px; flex: 1 1 180px; }
  .xiaoai-panel .xiaoai-track-actions { justify-content: flex-end; }
  @media (max-width: 680px) {
    .xiaoai-panel .xiaoai-song-actions > .ab-btn { flex: 1 1 112px; }
    .xiaoai-panel .xiaoai-track-actions { justify-content: flex-start; flex: 1 0 100%; }
  }
`;
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
      setState(previous => ({ ...previous, login: result.login || { phase: 'failed', message: messageFor(result, '未能生成二维码，请重试。') } }));
    } catch {
      setState(previous => ({ ...previous, login: { phase: 'failed', message: '暂时无法开始登录，请重新生成二维码。' } }));
    } finally { setBusy(false); }
  };
  const [voiceOptions, setVoiceOptions] = useState(null);
  const [localVoiceChecks, setLocalVoiceChecks] = useState({});
  const [playlistId, setPlaylistId] = useState(ALL_SONGS);
  const [directoryId, setDirectoryId] = useState('');
  const [directoryPath, setDirectoryPath] = useState('');
  const [directoryManage, setDirectoryManage] = useState(false);
  const [listName, setListName] = useState('');
  const [listIds, setListIds] = useState([]);
  const [newName, setNewName] = useState('');
  const [creatingList, setCreatingList] = useState(false);
  const [targetListId, setTargetListId] = useState('');
  const [selectedSongs, setSelectedSongs] = useState([]);
  const [songRemoval, setSongRemoval] = useState(null);
  const [batchVoice, setBatchVoice] = useState('');
  const [batchGeneration, setBatchGeneration] = useState(null);
  const batchControl = useRef(null);
  const [draggingId, setDraggingId] = useState('');
  const [dropId, setDropId] = useState('');
  const dragRef = useRef(null);
  const [savedQuery, setSavedQuery] = useState('');
  const [songSort, setSongSort] = useState('');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [songId, setSongId] = useState('');
  const [songMode, setSongMode] = useState('cover');
  const [songVoice, setSongVoice] = useState('');
  const [chosenVersions, setChosenVersions] = useState({});
  const [versionMenu, setVersionMenu] = useState('');
  const versionOptionsRef = useRef(null);
  const addSongRef = useRef(null);
  const [reminders, setReminders] = useState(null);
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
  const [recognition, setRecognition] = useState(null);
  const [recognitionLoading, setRecognitionLoading] = useState(false);
  const [recognitionError, setRecognitionError] = useState('');
  const [wakeDraft, setWakeDraft] = useState({ names: '', readings: '' });
  const [wakeAcknowledgement, setWakeAcknowledgement] = useState('');
  const [wakeAudio, setWakeAudio] = useState({ phase: 'idle' });
  const [wakeSaving, setWakeSaving] = useState(false);
  const [wakeSaved, setWakeSaved] = useState(null);
  const wakeAudioRef = useRef(null);
  const wakeReadingRequest = useRef(0);
  const wakeSavedReadings = useRef('');
  const [storageTarget, setStorageTarget] = useState('');
  const [storageVerification, setStorageVerification] = useState({ phase: 'idle' });
  const config = draftSettings || settings;
  const defaultVoiceId = voiceOptions?.singing?.id || '';
  const defaultVoiceLabel = voiceOptions?.singing?.label || '读取音色中…';
  const currentSongVoice = songMode === 'cover' ? songVoice || defaultVoiceId : '';
  const currentBatchVoice = batchVoice || defaultVoiceId;
  const localVoiceKey = [...new Set([config.motherVoice, currentSongVoice, currentBatchVoice])]
    .filter(id => id?.startsWith('local:')).sort().join('\n');
  const connectionDirty = ['networkInterface', 'speakerDevice', 'motherVoice'].some(key => String(config[key] || '') !== String(settings[key] || ''));
  const lists = state?.playlists || [];
  const entries = state?.songs?.entries || [];
  const directories = state?.songs?.directories || [];
  const selectedDirectory = directories.find(item => item.id === directoryId);
  const activeList = lists.find(list => list.id === playlistId);
  const dailyList = state?.dailyPlaylist;
  const showDaily = Boolean(dailyList && playlistId === dailyList.id);
  const showAll = playlistId === ALL_SONGS;
  const targetList = lists.find(list => list.id === targetListId) || lists[0];
  const listDirty = Boolean(activeList && (listName !== activeList.name || JSON.stringify(listIds) !== JSON.stringify(activeList.ids)));
  const generating = state?.songs?.jobs?.some(pendingJob);
  const batchRunning = Boolean(batchGeneration?.running);
  const entriesById = new Map(entries.map(entry => [entry.id, entry]));
  const currentEntry = entriesById.get(state?.playback?.current);
  const displayedSongs = showAll ? entries.filter(entry => !directoryId || entry.directoryIds?.includes(directoryId)) : (showDaily ? dailyList.ids : listIds).map(id => entriesById.get(id) ||
    { id, title: '找不到的歌曲', artists: '', sourceId: '', mode: 'local', voice: '', available: false, readOnly: true });
  const modeOf = entry => entry.mode || (entry.voice === '原曲' ? 'original' : 'cover');
  const voiceLabel = entry => modeOf(entry) === 'local' ? '本地音乐' : modeOf(entry) === 'original' ? '原曲' : entry.voiceLabel || entry.voice || '默认音色';
  const versionLabel = entry => (modeOf(entry) === 'cover' ? '翻唱 · ' : '') + voiceLabel(entry) +
    (entry.pitch > 0 ? ' · 升' + entry.pitch + '调' : entry.pitch < 0 ? ' · 降' + -entry.pitch + '调' : '');
  const searchTerms = savedQuery.toLowerCase().split(/\s+/u).filter(Boolean);
  const matchedSongs = displayedSongs.map(row => ({
    row, entry: showAll ? entriesById.get(chosenVersions[row.id]) || row : row,
  })).filter(({ entry }) => {
    const searchable = [entry.title, entry.artists, versionLabel(entry), entry.voice].join(' ').toLowerCase();
    return searchTerms.every(term => searchable.includes(term));
  });
  const visibleSongs = [...new Map(matchedSongs.map(song => [song.entry.id, song])).values()];
  if (songSort) visibleSongs.sort(({ entry: a }, { entry: b }) => {
    const byTitle = songCollator.compare(a.title, b.title);
    if (songSort === 'time') return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || byTitle;
    if (songSort === 'voice') return songCollator.compare(voiceLabel(a), voiceLabel(b)) || byTitle;
    return byTitle;
  });
  const visibleEntries = visibleSongs.map(({ entry }) => entry);
  const selectedSongIds = new Set(selectedSongs);
  const selectedRows = visibleSongs.filter(({ row }) => selectedSongIds.has(row.id));
  const selectedEntries = [...new Map(selectedRows.map(({ entry }) => [entry.id, entry])).values()];
  const allSelected = visibleSongs.length > 0 && selectedRows.length === visibleSongs.length;
  const readOnly = entry => entry.readOnly || (directoryId !== 'primary' && entry.directoryIds?.some(id => id !== 'primary'));
  const canDelete = entry => !readOnly(entry) && entry.available !== false;
  const clearSelection = () => { setSelectedSongs([]); setSongRemoval(null); };
  useEffect(clearSelection, [playlistId, directoryId, savedQuery]);
  useEffect(() => { if (versionMenu) versionOptionsRef.current?.scrollIntoView({ block: 'nearest' }); }, [versionMenu]);
  useEffect(() => () => { if (batchControl.current) batchControl.current.disposed = true; }, []);
  const loadOptions = async () => { const result = await call('/settings/options'); if (result.ok) setVoiceOptions(result.voices); };
  useEffect(() => {
    setLocalVoiceChecks({});
    if (!voiceOptions || !localVoiceKey) return;
    let active = true;
    const report = (voice, result) => {
      if (active) setLocalVoiceChecks(previous => ({ ...previous, [voice]: result }));
    };
    for (const voice of localVoiceKey.split('\n')) {
      call('/songs/local-voice/check', { voice }).then(result => report(voice, result))
        .catch(() => report(voice, { ok: false, message: '无法检查本地整曲音色，请刷新面板后重试。' }));
    }
    return () => { active = false; };
  }, [voiceOptions, localVoiceKey]);
  const localVoiceHint = id => {
    if (!id?.startsWith('local:') || !voiceOptions) return null;
    const check = localVoiceChecks[id];
    return h('p', { className: 'ab-small', role: check?.ok === false ? 'alert' : 'status' },
      check ? (check.ok ? check.message : '暂不可生成。' + messageFor(check, '请检查本地翻唱开关和登记文件。')) : '正在检查本地整曲音色…');
  };
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
      if (!result.ok) {
        setReminderError({ code: result.code, message: messageFor(result, '提醒列表暂时不可用，请刷新后重试。') });
        if (['FAMILY_REMINDER_INVALID', 'FAMILY_REMINDER_STORAGE'].includes(result.code)) setReminders([]);
        return;
      }
      setReminders(result.reminders); setReminderSession(result.session); setReminderError(result.error);
    } catch { setReminderError({ message: '提醒列表刷新未完成，显示的可能是旧状态；请刷新列表，不要重复保存。' }); }
  };
  const applyWake = (result, preserveDraft = false) => {
    const next = { ...result.wake, acknowledgement: result.wake.acknowledgement || '' };
    const display = { names: next.names.join('，'), readings: (result.readings || []).join('，') };
    const previousReadings = wakeSavedReadings.current;
    wakeSavedReadings.current = display.readings;
    if (preserveDraft) {
      setWakeDraft(draft => draft.names === (wakeSaved?.names.join('，') || '') &&
        draft.readings === previousReadings && !draft.loading ? display : draft);
      setWakeAcknowledgement(draft => draft === (wakeSaved?.acknowledgement || '') ? next.acknowledgement : draft);
    } else {
      wakeReadingRequest.current++;
      setWakeDraft(display);
      setWakeAcknowledgement(next.acknowledgement);
    }
    setWakeSaved(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    setWakeAudio(result.acknowledgementAudio || { phase: 'idle' });
  };
  const updateWakeNames = async value => {
    const ticket = ++wakeReadingRequest.current;
    const names = splitWakeNames(value);
    const previousNames = splitWakeNames(wakeDraft.names);
    const previousReadings = splitWakeReadings(wakeDraft.readings);
    const retained = names.map(name => previousReadings[previousNames.indexOf(name)] ?? '');
    const draft = { names: value, readings: retained.join('，') };
    setWakeDraft({ ...draft, loading: Boolean(names.length) });
    if (!names.length) return;
    try {
      const result = await call('/speaker/wake/pinyin', { names });
      if (ticket !== wakeReadingRequest.current) return;
      if (!result.ok) { setWakeDraft({ ...draft, error: messageFor(result, '无法生成称呼读音，请检查填写内容后重试。') }); return; }
      setWakeDraft({ names: value, readings: result.readings.map((reading, index) => retained[index] || reading).join('，') });
    } catch {
      if (ticket === wakeReadingRequest.current) setWakeDraft({ ...draft, error: '暂时无法生成拼音，请重新编辑称呼。' });
    }
  };
  const loadWake = async () => {
    const result = await call('/speaker/wake');
    if (!result.ok) throw new Error();
    applyWake(result, true);
  };
  const canPreviewWake = !wakeSaving && wakeAudio.phase === 'ready' &&
    wakeAcknowledgement.trim() === wakeSaved?.acknowledgement;
  const wakeDirty = wakeDraft.names !== (wakeSaved?.names.join('，') || '') ||
    wakeDraft.readings !== wakeSavedReadings.current || wakeAcknowledgement.trim() !== (wakeSaved?.acknowledgement || '');
  const uniqueWakeReadings = [...new Set(splitWakeReadings(wakeDraft.readings)
    .map(reading => reading.toLowerCase().replace(/ü/g, 'v').replace(/\s+/g, ' ')).filter(Boolean))];
  const saveWake = async () => {
    const names = splitWakeNames(wakeDraft.names);
    const pronunciations = wakeDraft.readings.trim() ? splitWakeReadings(wakeDraft.readings) : names.map(() => '');
    setWakeSaving(true);
    try {
      const result = await run('/speaker/wake/save', { names, pronunciations,
        greetingNames: [], acknowledgement: wakeAcknowledgement.trim(), expectedWake: wakeSaved || undefined });
      if (result?.ok) applyWake(result);
      else if (result?.code === 'WAKE_SETTINGS_CHANGED' && result.wake) applyWake(result, Boolean(wakeSaved));
    } finally { setWakeSaving(false); }
  };
  const wakeSaveButton = h(ui.Btn, { kind: 'primary', onClick: saveWake,
    disabled: !wakeSaved || busy || wakeSaving || wakeDraft.loading || Boolean(wakeDraft.error) || !splitWakeNames(wakeDraft.names).length },
  wakeSaving ? '保存称呼中…' : '保存称呼');
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
    const song = entriesById.get(id);
    setLocalSong(song ? song.title + ' · ' + (song.voiceLabel || song.voice) : '本地歌曲');
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
    if (!result.ok) { toast(messageFor(result, '歌曲库读取未完成，请检查保存目录后重试。')); return; }
    setState(result);
    setTargetListId(result.playlists?.[0]?.id || '');
  };
  useEffect(() => {
    call('/status').then(async result => {
      setState(result);
      if (result.onboarding && !result.onboarding.complete) return;
      loadWake().catch(() => toast('称呼读取未完成，请刷新页面。'));
      await loadLibrary();
      loadOptions().catch(() => toast('音色选项读取未完成。'));
      loadReminders();
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
    if (!reminders?.some(item => item.state === 'active')) return;
    const timer = setInterval(() => { loadReminders().catch(() => {}); }, 10000);
    return () => clearInterval(timer);
  }, [reminders?.some(item => item.state === 'active')]);
  useEffect(() => {
    if (batchRunning || (!generating && !['preparing', 'playing'].includes(state?.playback?.phase) && !state?.listener?.enabled && !loginPending)) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const result = await call('/status');
        if (active) { setState(result); setLoginStatusError(''); }
      } catch { if (active && loginPending) setLoginStatusError('暂时无法获取登录状态，正在重试。'); }
    }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [batchRunning, generating, state?.playback?.phase, state?.listener?.enabled, loginPending]);
  useEffect(() => {
    if (busy || batchRunning || !directories.length) return;
    let active = true;
    const timer = setInterval(() => { call('/songs/directories').then(result => { if (active && result.ok) setState(result); }).catch(() => {}); }, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [busy, batchRunning, directories.length]);
  const run = async (path, body) => {
    setBusy(true);
    try { const result = await call(path, body);
      if (typeof result.playback === 'object' || result.listener) setState(result);
      else {
        if (path === '/speaker/check') setConnection(result);
        try { setState(await call('/status')); }
        catch {
          toast(result.ok ? '操作已完成，但状态刷新未完成。请刷新查看，避免重复提交。' : messageFor(result, '操作未完成，请刷新面板后重试。'));
          return result;
        }
      }
      toast(messageFor(result, result.ok ? '已完成' : '操作未完成，请刷新面板后重试。')); return result;
    } catch { toast('操作未完成，请刷新状态。'); }
    finally { setBusy(false); }
  };
  const openList = list => {
    if (busy) return;
    if (listDirty) { toast('请先保存或取消当前歌单修改。'); return; }
    setDirectoryId('');
    setPlaylistId(list?.id || ALL_SONGS); setListName(list?.name || ''); setListIds([...(list?.ids || [])]);
    if (list && list.id !== dailyList?.id) setTargetListId(list.id);
    setSavedQuery(''); setSongSort(''); clearSelection(); setChosenVersions({}); setVersionMenu(''); dragRef.current = null; setDraggingId(''); setDropId('');
  };
  const chooseDirectory = id => {
    if (busy || listDirty) { toast('请先保存或取消当前歌单修改。'); return; }
    openList(null); setDirectoryId(id);
  };
  const chooseVersion = (row, id) => {
    setVersionMenu('');
    if (!id || id === row.id && !chosenVersions[row.id]) return;
    setSongRemoval(null);
    if (activeList) {
      if (listIds.includes(id)) { toast('该版本已在歌单中。'); return; }
      setListIds(listIds.map(value => value === row.id ? id : value));
      setSelectedSongs(previous => previous.map(value => value === row.id ? id : value));
      toast('已切换版本，请保存歌单修改。');
    } else setChosenVersions(previous => ({ ...previous, [row.id]: id }));
  };
  const switchAllVersions = () => {
    const options = new Map();
    for (const item of entries) {
      if (!item.sourceId || item.available === false || modeOf(item) !== 'cover' || item.voiceId !== currentBatchVoice ||
          (showAll && directoryId && !item.directoryIds?.includes(directoryId))) continue;
      const variants = options.get(item.sourceId) || [];
      variants.push(item);
      options.set(item.sourceId, variants);
    }
    const changes = new Map();
    const inList = new Set(listIds);
    let unchanged = 0;
    let skipped = 0;
    for (const { row, entry } of visibleSongs) {
      const variants = options.get(entry.sourceId) || [];
      const next = variants.find(item => item.id === entry.id) ||
        variants.find(item => item.pitch === entry.pitch) || variants.find(item => !item.pitch) || variants[0];
      if (next?.id === entry.id) { unchanged++; continue; }
      if (!next || (activeList && inList.has(next.id))) { skipped++; continue; }
      changes.set(row.id, next.id);
      inList.add(next.id);
    }
    if (changes.size) {
      if (activeList) setListIds(listIds.map(id => changes.get(id) || id));
      else {
        // Repoint hidden aliases too, so a prior switch cannot restore an older version.
        const byEntry = new Map(visibleSongs.filter(({ row }) => changes.has(row.id))
          .map(({ row, entry }) => [entry.id, changes.get(row.id)]));
        setChosenVersions(previous => ({
          ...previous, ...Object.fromEntries(displayedSongs.filter(row => byEntry.has(previous[row.id] || row.id))
            .map(row => [row.id, byEntry.get(previous[row.id] || row.id)])),
        }));
      }
      setVersionMenu('');
      clearSelection();
    }
    toast('已切换 ' + changes.size + ' 个版本，已是所选音色 ' + unchanged + ' 个，跳过 ' + skipped + ' 个。' +
      (activeList && changes.size ? '保存歌单修改后生效。' : ''));
  };
  const prepareMissingVersion = (entry, mode) => {
    setQuery(entry.title); setCandidates([{ id: entry.sourceId, title: entry.title, artists: entry.artists }]);
    setSongId(entry.sourceId); setSongMode(mode); setSongVoice(''); setVersionMenu('');
    toast(mode === 'original' ? '尚无原曲，请在上方保存原曲。' : '尚无翻唱，请在上方选择音色后生成。');
    addSongRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const resetList = () => { if (activeList) { clearSelection(); setListName(activeList.name); setListIds([...activeList.ids]); } };
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
  const changeSelection = ids => { setSelectedSongs(ids); setSongRemoval(null); };
  const toggleSong = (id, checked) => {
    setSelectedSongs(previous => checked ? [...previous, id] : previous.filter(value => value !== id));
    setSongRemoval(null);
  };
  const addToList = async (songs, multiple = false) => {
    if (!targetList || busy || (targetList.id === activeList?.id && listDirty)) return;
    const result = await run('/songs/playlist/add', { id: targetList.id, ids: songs.map(entry => entry.id) });
    if (!result?.ok) return;
    if (activeList?.id === result.playlist.id) setListIds(result.playlist.ids);
    if (multiple) clearSelection();
  };
  const askRemoval = (songs, multiple = false) => {
    const removable = showAll ? songs.filter(canDelete) : songs;
    const skipped = songs.length - removable.length;
    if (!removable.length) { toast('所选歌曲为只读或不可用，已跳过 ' + skipped + ' 首。'); return; }
    setSongRemoval({ songs: removable, skipped, multiple });
  };
  const confirmRemoval = async () => {
    const { songs, skipped } = songRemoval;
    if (activeList) {
      const ids = new Set(songs.map(entry => entry.id));
      setListIds(previous => previous.filter(id => !ids.has(id)));
      clearSelection();
      toast('已移出 ' + songs.length + ' 首，保存歌单后生效。');
      return;
    }
    setBusy(true);
    const failures = [];
    let deleted = 0;
    try {
      for (const entry of songs) {
        try {
          const result = await call('/songs/delete', { id: entry.id, directoryId });
          if (!result.ok) { failures.push(entry.title + '：' + messageFor(result, '删除未完成，请检查歌曲是否正在播放。')); continue; }
          setState(result);
          deleted++;
        } catch { failures.push(entry.title + '：未能确认删除结果，请刷新曲库'); }
      }
      toast('已删除 ' + deleted + ' 首，跳过 ' + skipped + ' 首，' +
        (failures.length ? '未确认或失败 ' + failures.length + ' 首。' + failures.join('；') : '失败 0 首。'));
    } finally { clearSelection(); setBusy(false); }
  };
  const generateBatch = async mode => {
    if (busy || batchControl.current || !visibleEntries.length) return;
    const voice = mode === 'cover' ? currentBatchVoice : '';
    const localCover = voice.startsWith('local:');
    const control = { stop: false, disposed: false };
    batchControl.current = control;
    const progress = { label: mode === 'original' ? '全部本地生成' : '全部音色生成', total: visibleEntries.length,
      running: true, current: '', succeeded: 0, failed: 0, skipped: 0, details: [] };
    const publish = () => {
      if (!control.disposed) setBatchGeneration({ ...progress, stopping: control.stop, details: [...progress.details] });
    };
    const skip = (entry, message) => { progress.skipped++; progress.details.push(entry.title + '：' + message); };
    const fail = (entry, message) => { progress.failed++; progress.details.push(entry.title + '：' + message); };
    const scheduled = new Set();
    publish();
    try {
      for (const entry of visibleEntries) {
        if (control.stop || control.disposed) break;
        if (entry.available === false) { skip(entry, '歌曲不可用'); continue; }
        if (modeOf(entry) === 'local' && mode === 'original') { skip(entry, '已有本地音频'); continue; }
        if (!/^\d{1,20}$/.test(entry.sourceId || '')) { skip(entry, '没有可用于生成的网易云版本'); continue; }
        const pitch = mode === 'cover' ? (entry.pitch ?? 0) : 0;
        if (localCover && pitch !== 0) { skip(entry, '本地整曲音色仅支持原调，请先切换到原调版本'); continue; }
        const key = entry.sourceId + ':' + pitch;
        if (scheduled.has(key)) { skip(entry, '本批已有相同目标版本'); continue; }
        scheduled.add(key);
        progress.current = entry.title;
        publish();
        const result = await call('/songs/generate', { songId: entry.sourceId, pitch, mode, voice, play: false });
        if (control.disposed) break;
        if (!result.ok) { fail(entry, messageFor(result, '未能提交生成，请检查音色与歌曲版本。')); continue; }
        setState(result);
        const initial = result.job;
        if (initial?.reused && initial.state === 'ready') { skip(entry, '目标版本已存在'); continue; }
        let job = initial;
        while (pendingJob(job) && !control.disposed) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (control.disposed) break;
          const snapshot = await call('/status');
          if (control.disposed) break;
          if (!snapshot.ok) throw new Error();
          setState(snapshot);
          job = snapshot.songs?.jobs?.find(item => item.id === initial.id);
        }
        if (control.disposed) break;
        if (job?.state === 'ready') progress.succeeded++;
        else if (job?.state === 'failed') fail(entry, messageFor(job.error, '生成未完成，请检查任务中的处理阶段。'));
        else throw new Error();
      }
    } catch {
      progress.error = '未能确认' + (progress.current ? '《' + progress.current + '》' : '当前歌曲') + '的结果，已停止提交后续任务。';
    } finally {
      progress.running = false;
      progress.current = '';
      batchControl.current = null;
      publish();
    }
  };
  const stopBatch = () => {
    if (!batchControl.current) return;
    batchControl.current.stop = true;
    setBatchGeneration(previous => ({ ...previous, stopping: true }));
  };
  const openSingingSettings = () => rootRef.current?.closest('.ab-root')?.querySelector('.ab-hero')
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const field = (key, value) => setSettings?.({ [key]: value });
  const voiceSelect = (key, label) => h(ui.Row, { label }, h('select', { className: 'ab-input', value: config[key] || '',
    'aria-label': label, onChange: event => field(key, event.target.value), disabled: busy || !voiceOptions },
    ...(voiceOptions?.options || [{ id: '', label: '读取音色中…' }]).map(option => h('option', { key: option.id, value: option.id }, option.label)),
    config[key] && !voiceOptions?.options?.some(option => option.id === config[key])
      ? h('option', { value: config[key], disabled: true }, '原音色不可用，请重新选择') : null));

  const targetPlaylistPicker = h('label', { className: 'ab-small', style: flex }, '加入到',
    h('select', { className: 'ab-input', style: compactInput, value: targetList?.id || '', disabled: busy || !lists.length,
      'aria-label': '加入目标歌单', onChange: event => setTargetListId(event.target.value) },
      !lists.length ? h('option', { value: '' }, '请先创建歌单') :
        lists.map(list => h('option', { key: list.id, value: list.id }, list.name))));
  const batchProcessed = batchGeneration ? batchGeneration.succeeded + batchGeneration.failed + batchGeneration.skipped : 0;
  const queueDisabled = busy || batchRunning || !visibleSongs.length;

  const setupNotice = needsSetup && h('div', { className: 'ab-note err', role: 'alert',
    style: { color: '#c5222e', fontWeight: 600 } },
  (!onboarding.storageReady ? (onboarding.confirmExisting ? '已找到原来的资料，确认后即可继续。' : onboarding.resourceRoot ? '保存位置已选好。点击「重试初始化」继续。' : '请先确认保存位置。')
    : !onboarding.speakerVerified ? '登录后点击「检查登录与连接」。'
    : !onboarding.wakeSaved ? '填好主要称呼后，点击「保存称呼」。' : '点击「完成配置，进入模块」即可开始使用。'));
  if (onboarding && !onboarding.storageReady) return h('div', { className: 'ab-grid' },
    setupNotice,
    h(ui.Card, { title: onboarding.confirmExisting ? '配置引导 · 1. 确认保存位置' : '首次配置 · 1. 选择保存位置',
      desc: onboarding.confirmExisting ? '继续使用现有歌曲、歌单和设置。' : '歌曲和歌单将保存在这里。建议选空间充足的非 C 盘文件夹。' },
      h(ui.Row, { label: '保存目录', hint: onboarding.confirmExisting ? undefined : '填写专用文件夹的完整路径。已有的小爱资料会保留在原处。' },
        h('input', { className: 'ab-input', 'aria-label': '首次保存目录', value: setupRoot || onboarding.resourceRoot || '',
          placeholder: '例如 D:\\XiaoaiMusic', disabled: busy || Boolean(onboarding.resourceRoot), onChange: event => setSetupRoot(event.target.value) })),
      h(ui.Btn, { disabled: busy || !(setupRoot || onboarding.resourceRoot).trim(), onClick: () => run('/onboarding/storage', { root: setupRoot || onboarding.resourceRoot }) },
        onboarding.confirmExisting ? '确认现有位置并继续' : onboarding.resourceRoot ? '重试初始化' : '确认位置并继续')));

  return h('div', { ref: rootRef, className: 'ab-grid xiaoai-panel' },
    setupNotice,
    h(ui.Card, { title: needsSetup ? '首次配置 · 2. 小爱音箱连接' : '小爱音箱',
      desc: '打开开关后，可以用设定的称呼和小爱对话。',
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
        if (result.ok) setStorageVerification(result.verification); else toast(messageFor(result, '核验未能开始，请检查复制目标位置。'));
      } }, '核验手动复制'),
      storageVerification.phase !== 'idle' && h('div', { className: 'ab-small', role: 'status', style: { margin: '8px 0' } },
        h('progress', { max: Math.max(storageVerification.total || 0, 1), value: storageVerification.checked || 0 }),
        ' ' + (storageVerification.checked || 0) + ' / ' + (storageVerification.total || 0) + ' 个文件 · ' +
          ({ checking: '正在核验', matched: '核验时文件一致，尚未切换', mismatch: '存在缺失或不一致，未切换', failed: storageVerification.message || '核验未完成' }[storageVerification.phase] || '') +
          (storageVerification.phase === 'mismatch' ? '（缺失 ' + storageVerification.missing + '，不一致 ' + storageVerification.conflicts + '，额外 ' + storageVerification.extra + '）' : ''))),
      h(ui.Row, { label: '小米账号登录', hint: '先保存电脑网卡，再用绑定音箱的米家 App 扫码。更新登录请用原账号。' },
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
                if (result.ok) reload?.(); else toast(messageFor(result.login, '设备选择未完成，请确认音箱在线。'));
              } catch { toast('设备选择结果未能读取，请检查登录状态。'); }
              finally { setBusy(false); }
            } }, device.supported ? '选择此音箱' : '暂不支持')))),
        login?.phase === 'waiting' && h('p', { className: 'ab-small ab-muted' }, '扫码后在手机上确认。验证通过后会自动保存登录信息。')),
      connection && h('p', { className: 'ab-small' }, connection.ok && connection.historyReadable ? '登录与连接正常，语音记录可读。' : messageFor(connection, '连接检查未通过，请检查音箱登录与所选网卡。')),
      h(ui.Row, { label: '音箱所在电脑网卡', hint: '选择与音箱在同一局域网的网卡，保存后再扫码。' },
        needsSetup && networks.length > 0 && h('select', { className: 'ab-input', 'aria-label': '可用网卡', value: config.networkInterface || '', disabled: busy, onChange: event => field('networkInterface', event.target.value) },
          h('option', { value: '' }, '请选择网卡'), ...networks.map(item => h('option', { key: item.name, value: item.name }, item.name + ' · ' + item.addresses.join('、')))), h('input', { className: 'ab-input', value: config.networkInterface || '',
        'aria-label': '音箱所在电脑网卡', disabled: busy, onChange: event => field('networkInterface', event.target.value) })),
      h(ui.Row, { label: '音箱设备标识', hint: '只有一台 L05C 可留空。多台时请填写目标音箱在小米设备列表中的 ID。' },
        h('input', { className: 'ab-input', value: config.speakerDevice || '', placeholder: '手动填写设备标识',
          'aria-label': '音箱设备标识', disabled: busy, onChange: event => field('speakerDevice', event.target.value) })),
      voiceSelect('motherVoice', '儿歌翻唱音色'),
      localVoiceHint(config.motherVoice),
      voiceOptions?.localVoices?.file && h('details', { className: 'ab-small ab-muted' },
        h('summary', null, '本地整曲音色（可选）'),
        h('p', null, '使用现有 RVC 音色无需配置。接入自己的整曲脚本时，先在宿主「本地接口」开启「翻唱换声」，按模块说明登记音色后刷新面板。'),
        h('p', { style: { overflowWrap: 'anywhere' } }, '登记文件 ', h('code', null, voiceOptions.localVoices.file)),
        voiceOptions.localVoices.entries.length > 0 && h('p', null,
          '已登记 ' + voiceOptions.localVoices.entries.map(item => item.label).join('、')),
        voiceOptions.localVoices.error && h('p', { role: 'alert' }, voiceOptions.localVoices.error)),
      h('p', { className: 'ab-small ab-muted' }, '当前默认翻唱音色 · ' + defaultVoiceLabel),
      h('div', { style: flex },
        h(ui.Btn, { small: true, onClick: openSingingSettings }, '返回页首设置翻唱'),
        h(ui.Btn, { disabled: busy, onClick: async () => {
          const result = await run('/settings/save', { networkInterface: config.networkInterface || '', speakerDevice: config.speakerDevice || '',
            motherVoice: config.motherVoice || '' });
          if (result?.ok) { await loadOptions(); reload?.(); }
        } }, '保存连接与音色设置'))),
    h(ui.Card, { title: needsSetup ? '首次配置 · 3. 语音称呼' : '语音称呼' },
      h(ui.Row, { label: '主要称呼', hint: '多个称呼用逗号分隔，同音字也能识别。开启接入后，先说“小爱同学”，再说“' + (wakeSaved?.names?.[0] || '小伴') + '，暂停播放”。' },
        h('textarea', { className: 'ab-textarea', rows: 2, value: wakeDraft.names, disabled: busy, 'aria-label': '主要称呼', onChange: e => updateWakeNames(e.target.value) })),
      h(ui.Row, { label: '主要称呼读音', hint: '自动生成并去重，每组用逗号分隔。' },
        h('output', { 'aria-label': '去重后的主要称呼读音', style: { display: 'block', overflowWrap: 'anywhere' } }, uniqueWakeReadings.join('，')),
        h('details', { style: { marginTop: 8 } },
          h('summary', null, '手动修正多音字'),
          h('p', { className: 'ab-small' }, '读音按称呼逐项填写，每组用逗号分隔，组内用空格分隔音节。'),
          h('textarea', { className: 'ab-textarea', rows: 2, value: wakeDraft.readings, disabled: busy || wakeDraft.loading,
            'aria-label': '主要称呼读音', onChange: e => setWakeDraft({ ...wakeDraft, readings: e.target.value }) })),
        wakeDraft.loading && h('span', { role: 'status' }, '生成拼音中…'),
        wakeDraft.error && h('p', { role: 'alert', className: 'ab-note err' }, wakeDraft.error)),
      h(ui.Btn, { disabled: recognitionLoading || needsSetup, onClick: async () => {
        setRecognitionLoading(true); setRecognitionError(''); setRecognition(null);
        try {
          const result = await call('/speaker/history/read', {});
          if (result.ok) setRecognition(result);
          else setRecognitionError(messageFor(result, '识别日志读取失败，请检查登录与连接。'));
        } catch { setRecognitionError('识别日志读取失败，请检查登录与连接。'); }
        finally { setRecognitionLoading(false); }
      } }, recognitionLoading ? '读取中…' : '读取识别日志'),
      recognitionError && h('p', { role: 'alert', className: 'ab-note err' }, recognitionError),
      recognition && h('div', { className: 'ab-note', 'aria-label': '识别日志' },
        h('p', null, recognition.message),
        h('p', null, recognition.listenerActive ? '当前语音接入已开启。' : '当前语音接入未开启；读取日志不会开启接入。'),
        !recognition.records.length && h('p', null, '小米云端未返回最近识别记录。'),
        ...recognition.records.map((item, index) => h('div', { key: index, style: { marginBottom: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
          h('div', null, new Date(item.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）'),
          h('div', null, '识别文字：' + item.text),
          h('div', null, '句首读音：' + item.heardPinyin + '；目标读音：' + item.targetPinyin),
          h('div', null, item.matched ? '按当前称呼：已命中' : '按当前称呼：未命中'),
          h('div', null, '处理结果：' + item.outcome))),
        h(ui.Btn, { small: true, onClick: () => setRecognition(null) }, '收起日志')),
      h(ui.Row, { label: '称呼应答', hint: '只说称呼时播报这句话。留空使用默认的“我在”。保存后可在电脑上试听。' },
        h('input', { className: 'ab-input', value: wakeAcknowledgement, maxLength: 160, disabled: busy,
          'aria-label': '称呼应答', onChange: e => {
            wakeAudioRef.current?.pause();
            setWakeAcknowledgement(e.target.value);
          } }),
        (wakeSaving || wakeAudio.phase === 'generating') && h('span', { role: 'status', className: 'ab-small' }, '生成中…'),
        !wakeSaving && wakeAudio.phase === 'failed' && h('p', { role: 'status', className: 'ab-small' },
          messageFor(wakeAudio, '生成失败，请再次保存称呼。')),
        canPreviewWake &&
          h('div', null,
            h('audio', { ref: wakeAudioRef, preload: 'none', src: '/aurabot/api/ext/xiaoai-music/speaker/wake/audio?id=' + encodeURIComponent(wakeAudio.id) }),
            h(ui.Btn, { small: true, disabled: busy, onClick: previewWake }, '试听'))),
      !wakeDirty && !wakeSaving && wakeSaveButton,
      state?.listener?.wakeError && h('p', { className: 'ab-note err' }, state.listener.wakeError.message),
      ['FAMILY_SESSION_STORAGE', 'FAMILY_SESSION_RESOLVE'].includes(state?.companion?.session?.error?.code) &&
        h('p', { className: 'ab-note err' }, '家庭会话不可用，请检查家庭会话记录。已开启的语音入口仍可使用称呼应答和播放控制。'),
      state?.listener?.error && h('p', { className: 'ab-note err' }, messageFor(state.listener.error, '语音接入未能启动，请检查登录与连接。'))),
    !needsSetup && h(ui.Card, { title: '歌曲与歌单' },
      h('style', null, musicLayoutCss),
      h('div', { ref: addSongRef, style: { paddingBottom: 14, borderBottom: '1px solid var(--ab-line)' } },
        h('div', { style: { ...flex, justifyContent: 'space-between' } },
          h('strong', null, '添加新歌曲'),
          state?.storage?.songs && h('span', { className: 'ab-small ab-muted' }, '歌曲目录：' + state.storage.songs)),
        h('p', { className: 'ab-small ab-muted' }, '搜索和下载跟随「表达 → 翻唱 → 网易云」中的登录配置。选择歌曲版本后，可保存原曲或生成翻唱；已有成品直接复用。'),
        h('div', { className: 'xiaoai-song-actions', style: flex },
          h('input', { className: 'ab-input', style: listInput, value: query, placeholder: '按歌名或歌手搜索新歌曲', 'aria-label': '搜索新歌曲',
            disabled: busy, onChange: event => setQuery(event.target.value) }),
          h(ui.Btn, { disabled: busy || !query.trim(), onClick: async () => { const result = await run('/songs/search', { query });
            if (result?.ok) { setCandidates(result.candidates || []); setSongId(''); }
          } }, '搜索版本'),
          candidates.length > 0 && h('select', { className: 'ab-input', style: compactInput, value: songId, disabled: busy,
            'aria-label': '选择歌曲版本', onChange: event => setSongId(event.target.value) },
            h('option', { value: '' }, '请选择版本'), ...candidates.map(song => h('option', { key: song.id, value: song.id }, song.title + ' — ' + song.artists))),
          h('select', { className: 'ab-input', value: songMode, disabled: busy,
            'aria-label': '歌曲方式', onChange: event => setSongMode(event.target.value) },
            h('option', { value: 'original' }, '原曲'), h('option', { value: 'cover' }, '生成翻唱')),
          songMode === 'cover' && h('select', { className: 'ab-input', value: songVoice, disabled: busy || !voiceOptions,
            'aria-label': '本次生成音色', onChange: event => setSongVoice(event.target.value) },
            h('option', { value: '' }, '默认翻唱音色 · ' + defaultVoiceLabel),
            ...(voiceOptions?.options || []).filter(option => option.id).map(option => h('option', { key: option.id, value: option.id }, option.label))),
          h(ui.Btn, { disabled: busy || !songId || (songMode === 'cover' && (!voiceOptions || (!songVoice && features?.singing === false))),
            onClick: () => run('/songs/generate', { songId, pitch: 0, play: false, mode: songMode, voice: songMode === 'cover' ? songVoice : '' }) },
            songMode === 'original' ? '保存原曲' : '生成并保存'),
          h(ui.Btn, { disabled: busy || !songId || (songMode === 'cover' && (!voiceOptions || (!songVoice && features?.singing === false))),
            onClick: () => run('/songs/generate', { songId, pitch: 0, play: true, mode: songMode, voice: songMode === 'cover' ? songVoice : '' }) },
            songMode === 'original' ? '保存并播放原曲' : '生成并播放到小爱')),
        localVoiceHint(currentSongVoice),
        ...(state?.songs?.jobs || []).map(job => h('p', { key: job.id, className: 'ab-small' }, job.title + '：' +
          ({ queued: '等待生成', generating: job.stage, ready: '完整成品已保存', failed: messageFor(job.error, '生成未完成，请检查歌曲来源和所选音色。') }[job.state] || '暂时无法读取任务状态')))),
      h('div', { className: 'xiaoai-song-actions', style: { ...flex, padding: '14px 0', borderBottom: '1px solid var(--ab-line)' } },
        h('strong', null, '当前播放'),
        h('span', { role: 'status', style: { flex: 1, minWidth: 130 } },
          (phaseNames[state?.playback?.phase] || '读取状态中') +
            (currentEntry ? ' · ' + currentEntry.title + ' · ' + (currentEntry.voiceLabel || currentEntry.voice) : state?.playback?.current === 'sister-dialogue' ? ' · 音箱对话'
            : state?.playback?.current?.startsWith('family-reminder:') ? ' · 定时提醒' : '') +
          (state?.playback?.playlist ? ' · ' + (state.playback.playlist.index + 1) + '/' + state.playback.playlist.total : '')),
        h(ui.Btn, { small: true, disabled: busy, onClick: () => run('/songs/pause', {}) }, '暂停播放'),
        h(ui.Btn, { small: true, disabled: busy || !state?.playback?.playlist, onClick: () => run('/songs/next', {}) }, '下一首'),
        h(ui.Btn, { small: true, disabled: busy, onClick: () => run('/songs/stop', {}) }, '停止播放')),
      state?.playback?.error && h('p', { className: 'ab-note err', role: 'alert' },
        messageFor(state.playback.error, '未能播放歌曲，请检查音箱是否在线以及电脑与音箱的网络连接。')),
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
        ...directories.filter(dir => dir.phase !== 'ready' || dir.missing || dir.skipped || dir.invalid).map(dir => h('p', { key: dir.id, className: 'ab-note' },
          dir.path + '：' + (dir.phase === 'missing' ? '目录已离线或搬走，找不到原歌曲；请连接磁盘或重新添加目录。' : dir.phase === 'invalid' ? '曲库记录与文件不一致，请检查原文件后刷新。' : dir.phase !== 'ready' ? '目录已恢复，请刷新核对文件。' : '') +
          (dir.missing ? ' 缺失 ' + dir.missing + ' 条记录，歌单关联仍保留。' : '') +
          (dir.invalid ? ' 有 ' + dir.invalid + ' 首歌曲校验失败。恢复对应文件后刷新目录。' : '') +
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
          h('span', { className: 'ab-small ab-muted' }, '先接好移动硬盘。清除会从曲库和歌单移除找不到的歌曲，不删除磁盘文件。'))),
      h('div', { className: 'family-music-layout', style: { display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 16 } },
        h('aside', { 'aria-label': '歌单列表', style: { flex: '1 1 170px', minWidth: 0, paddingRight: 12 } },
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
            ...(dailyList ? [dailyList, ...lists] : lists).map(list => h('button', { key: list.id, type: 'button', className: 'ab-li', disabled: busy,
              'aria-pressed': list.id === playlistId, onClick: () => openList(list),
              style: { width: '100%', textAlign: 'left', color: 'inherit', cursor: 'pointer', gap: 8, border: 0, padding: '10px 8px', borderRadius: 8,
                background: list.id === playlistId ? 'var(--ab-foam-2)' : 'transparent' } },
              h('span', { style: { display: 'grid', placeItems: 'center', width: 30, height: 34, flexShrink: 0,
                background: 'var(--ab-foam-2)', borderRadius: 5 } }, '♪'),
              h('span', { style: { minWidth: 0, flex: 1, overflowWrap: 'anywhere' } }, list.name),
              h('span', { className: 'ab-muted ab-small' }, list.ids.length)))),
          !lists.length && h('p', { className: 'ab-small ab-muted' }, '点击 + 创建歌单。')),
        h('section', { 'aria-label': showAll ? '全部歌曲内容' : '歌单歌曲内容', style: { flex: '999 1 360px', minWidth: 0 } },
          h('div', { style: flex },
            h('h4', { style: { margin: 0, overflowWrap: 'anywhere' } }, showAll ? selectedDirectory?.path || '全部歌曲' : (showDaily ? dailyList : activeList)?.name || '选择歌单'),
            h('span', { className: 'ab-small ab-muted' }, visibleSongs.length + ' 首歌曲')),
          !showDaily && h('div', { className: 'xiaoai-song-actions', role: 'group', 'aria-label': '当前结果批量生成', style: { ...flex, marginTop: 10 } },
            h(ui.Btn, { disabled: queueDisabled, title: '为当前搜索结果保存原曲到本地', onClick: () => generateBatch('original') }, '全部本地生成'),
            h(ui.Btn, { disabled: queueDisabled || !voiceOptions || (!batchVoice && features?.singing === false),
              onClick: () => generateBatch('cover') }, '全部音色生成'),
            h(ui.Btn, { disabled: queueDisabled || !currentBatchVoice, title: '使用当前筛选结果中已保存的所选音色版本',
              onClick: switchAllVersions }, '全部版本切换音色'),
            h('label', { className: 'ab-small', style: { ...flex, minWidth: 0, flex: '1 1 220px' } }, '可选音色',
              h('select', { className: 'ab-input', style: compactInput, 'aria-label': '可选音色', value: batchVoice,
                disabled: busy || batchRunning || !voiceOptions, onChange: event => setBatchVoice(event.target.value) },
                h('option', { value: '' }, '默认翻唱音色 · ' + defaultVoiceLabel),
                ...(voiceOptions?.options || []).filter(option => option.id).map(option => h('option',
                  { key: option.id, value: option.id }, option.label))))),
          !showDaily && localVoiceHint(currentBatchVoice),
          h('p', { className: 'ab-small ab-muted' }, showDaily
            ? '每天从可播放的全部歌曲中随机抽取最多 20 首，同一首歌只选一个版本。'
            : '批量操作处理当前筛选结果。切换音色只使用已保存版本，缺少对应版本时跳过。'),
          batchGeneration && h('div', { className: 'ab-note', style: { marginTop: 10 } },
            h('div', { style: flex },
              h('span', { role: 'status', className: 'ab-small', style: { flex: '1 1 230px', overflowWrap: 'anywhere' } },
                batchGeneration.label + ' · ' + batchProcessed + '/' + batchGeneration.total +
                ' · 成功 ' + batchGeneration.succeeded + ' · 失败 ' + batchGeneration.failed + ' · 跳过 ' + batchGeneration.skipped +
                (batchGeneration.current ? ' · 正在处理《' + batchGeneration.current + '》' : '') +
                (batchGeneration.stopping ? (batchRunning ? ' · 正在等待当前歌曲结束' : ' · 已停止后续任务') : '')),
              batchRunning && h(ui.Btn, { small: true, disabled: batchGeneration.stopping, onClick: stopBatch }, '停止后续任务')),
            batchGeneration.error && h('p', { className: 'ab-small', role: 'alert' }, batchGeneration.error),
            batchGeneration.details.length > 0 && h('details', { className: 'ab-small', style: { marginTop: 6 } },
              h('summary', null, '失败和跳过详情'),
              h('ul', { style: { maxHeight: 160, overflowY: 'auto' } }, ...batchGeneration.details.map((message, index) =>
                h('li', { key: index }, message))))),
          activeList && h('div', { className: 'family-playlist-toolbar xiaoai-song-actions', style: { ...flex, marginTop: 10,
            position: 'sticky', top: navigationHeight + 8, zIndex: 4, padding: '10px',
            background: 'var(--ab-card, #fff)', border: '1px solid var(--ab-line)', borderRadius: 10,
            boxShadow: '0 4px 12px rgba(0,0,0,.12)' } },
            h('input', { className: 'ab-input', style: listInput, value: listName, disabled: busy, 'aria-label': '当前歌单名称',
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
            h('input', { className: 'ab-input', style: listInput, value: savedQuery, placeholder: '搜索歌名、歌手、原曲或翻唱音色',
              'aria-label': '搜索已保存歌曲', disabled: busy, onChange: event => { setSavedQuery(event.target.value); setVersionMenu(''); } }),
            h('select', { className: 'ab-input', style: compactInput, 'aria-label': '歌曲排序', value: songSort, disabled: busy,
              onChange: event => { setSongSort(event.target.value); setVersionMenu(''); endDrag(); } },
              h('option', { value: '' }, '默认顺序'),
              h('option', { value: 'time' }, '时间排序 · 最新在前'),
              h('option', { value: 'title' }, '字母排序 · 歌名'),
              h('option', { value: 'voice' }, '音色排序')),
            h('label', { className: 'ab-small', style: checkboxArea },
              h('input', { type: 'checkbox', 'aria-label': '全选当前结果', checked: allSelected, disabled: busy || !visibleSongs.length,
                ref: node => { if (node) node.indeterminate = !allSelected && selectedRows.length > 0; },
                onChange: event => changeSelection(event.target.checked ? visibleSongs.map(({ row }) => row.id) : []),
                style: checkboxSize }), '全选当前结果')),
          h('div', { className: 'xiaoai-song-actions', style: { ...flex, marginTop: 8 } },
            showDaily && h(ui.Btn, { small: true, disabled: busy || !dailyList.ids.length,
              onClick: () => run('/songs/playlist/play', { id: dailyList.id, mode: 'sequential' }) }, '小爱播放今日歌单'),
            !activeList && h(ui.Btn, { small: true, disabled: busy || !visibleSongs.length,
              onClick: () => startLocal(visibleEntries.filter(entry => entry.available !== false).map(entry => entry.id)) }, '本地顺序播放'),
            !activeList && h(ui.Btn, { small: true, disabled: busy || !visibleSongs.length,
              onClick: () => startLocal(visibleEntries.filter(entry => entry.available !== false).map(entry => entry.id), true) }, '本地随机播放'),
            activeList ? h(React.Fragment, null,
              h(ui.Btn, { small: true, disabled: busy || listDirty || !activeList.ids.length,
                onClick: () => run('/songs/playlist/play', { id: activeList.id, mode: 'sequential' }) }, '小爱顺序播放'),
              h(ui.Btn, { small: true, disabled: busy || listDirty || !activeList.ids.length,
                onClick: () => run('/songs/playlist/play', { id: activeList.id, mode: 'random' }) }, '小爱随机播放'),
              h(ui.Btn, { small: true, disabled: busy || listDirty || !activeList.ids.length,
                onClick: () => startLocal(activeList.ids) }, '本地顺序播放'),
              h(ui.Btn, { small: true, disabled: busy || listDirty || !activeList.ids.length,
                onClick: () => startLocal(activeList.ids, true) }, '本地随机播放'),
              h(ui.Btn, { small: true, disabled: busy || listDirty, onClick: () => openList(null) }, '添加歌曲'))
              : targetPlaylistPicker),
          selectedEntries.length > 0 && h('div', { className: 'ab-note', role: 'group', 'aria-label': '多选操作',
            style: { ...flex, marginTop: 10 } },
            h('strong', { className: 'ab-small' }, '已选 ' + selectedEntries.length + ' 首'),
            activeList && targetPlaylistPicker,
            h(ui.Btn, { small: true, disabled: busy || !targetList || (listDirty && targetList.id === activeList?.id),
              onClick: () => addToList(selectedEntries, true) }, '批量加入歌单'),
            !showDaily && h(ui.Btn, { small: true, disabled: busy || batchRunning, onClick: () => askRemoval(selectedEntries, true) },
              showAll ? '批量删除' : '批量移出'),
            h(ui.Btn, { small: true, disabled: busy, onClick: clearSelection }, '清空选择')),
          activeList && h('p', { className: 'ab-small ab-muted' }, listDirty ? '有未保存修改，保存后生效。'
            : '按住歌曲左侧 ⠿ 拖拽排序；也可聚焦拖动柄后用上下方向键调整。移出歌单会保留音频。'),
          songRemoval && h('div', { className: showAll ? 'ab-note err' : 'ab-note', role: 'group',
            'aria-label': showAll ? '删除歌曲确认' : '移出歌单确认', style: { marginTop: 12 } },
            h('p', null, showAll
              ? '从曲库删除' + (songRemoval.multiple ? ' ' + songRemoval.songs.length + ' 首歌曲' :
                '《' + songRemoval.songs[0].title + '》（' + versionLabel(songRemoval.songs[0]) + '）') +
                '？音频文件和曲库记录会被删除，并从所有歌单移除。' +
                (songRemoval.skipped ? ' 将跳过 ' + songRemoval.skipped + ' 首只读或不可用歌曲。' : '')
              : '从当前歌单移出 ' + songRemoval.songs.length + ' 首歌曲？保存修改后生效，音频和曲库记录会保留。'),
            h('div', { style: flex },
              h(ui.Btn, { disabled: busy || batchRunning, onClick: confirmRemoval },
                showAll ? '确认删除歌曲' : '确认移出歌单'),
              h(ui.Btn, { disabled: busy, onClick: () => setSongRemoval(null) }, '取消'))),
          h('div', { className: 'ab-list', style: { marginTop: 12, maxHeight: 540, overflowY: 'auto' } },
            ...visibleSongs.map(({ row, entry }) => {
              const versions = versionMenu === row.id ? entries.filter(item => item.sourceId && item.sourceId === entry.sourceId) : [];
              const hasOriginal = versions.some(item => modeOf(item) === 'original');
              const hasCover = versions.some(item => modeOf(item) === 'cover');
              return h('div', { key: row.id, className: 'ab-li', 'data-song-id': row.id,
              style: { ...flex, gap: 8, opacity: draggingId === entry.id ? 0.45 : 1,
                borderTop: dropId === entry.id ? '2px solid var(--ab-accent, #79baff)' : '2px solid transparent' },
               },
              h('label', { style: checkboxArea },
                h('input', { type: 'checkbox', 'aria-label': '选择：' + entry.title, checked: selectedSongIds.has(row.id),
                  disabled: busy, onChange: event => toggleSong(row.id, event.target.checked), style: checkboxSize })),
              activeList && !songSort && h('button', { type: 'button', className: 'ab-btn', disabled: busy,
                title: '拖动排序：' + entry.title, 'aria-label': '拖动排序：' + entry.title,
                onPointerDown: event => startDrag(event, entry.id), onPointerMove: moveDrag, onPointerUp: finishDrag,
                onPointerCancel: endDrag, onLostPointerCapture: endDrag,
                onKeyDown: event => {
                  if (!['ArrowUp', 'ArrowDown'].includes(event.key) || busy) return;
                  event.preventDefault(); const at = listIds.indexOf(entry.id), to = at + (event.key === 'ArrowUp' ? -1 : 1);
                  if (to >= 0 && to < listIds.length) reorder(entry.id, listIds[to]);
                }, style: { cursor: busy ? 'default' : draggingId === entry.id ? 'grabbing' : 'grab',
                  touchAction: 'none', userSelect: 'none', padding: '5px 7px', flexShrink: 0 } }, '⠿'),
              h('div', { style: { flex: '1 1 130px', minWidth: 0, overflowWrap: 'anywhere' } },
                h('div', null, entry.title + (entry.available === false ? '（找不到或无法读取，请重新添加）' : '')), h('div', { style: { ...flex, marginTop: 4 } },
                  h('span', { className: 'ab-small ab-muted' }, entry.artists),
                  h('span', { className: 'family-song-version', style: { display: 'inline-block', padding: '1px 8px',
                    border: '2px solid ' + (modeOf(entry) === 'original' ? '#2373b7' : '#b57413'), borderRadius: 6,
                    background: modeOf(entry) === 'original' ? '#e8f4ff' : '#fff1d6',
                    color: modeOf(entry) === 'original' ? '#154d7a' : '#714500', fontSize: 12, fontWeight: 700 } },
                    versionLabel(entry)),
                  showAll && readOnly(entry) && h('span', { className: 'ab-small ab-muted' }, '只读'))),
              h('div', { className: 'xiaoai-track-actions', style: { ...flex, gap: 6, minWidth: 0, maxWidth: '100%' } },
                Number.isFinite(entry.duration) && h('span', { className: 'ab-small ab-muted' },
                  Math.floor(Math.round(entry.duration) / 60) + ':' + String(Math.round(entry.duration) % 60).padStart(2, '0')),
                h(ui.Btn, { small: true, disabled: busy || entry.available === false, title: '小爱播放' + entry.title,
                  onClick: () => run('/songs/play', { id: entry.id }) }, '小爱播放'),
                h(ui.Btn, { small: true, disabled: busy || entry.available === false, title: '本地播放' + entry.title,
                  onClick: () => startLocal([entry.id]) }, '本地播放'),
                !showDaily && h(ui.Btn, { small: true, disabled: busy || modeOf(entry) === 'local', 'aria-expanded': versionMenu === row.id,
                  onClick: () => setVersionMenu(versionMenu === row.id ? '' : row.id) }, '切换版本'),
                activeList ? h(ui.Btn, { small: true, disabled: busy, title: '移出' + entry.title,
                  onClick: () => setListIds(listIds.filter(id => id !== entry.id)) }, '移出')
                  : h(React.Fragment, null,
                    h(ui.Btn, { small: true, disabled: busy || entry.available === false || !targetList || targetList.ids.includes(entry.id),
                      title: '加入' + entry.title, onClick: () => addToList([entry]) }, targetList?.ids.includes(entry.id) ? '已加入' : '加入歌单'),
                    !showDaily && h(ui.Btn, { small: true, disabled: busy || batchRunning || !canDelete(entry),
                      title: readOnly(entry) ? '外部目录只读；删除主目录副本请先选择新增歌曲保存目录' : '删除' + entry.title,
                      onClick: () => askRemoval([entry]) }, '删除'))),
              versionMenu === row.id && h('div', { ref: versionOptionsRef, style: { flexBasis: '100%', minWidth: 0 } },
                h('div', { className: 'ab-note', role: 'group', 'aria-label': '选择歌曲版本',
                  style: { maxWidth: 640, boxSizing: 'border-box' } },
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 4, maxHeight: 176, overflowY: 'auto' } },
                    ...versions.map(item => h('button', { key: item.id, type: 'button', className: 'ab-btn',
                      'aria-pressed': item.id === entry.id, disabled: busy, onClick: () => chooseVersion(row, item.id),
                      style: { justifyContent: 'center', textAlign: 'center', whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 0, padding: '7px 6px',
                        background: item.id === entry.id ? 'var(--ab-foam-2)' : undefined } },
                      versionLabel(item) + (item.available === false ? '（不可用）' : '')))),
                  h('div', { style: { ...flex, marginTop: 6 } },
                    !hasOriginal && entry.sourceId && h(ui.Btn, { small: true, disabled: busy, onClick: () => prepareMissingVersion(entry, 'original') }, '保存原曲'),
                    !hasCover && entry.sourceId && h(ui.Btn, { small: true, disabled: busy, onClick: () => prepareMissingVersion(entry, 'cover') }, '生成翻唱'))))); })),
          !visibleSongs.length && h('p', { className: 'ab-small ab-muted' }, savedQuery.trim() ? '没有匹配的歌曲。'
            : showDaily ? '全部歌曲中暂无可播放的歌曲。' : showAll ? '还没有已保存歌曲，可在顶部搜索生成。' : '歌单是空的，点击“添加歌曲”从全部歌曲加入。'),
          activeList && !songSort && h('div', { 'aria-label': '拖拽移出歌单',
            style: { marginTop: 12, border: '1px dashed var(--ab-line)', borderRadius: 8, textAlign: 'center', padding: 12,
              background: dropId === '__remove__' ? 'var(--ab-foam-2)' : 'transparent' } },
            h('span', { className: 'ab-small ab-muted' }, '将歌曲拖到这里移出歌单'))))),
    !needsSetup && h(ui.Card, { title: '定时提醒', desc: '按北京时间设置。到点后，小爱会用当前人设播报提醒。' },
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
        h(ui.Btn, { disabled: busy || features?.dialogue === false || ['FAMILY_REMINDER_INVALID', 'FAMILY_REMINDER_STORAGE'].includes(reminderError?.code) ||
          !reminderText.trim() || !reminderTime || (reminderMode === 'once' && !reminderDate) || (reminderMode === 'periodic' && reminderFrequency === 'weekly' && !reminderDays.length), onClick: async () => {
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
      reminderSession?.title && h('p', { className: 'ab-small ab-muted' }, '提醒会话：' + reminderSession.title),
      reminderPreview && h('p', { className: 'ab-note' }, '文字预览：' + reminderPreview),
      h('p', { className: 'ab-small ab-muted' }, '关闭语音接入后，提醒仍会播报。要停用某条提醒，请点「取消提醒」。'),
      state?.playback?.phase === 'paused' && h('p', { className: 'ab-small ab-muted' }, '音乐暂停时也能播提醒。提醒结束后，音乐仍然暂停。'),
      reminderError && h('p', { className: 'ab-note err' }, messageFor(reminderError, '提醒列表暂时不可用，请刷新后重试。')),
      h('div', { className: 'ab-list', style: { maxHeight: 360, overflowY: 'auto' } }, ...(reminders || []).filter(item => item.state === 'active' || item.state === 'completed').map(item =>
        h('div', { className: 'ab-li', key: item.id }, h('div', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } },
          h('div', null, item.text),
          h('div', { className: 'ab-small ab-muted' },
            (item.schedule.frequency === 'once' ? '一次 ' + item.schedule.date : item.schedule.frequency === 'daily' ? '每天' : item.schedule.frequency === 'weekly'
              ? '每周 ' + item.schedule.weekdays.map(day => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、')
              : '每月 ' + item.schedule.monthDay + ' 日') + ' ' + item.schedule.time + (item.state === 'completed' ? ' · 已结束' : ' · 下次 ' + localTime(item.nextAt))),
          item.lastRun && h('div', { className: 'ab-small ab-muted' }, '上次：' + ({ sending: '正在准备或发送提醒', sent: '已发送给音箱',
            failed: '未确认是否播出，本次不会重播', interrupted: '上次处理已中断，本次不会重播' }[item.lastRun.state] || item.lastRun.state)),
          item.state === 'active' && item.lastRun?.state !== 'sending' && new Date(item.nextAt).getTime() <= Date.now() && h('div', { className: 'ab-small ab-muted' }, '已到提醒时间，正在等待播报。')),
        item.state === 'active' && h(ui.Btn, { small: true, disabled: busy || item.lastRun?.state === 'sending', onClick: async () => {
          await run('/reminders/cancel', { id: item.id }); await loadReminders();
        } }, '取消提醒')))),
      reminders && !reminderError && !reminders.some(item => item.state === 'active') && h('p', { className: 'ab-small ab-muted' }, '还没有待执行的提醒。')),
    onboarding && h(ui.Card, { title: needsSetup ? '首次配置 · 4. 功能检查与完成' : '功能配置状态',
      desc: '按需配置功能。原曲播放不要求翻唱音色。这里检查配置，不会试播音箱。' },
      ...[['original', '原曲搜索与保存', '请配置表达 → 翻唱 → 网易云'],
        ['dialogue', '语音对话与提醒', '需要当前模型及表达 → 语音'], ['singing', '翻唱', '需要表达 → 翻唱中的音色及生成环境']].map(([key, name, guide]) =>
        h('p', { key, className: 'ab-small' }, name + '：' + (features?.[key] ? '已配置（实际下载、合成或播放仍需验证）' : '待配置 · ' + guide))),
      h('p', { className: 'ab-small ab-muted' }, '电脑与 AuraBot 需要保持运行。提醒按北京时间执行，关闭语音接入不会取消提醒；到期离线的提醒可能在恢复后补播。'),
      needsSetup && h('p', { className: 'ab-small' }, '基础配置：' + (onboarding.speakerVerified ? '音箱连接已检查' : '请点击“检查登录与连接”') + '；' + (onboarding.wakeSaved ? '称呼已保存' : '请保存主要称呼')),
      needsSetup && h(ui.Btn, { disabled: busy || connectionDirty || !onboarding.speakerVerified || !onboarding.wakeSaved, onClick: async () => {
        const result = await run('/onboarding/complete', {});
        if (result?.ok) { await loadLibrary(); await loadReminders(); }
      } }, '完成配置，进入模块')),
    (wakeDirty || wakeSaving) && h('div', { className: 'ab-savebar', 'aria-label': '称呼保存栏' },
      h('span', { className: 'msg', role: 'status' }, wakeSaving ? '正在保存称呼' : '称呼有改动还没保存'), wakeSaveButton)
);
};
