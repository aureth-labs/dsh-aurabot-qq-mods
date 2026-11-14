import { modelFailureMessage } from './model.mjs';
import { historyFailure } from './mina.mjs';
import { DEFAULT_WAKE_CONFIG, matchWakePrefix } from './wake.mjs';

export const WAKE_ACK_LEAD_IN_MS = 750;

export class SpeakerProbe {
  constructor({ speaker, cursor, ask, familyAction, prepareAnswer, playAnswer,
    answerFailure = error => modelFailureMessage(error?.code), onInvalidate, sessionRouting = false, getWakeConfig,
    now = Date.now, lifetimeMs = 600000 }) {
    Object.assign(this, { speaker, cursor, ask, familyAction, prepareAnswer, playAnswer, answerFailure,
      onInvalidate, sessionRouting, getWakeConfig, now, lifetimeMs });
    this.until = 0;
    this.persistent = false;
    this.generation = 0;
    this.polling = false;
    this.pending = Promise.resolve();
    this.answersPending = 0;
    this.answerSince = 0;
    this.stats = { polls: 0, handled: 0, duplicates: 0, failures: 0, historyFailures: 0,
      lastHistoryFailure: null, lastAction: '', lastError: '' };
  }
  active() { return this.persistent || this.until > this.now(); }
  status() {
    return { active: this.active(), persistent: this.persistent,
      remainingSeconds: this.persistent ? null : Math.max(0, Math.ceil((this.until - this.now()) / 1000)), ...this.stats };
  }
  async arm({ persistent = false } = {}) {
    persistent = persistent === true;
    if (this.active() && this.persistent === persistent) return this.status();
    this.until = 0;
    this.persistent = false;
    this.invalidate();
    const ticket = this.generation;
    await this.speaker.conversations(); // Fail before arming on an incompatible API.
    if (ticket !== this.generation) return this.status();
    await this.cursor.begin(this.now());
    if (ticket !== this.generation) return this.status();
    this.persistent = persistent;
    this.until = persistent ? 0 : this.now() + this.lifetimeMs;
    return this.status();
  }
  invalidate() {
    this.generation++;
    try { Promise.resolve(this.onInvalidate?.()).catch(() => {}); } catch {}
  }
  async close({ keepPlayback = false } = {}) {
    this.until = 0;
    this.persistent = false;
    this.invalidate();
    if (!keepPlayback) await this.speaker.close();
  }
  // Model work stays outside the device queue so stop never waits for the model.
  // Device calls stay ordered: an in-flight play is always followed by stop.
  act(action, text = '', at = this.now()) {
    if (!this.active()) return Promise.reject(new Error('请先开启小爱入口。'));
    if (['stop', 'pause', 'cancel-answer', 'play-test', 'next', 'play-song', 'play-playlist', 'shuffle-playlist', 'ask-test', 'wake-ack'].includes(action)) this.invalidate();
    if (action === 'ask-test' || action === 'wake-ack') this.answerSince = at;
    if (action === 'cancel-answer') {
      this.stats.lastAction = 'cancel-answer';
      this.stats.lastError = '';
      return Promise.resolve({ cancelled: true });
    }
    const ticket = this.generation;
    const family = this.familyAction?.(action, text);
    if (family !== undefined) return Promise.resolve(family).catch(() => {
      this.stats.failures++;
      this.stats.lastError = '家庭歌曲操作未完成，请查看家庭面板。';
      throw new Error(this.stats.lastError);
    }).then(result => {
      if (action === 'play-test') return this.enqueue(action, text, ticket);
      this.stats.lastAction = action;
      this.stats.lastError = '';
      return result;
    });
    if (action === 'ask-test' || action === 'wake-ack') return this.answer(text, ticket, action);
    return this.enqueue(action, text, ticket);
  }
  enqueue(action, text, ticket) {
    const operation = this.pending.then(() => this.perform(action, text, ticket));
    this.pending = operation.catch(() => {});
    return operation;
  }
  async answer(text, ticket, action) {
    this.answersPending++;
    let prepared;
    const isCurrent = () => this.active() && ticket === this.generation;
    try {
      const answer = action === 'wake-ack' ? text : await this.ask(text || '一加一等于几？请只回答一句。', { isCurrent });
      if (!isCurrent()) return { cancelled: true };
      if (answer && typeof answer === 'object' && answer.suppressSpeech === true) {
        this.stats.lastAction = 'ask-test';
        this.stats.lastError = '';
        return { suppressed: true };
      }
      if (typeof answer !== 'string' || !answer.trim()) throw new Error();
      const spoken = answer.trim().slice(0, 160);
      const leadInMs = action === 'wake-ack' ? WAKE_ACK_LEAD_IN_MS : 0;
      prepared = this.prepareAnswer ? await this.prepareAnswer(spoken, { leadInMs }) : spoken;
      if (!isCurrent()) return { cancelled: true };
      return await this.enqueue(action === 'wake-ack' ? 'say-ack' : 'say-answer', prepared, ticket);
    } catch (error) {
      if (!isCurrent()) return { cancelled: true };
      this.stats.failures++;
      this.stats.lastError = this.answerFailure(error);
      throw new Error(this.stats.lastError);
    } finally {
      this.answersPending--;
      try { await prepared?.cleanup?.(); }
      catch { this.stats.failures++; this.stats.lastError = '本次对话临时文件清理未完成。'; }
    }
  }
  async perform(action, text, ticket) {
    if (!this.active() || ticket !== this.generation) return { cancelled: true };
    try {
      let result;
      if (action === 'play-test') result = await this.speaker.playProbe();
      else if (action === 'pause') result = await this.speaker.operate('pause');
      else if (action === 'resume') result = await this.speaker.operate('play');
      else if (action === 'stop') result = await this.speaker.operate('stop');
      else if (action === 'say-answer' || action === 'say-ack') result = this.playAnswer
        ? await this.playAnswer(text, { isCurrent: () => this.active() && ticket === this.generation }) : await this.speaker.say(text);
      else throw new Error('不支持的测试操作。');
      this.stats.lastAction = action === 'say-answer' ? 'ask-test' : action === 'say-ack' ? 'wake-ack' : action;
      this.stats.lastError = '';
      return result;
    } catch {
      this.stats.failures++;
      this.stats.lastError = '音箱或模型操作失败，请检查连接后重新开启测试。';
      throw new Error(this.stats.lastError);
    }
  }
  async poll() {
    if (this.polling || !this.active()) return;
    this.polling = true;
    let phase = 'history';
    let ticket = this.generation;
    try {
      const records = await this.speaker.conversationsSince(this.cursor.state.since);
      if (!this.active() || ticket !== this.generation) return;
      this.stats.polls++;
      if (this.stats.lastError === '语音记录读取失败；未将失败当作空记录。') this.stats.lastError = '';
      for (const record of records.sort((a, b) => a.time - b.time)) {
        if (!this.active() || ticket !== this.generation) return;
        if (record.time < this.cursor.state.since) continue;
        const native = String(record.query || '').replace(/[\s，。！？、,.!?：:]/g, '');
        const action = parseProbeCommand(record.query, { sessionRouting: this.sessionRouting, wakeConfig: this.getWakeConfig?.() }) || (this.answersPending && record.time >= this.answerSince &&
          /^(?:小爱同学|你好小爱)?(?:暂停(?:播放)?|停止(?:播放)?|别说了)(?:一下|吧)?$/.test(native)
          ? { action: 'cancel-answer' } : null);
        if (!action) continue;
        phase = 'cursor';
        const claimed = await this.cursor.claim(record);
        phase = 'history';
        if (!this.active() || ticket !== this.generation) return;
        if (!claimed) { this.stats.duplicates++; continue; }
        this.stats.handled++;
        // Do not await a long model call: the next poll must still hear "stop".
        void this.act(action.action, action.text, record.time).catch(() => {});
        ticket = this.generation;
      }
      phase = 'cursor-advance';
      await this.cursor.advance?.(this.now(), { overlapMs: 60000 });
    } catch (error) {
      if (!this.active() || ticket !== this.generation) return;
      this.stats.failures++;
      if (phase === 'history') {
        this.stats.historyFailures++;
        this.stats.lastHistoryFailure = historyFailure(error);
        this.stats.lastError = '语音记录读取失败；未将失败当作空记录。';
      } else this.stats.lastError = phase === 'cursor-advance'
        ? '语音游标推进失败，已领取口令不会重试。' : '语音游标保存失败，未执行本条口令。';
    } finally { this.polling = false; }
  }
}

