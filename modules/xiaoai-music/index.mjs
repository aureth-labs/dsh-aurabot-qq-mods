import { setupOnboarding } from './lib/companion/onboarding.mjs';
import { VoiceCursor } from './lib/speaker/cursor.mjs';
import { loadWindowsCredentials, saveWindowsCredentials } from './lib/speaker/windows.mjs';
import { connectSpeaker, verifySpeakerLogin, historyFailure } from './lib/speaker/mina.mjs';
import { SpeakerProbe, matchSavedSongSources, WAKE_ACK_LEAD_IN_MS } from './lib/speaker/probe.mjs';
import { askProbeModel, MODEL_TOKEN_BUDGET, MODEL_TEST_QUESTION } from './lib/speaker/model.mjs';
import { SpeakerLogin } from './lib/speaker/login.mjs';
import { authObservation, completeServiceLogin } from './lib/speaker/transport.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { FamilySongError, songFailure } from './lib/songs/library.mjs';
import { FamilyPlayback } from './lib/songs/playback.mjs';
import { SongPlaylists } from './lib/songs/playlists.mjs';
import { resourcePaths } from './lib/songs/storage.mjs';
import { companionFailure } from './lib/companion/runtime.mjs';
import { createDialogueSpeech } from './lib/companion/speech.mjs';
import { createWakeAudio } from './lib/companion/wake-audio.mjs';
import { ListenerPreference } from './lib/speaker/listener.mjs';
import { suggestWakeNames } from './lib/speaker/wake-ai.mjs';
import { WakePreference } from './lib/speaker/wake.mjs';
import { createLocalAudioHandler } from './lib/songs/local-audio.mjs';
import { checkResourceCopy } from './lib/songs/resource-check.mjs';
import { createFamilyActions } from './lib/companion/actions.mjs';
import { getVoiceOptions } from './lib/companion/settings.mjs';
import { FamilyReminders } from './lib/companion/reminders.mjs';
import { registerFamilyTools, PLAYBACK_ACTIONS, PLAYBACK_PROPERTIES, REMINDER_PROPERTIES } from './lib/companion/aurabot-tools.mjs';

function localRequest(req) {
  const remote = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  if (req.headers.origin && req.headers.origin !== 'http://' + host) return false;
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

export function localPost(req) {
  return localRequest(req) && req.method === 'POST' &&
    /^application\/json(?:;|$)/i.test(req.headers['content-type'] || '');
}

export function speakerFailure(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('HISTORY_')) return {
    ...historyFailure(error), message: '语音记录暂时读取失败，请查看错误分类。',
  };
  const value = String(error?.message || '');
  if (value === '正在扫码登录，请完成后再操作音箱。') return { code: 'SPEAKER_LOGIN_PENDING', message: value };
  const auth = /^authentication code (\d+);/.exec(value);
  if (auth) return {
    code: 'SPEAKER_AUTH_REJECTED',
    authCode: Number(auth[1]),
    authObservation: error.authObservation ? authObservation(error.authObservation) : null,
    message: '小米登录被拒绝（' + auth[1] + '），请更新已保存的音箱登录凭据。',
  };
  if (value === 'additional verification required') return {
    code: 'SPEAKER_VERIFICATION_REQUIRED',
    authObservation: error.authObservation ? authObservation(error.authObservation) : null,
    message: '小米账号需要完成安全验证，请在小米账号页面处理。',
  };
  return {
    code: 'SPEAKER_OPERATION_FAILED',
    message: '检查或操作失败，请检查音箱登录、在线状态和所选网卡。',
  };
}

export default {
  id: 'xiaoai-music',
  name: 'xiaoai music · 小爱音响接入',
  version: '0.15.2',
  api: 1,
  description: '小爱音箱接入、歌曲与歌单播放、提醒及 AI 称呼同音词补足。',
  defaults: { networkInterface: '', speakerDevice: '', resourceRoot: '' },
  settings: [],
  panel: 'panel.js',
  async setup(api) { return setupOnboarding(api, setupRuntime, { localPost, localRequest }); },
};

