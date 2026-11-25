import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { authenticateSession, minaRequest, request, checkHttp, cookieValue, musicMessage, audioServer, FAMILY_AUDIO_ID } from './transport.mjs';
import { makeProbeAudio } from './probe-audio.mjs';
import { createL05CControl } from './miot.mjs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export function selectDevice(devices, selector = '') {
  if (!Array.isArray(devices)) throw new Error('音箱列表格式不可用。');
  const matches = devices.filter((d) => String(d.hardware).toUpperCase() === 'L05C' &&
    (!selector || String(d.deviceID) === selector || String(d.miotDID) === selector));
  if (matches.length !== 1 || !matches[0].deviceID) throw new Error('需要唯一的 L05C；多台时请在面板指定设备。');
  if (matches[0].presence !== 'online') throw new Error('音箱未报告在线。');
  return matches[0];
}

export function historyFailure(error) {
  const message = String(error?.message || '');
  const http = /^HTTP (\d{3})$/.exec(message);
  const known = ['HISTORY_SERVICE', 'HISTORY_DATA_JSON', 'HISTORY_RESPONSE_JSON', 'HISTORY_SCHEMA', 'HISTORY_NETWORK', 'HISTORY_HTTP', 'HISTORY_PAGING'];
  const code = known.includes(error?.code) ? error.code
    : http ? 'HISTORY_HTTP'
    : message === 'network request failed or timed out' ? 'HISTORY_NETWORK'
    : message === '语音记录分页游标没有前进。' ? 'HISTORY_PAGING' : 'HISTORY_READ_FAILED';
  const result = { code };
  if (Number.isSafeInteger(error?.serviceCode)) result.serviceCode = error.serviceCode;
  const status = http ? Number(http[1]) : error?.httpStatus;
  if (Number.isInteger(status) && status >= 100 && status <= 599) result.httpStatus = status;
  return result;
}

function historyError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export function decodeConversations(result) {
  if (result?.code !== 0) throw historyError('语音记录接口未返回成功。', 'HISTORY_SERVICE', {
    serviceCode: Number.isSafeInteger(result?.code) ? result.code : null,
  });
  let data;
  try { data = typeof result.data === 'string' ? JSON.parse(result.data) : result.data; }
  catch { throw historyError('语音记录数据格式不可用。', 'HISTORY_DATA_JSON'); }
  if (!data || !Array.isArray(data.records) ||
      data.records.some((r) => !Number.isSafeInteger(r.time) || r.time < 0 ||
        typeof r.query !== 'string' || typeof r.requestId !== 'string')) {
    throw historyError('语音记录字段格式不可用。', 'HISTORY_SCHEMA');
  }
  return { records: data.records, nextEndTime: data.nextEndTime };
}

export async function connectSpeaker(credentials, selector = '', onRefresh, discovery = null) {
  const { userId, passToken, deviceId, localAddress } = credentials;
  if (!/^\d+$/.test(userId) || !passToken || !deviceId || isIP(localAddress) !== 4) {
    throw new Error('现有音箱凭据或网卡不可用。');
  }
  const session = discovery?.session || await authenticateSession(userId, passToken, deviceId);
  const token = session.serviceToken;
  if (session.renewed && onRefresh) await onRefresh(session.credentials);
  const device = selectDevice(discovery?.devices || await minaRequest('GET', '/admin/v2/device_list', {}, userId, token), String(selector));
  const call = async (scope, method, message = {}) => {
    const data = await minaRequest('POST', '/remote/ubus', {
      deviceId: String(device.deviceID), path: scope, method,
      message: typeof message === 'string' ? message : JSON.stringify(message),
    }, userId, token, device);
    if (data?.code !== 0) throw new Error('音箱未接受操作。');
    return data;
  };
  const history = async (timestamp = Date.now()) => {
    try {
    const url = new URL('https://userprofile.mina.mi.com/device_profile/v2/conversation');
    url.search = new URLSearchParams({
      source: 'dialogu', hardware: device.hardware, timestamp: String(timestamp), limit: '10',
      requestId: randomUUID(),
    }).toString();
    const response = await request(url, { headers: {
      Cookie: 'userId=' + cookieValue(userId) + '; serviceToken=' + cookieValue(token) +
        '; deviceId=' + cookieValue(device.deviceID),
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; wv) /XiaoMi/HybridView/ micoSoundboxApp/i appVersion/A_2.4.40',
      Referer: 'https://userprofile.mina.mi.com/dialogue-note/index.html',
    } });
    checkHttp(response);
    let result;
    try { result = await response.json(); } catch { throw historyError('语音记录响应不可用。', 'HISTORY_RESPONSE_JSON'); }
    return decodeConversations(result);
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('HISTORY_')) throw error;
      throw Object.assign(new Error('语音记录读取失败。'), historyFailure(error));
    }
  };
  return new MiNASpeaker({ call, history, localAddress,
    control: createL05CControl(session.credentials, device.miotDID, onRefresh),
  });
}

