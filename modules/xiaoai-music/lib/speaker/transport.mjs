// Transport extracted from tools/l05c-play.mjs, baseline in README.md.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';

const accountUrl = 'https://account.xiaomi.com/pass/serviceLogin';
const minaBase = 'https://api2.mina.mi.com';
const loginAgent = 'APP/com.xiaomi.mihome APPV/6.0.103 iosPassportSDK/3.9.0 iOS/14.4 miHSTS';
const minaAgent = 'MICO/AndroidApp/@SHIP.TO.2A2FE0D7@/2.4.40';

class TestError extends Error {}

function fail(message, observation) {
  const error = new TestError(message);
  if (observation) error.authObservation = observation;
  throw error;
}

export function authObservation(value = {}) {
  return {
    code: Number.isSafeInteger(value.code) ? value.code : null,
    securityStatus: Number.isSafeInteger(value.securityStatus) ? value.securityStatus : null,
    hasNotificationUrl: value.hasNotificationUrl === true || Boolean(value.notificationUrl),
    hasCaptchaUrl: value.hasCaptchaUrl === true || Boolean(value.captchaUrl),
  };
}

export function cookieValue(value) {
  const text = String(value ?? '');
  if (/[^\x21-\x7e]|[;,]/.test(text)) fail('invalid cookie field');
  return text;
}

function safeCode(value) {
  return Number.isSafeInteger(value) ? String(value) : 'unavailable';
}

function callbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('invalid service address');
  }
  const host = url.hostname.toLowerCase();
  const allowed = host === 'mi.com' || host.endsWith('.mi.com') ||
    host === 'xiaomi.com' || host.endsWith('.xiaomi.com');
  if (url.protocol !== 'https:' || !allowed || url.username || url.password) {
    fail('unexpected service address');
  }
  return url;
}

export async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    fail('network request failed or timed out');
  }
  return response;
}

export function checkHttp(response) {
  if (!response.ok) fail(`HTTP ${response.status}`);
}

export async function authenticateSession(userId, passToken, deviceId, sid = 'micoapi') {
  if (!['micoapi', 'xiaomiio'].includes(sid)) fail('unsupported account service');
  const loginUrl = new URL(accountUrl);
  loginUrl.search = new URLSearchParams({ sid, _json: 'true' }).toString();
  const response = await request(loginUrl, {
    headers: {
      Cookie: `sdkVersion=3.9; deviceId=${cookieValue(deviceId)}; userId=${cookieValue(userId)}; passToken=${cookieValue(passToken)};`,
      'User-Agent': loginAgent,
    },
  });
  checkHttp(response);
  let pass;
  try {
    pass = JSON.parse((await response.text())
      .replace('&&&START&&&', '')
      .replace(/:(\d{9,})/g, ':"$1"'));
  } catch {
    fail('authentication response could not be parsed');
  }
  const observation = authObservation(pass);
  if (pass.notificationUrl || pass.captchaUrl || pass.securityStatus === 16) {
    fail('additional verification required', observation);
  }
  if (pass.code !== 0) {
    fail(`authentication code ${safeCode(pass.code)}; check saved credentials or verification`, observation);
  }
  const serviceToken = await completeServiceLogin(pass);
  const nextPassToken = typeof pass.passToken === 'string' && pass.passToken ? pass.passToken : passToken;
  cookieValue(nextPassToken);
  return {
    serviceToken,
    ssecurity: pass.ssecurity,
    cUserId: pass.cUserId,
    credentials: { userId, passToken: nextPassToken, deviceId },
    renewed: nextPassToken !== passToken,
  };
}

export async function completeServiceLogin(pass) {
  if (!pass.location || !pass.nonce || !pass.ssecurity) {
    fail('authentication response is missing required fields');
  }

  let url = callbackUrl(pass.location);
  url.searchParams.set('_userIdNeedEncrypt', 'true');
  url.searchParams.set(
    'clientSign',
    createHash('sha1').update(`nonce=${pass.nonce}&${pass.ssecurity}`).digest('base64'),
  );
  let serviceToken = '';
  for (let i = 0; i < 6; i++) {
    const tokenResponse = await request(url);
    for (const cookie of tokenResponse.headers.getSetCookie()) {
      const match = /^serviceToken=([^;]*)/i.exec(cookie);
      if (match?.[1]) serviceToken = match[1];
    }
    if (tokenResponse.status >= 300 && tokenResponse.status < 400) {
      const location = tokenResponse.headers.get('location');
      if (!location) fail('service redirect address missing');
      url = callbackUrl(new URL(location, url).href);
      continue;
    }
    checkHttp(tokenResponse);
    if (!serviceToken) fail('service token was not returned');
    return serviceToken;
  }
  fail('too many service redirects');
}

export async function authenticate(userId, passToken, deviceId) {
  return (await authenticateSession(userId, passToken, deviceId)).serviceToken;
}

export async function minaRequest(method, path, data, userId, serviceToken, device) {
  const url = new URL(path, minaBase);
  const params = new URLSearchParams({
    ...data,
    requestId: randomUUID(),
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  const cookies = {
    userId,
    serviceToken,
    sn: device?.serialNumber,
    hardware: device?.hardware,
    deviceId: device?.deviceID,
    deviceSNProfile: device?.deviceSNProfile,
  };
  const headers = {
    Cookie: Object.entries(cookies).map(([key, value]) => `${key}=${cookieValue(value)}`).join('; '),
    'User-Agent': minaAgent,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const options = { method, headers };
  if (method === 'GET') url.search = params.toString();
  else options.body = params.toString();
  const response = await request(url, options);
  checkHttp(response);
  let result;
  try {
    result = await response.json();
  } catch {
    fail('service response could not be parsed');
  }
  if (result.code !== 0) fail(`service code ${safeCode(result.code)}`);
  return result.data;
}

export const FAMILY_AUDIO_ID = '1582971365183456177';

export function musicMessage(audioUrl) {
  const audioId = FAMILY_AUDIO_ID;
  const music = {
    payload: {
      audio_type: 'MUSIC',
      audio_items: [{
        item_id: {
          audio_id: audioId,
          cp: { album_id: '-1', episode_index: 0, id: '355454500', name: 'xiaowei' },
        },
        stream: { url: audioUrl },
      }],
      list_params: { listId: '-1', loadmore_offset: 0, origin: 'xiaowei', type: 'MUSIC' },
    },
    play_behavior: 'REPLACE_ALL',
  };
  return JSON.stringify({ startaudioid: audioId, music: JSON.stringify(music) });
}

export function audioServer(audio, route, counts, contentType, onRead) {
  return createServer((req, res) => {
    if (req.method === 'GET') counts.get++;
    if (req.method === 'HEAD') counts.head++;
    if (req.url !== route || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404, { Connection: 'close' });
      res.end();
      return;
    }
    let start = 0;
    let end = audio.length - 1;
    let status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!match) {
        counts.invalidRange++;
        res.writeHead(416, { 'Content-Range': `bytes */${audio.length}`, Connection: 'close' });
        res.end();
        return;
      }
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end || start >= audio.length) {
        counts.invalidRange++;
        res.writeHead(416, { 'Content-Range': `bytes */${audio.length}`, Connection: 'close' });
        res.end();
        return;
      }
      status = 206;
    }
    const headers = {
      'Content-Type': contentType,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      Connection: 'close',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${audio.length}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end();
    else {
      counts.matchedGet++;
      onRead?.();
      res.end(audio.subarray(start, end + 1));
    }
  });
}
