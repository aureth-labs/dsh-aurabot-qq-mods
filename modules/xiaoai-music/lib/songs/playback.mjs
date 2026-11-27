import { FamilySongError, songFailure } from './library.mjs';
import { SpeakerPlaybackError } from '../speaker/mina.mjs';

const playbackSteps = {
  prepare: ['FAMILY_PLAYBACK_PREPARE', '尚未准备好当前歌曲，请查看生成进度或重新选择歌曲。'],
  read: ['FAMILY_PLAYBACK_READ', '读不到这首歌的完整音频，请检查文件是否仍在曲库。'],
  connect: ['FAMILY_PLAYBACK_CONNECT', '没能连接小爱音箱，请检查登录、音箱在线状态和所选网卡。'],
  announce: ['FAMILY_PLAYBACK_ANNOUNCE', '音箱未能播报播放提示，请检查连接后重试。'],
  play: ['FAMILY_PLAYBACK_START', '没能开始播放歌曲，请检查音箱在线状态后重试。'],
  pause: ['FAMILY_PLAYBACK_PAUSE', '暂停指令未完成，请在音箱上查看当前是否仍在播放。'],
  resume: ['FAMILY_PLAYBACK_RESUME', '没能继续播放，请重新点选这首歌。'],
  stop: ['FAMILY_PLAYBACK_STOP', '没能停止音箱上的播放，请在音箱上手动停止后重试。'],
};