export async function verifySpeakerLogin(credentials, selector = '') {
  const session = await authenticateSession(credentials.userId, credentials.passToken, credentials.deviceId);
  const devices = await minaRequest('GET', '/admin/v2/device_list', {}, credentials.userId, session.serviceToken);
  const choices = speakerChoices(devices);
  const available = choices.filter(item => item.supported && item.online);
  if (!selector && available.length !== 1) return { needsSelection: true, devices: choices,
    credentials: session.credentials, renewed: session.renewed === true };
  const selected = selector || available[0].id;
  let current = session.credentials;
  let renewed = session.renewed === true;
  const speaker = await connectSpeaker(credentials, selector, async (next) => {
    current = next;
    renewed = true;
  }, { session, devices: devices.filter(device => String(device.deviceID) === selected || String(device.miotDID) === selected) });
  try {
    await speaker.conversations();
    return { credentials: current, renewed, selectedDevice: selected };
  } finally { await speaker.close(); }
}

export function speakerChoices(devices) {
  if (!Array.isArray(devices)) throw new Error('音箱列表格式不可用。');
  return devices.filter(item => item?.deviceID).map(item => ({ id: String(item.deviceID),
    name: String(item.name || item.alias || '小爱音箱'), model: String(item.hardware || ''),
    supported: String(item.hardware).toUpperCase() === 'L05C', online: item.presence === 'online' }));
}

