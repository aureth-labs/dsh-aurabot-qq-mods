import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateSession, authObservation } from '../lib/speaker/transport.mjs';
import { verifySpeakerLogin } from '../lib/speaker/mina.mjs';

test('login returns the server passport instead of discarding renewed credentials', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (new URL(url).hostname === 'account.xiaomi.com') return Response.json({
      code: 0, nonce: '1234567890', ssecurity: 'synthetic-security',
      location: 'https://api2.mina.mi.com/synthetic-sts', passToken: 'V1:renewed-synthetic',
    });
    return new Response('', { headers: { 'set-cookie': 'serviceToken=synthetic-service; Path=/' } });
  });
  const session = await authenticateSession('1234567890', 'V1:old-synthetic', 'synthetic-device');
  assert.equal(session.serviceToken, 'synthetic-service');
  assert.equal(session.credentials.passToken, 'V1:renewed-synthetic');
  assert.equal(session.renewed, true);
});

test('security observation exposes flags without challenge URLs or context secrets', () => {
  const value = authObservation({
    code: 0, securityStatus: 16,
    notificationUrl: 'https://account.xiaomi.com/identity/authStart?context=synthetic-private',
  });
  assert.equal(value.hasNotificationUrl, true);
  assert.equal(value.securityStatus, 16);
  assert.equal(JSON.stringify(value).includes('synthetic-private'), false);
});

test('account challenge is identified before generic authentication rejection', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    code: 70016, securityStatus: 16,
    notificationUrl: 'https://account.xiaomi.com/identity/authStart?context=synthetic-private',
  }));
  await assert.rejects(authenticateSession('1234567890', 'V1:synthetic', 'synthetic'), (error) => {
    assert.equal(error.message, 'additional verification required');
    assert.equal(error.authObservation.hasNotificationUrl, true);
    assert.equal(JSON.stringify(error.authObservation).includes('synthetic-private'), false);
    return true;
  });
});

test('verified login uses the online device and readable history independently of playback status', async (t) => {
  const credentials = { userId: '1234567890', passToken: 'V1:synthetic', deviceId: 'synthetic-browser', localAddress: '127.0.0.1' };
  let historyReads = 0;
  let historyCode = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.hostname === 'account.xiaomi.com') return Response.json({
      code: 0, nonce: '1234567890', ssecurity: 'synthetic-security',
      location: 'https://api2.mina.mi.com/synthetic-sts',
    });
    if (url.pathname === '/synthetic-sts') return new Response('', {
      headers: { 'set-cookie': 'serviceToken=synthetic-service; Path=/' },
    });
    if (url.pathname === '/admin/v2/device_list') return Response.json({ code: 0, data: [
      { hardware: 'L05C', deviceID: 'synthetic-speaker', presence: 'online' },
    ] });
    if (url.pathname === '/device_profile/v2/conversation') {
      historyReads++;
      return Response.json({ code: historyCode, data: JSON.stringify({ records: [] }) });
    }
    throw new Error('Login must not require playback status or send any device command');
  });
  const result = await verifySpeakerLogin(credentials);
  assert.equal(result.credentials.passToken, credentials.passToken);
  assert.equal(historyReads, 1);
  historyCode = 1;
  await assert.rejects(verifySpeakerLogin(credentials), /语音记录接口/);
});