export function parseProbeCommand(query, { sessionRouting = false, wakeConfig } = {}) {
  const raw = String(query || '');
  const clean = raw.replace(/[\s，。！？、,.!?：:]/g, '');
  // Keep an explicit invocation; spelling variants do not change the hardware wake word.
  const prefix = matchWakePrefix(clean, wakeConfig);
  if (!prefix) return null;
  const text = clean.slice(prefix[0].length).replace(/^(?:啊|呀)/, '');
  const command = text.replace(/^(?:请你?|麻烦你?|帮我|给我|帮忙|能不能|可以|先)+/, '');
  const control = command.replace(/^(?:我想|我要)/, '')
    .replace(/(?:一下|一会儿?|会儿|吧|啊|呀|呗|谢谢|好吗|好不好)+$/, '');
  if (/^(?:暂停(?:播放|音乐)?|停|停一停|等|等等|等一等|等会儿?|稍等)$/.test(control)) return { action: 'pause' };
  if (/^(?:停止(?:播放|音乐|唱歌)?|结束播放|停掉|停了|关掉(?:音乐|歌曲)|(?:别|不要)(?:播放|放|播|唱)了|不听了)$/.test(control)) return { action: 'stop' };
  if (sessionRouting) {
    let offset = 0;
    let consumed = 0;
    for (const character of raw) {
      offset += character.length;
      if (!/[\s，。！？、,.!?：:]/.test(character)) consumed += character.length;
      if (consumed === prefix[0].length) break;
    }
    const spoken = raw.slice(offset).replace(/^[\s，。！？、,.!?：:]+/, '').replace(/^[啊呀][\s，。！？、,.!?：:]*/, '').trim();
    if (spoken) return { action: 'ask-test', text: spoken };
    return { action: 'wake-ack', text: wakeConfig?.acknowledgement?.trim() || DEFAULT_WAKE_CONFIG.acknowledgement };
  }
  if (/^(?:继续(?:播放|放|播|唱)?|接着(?:播放|放|播|唱)|恢复(?:播放)?)$/.test(control)) return { action: 'resume' };
  if (/^(?:下一首(?:歌)?|下一曲|换一首(?:歌)?|换首歌|切歌)$/.test(control)) return { action: 'next' };
  if (/^(?:播放|放|播)(?:一下)?测试音$/.test(control)) return { action: 'play-test' };
  const playlist = /^(随机播放|随机放|打乱播放|按顺序播放|顺序播放|播放|放)(?:一下)?(?:妈妈)?歌单(.*)$/.exec(command)
    || /^(随机播放|随机放|打乱播放|按顺序播放|顺序播放|播放|放)(?:一下)?(.+?)歌单(?:吧|呀|呗|谢谢|好吗|好不好)*$/.exec(command);
  if (playlist) return { action: /随机|打乱/.test(playlist[1]) ? 'shuffle-playlist' : 'play-playlist', text: playlist[2] };
  const song = /^(?:(?:用)?妈妈(?:的声音|声音|音色)?(?:唱|播放|放|播)|(?:我)?(?:想|要)听|听一听|听听|播放|放|播|唱|来(?=一?首|一曲))(.+)$/.exec(command);
  if (song) return { action: 'play-song', text: song[1] };
  const question = text.replace(/^请/, '');
  return question ? { action: 'ask-test', text: question } : null;
}

export function matchSavedSongSources(entries, text) {
  const normalize = value => String(value).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const requested = normalize(text);
  const sources = titles => [...new Set(entries.filter(entry => titles.has(normalize(entry.title)))
    .map(entry => entry.sourceId))];
  const exact = sources(new Set([requested]));
  if (exact.length) return exact;
  // Prefer the actual saved title before removing conversational wording.
  const withoutLead = requested.replace(/^(?:一首|一曲|一遍|首|一下|个|妈妈版|妈妈的)+/, '');
  const withoutTail = value => value.replace(/(?:妈妈版|妈妈唱的版本|妈妈唱的|吧|呀|呗|谢谢|好吗|好不好)+$/, '');
  return sources(new Set([withoutLead, withoutTail(requested), withoutTail(withoutLead)]));
}