export class MiNASpeaker {
  constructor({ call, history, localAddress, control }) {
    Object.assign(this, { call, history, localAddress, control });
    this.server = null;
    this.ownsPlayback = false;
    this.canResume = false;
    this.counts = { get: 0, head: 0, matchedGet: 0, invalidRange: 0 };
  }
  async conversations() { return (await this.history()).records; }
  async conversationsSince(since) {
    let page = await this.history();
    const records = [...page.records];
    let previousEnd = Infinity;
    while (page.records.length && Math.min(...page.records.map((r) => r.time)) >= since) {
      const end = page.nextEndTime;
      if (!Number.isSafeInteger(end) || end <= 0) break;
      if (end >= previousEnd) throw new Error('语音记录分页游标没有前进。');
      previousEnd = end;
      page = await this.history(end);
      records.push(...page.records);
    }
    const unique = new Map(records.filter((r) => r.time >= since).map((r) => [r.time + ':' + r.requestId, r]));
    return [...unique.values()];
  }
  async status() {
    const data = await this.call('mediaplayer', 'player_get_play_status');
    if (data?.code === 0 && !Object.hasOwn(data, 'info')) return {
      playback: 'unknown', playbackReadable: false, position: null, duration: null,
      itemOwned: null, loopType: null,
      audioRequests: { ...this.counts },
    };
    let info;
    try { info = typeof data.info === 'string' ? JSON.parse(data.info) : data.info; } catch {}
    if (!info || !Number.isInteger(info.status)) throw new Error('音箱播放状态不可用。');
    const detail = info.play_song_detail;
    const audioId = detail?.audio_id;
    const itemOwned = typeof audioId === 'string' && audioId ? audioId === FAMILY_AUDIO_ID : null;
    // L05C reports progress in milliseconds inside play_song_detail.
    const position = Number.isFinite(detail?.position) ? detail.position / 1000 : info.position;
    const duration = Number.isFinite(detail?.duration) ? detail.duration / 1000 : info.duration;
    return {
      playback: ({ 0: 'idle', 1: 'playing', 2: 'paused', 3: 'stopped' })[info.status] || 'unknown',
      playbackReadable: true,
      position: Number.isFinite(position) ? position : null,
      duration: Number.isFinite(duration) ? duration : null,
      itemOwned,
      loopType: Number.isInteger(info.loop_type) ? info.loop_type : null,
      audioRequests: { ...this.counts },
    };
  }
  async playProbe() {
    return this.playAudio(makeProbeAudio(), '.wav', 'audio/wav', 18);
  }
  async playFile(file, duration) {
    const extension = extname(file).toLowerCase();
    const contentType = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' }[extension];
    if (!contentType) throw new Error('对话音频格式不可用。');
    return this.playAudio(await readFile(file), extension, contentType, duration, true);
  }
  async playAudio(audio, extension, contentType, duration, waitForRead = false) {
    if (this.server) { this.server.close(); this.server.closeAllConnections(); this.server = null; }
    this.counts = { get: 0, head: 0, matchedGet: 0, invalidRange: 0 };
    const route = '/' + randomUUID() + extension;
    let startedAt = null;
    let readStarted;
    const firstRead = new Promise(resolve => { readStarted = resolve; });
    this.server = audioServer(audio, route, this.counts, contentType, () => {
      if (startedAt === null) { startedAt = Date.now(); readStarted(startedAt); }
    });
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(0, this.localAddress, resolve);
      });
      const url = 'http://' + this.localAddress + ':' + this.server.address().port + route;
      await this.call('mediaplayer', 'player_play_music', musicMessage(url));
      this.ownsPlayback = true;
      this.canResume = true;
      // A one-item MUSIC list can inherit device repeat-all. Our controller,
      // rather than the speaker loop, owns progression to the next entry.
      const loop = await this.call('mediaplayer', 'player_set_loop', { type: 2, media: 'common' });
      if (loop?.code !== 0) throw new Error('音箱未接受本次单轮播放模式。');
      if (waitForRead) {
        let timer;
        try { await Promise.race([firstRead, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('音箱没有开始读取歌曲。')), 15000);
        })]); } finally { clearTimeout(timer); }
      }
      const state = await this.status();
      if (state.loopType !== null && state.loopType !== 2) throw new Error('音箱单轮播放模式未生效。');
      return { accepted: true, expectedSeconds: duration, startedAt, singlePlayVerified: state.loopType === 2, ...state };
    } catch (error) {
      if (this.ownsPlayback) {
        const state = await this.status().catch(() => null);
        if (state?.itemOwned !== false) {
          try {
            if (this.control) await this.control.operate('pause');
            else await this.call('mediaplayer', 'player_play_operation', { action: 'pause' });
          } catch {}
        }
      }
      this.releasePlayback();
      throw error;
    }
  }
  async operate(action) {
    if (!['pause', 'play', 'stop'].includes(action)) throw new Error('不支持的音箱操作。');
    if (action === 'play' && !this.canResume) throw new Error('没有可继续的测试播放。');
    // L05C accepted action=stop without changing state during the device test.
    // Stop in this adapter therefore pauses the hardware and discards our item.
    if (this.control) await this.control.operate(action === 'stop' ? 'pause' : action);
    else await this.call('mediaplayer', 'player_play_operation', { action: action === 'stop' ? 'pause' : action });
    if (action === 'stop') {
      this.releasePlayback();
    }
    return { accepted: true, operation: action === 'stop' ? 'stopped' : action, ...await this.status() };
  }
  async say(text) {
    if (this.control) await this.control.say(text);
    else await this.call('mibrain', 'text_to_speech', { text, save: 0 });
    this.ownsPlayback = true;
    this.canResume = false;
    return { accepted: true, voice: 'xiaomi-native', output: this.control ? 'miot-5-3' : 'mina', targetVoiceVerified: false };
  }
  async close() {
    try {
      if (this.ownsPlayback) {
        if (this.control) await this.control.operate('pause');
        else await this.call('mediaplayer', 'player_play_operation', { action: 'pause' });
      }
    } finally {
      this.releasePlayback();
    }
  }
  releasePlayback() {
    this.ownsPlayback = false;
    this.canResume = false;
    if (this.server) {
      this.server.close();
      this.server.closeAllConnections();
      this.server = null;
    }
  }
}
