import { randomBytes } from 'node:crypto';
import { authObservation, cookieValue } from './transport.mjs';

const origin = 'https://account.xiaomi.com';
const agent = 'APP/com.xiaomi.mihome APPV/6.0.103 iosPassportSDK/3.9.0 iOS/14.4 miHSTS';
const messages = {
  QR_ACCOUNT_MISMATCH: '扫码账号与当前保存的音箱账号不一致，未更新凭据。',
  QR_VERIFY_FAILED: '扫码已完成，但音箱服务验证未通过，原凭据未变。',
  QR_SAVE_FAILED: '音箱验证通过，但本机凭据保存未完成，原凭据未确认更新。',
  QR_RELOAD_FAILED: '已保存扫码结果，但重新读取后的登录验证未通过，不能继续测试。',
  QR_FAILED: '扫码登录未完成，请重新生成二维码。',
};

function accountUrl(value) {
  const url = new URL(value);
  const host = url.hostname;
  if (url.protocol !== 'https:' || !(host === 'account.xiaomi.com' || host.endsWith('.account.xiaomi.com')) ||
      url.username || url.password) {
    throw new Error('Unexpected login destination');
  }
  return url.href;
}

function decode(text) {
  return JSON.parse(text.replace(/^&&&START&&&/, '').replace(/:(\d{9,})/g, ':"$1"'));
}

function failureReason(error) {
  const message = String(error?.message || '');
  const http = /^HTTP (\d{3})$/.exec(message);
  if (http) return { code: 'XIAOMI_HTTP_FAILURE', httpStatus: Number(http[1]) };
  const service = /^service code (-?\d+)$/.exec(message);
  if (service) return { code: 'MINA_SERVICE_REJECTED', serviceCode: Number(service[1]) };
  if (/^authentication code \d+;/.test(message)) return { code: 'PASSPORT_REJECTED' };
  const known = {
    'additional verification required': 'ACCOUNT_VERIFICATION_REQUIRED',
    'authentication response is missing required fields': 'PASSPORT_FIELDS_MISSING',
    'authentication response could not be parsed': 'PASSPORT_RESPONSE_INVALID',
    'service token was not returned': 'SERVICE_TOKEN_MISSING',
    'network request failed or timed out': 'XIAOMI_NETWORK_FAILURE',
    'too many service redirects': 'SERVICE_REDIRECT_LIMIT',
    '需要唯一的 L05C；多台时请在面板指定设备。': 'L05C_SELECTION_FAILED',
    '音箱未报告在线。': 'L05C_OFFLINE',
    '语音记录接口未返回成功。': 'HISTORY_REJECTED',
    '音箱未接受操作。': 'DEVICE_STATUS_REJECTED',
    '音箱播放状态不可用。': 'DEVICE_STATUS_INVALID',
  };
  return { code: known[message] || 'SPEAKER_VALIDATION_FAILED' };
}