export class FamilyPlayback {
  constructor({ library, getSpeaker, log, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), random = Math.random }) {
    Object.assign(this, { library, getSpeaker, log, now, schedule, cancel, wait, random });
    this.generation = 0;
    this.queue = Promise.resolve();
    this.phase = 'idle';
    this.selected = null;
    this.current = null;
    this.speaker = null;
    this.error = null;
    this.elapsed = 0;
    this.startedAt = null;
    this.endTimer = null;
    this.list = null;
    this.statusRead = null;
    this.removingEntries = new Set();
    this.removedEntries = new Set();
    this.pendingSources = new Map();
  }
  status() {
    return { phase: this.phase, selected: this.selected, current: this.current?.id || null, error: this.error,
      playlist: this.list ? { ids: [...this.list.ids], mode: this.list.mode, index: this.list.index, total: this.list.ids.length } : null };
  }
  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  fail(ticket, error, step) {
    const failure = error instanceof FamilySongError ? error
      : error instanceof SpeakerPlaybackError ? new FamilySongError(error.code, error.message)
      : new FamilySongError(...playbackSteps[step]);
    if (ticket === this.generation) {
      this.phase = 'failed';
      this.error = songFailure(failure);
      this.log?.warn?.('小爱播放未完成。' + this.error.message);
    }
    return failure;
  }
  assertAvailable(ids, { saved = true, restored = false } = {}) {
    for (const id of ids) {
      if (this.removingEntries.has(id)) throw new FamilySongError('FAMILY_ENTRY_REMOVING', '这首歌曲正在删除，请稍后再选择。');
      if (!saved) continue;
      const indexed = this.library.entries instanceof Map;
      const present = indexed && this.library.entries.has(id);
      if ((indexed && !present) || (this.removedEntries.has(id) && !present && !restored)) {
        throw new FamilySongError('FAMILY_ENTRY_MISSING', '这首完整歌曲已不在曲库，请重新选择。');
      }
    }
  }
  entryInUse(id, sourceId) {
    return this.selected === id || this.current?.id === id || Boolean(this.list?.ids.includes(id)) ||
      (sourceId !== undefined && [...this.pendingSources.values()].includes(String(sourceId)));
  }
  removeEntry(id, removeCallback) {
    if (typeof id !== 'string' || !id || typeof removeCallback !== 'function') {
      return Promise.reject(new FamilySongError('FAMILY_ENTRY_INVALID', '请选择要删除的完整歌曲。'));
    }
    if (this.removingEntries.has(id)) return Promise.reject(new FamilySongError('FAMILY_ENTRY_REMOVING', '这首歌曲正在删除，请稍后再选择。'));
    this.removingEntries.add(id);
    if (this.entryInUse(id)) {
      this.removingEntries.delete(id);
      return Promise.reject(new FamilySongError('FAMILY_ENTRY_IN_USE', '歌曲正在播放或仍在本轮歌单中，请先停止本轮再删除。'));
    }
    const removal = this.enqueue(async () => {
      if (this.entryInUse(id)) throw new FamilySongError('FAMILY_ENTRY_IN_USE', '歌曲正在播放或仍在本轮歌单中，请先停止本轮再删除。');
      const entry = await this.library.get(id);
      if (this.entryInUse(id, entry.source?.id)) throw new FamilySongError('FAMILY_ENTRY_IN_USE', '歌曲正在准备播放，请先停止本轮再删除。');
      const result = await removeCallback();
      this.removedEntries.add(id);
      return result;
    });
    return removal.finally(() => this.removingEntries.delete(id));
  }
  async source(sourceId, options) {
    const blockedAtStart = new Set(this.removingEntries);
    if (this.library.entries instanceof Map && [...blockedAtStart].some(id =>
      String(this.library.entries.get(id)?.source?.id) === String(sourceId))) {
      throw new FamilySongError('FAMILY_ENTRY_REMOVING', '这首歌曲正在删除，请稍后再选择。');
    }
    this.list = null;
    this.clearEnd();
    const ticket = ++this.generation;
    this.pendingSources.set(ticket, String(sourceId));
    this.phase = 'preparing';
    this.error = null;
    let step = 'stop';
    try {
      await this.halt(ticket);
      step = 'prepare';
      const job = await this.library.request(sourceId, options);
      if (ticket !== this.generation) return { ...job, cancelled: true };
      if (blockedAtStart.has(job.id)) throw new FamilySongError('FAMILY_ENTRY_REMOVING', '这首歌曲正在删除，请稍后再选择。');
      this.assertAvailable([job.id], { saved: false });
      this.selected = job.id;
      this.finish(job.id, ticket, options?.announce === true, null, options?.isCurrent, true);
      return { ...job, playback: this.status() };
    } catch (error) {
      throw this.fail(ticket, error, step);
    } finally { this.pendingSources.delete(ticket); }
  }
  async entry(id, { announce = false, isCurrent = null } = {}) {
    this.assertAvailable([String(id)]);
    this.list = null;
    return this.startEntry(String(id), announce, null, isCurrent);
  }
  async audio(entry, { isCurrent = () => true, beforeSubmit } = {}) {
    if (!entry || typeof entry.id !== 'string' || !entry.id ||
        typeof entry.absoluteFile !== 'string' || !entry.absoluteFile || !(entry.duration > 0) || !Number.isFinite(entry.duration)) {
      throw new FamilySongError('FAMILY_AUDIO_INVALID', '本次对话音频不可用。');
    }
    this.list = null;
    return this.startEntry(entry.id, false, entry, isCurrent, beforeSubmit);
  }
  async playlist(ids, { mode = 'sequential', announce = false, isCurrent = null } = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) {
      throw new FamilySongError('FAMILY_PLAYLIST_EMPTY', '请先选择已保存的妈妈歌曲。');
    }
    if (!['sequential', 'random'].includes(mode)) {
      throw new FamilySongError('FAMILY_PLAYLIST_MODE', '请选择顺序或随机播放。');
    }
    const invalid = this.library.invalidSongIds;
    const ordered = [...new Set(ids)].filter(id => !invalid?.has(id));
    if (!ordered.length) throw new FamilySongError('FAMILY_CACHE_INVALID', '歌单中的歌曲均未通过校验，请恢复文件后刷新。');
    this.assertAvailable(ordered);
    if (mode === 'random') {
      for (let i = ordered.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      }
    }
    this.list = { ids: ordered, mode, index: 0 };
    return this.startEntry(ordered[0], announce, null, isCurrent);
  }
  async next({ isCurrent = null } = {}) {
    if (!this.list) throw new FamilySongError('FAMILY_NO_PLAYLIST', '当前没有正在播放的妈妈歌单。');
    if (this.list.index + 1 === this.list.ids.length) return this.complete();
    this.list.index++;
    return this.startEntry(this.list.ids[this.list.index], false, null, isCurrent);
  }
  async startEntry(id, announce = false, readyEntry = null, isCurrent = null, beforeSubmit) {
    this.assertAvailable([id], { saved: !readyEntry });
    this.clearEnd();
    const ticket = ++this.generation;
    this.selected = id;
    this.phase = 'preparing';
    this.error = null;
    this.elapsed = 0;
    this.startedAt = null;
    try {
      await this.halt(ticket);
      if (ticket !== this.generation) return { ...this.status(), cancelled: true };
      this.finish(id, ticket, announce, readyEntry, isCurrent, false, beforeSubmit);
      return this.status();
    } catch (error) {
      throw this.fail(ticket, error, 'stop');
    }
  }
  halt(ticket) {
    return this.enqueue(async () => {
      if (ticket !== this.generation) return;
      if (this.speaker && (this.current || this.speaker.ownsPlayback)) await this.speaker.operate('stop');
      this.current = null;
    });
  }
  finish(id, ticket, announce = false, readyEntry = null, isCurrent = null, restored = false, beforeSubmit) {
    let step = 'prepare';
    this.task = (readyEntry ? Promise.resolve() : this.library.wait(id)).then(() => this.enqueue(async () => {
      if (ticket !== this.generation) return;
      if (isCurrent && !isCurrent()) return this.release();
      step = 'read';
      this.assertAvailable([id], { saved: !readyEntry, restored });
      const entry = readyEntry || await this.library.get(id);
      this.assertAvailable([id], { saved: !readyEntry, restored });
      step = 'connect';
      const speaker = await this.getSpeaker();
      if (ticket !== this.generation) return;
      this.assertAvailable([id], { saved: !readyEntry, restored });
      this.speaker = speaker;
      if (isCurrent && !isCurrent()) return this.release();
      if (announce) {
        step = 'announce';
        await speaker.say('收到，准备播放。');
        await this.wait(3000);
        if (ticket !== this.generation) return;
      }
      if (isCurrent && !isCurrent()) {
        step = 'stop';
        if (speaker.ownsPlayback) await speaker.operate('stop');
        if (ticket === this.generation) return this.release();
        return;
      }
      this.current = entry;
      if (restored) this.removedEntries.delete(id);
      step = 'play';
      const submit = beforeSubmit && (() => beforeSubmit(() => ticket === this.generation && isCurrent()));
      const result = await speaker.playFile(entry.absoluteFile, entry.duration, submit);
      if (ticket === this.generation) {
        if (isCurrent && !isCurrent()) {
          step = 'stop';
          await speaker.operate('stop');
          if (ticket === this.generation) return this.release();
          return;
        }
        this.phase = 'playing';
        this.elapsed = 0;
        this.startedAt = Number.isFinite(result?.startedAt) ? result.startedAt : this.now();
        this.armEnd(ticket);
      }
    })).catch(async error => {
      if (ticket === this.generation && this.list && this.library.invalidSongIds?.has(id) && (!isCurrent || isCurrent())) {
        if (this.list.index + 1 >= this.list.ids.length) return this.complete();
        const next = await this.next({ isCurrent });
        if (!next.cancelled) return this.task;
        return;
      }
      this.fail(ticket, error, step);
    });
  }
  async pause() {
    this.clearEnd();
    if (this.phase === 'playing' && this.startedAt !== null) this.elapsed += Math.max(0, this.now() - this.startedAt);
    this.startedAt = null;
    const ticket = ++this.generation;
    this.phase = 'pausing';
    return this.enqueue(async () => {
      try {
        if (this.speaker && (this.current || this.speaker.ownsPlayback)) await this.speaker.operate('pause');
        if (ticket === this.generation) this.phase = 'paused';
      } catch (error) {
        throw this.fail(ticket, error, 'pause');
      }
      return this.status();
    });
  }
  async resume() {
    if (this.phase !== 'paused' || !this.selected) throw new FamilySongError('FAMILY_NOT_PAUSED', '没有可继续的家庭歌曲。');
    if (!this.current || this.current.id !== this.selected) return this.startEntry(this.selected);
    const ticket = ++this.generation;
    return this.enqueue(async () => {
      if (ticket !== this.generation) return this.status();
      try {
        await this.speaker.operate('play');
        this.phase = 'playing';
        this.startedAt = this.now();
        this.armEnd(ticket);
      }
      catch (error) { throw this.fail(ticket, error, 'resume'); }
      return this.status();
    });
  }
  async stop({ onlyOwned = false } = {}) {
    this.clearEnd();
    const ticket = ++this.generation;
    this.phase = 'stopping';
    this.selected = null;
    this.list = null;
    return this.enqueue(async () => {
      try {
        if (this.speaker && (this.current || this.speaker.ownsPlayback)) {
          let state;
          if (onlyOwned && typeof this.speaker.status === 'function') {
            try { state = await this.speaker.status(); } catch {}
          }
          if (state?.itemOwned === false) await this.speaker.releasePlayback?.();
          else await this.speaker.operate('stop');
        }
        this.current = null;
        this.startedAt = null;
        this.elapsed = 0;
        if (ticket === this.generation) this.phase = 'stopped';
      } catch (error) {
        throw this.fail(ticket, error, 'stop');
      }
      return this.status();
    });
  }
  async complete() {
    const previous = this.generation;
    await this.stop();
    if (this.generation === previous + 1 && this.phase === 'stopped') this.phase = 'completed';
    return this.status();
  }
  async release(error = null) {
    this.clearEnd();
    this.generation++;
    this.selected = null;
    this.list = null;
    this.current = null;
    this.startedAt = null;
    this.elapsed = 0;
    this.phase = 'stopped';
    this.error = error;
    // Native control already selected the hardware state; do not send pause.
    await this.speaker?.releasePlayback?.();
    return this.status();
  }
  async syncNativePlayback({ beforeAdvance = false } = {}) {
    if (this.phase !== 'playing' || !this.current || typeof this.speaker?.status !== 'function') return this.status();
    const ticket = this.generation;
    if (this.statusRead?.ticket !== ticket) {
      const read = { ticket };
      read.promise = Promise.resolve().then(() => this.speaker.status()).catch(() => null).finally(() => {
        if (this.statusRead === read) this.statusRead = null;
      });
      this.statusRead = read;
    }
    const state = await this.statusRead.promise;
    if (ticket !== this.generation || this.phase !== 'playing') return this.status();
    const played = this.elapsed + (this.startedAt === null ? 0 : Math.max(0, this.now() - this.startedAt));
    // Initial L05C reads can still describe the preceding item.
    if (!beforeAdvance && played < 2000) return this.status();
    if (state?.itemOwned === false) return this.release();
    if (!state || state.playback === 'unknown' || state.itemOwned !== true) {
      if (beforeAdvance) return this.release({ code: 'FAMILY_PLAYBACK_STATE_UNKNOWN', message: '音箱状态暂不可读，本轮歌单已停止自动续播。' });
      return this.status();
    }
    if (beforeAdvance && state.playback === 'playing') {
      if (!Number.isFinite(state.position) || state.position < 0 || !Number.isFinite(state.duration) || state.duration <= 0) {
        return this.release({ code: 'FAMILY_PLAYBACK_STATE_UNKNOWN', message: '音箱进度暂不可读，本轮已停止自动续播。' });
      }
      const remaining = state.duration - state.position;
      if (remaining > 0) this.armEnd(ticket, remaining * 1000);
    }
    if (['paused', 'stopped', 'idle'].includes(state.playback)) {
      const atEnd = Number.isFinite(state.position) && state.duration > 0 &&
        (state.position >= state.duration - 0.05 || (state.position === 0 && played >= this.current.duration * 1000));
      // Natural L05C completion resets position to zero and reports paused.
      if (!atEnd) return this.release();
    }
    return this.status();
  }
  clearEnd() {
    if (this.endTimer !== null) this.cancel(this.endTimer);
    this.endTimer = null;
  }
  armEnd(ticket, remainingMs = null) {
    this.clearEnd();
    const played = this.elapsed + (this.startedAt === null ? 0 : Math.max(0, this.now() - this.startedAt));
    const remaining = Math.max(0, Number.isFinite(remainingMs) ? remainingMs : this.current.duration * 1000 - played);
    this.endTimer = this.schedule(async () => {
      if (ticket !== this.generation) return;
      this.endTimer = null;
      await this.syncNativePlayback({ beforeAdvance: true });
      if (ticket !== this.generation || this.phase !== 'playing' || this.endTimer !== null) return;
      const next = this.list ? this.next().then(() => this.task) : this.complete();
      return next.catch(() => {}); // The operation records its failure in status().
    }, remaining + 500);
    this.endTimer?.unref?.();
  }
  async close() { await this.stop({ onlyOwned: true }); this.speaker = null; }
}
