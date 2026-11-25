import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { authenticateSession, request, checkHttp, cookieValue } from './transport.mjs';

// Xiaomi's existing cloud protocol requires RC4 with the first 1024 bytes discarded.
// Protocol reference: mi-service-lite/src/utils/codec.ts and src/mi/miot.ts.
export function rc4Drop(key, input) {
  if (!key.length) throw new Error('MIoT session unavailable');
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  const output = Buffer.alloc(input.length);
  for (let offset = 0; offset < input.length + 1024; offset++) {
    i = (i + 1) & 255;
    j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    if (offset >= 1024) output[offset - 1024] = input[offset - 1024] ^ state[(state[i] + state[j]) & 255];
  }
  return output;
}

function signature(path, params, signedNonce) {
  return createHash('sha1').update([
    'POST', path, ...Object.entries(params).map(([key, value]) => key + '=' + value), signedNonce,
  ].join('&')).digest('base64');
}

export function createL05CControl(credentials, did, onRefresh) {
  let session;
  const action = async (siid, aiid, input = []) => {
    if (!/^\d+$/.test(String(did))) throw new Error('L05C MIoT device unavailable');
    if (!session) {
      session = await authenticateSession(credentials.userId, credentials.passToken, credentials.deviceId, 'xiaomiio');
      if (session.renewed && onRefresh) await onRefresh(session.credentials);
    }
    const path = '/miotspec/action';
    const nonce = Buffer.alloc(12);
    randomBytes(8).copy(nonce);
    nonce.writeUInt32BE(Math.floor(Date.now() / 60000), 8);
    const signed = createHash('sha256').update(Buffer.concat([
      Buffer.from(session.ssecurity, 'base64'), nonce,
    ])).digest();
    const signedNonce = signed.toString('base64');
    const params = { data: JSON.stringify({ params: { did: String(did), siid, aiid, in: input }, datasource: 2 }) };
    params.rc4_hash__ = signature(path, params, signedNonce);
    for (const name of Object.keys(params)) params[name] = rc4Drop(signed, Buffer.from(params[name])).toString('base64');
    params.signature = signature(path, params, signedNonce);
    params.ssecurity = session.ssecurity;
    params._nonce = nonce.toString('base64');
    const cookies = {
      countryCode: 'CN', locale: 'zh_CN', timezone: 'GMT+08:00', timezone_id: 'Asia/Shanghai',
      userId: credentials.userId, PassportDeviceId: credentials.deviceId,
      serviceToken: session.serviceToken, yetAnotherServiceToken: session.serviceToken,
      ...(session.cUserId ? { cUserId: session.cUserId } : {}),
    };
    const response = await request('https://api.io.mi.com/app' + path, {
      method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'MICO/AndroidApp/@SHIP.TO.2A2FE0D7@/2.4.40',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'miot-accept-encoding': 'GZIP', 'miot-encrypt-algorithm': 'ENCRYPT-RC4',
        Cookie: Object.entries(cookies).map(([key, value]) => key + '=' + cookieValue(value)).join('; '),
      }, body: new URLSearchParams(params).toString(),
    });
    checkHttp(response);
    const text = await response.text();
    let result;
    try {
      if (text.trimStart().startsWith('{')) result = JSON.parse(text);
      else {
        let decoded = rc4Drop(signed, Buffer.from(text, 'base64'));
        if (response.headers.get('miot-content-encoding') === 'GZIP') decoded = gunzipSync(decoded);
        result = JSON.parse(decoded.toString('utf8'));
      }
    } catch { throw new Error('MIoT response unavailable'); }
    if (result?.code !== 0 || result?.result?.code !== 0) {
      const code = result?.code !== 0 ? result?.code : result?.result?.code;
      throw new Error('MIoT action rejected: ' + (Number.isSafeInteger(code) ? code : 'unavailable'));
    }
  };
  return {
    say: (text) => action(5, 3, [text]),
    operate: (operation) => action(3, operation === 'play' ? 2 : 3),
  };
}