async function setupRuntime(api) {
    let speaker;
    let probe;
    let connecting;
    let lastProbe = { active: false, handled: 0 };
    let lastModel = { checked: false };
    let songs;
    let songsInit;
    let playback;
    let playlists;
    let companion;
    let companionInit;
    let reminderDialogue;
    let reminderDialogueInit;
    let reminderError = null;
    let reminderPreviewing = false;
    let familyIntent = 0;
    let disposed = false;
    let shutdowns = 0;
    let listenerEpoch = 0;
    let listenerStarting;
    let listenerRetryAt = 0;
    let listenerError = null;
    let historyFailureStreak = 0;
    let savingLoginDevice = false;
    const resourceRoot = api.settings().resourceRoot || api.dataDir();
    const resources = resourcePaths(resourceRoot);
    let resourceVerification = { phase: 'idle', total: 0, checked: 0, missing: 0, conflicts: 0, extra: 0 };
    const reminders = new FamilyReminders({ file: resources.remindersFile,
      canDeliver: async () => {
        if (disposed || shutdowns || loginPending() || reminderPreviewing || companion?.status().session?.busy || reminderDialogue?.status().busy) return false;
        if (playback && !['idle', 'paused', 'stopped', 'completed', 'failed'].includes(playback.status().phase)) return false;
        try {
          const state = await (await prepare()).status();
          return !disposed && !shutdowns && !loginPending() && !reminderPreviewing && !reminderDialogue?.status().busy &&
            ['idle', 'paused', 'stopped'].includes(state.playback);
        }
        catch { return false; }
      },
      deliver: deliverReminder,
    });
    await reminders.open();
    await mkdir(dirname(resources.cursorFile), { recursive: true });
    const cursor = new VoiceCursor(resources.cursorFile);
    await cursor.open();
    const preference = new ListenerPreference(resources.listenerFile);
    await preference.open();
    const wakePreference = new WakePreference(join(dirname(resources.listenerFile), '家庭称呼.json'));
    await wakePreference.open();
    const wakeSpeech = createDialogueSpeech(api, { workRoot: resources.dialogueWorkRoot });
    const wakeReply = () => wakePreference.get().acknowledgement;
    const wakeAudio = createWakeAudio({
      getText: wakeReply,
      signature: () => {
        const config = api.config();
        return [config.voice, config.song?.root, Boolean(api.core?.local?.active?.('tts'))];
      },
      prepare: text => wakeSpeech.prepare(text, { leadInMs: WAKE_ACK_LEAD_IN_MS }),
      failure: error => companionFailure(error).message,
    });
    const warmWakeAudio = () => {
      try {
        if (getVoiceOptions(api).dialogue?.configured) void wakeAudio.generate(wakeReply()).catch(() => {});
      } catch { /* An unconfigured voice must not prevent the module from starting. */ }
    };
    const login = new SpeakerLogin({
      environment: () => loadWindowsCredentials(api.settings().networkInterface, { allowMissing: true }),
      finalize: completeServiceLogin,
      verify: (credentials, selector) => verifySpeakerLogin(credentials, selector || api.settings().speakerDevice),
      save: saveWindowsCredentials,
      onDeviceSelected: async id => {
        if (!id || id === api.settings().speakerDevice) return;
        savingLoginDevice = true;
        try { await api.saveSettings({ speakerDevice: id }); }
        finally { savingLoginDevice = false; }
      },
    });
    const loginPending = () => ['preparing', 'waiting', 'verifying', 'select-device'].includes(login.status().phase);
    async function ask(text, maxTokens = MODEL_TOKEN_BUDGET) {
      const started = Date.now();
      try {
        const answer = await askProbeModel((options) => api.ask(options), text, maxTokens);
        lastModel = { checked: true, ok: true, ms: Date.now() - started, maxTokens, hasReply: true };
        return answer;
      } catch (error) {
        lastModel = { checked: true, ok: false, ms: Date.now() - started, maxTokens, code: error.code, message: error.message };
        throw error;
      }
    }
    async function prepare() {
      if (loginPending()) throw new Error('正在扫码登录，请完成后再操作音箱。');
      if (speaker) return speaker;
      if (connecting) return connecting;
      connecting = (async () => {
        const settings = api.settings();
        const credentials = await loadWindowsCredentials(settings.networkInterface);
        speaker = await connectSpeaker(credentials, settings.speakerDevice, saveWindowsCredentials);
        return speaker;
      })();
      try { return await connecting; } finally { connecting = null; }
    }
    function beginClose() {
      shutdowns++;
      listenerEpoch++;
      if (probe) void probe.close({ keepPlayback: true }).catch(() => {});
    }
    async function dispose({ gateHeld = false } = {}) {
      if (!gateHeld) beginClose();
      try {
        familyIntent++;
        await companion?.cancel();
        login.close();
        if (playback) await playback.close();
        if (connecting) { try { await connecting; } catch {} }
        if (probe) {
          await probe.close();
          lastProbe = probe.status();
        }
        else if (speaker) await speaker.close();
        probe = undefined;
        speaker = undefined;
      } finally { if (!gateHeld) shutdowns--; }
    }
    async function ensureCompanion() {
      if (companion) return companion;
      if (!companionInit) companionInit = (async () => {
        const { createFamilyCompanion } = await import('./lib/companion/runtime.mjs');
        companion = await createFamilyCompanion(api, resources, { execute: executeFamily });
        return companion;
      })();
      try { return await companionInit; } finally { companionInit = null; }
    }
    async function ensureSongs() {
      if (songs) return songs;
      if (!songsInit) songsInit = (async () => {
        const { createFamilySongs } = await import('./lib/songs/runtime.mjs');
        const service = await createFamilySongs(api, resources);
        const savedLists = new SongPlaylists({ file: resources.playlistsFile, library: service.library });
        await savedLists.open();
        playlists = savedLists;
        playback = new FamilyPlayback({ library: service.library, getSpeaker: prepare });
        songs = service;
        return songs;
      })();
      try { return await songsInit; } finally { songsInit = null; }
    }
    const executeFamily = createFamilyActions({
      getContext: async () => { await ensureSongs(); return { library: songs.library, playlists, playback }; },
      onMutation: () => ++familyIntent, getIntent: () => familyIntent,
    });
    async function ensureReminderDialogue() {
      if (reminderDialogue) return reminderDialogue;
      if (!reminderDialogueInit) reminderDialogueInit = (async () => {
        const { createReminderDialogue } = await import('./lib/companion/reminder-dialogue.mjs');
        const service = await createReminderDialogue(api, resources, { execute: (args, options) =>
          ['catalog', 'status'].includes(args.action) ? executeFamily(args, options)
            : { ok: false, message: '提醒会话只生成提醒文字，不能修改播放或设置。' } });
        if (disposed) { await service.close(); throw new Error('reminder module closed'); }
        reminderDialogue = service;
        return service;
      })();
      try { return await reminderDialogueInit; } finally { reminderDialogueInit = null; }
    }
    async function deliverReminder(reminder, options) {
      let ticket = familyIntent;
      const isCurrent = () => options.isCurrent() && !disposed && !shutdowns && ticket === familyIntent;
      let prepared;
      try {
        const text = await (await ensureReminderDialogue()).generate(reminder.text, { isCurrent });
        if (!isCurrent()) throw new Error('reminder superseded');
        prepared = await (await ensureCompanion()).prepare(text);
        await ensureSongs();
        if (!isCurrent() || !['idle', 'paused', 'stopped', 'completed', 'failed'].includes(playback.status().phase)) throw new Error('reminder superseded');
        const device = await prepare();
        const deviceState = await device.status();
        if (!isCurrent() || !['idle', 'paused', 'stopped'].includes(deviceState.playback) ||
            !['idle', 'paused', 'stopped', 'completed', 'failed'].includes(playback.status().phase)) throw new Error('speaker busy');
        ticket = ++familyIntent;
        await playback.audio({ id: 'family-reminder:' + reminder.id, absoluteFile: prepared.file, duration: prepared.duration }, { isCurrent });
        await playback.task;
        if (!isCurrent() || playback.error) throw new Error('reminder playback failed');
        return { accepted: true };
      } finally { await prepared?.cleanup(); }
    }
    async function callFamily(args, options = {}) {
      if (!PLAYBACK_ACTIONS.includes(args?.action)) return { ok: false, message: '请选择家庭接口支持的action。' };
      const isCurrent = () => !disposed && !shutdowns && (options.isCurrent?.() ?? true);
      if (!isCurrent()) return { ok: false, cancelled: true };
      if (!['catalog', 'status'].includes(args?.action)) probe?.invalidate();
      return executeFamily(args || {}, { ...options, isCurrent });
    }
    async function callReminder(args, options = {}) {
      if (disposed || shutdowns || options.isCurrent?.() === false) return { ok: false, cancelled: true };
      try {
        if (args?.action === 'preview') {
          if (typeof args.text !== 'string' || !args.text.trim() || [...args.text].length > 500) return { ok: false, message: '请填写500字以内的提醒提示词。' };
          if (reminderPreviewing || reminderDialogue?.status().busy || reminders.list().some(item => item.state === 'active' &&
              (item.lastRun?.state === 'sending' || new Date(item.nextAt).getTime() <= Date.now()))) {
            return { ok: false, message: '已有提醒等待或正在投送，请稍后预览。' };
          }
          reminderPreviewing = true;
          try {
            const service = await ensureReminderDialogue();
            const preview = await service.generate(args.text, { isCurrent: () => !disposed && !shutdowns && (options.isCurrent?.() ?? true) });
            return { ok: true, preview, session: service.status(), message: '预览已生成，没有向音箱或QQ投送。' };
          } finally { reminderPreviewing = false; }
        }
        if (args?.action === 'list') return { ok: true, reminders: reminders.list(), session: reminderDialogue?.status() || null, error: reminderError };
        if (args?.action === 'create') {
          const reminder = await reminders.create({ text: args.text, schedule: args.schedule, startsAt: args.startsAt });
          return { ok: true, reminder, message: '提醒已保存，到时按AuraBot当前人设生成并投送小爱；播放繁忙时等空闲，不代表已经播报。' };
        }
        if (args?.action === 'cancel') return { ok: true, reminder: await reminders.cancel(args.id), message: '提醒已取消。' };
        return { ok: false, message: '请选择create、list、cancel或preview。' };
      } catch (error) { return /^FAMILY_REMINDER_[A-Z_]+$/.test(error?.code || '')
        ? { ok: false, code: error.code, message: error.message }
        : { ok: false, code: 'FAMILY_REMINDER_FAILED', message: '定时提醒操作未完成。' }; }
    }
    registerFamilyTools(api, { execute: callFamily, remind: callReminder, available: () => !disposed && !shutdowns });
    function familyAction(action, text) {
      if (['stop', 'play-test', 'next'].includes(action)) familyIntent++;
      if (['pause', 'resume', 'stop', 'play-test'].includes(action) && playback?.selected) {
        return playback[action === 'play-test' ? 'stop' : action]();
      }
      if (action === 'next') return (async () => { await ensureSongs(); return playback.next(); })();
      if (['play-playlist', 'shuffle-playlist'].includes(action)) {
        const intent = ++familyIntent;
        return (async () => {
          await ensureSongs();
          if (intent !== familyIntent) return { cancelled: true };
          const normalize = value => String(value).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
          const allLists = playlists.status();
          const exact = allLists.filter(list => !text || normalize(list.name) === normalize(text));
          const spoken = String(text || '').replace(/(?:吧|呀|呗|谢谢|好吗|好不好)+$/, '');
          const lists = exact.length ? exact : allLists.filter(list => !spoken || normalize(list.name) === normalize(spoken));
          if (lists.length !== 1) {
            await (await prepare()).say('请在电脑家庭面板选择歌单，或说播放歌单加上歌单名称。');
            return { needsSelection: true };
          }
          await playback.playlist(lists[0].ids, { mode: action === 'shuffle-playlist' ? 'random' : 'sequential', announce: true });
          await playback.task;
          if (playback.error) throw new FamilySongError(playback.error.code, playback.error.message);
          return { accepted: true };
        })();
      }
      if (action !== 'play-song') return undefined;
      const intent = ++familyIntent;
      return (async () => {
        const service = await ensureSongs();
        if (intent !== familyIntent) return { cancelled: true };
        const sourceIds = matchSavedSongSources(service.library.status().entries, text);
        if (sourceIds.length !== 1) {
          await (await prepare()).say('请先在电脑的家庭面板选定歌曲版本，生成妈妈版后就能直接点播。');
          return { needsSelection: true };
        }
        await playback.source(sourceIds[0], { pitch: 0, announce: true });
        await playback.task;
        if (playback.error) throw new FamilySongError(playback.error.code, playback.error.message);
        return { accepted: true, reused: true };
      })();
    }
    async function beginListening(persistent) {
      const epoch = listenerEpoch;
      const current = () => !disposed && !shutdowns && !loginPending() && epoch === listenerEpoch && (!persistent || preference.enabled);
      if (!current()) return { cancelled: true };
      await prepare();
      if (!current()) return { cancelled: true };
      const service = await ensureCompanion();
      if (!current()) return { cancelled: true };
      await service.ensureSession();
      if (!current()) return { cancelled: true };
      if (!probe) probe = new SpeakerProbe({ speaker, cursor, familyAction, sessionRouting: true, getWakeConfig: () => wakePreference.get(),
        onInvalidate: () => { familyIntent++; return companion?.cancel(); },
        ask: async (text, options) => {
          if (!options.isCurrent()) return '';
          const own = playback?.status();
          if (!own?.selected && !own?.playlist) await speaker.operate('pause');
          if (!options.isCurrent()) return '';
          return (await ensureCompanion()).converse(text, options);
        },
        prepareAnswer: async (text, options) => options.leadInMs > 0
          ? wakeAudio.acquire(text) : (await ensureCompanion()).prepare(text, options),
        answerFailure: error => companionFailure(error).message,
        playAnswer: async (prepared, { isCurrent }) => {
          const intent = ++familyIntent;
          await ensureSongs();
          const currentAnswer = () => isCurrent() && (prepared.isCurrent?.() ?? true);
          if (!currentAnswer() || intent !== familyIntent) return { cancelled: true };
          await playback.audio({ id: 'sister-dialogue', absoluteFile: prepared.file, duration: prepared.duration }, { isCurrent: currentAnswer });
          await playback.task;
          if (!currentAnswer()) return { cancelled: true };
          if (playback.error) throw new FamilySongError(playback.error.code, playback.error.message);
          return { accepted: true, voice: 'family-dialogue', engine: prepared.engine, fallback: prepared.fallback,
            conversion: prepared.conversion };
        },
      });
      return { probe: await probe.arm({ persistent }) };
    }
    function startResident() {
      if (listenerStarting) return listenerStarting;
      listenerStarting = (async () => {
        try {
          const result = await beginListening(true);
          if (!result.cancelled) { listenerError = null; listenerRetryAt = 0; historyFailureStreak = 0; }
          return result;
        } catch (error) {
          listenerError = error?.code?.startsWith('FAMILY_SESSION') ? companionFailure(error) : speakerFailure(error);
          listenerRetryAt = Date.now() + 60000;
          throw error;
        } finally { listenerStarting = undefined; }
      })();
      return listenerStarting;
    }
    const status = () => ({
      ok: true, connected: Boolean(speaker),
      probe: probe?.status() || lastProbe,
      model: lastModel,
      login: login.status(),
      songs: songs?.library.status() || { entries: [], jobs: [] },
      playback: playback?.status() || { phase: 'idle' },
      playlists: playlists?.status() || [],
      storage: { root: resourceRoot, songs: songs?.library.root || resources.songRoot },
      companion: companion?.status() || { checked: false, voiceChecked: false },
      listener: { enabled: preference.enabled, active: Boolean(probe?.active() && probe?.persistent),
        starting: Boolean(listenerStarting), retrySeconds: Math.max(0, Math.ceil((listenerRetryAt - Date.now()) / 1000)), error: listenerError },
      stage: 'resident-family-session',
    });
    api.route('/status', async () => status());
    api.route('/storage/verification', async req => localRequest(req) && req.method === 'GET'
      ? { ok: true, verification: resourceVerification } : { ok: false, message: '需要本机读取核验状态。' });
    api.route('/speaker/wake', async req => localRequest(req) && req.method === 'GET'
      ? { ok: true, wake: wakePreference.get(), acknowledgementAudio: wakeAudio.state(wakeReply()) }
      : { ok: false, message: '需要本机读取家庭称呼。' });
    api.route('/speaker/wake/audio', createLocalAudioHandler({
      library: { get: id => wakeAudio.preview(wakeReply(), id) }, isLocalRequest: localRequest,
    }));
    api.route('/songs/local-audio', createLocalAudioHandler({
      library: { get: async id => (await ensureSongs()).library.get(id) }, isLocalRequest: localRequest,
    }));
    const post = (path, fn) => api.route(path, async (req) => {
      if (!localPost(req)) return { ok: false, message: '需要本机同源 JSON POST。' };
      try { return { ok: true, ...await fn(await api.core.http.body(req)) }; }
      catch (error) { return { ok: false, ...(path.startsWith('/settings/')
        ? { code: 'FAMILY_SETTINGS_SAVE', message: '家庭设置保存失败，请检查所选音色和连接设置。' }
        : path.startsWith('/companion/') ? companionFailure(error)
        : path.startsWith('/songs/') || error instanceof FamilySongError
        ? songFailure(error) : speakerFailure(error)) }; }
    });
    post('/storage/verify', async body => {
      if (resourceVerification.phase === 'checking') return { ok: false, message: '已有核验正在进行。' };
      if (typeof body.targetRoot !== 'string' || !body.targetRoot.trim()) return { ok: false, message: '请输入新的保存位置。' };
      const targetRoot = body.targetRoot.trim();
      resourceVerification = { phase: 'checking', targetRoot, total: 0, checked: 0, missing: 0, conflicts: 0, extra: 0 };
      void checkResourceCopy(resourceRoot, targetRoot, { onProgress: progress => {
        resourceVerification = { phase: 'checking', targetRoot, ...progress };
      } }).then(result => {
        resourceVerification = { phase: result.ok ? 'matched' : 'mismatch', targetRoot, ...result };
      }).catch(error => {
        resourceVerification = { phase: 'failed', targetRoot, total: 0, checked: 0, missing: 0, conflicts: 0, extra: 0,
          message: typeof error.code === 'string' && error.code.startsWith('RESOURCE_') ? error.message : '核验未完成，请检查目录。' };
      });
      return { verification: resourceVerification };
    });
    post('/speaker/wake/suggest', async body => suggestWakeNames(options => api.ask(options), body));
    post('/speaker/wake/save', async body => {
      const latestWake = () => {
        const wake = wakePreference.get();
        return { ok: false, code: 'WAKE_SETTINGS_CHANGED', message: '称呼设置已更新，请核对后再保存。',
          wake, acknowledgementAudio: wakeAudio.state(wake.acknowledgement) };
      };
      let wake;
      try { wake = await wakePreference.save(body, body?.expectedWake); }
      catch (error) {
        if (error.code === 'WAKE_SETTINGS_CHANGED') return latestWake();
        return { ok: false, message: error.message };
      }
      const text = wake.acknowledgement;
      try { await wakeAudio.generate(text); } catch {}
      if (JSON.stringify(wake) !== JSON.stringify(wakePreference.get())) return latestWake();
      const acknowledgementAudio = wakeAudio.state(text);
      return { wake, acknowledgementAudio, message: acknowledgementAudio.phase === 'failed'
        ? '称呼已保存，语音生成失败。' : '称呼已保存。' };
    });
    api.route('/capabilities', async () => ({ ok: true,
      module: 'xiaoai-music', version: '0.15.2',
      tools: [{ name: 'xiaoai_music', parameters: { type: 'object', properties: PLAYBACK_PROPERTIES, required: ['action'], additionalProperties: false } },
        { name: 'xiaoai_reminder', parameters: { type: 'object', properties: REMINDER_PROPERTIES, required: ['action'], additionalProperties: false } }],
      moduleCalls: { playback: "api.use('xiaoai-music').execute(args)", reminders: "api.use('xiaoai-music').remind(args)" },
      routes: { playback: 'POST /aurabot/api/ext/xiaoai-music/call', reminderList: 'GET /aurabot/api/ext/xiaoai-music/reminders',
        reminderCreate: 'POST /aurabot/api/ext/xiaoai-music/reminders/create', reminderCancel: 'POST /aurabot/api/ext/xiaoai-music/reminders/cancel',
        reminderPreview: 'POST /aurabot/api/ext/xiaoai-music/reminders/preview' },
    }));
    post('/call', body => callFamily(body));
    api.route('/reminders', async req => localRequest(req) && req.method === 'GET'
      ? callReminder({ action: 'list' }) : { ok: false, message: '需要本机读取提醒。' });
    post('/reminders/create', body => callReminder({ ...body, action: 'create' }));
    post('/reminders/cancel', body => callReminder({ ...body, action: 'cancel' }));
    post('/reminders/preview', body => callReminder({ ...body, action: 'preview' }));
    post('/reminders/session/open', async () => {
      try {
        const service = await ensureReminderDialogue(); await service.ensureSession();
        return { ok: true, session: service.status() };
      } catch { return { ok: false, message: '提醒会话暂时无法连接。' }; }
    });
    api.route('/settings/options', async () => ({ ok: true, voices: getVoiceOptions(api) }));
    post('/settings/save', async body => {
      const keys = ['networkInterface', 'speakerDevice', 'motherVoice'];
      if (keys.some(key => typeof body[key] !== 'string' || body[key].length > 160)) {
        return { ok: false, message: '请检查连接与音色设置。' };
      }
      const choices = getVoiceOptions(api).options;
      if (!choices.some(option => option.id === body.motherVoice)) {
        return { ok: false, message: '所选音色已不可用，请重新选择或前往表达模块设置。' };
      }
      const patch = Object.fromEntries(keys.map(key => [key, body[key].trim()]));
      await api.saveSettings(patch);
      return status();
    });
    post('/speaker/login/start', async () => {
      await dispose();
      const result = await login.start();
      return { ok: ['waiting', 'saved'].includes(result.phase), login: result };
    });
    post('/speaker/login/select', async body => {
      const result = await login.selectDevice(body.id);
      return { ok: result.phase === 'saved', login: result };
    });
    api.route('/speaker/login', async (req, res) => {
      if (!localRequest(req) || req.method !== 'GET') return { ok: false, message: '需要本机访问。' };
      res.setHeader('Cache-Control', 'no-store');
      api.core.http.send(res, 200, await readFile(join(api.dir, 'assets', 'login.html')), 'text/html; charset=utf-8');
    });
    api.route('/speaker/login/qr', async (req, res) => {
      if (!localRequest(req) || req.method !== 'GET' || !login.picture) {
        return api.core.http.send(res, 404, '', 'text/plain');
      }
      res.setHeader('Cache-Control', 'no-store');
      api.core.http.send(res, 200, login.picture.data, login.picture.type);
    });
    post('/model/check', async (body) => {
      if (body.extendedBudget !== undefined && typeof body.extendedBudget !== 'boolean') {
        return { ok: false, message: '模型检查参数不正确。' };
      }
      try {
        await ask(MODEL_TEST_QUESTION, body.extendedBudget === true ? 800 : MODEL_TOKEN_BUDGET);
        return { model: lastModel };
      } catch {
        return { ok: false, model: lastModel, message: lastModel.message };
      }
    });
    post('/speaker/check', async () => {
      const device = await prepare();
      const records = await device.conversations();
      return { connected: true, historyReadable: true, historyCount: records.length, ...await device.status() };
    });
    post('/speaker/history/check', async () => {
      const records = await (await prepare()).conversationsSince(cursor.state.since || Date.now());
      return { historyReadable: true, historyCount: records.length };
    });
    post('/speaker/arm', async () => {
      await preference.setEnabled(false);
      return beginListening(false);
    });
    post('/speaker/listener/start', async () => {
      await preference.setEnabled(true);
      await startResident();
      return status();
    });
    post('/speaker/action', async (body) => {
      if (!probe) throw new Error('未开启测试。');
      const result = await probe.act(body.action);
      return { result, probe: probe.status() };
    });
    post('/speaker/end', async () => {
      beginClose();
      try {
        try { await preference.setEnabled(false); }
        finally { await dispose({ gateHeld: true }); }
      } finally { shutdowns--; }
      listenerError = null; listenerRetryAt = 0; historyFailureStreak = 0;
      return status();
    });
    post('/companion/session/check', async body => {
      const service = await ensureCompanion();
      const session = await service.ensureSession();
      const prompt = body.followup === true ? '上一轮查到的妈妈歌曲总共几首？用刚才的上下文回答，不要调用播放接口。'
        : '这是一次隔离接口检查。请调用xiaoai_music的catalog，只回答现有妈妈歌曲共几首；不要播放或改变任何设置。';
      const result = await session.ask(prompt, { readOnly: true });
      return { dialoguePreview: result.text, sessionToolCalls: result.toolCalls, ...status() };
    });
    post('/companion/check', async () => {
      const dialoguePreview = await (await ensureCompanion()).ask('我今天有点累，陪我说两句。');
      return { dialoguePreview, ...status() };
    });
    post('/companion/voice/check', async () => {
      const prepared = await (await ensureCompanion()).prepare('小伴，我在这儿呢。');
      try { return status(); } finally { await prepared.cleanup(); }
    });
    post('/songs/check', async () => { await ensureSongs(); return status(); });
    api.route('/songs/directories', async req => {
      if (!localRequest(req) || req.method !== 'GET') return { ok: false, message: '需要本机读取音乐目录。' };
      await ensureSongs(); await songs.library.checkPaths(); return status();
    });
    let directoryTask = Promise.resolve();
    const serializeDirectoryChange = operation => {
      const result = directoryTask.then(operation);
      directoryTask = result.catch(() => {});
      return result;
    };
    const directoryChange = operation => serializeDirectoryChange(async () => {
      await ensureSongs();
      if (playback.selected || songs.library.status().jobs.some(job => ['queued','generating'].includes(job.state))) {
        return { ok: false, message: '请先停止本轮播放，并等待歌曲生成结束，再更新目录。' };
      }
      return operation();
    });
    post('/songs/directories/add', body => directoryChange(async () => { await songs.library.add(body.path); return status(); }));
    post('/songs/directories/refresh', body => directoryChange(async () => { await songs.library.refresh(body.id); return status(); }));
    post('/songs/missing/clear', () => directoryChange(async () => {
      const result = await songs.library.clearMissing(playlists);
      return { ...status(), ...result, message: '已清除 ' + result.removed + ' 首失效歌曲及歌单引用；磁盘文件未删除。' };
    }));
    post('/songs/delete', body => serializeDirectoryChange(async () => {
      await ensureSongs();
      const result = await playback.removeEntry(body.id, () => playlists.removeSong(body.id, () => songs.library.remove(body.id, { directoryId: body.directoryId })));
      return { deleted: result.entry.id, affectedPlaylists: result.affectedPlaylists, ...status() };
    }));
    post('/songs/search', async (body) => ({ candidates: await (await ensureSongs()).search(body.query) }));
    post('/songs/generate', async (body) => {
      if (body.play === true) probe?.invalidate();
      const intent = body.play === true ? ++familyIntent : null;
      const service = await ensureSongs();
      await service.select(body.songId);
      const options = { pitch: body.pitch === undefined ? 0 : body.pitch, announce: body.announce === true,
        mode: body.mode === undefined ? 'cover' : body.mode, voice: body.voice === undefined ? '' : body.voice };
      const shouldPlay = body.play === true && intent === familyIntent;
      const job = shouldPlay ? await playback.source(body.songId, options)
        : await service.library.request(body.songId, options);
      return { job, cancelled: body.play === true && !shouldPlay, ...status() };
    });
    post('/songs/play', async (body) => {
      probe?.invalidate();
      const intent = ++familyIntent;
      await ensureSongs();
      if (intent !== familyIntent) return { cancelled: true, ...status() };
      await playback.entry(body.id);
      return status();
    });
    post('/songs/pause', async () => { probe?.invalidate(); await ensureSongs(); await playback.pause(); return status(); });
    post('/songs/resume', async () => { await ensureSongs(); await playback.resume(); return status(); });
    post('/songs/stop', async () => { probe?.invalidate(); familyIntent++; await ensureSongs(); await playback.stop(); return status(); });
    post('/songs/next', async () => { probe?.invalidate(); familyIntent++; await ensureSongs(); await playback.next(); return status(); });
    post('/songs/playlist/save', async body => {
      await ensureSongs();
      const playlist = await playlists.save(body.name, body.ids);
      return { playlist, ...status() };
    });
    post('/songs/playlist/create', async body => {
      await ensureSongs();
      const playlist = await playlists.create(body.name);
      return { playlist, ...status() };
    });
    post('/songs/playlist/update', async body => {
      await ensureSongs();
      const playlist = await playlists.update(body.id, { name: body.name, ids: body.ids });
      return { playlist, ...status() };
    });
    post('/songs/playlist/delete', async body => {
      await ensureSongs();
      await playlists.remove(body.id);
      return status();
    });
    post('/songs/playlist/play', async body => {
      probe?.invalidate();
      const intent = ++familyIntent;
      await ensureSongs();
      if (intent !== familyIntent) return { cancelled: true, ...status() };
      const list = playlists.get(body.id);
      await playback.playlist(list.ids, { mode: body.mode || 'sequential', announce: body.announce === true });
      return status();
    });
    api.every(2000, async () => {
      if (disposed || shutdowns || loginPending()) return;
      void reminders.tick().then(() => { reminderError = null; }, () => {
        reminderError = { code: 'FAMILY_REMINDER_TICK', message: '定时提醒检查未完成，请检查提醒文件和音箱状态。' };
      });
      const epoch = listenerEpoch;
      await playback?.syncNativePlayback();
      if (disposed || shutdowns || epoch !== listenerEpoch) return;
      if (preference.enabled && !probe?.active()) {
        if (!listenerStarting && Date.now() >= listenerRetryAt && !loginPending()) {
          await startResident().catch(() => {});
        }
        return;
      }
      if (!probe) return;
      if (!probe.active()) {
        if (playback?.selected) {
          await probe.close({ keepPlayback: true });
          lastProbe = probe.status();
          probe = undefined;
        } else await dispose();
        return;
      }
      const current = probe;
      const before = current.status();
      await current.poll();
      if (disposed || shutdowns || epoch !== listenerEpoch || probe !== current || !preference.enabled || !current.persistent) return;
      const after = current.status();
      if (after.historyFailures > before.historyFailures) historyFailureStreak++;
      else if (after.polls > before.polls) historyFailureStreak = 0;
      if (historyFailureStreak >= 3 && !playback?.selected) {
        await current.close({ keepPlayback: true });
        lastProbe = current.status();
        speaker?.releasePlayback?.();
        probe = undefined; speaker = undefined;
        listenerError = { code: 'HISTORY_RECONNECT_PENDING', message: '语音记录暂不可读，稍后自动重连。' };
        listenerRetryAt = Date.now() + 60000;
      }
    }, '小爱家庭入口');
    api.on('config', async (next, previous) => {
      if (JSON.stringify(next.voice) !== JSON.stringify(previous.voice) || next.song?.root !== previous.song?.root) {
        warmWakeAudio();
      }
      if (savingLoginDevice) return;
      if (JSON.stringify(next.ext?.[api.id]) !== JSON.stringify(previous.ext?.[api.id])) await dispose();
    });
    api.onDispose(async () => {
      disposed = true;
      const closing = Promise.allSettled([reminders.close(), reminderDialogue?.close(), wakeAudio.close()]);
      try {
        const results = await closing;
        if (results.some(result => result.status === 'rejected')) throw new Error('家庭提醒收尾未完成。');
      } finally { await dispose(); await companion?.close(); }
    });
    warmWakeAudio();
    return { status, execute: callFamily, remind: callReminder };
}