export class SpeakerLogin {
  constructor({ environment, finalize, verify, save, onDeviceSelected = async () => {}, fetchImpl = fetch }) {
    Object.assign(this, { environment, finalize, verify, save, onDeviceSelected, fetchImpl });
    this.phase = 'idle';
    this.step = 'idle';
    this.message = '尚未开始扫码登录。';
    this.controller = null;
    this.picture = null;
    this.renewalObserved = false;
    this.cookies = new Map();
    this.authObservation = null;
    this.failure = null;
    this.devices = [];
    this.pendingSelection = null;
  }
  status() { return {
    phase: this.phase, step: this.step, message: this.message,
    renewalObserved: this.renewalObserved, authObservation: this.authObservation,
    failure: this.failure,
    devices: this.devices,
  }; }
  close() {
    clearTimeout(this.expiry);
    this.controller?.abort();
    this.controller = null;
    this.picture = null;
    this.phase = 'idle';
    this.step = 'idle';
    this.message = '扫码登录已关闭。';
    this.renewalObserved = false;
    this.cookies.clear();
    this.authObservation = null;
    this.failure = null;
    this.devices = [];
    this.pendingSelection = null;
  }
  async get(url, controller, milliseconds = 15000, headers = {}) {
    if (controller.signal.aborted) throw new Error('Login cancelled');
    const response = await this.fetchImpl(accountUrl(url), {
      headers: {
        'User-Agent': agent,
        Cookie: [...this.cookies].map(([key, value]) => key + '=' + cookieValue(value)).join('; '),
        ...headers,
      }, redirect: 'manual',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(milliseconds)]),
    });
    if (!response.ok) throw new Error('Login request failed');
    if (this.controller === controller && !controller.signal.aborted) {
      for (const header of response.headers.getSetCookie()) {
        const pair = /^([A-Za-z0-9_-]+)=([^;]*)/.exec(header);
        if (pair) this.cookies.set(pair[1], pair[2]);
      }
    }
    return response;
  }
  async start() {
    this.close();
    const controller = new AbortController();
    this.controller = controller;
    this.phase = 'preparing';
    this.step = 'read-local-account';
    this.message = '正在准备小米音箱扫码登录。';
    try {
      const previous = await this.environment();
      if (this.controller !== controller) return this.status();
      const deviceId = randomBytes(8).toString('hex').toUpperCase();
      this.cookies.set('sdkVersion', '3.9');
      this.cookies.set('deviceId', deviceId);
      this.step = 'prepare-session';
      const serviceUrl = origin + '/pass/serviceLogin?sid=micoapi&_json=true';
      const initial = decode(await (await this.get(serviceUrl, controller)).text());
      if (initial.sid !== 'micoapi' || !['qs', '_sign', 'callback'].every((key) => typeof initial[key] === 'string')) {
        throw new Error('Login parameters unavailable');
      }
      const qrUrl = new URL('/longPolling/loginUrl', origin);
      qrUrl.search = new URLSearchParams({
        qs: initial.qs, sid: initial.sid, _sign: initial._sign, callback: initial.callback,
        theme: '', bizDeviceType: '', _hasLogo: 'false', _qrsize: '300', _dc: String(Date.now()),
      }).toString();
      this.step = 'request-qr';
      const qr = decode(await (await this.get(qrUrl.href, controller)).text());
      const pollUrl = accountUrl(qr.lp);
      this.step = 'read-qr-image';
      const imageResponse = await this.get(qr.qr, controller);
      const type = (imageResponse.headers.get('content-type') || '').split(';')[0];
      if (!['image/png', 'image/jpeg'].includes(type)) throw new Error('QR image unavailable');
      const data = Buffer.from(await imageResponse.arrayBuffer());
      if (!data.length || data.length > 2 * 1024 * 1024) throw new Error('QR image unavailable');
      if (this.controller !== controller) return this.status();
      this.picture = { data, type };
      this.phase = 'waiting';
      this.step = 'phone-confirmation';
      this.message = '请用音箱同一账号的米家 App 扫码，并在手机确认登录。';
      const seconds = Math.min(300, Math.max(30, Number(qr.timeout) || 180));
      const expiry = setTimeout(() => {
        if (this.controller !== controller || this.phase !== 'waiting') return;
        controller.abort();
        this.picture = null;
        this.phase = 'expired';
        this.message = '二维码已过期，请重新生成。';
      }, seconds * 1000);
      this.expiry = expiry;
      expiry.unref?.();
      this.work = this.complete(pollUrl, controller, previous, deviceId, seconds, expiry);
      return this.status();
    } catch {
      if (this.controller === controller) {
        this.phase = 'failed';
        this.message = this.step === 'read-local-account'
          ? '无法读取音箱登录环境，请先保存当前已连接的网卡；若本机已有账号，请检查其保存状态。'
          : messages.QR_FAILED;
        this.picture = null;
      }
      return this.status();
    }
  }
  async complete(url, controller, previous, deviceId, seconds, expiry) {
    try {
      const result = decode(await (await this.get(url, controller, (seconds + 5) * 1000)).text());
      if (this.controller !== controller || controller.signal.aborted) return;
      clearTimeout(expiry);
      this.picture = null;
      this.authObservation = authObservation(result);
      if (result.notificationUrl || result.captchaUrl || result.securityStatus === 16) {
        this.phase = 'verification-required';
        this.message = '小米要求额外账号安全验证，请在手机或小米账号页面完成。本轮未继续登录。';
        return;
      }
      if (result.code !== 0 || !/^\d+$/.test(String(result.userId)) || typeof result.passToken !== 'string') {
        throw new Error('Incomplete login');
      }
      if (previous.userId && String(result.userId) !== String(previous.userId)) {
        this.phase = 'failed';
        this.message = messages.QR_ACCOUNT_MISMATCH;
        return;
      }
      const credentials = {
        userId: String(result.userId),
        passToken: this.cookies.get('passToken') || result.passToken,
        deviceId: this.cookies.get('deviceId') || deviceId,
      };
      this.phase = 'verifying';
      this.step = 'finish-qr-session';
      this.message = '手机已确认，正在完成音箱登录会话。';
      try { await this.finalize(result); }
      catch (error) {
        if (this.controller !== controller || controller.signal.aborted) return;
        this.failure = failureReason(error);
        if (error.authObservation) this.authObservation = authObservation(error.authObservation);
        this.phase = 'failed';
        this.message = '小米扫码会话未完成，未更新本机凭据。';
        return;
      }
      if (this.controller !== controller || controller.signal.aborted) return;
      await this.finishCredentials(credentials, previous, controller);
    } catch {
      if (this.controller === controller && !controller.signal.aborted) {
        this.phase = 'failed';
        this.message = messages.QR_FAILED;
        this.picture = null;
      }
    } finally { clearTimeout(expiry); }
  }
  async selectDevice(id) {
    const pending = this.pendingSelection;
    if (!pending || this.phase !== 'select-device' || !this.devices.some(item => item.id === id && item.supported && item.online)) {
      return { ...this.status(), message: '请选择列表中受支持且在线的音箱。' };
    }
    this.phase = 'verifying';
    try { await this.finishCredentials(pending.credentials, pending.previous, pending.controller, id); }
    catch {
      if (this.controller === pending.controller && !pending.controller.signal.aborted) {
        this.phase = 'failed'; this.message = messages.QR_FAILED;
      }
    }
    return this.status();
  }
  async finishCredentials(credentials, previous, controller, selector = '') {
      this.step = 'verify-speaker';
      this.message = '手机已确认，正在验证音箱账号与连接。';
      let verified;
      try { verified = await this.verify({ ...credentials, localAddress: previous.localAddress }, selector); }
      catch (error) {
        if (this.controller !== controller || controller.signal.aborted) return;
        this.failure = failureReason(error);
        if (error.authObservation) this.authObservation = authObservation(error.authObservation);
        this.phase = 'failed';
        this.message = messages.QR_VERIFY_FAILED;
        return;
      }
      if (this.controller !== controller || controller.signal.aborted) return;
      if (verified?.needsSelection) {
        this.devices = verified.devices;
        this.pendingSelection = { credentials: verified.credentials || credentials, previous, controller };
        this.phase = 'select-device';
        this.message = '请选择要接入的在线 L05C 音箱；未支持的型号不能选择。';
        return;
      }
      this.pendingSelection = null;
      this.step = 'save-local-credential';
      const finalCredentials = verified?.credentials || credentials;
      this.renewalObserved = verified?.renewed === true;
      try { await this.save(finalCredentials); }
      catch {
        if (this.controller !== controller || controller.signal.aborted) return;
        this.phase = 'failed';
        this.message = messages.QR_SAVE_FAILED;
        return;
      }
      if (this.controller !== controller || controller.signal.aborted) return;
      this.step = 'verify-saved-credential';
      this.message = '已保存，正在重新读取并验证登录。';
      try {
        const loaded = await this.environment();
        if (!['userId', 'passToken', 'deviceId'].every((key) => loaded[key] === finalCredentials[key])) throw new Error();
        const checked = await this.verify(loaded, verified?.selectedDevice || selector);
        if (this.controller !== controller || controller.signal.aborted) return;
        if (checked?.needsSelection) throw new Error('Saved speaker not verified');
        if (checked?.renewed) {
          this.renewalObserved = true;
          await this.save(checked.credentials);
        }
      } catch {
        if (this.controller !== controller || controller.signal.aborted) return;
        this.phase = 'failed';
        this.message = messages.QR_RELOAD_FAILED;
        return;
      }
      if (this.controller !== controller || controller.signal.aborted) return;
      await this.onDeviceSelected(verified?.selectedDevice || selector);
      if (this.controller !== controller || controller.signal.aborted) return;
      this.devices = [];
      this.phase = 'saved';
      this.message = '音箱连接验证通过，登录已安全保存。请检查连接并继续完成配置。';
  }
}
