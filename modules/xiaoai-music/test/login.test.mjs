import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeakerLogin } from '../lib/speaker/login.mjs';
import { saveWindowsCredentials } from '../lib/speaker/windows.mjs';

const account = 'https://account.xiaomi.com';
const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness(t, options = {}) {
  const saved = [];
  const verified = [];
  const destinations = [];
  const events = [];
  let finish;
  let stored = options.firstTime ? { localAddress: '127.0.0.1' } : { userId: '1234567890', passToken: 'V1:previous-synthetic', deviceId: 'previous-synthetic', localAddress: '127.0.0.1' };
  const pending = new Promise((resolve) => { finish = resolve; });
  const session = new SpeakerLogin({
    environment: async () => ({ ...stored }),
    finalize: async () => { events.push('callback'); },
    verify: async (value) => { events.push('verify'); verified.push(value); if (options.verifyFails) throw new Error('private-server-body'); },
    save: async (value) => { saved.push(value); stored = { ...stored, ...value }; },
    fetchImpl: async (url, init) => {
      destinations.push(url);
      assert.equal(init.redirect, 'manual');
      if (url.includes('/pass/serviceLogin')) return new Response('&&&START&&&' + JSON.stringify({
        code: 70016, sid: 'micoapi', qs: '?sid=micoapi', _sign: 'synthetic-sign', callback: 'https://api2.mina.mi.com/sts',
      }), { headers: { 'set-cookie': 'passport_flow=synthetic-flow; Path=/' } });
      assert.match(init.headers.Cookie, /passport_flow=synthetic-flow/);
      if (url.includes('/longPolling/loginUrl')) return Response.json({
        qr: options.imageUrl || account + '/synthetic-image',
        lp: options.pollUrl || 'https://c3.lp.account.xiaomi.com/synthetic-poll', timeout: 180,
      });
      if (url.includes('/synthetic-image')) return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      });
      if (url.includes('/synthetic-poll')) return pending;
      throw new Error('Unexpected destination');
    },
  });
  t.after(() => session.close());
  return {
    session, saved, verified, destinations, events,
    finish: (userId = '1234567890', extra = {}) => finish(Response.json({ code: 0, userId, passToken: 'V1:synthetic-test-token', ...extra })),
  };
}

test('QR login saves only the same account after speaker preflight, with no secret in public status', async (t) => {
  const h = harness(t);
  assert.equal((await h.session.start()).phase, 'waiting');
  assert.equal(h.saved.length, 0);
  assert.equal(h.verified.length, 0);
  h.finish();
  await h.session.work;
  assert.equal(h.session.status().phase, 'saved');
  assert.equal(h.verified.length, 2);
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.events, ['callback', 'verify', 'verify']);
  assert.match(h.saved[0].deviceId, /^[A-F0-9]{16}$/);
  assert.equal(JSON.stringify(h.session.status()).includes('synthetic-test-token'), false);
  assert.equal(JSON.stringify(h.session.status()).includes('1234567890'), false);
  assert.equal(h.session.picture, null);
});

test('different account never verifies or replaces existing credentials', async (t) => {
  const h = harness(t);
  await h.session.start();
  h.finish('9999999999');
  await h.session.work;
  assert.equal(h.session.status().phase, 'failed');
  assert.equal(h.saved.length, 0);
  assert.equal(h.verified.length, 0);
  assert.match(h.session.status().message, /不一致/);
});

test('a first account can scan and save after validation without preexisting credentials', async t => {
  const h = harness(t, { firstTime: true });
  assert.equal((await h.session.start()).phase, 'waiting');
  h.finish(); await h.session.work;
  assert.equal(h.session.status().phase, 'saved');
  assert.equal(h.saved.length, 1); assert.equal(h.verified.length, 2);
  assert.equal(JSON.stringify(h.session.status()).includes('1234567890'), false);
});

test('multiple speakers require supported online selection before credentials are saved', async t => {
  const h = harness(t, { firstTime: true });
  const selected = [];
  h.session.verify = async (credentials, selector) => selector
    ? { credentials, selectedDevice: selector }
    : { needsSelection: true, credentials, devices: [
      { id: 'a', name: 'Synthetic A', model: 'L05C', supported: true, online: true },
      { id: 'b', name: 'Synthetic B', model: 'LX06', supported: false, online: true },
      { id: 'c', name: 'Synthetic C', model: 'L05C', supported: true, online: false }] };
  h.session.onDeviceSelected = async id => selected.push(id);
  await h.session.start(); h.finish(); await h.session.work;
  assert.equal(h.session.status().phase, 'select-device'); assert.equal(h.saved.length, 0);
  assert.equal(JSON.stringify(h.session.status()).includes('synthetic-test-token'), false);
  for (const id of ['b','c','missing']) assert.equal((await h.session.selectDevice(id)).phase, 'select-device');
  assert.equal(h.saved.length, 0);
  assert.equal((await h.session.selectDevice('a')).phase, 'saved');
  assert.equal(h.saved.length, 1); assert.deepEqual(selected, ['a']);
});

test('closing device selection discards the pending account', async t => {
  const h = harness(t, { firstTime: true });
  h.session.verify = async credentials => ({ needsSelection: true, credentials,
    devices: [{ id: 'a', supported: true, online: true }] });
  await h.session.start(); h.finish(); await h.session.work;
  h.session.close(); await h.session.selectDevice('a');
  assert.equal(h.saved.length, 0); assert.equal(h.session.pendingSelection, null);
});

test('missing local login environment explains initialization prerequisite before requesting a QR', async t => {
  const h = harness(t);
  h.session.environment = async () => { throw Error('private account details'); };
  assert.equal((await h.session.start()).phase, 'failed');
  assert.match(h.session.status().message, /网卡/);
  assert.deepEqual(h.destinations, []); assert.deepEqual(h.saved, []);
  assert.equal(JSON.stringify(h.session.status()).includes('private account details'), false);
});

test('speaker validation failure preserves existing credentials and hides upstream body', async (t) => {
  const h = harness(t, { verifyFails: true });
  await h.session.start();
  h.finish();
  await h.session.work;
  assert.equal(h.saved.length, 0);
  assert.equal(h.session.status().phase, 'failed');
  assert.equal(JSON.stringify(h.session.status()).includes('private-server-body'), false);
});

test('closed QR session cannot save a late phone confirmation', async (t) => {
  const h = harness(t);
  await h.session.start();
  h.session.close();
  h.finish();
  await h.session.work;
  assert.equal(h.saved.length, 0);
  assert.equal(h.session.status().phase, 'idle');
});

test('cancellation during validation cannot update the credential store', async (t) => {
  const h = harness(t);
  let finishVerify;
  h.session.verify = () => new Promise((resolve) => { finishVerify = resolve; });
  await h.session.start();
  h.finish();
  await settle();
  h.session.close();
  finishVerify();
  await h.session.work;
  assert.equal(h.saved.length, 0);
});

test('unapproved QR image destination is not requested', async (t) => {
  const h = harness(t, { imageUrl: 'https://example.com/synthetic-image' });
  assert.equal((await h.session.start()).phase, 'failed');
  assert.equal(h.destinations.some((url) => url.startsWith('https://example.com')), false);
  assert.equal(h.saved.length, 0);
});

test('a lookalike account hostname is not a permitted polling destination', async (t) => {
  const h = harness(t, { pollUrl: 'https://account.xiaomi.com.example.com/synthetic-poll' });
  assert.equal((await h.session.start()).phase, 'failed');
  assert.equal(h.destinations.some((url) => url.includes('account.xiaomi.com.example.com')), false);
});

test('invalid credentials are rejected before starting a Windows writer', async () => {
  await assert.rejects(saveWindowsCredentials({ userId: 'not-an-id', passToken: 'synthetic', deviceId: 'synthetic' }), /格式/);
});

test('final returned passport is persisted, then loaded and verified before success', async (t) => {
  const h = harness(t);
  let calls = 0;
  h.session.verify = async (credentials) => {
    calls++;
    if (calls === 1) return {
      credentials: { ...credentials, passToken: 'V1:renewed-synthetic-passport' }, renewed: true,
    };
    assert.equal(credentials.passToken, 'V1:renewed-synthetic-passport');
    return { credentials, renewed: false };
  };
  await h.session.start();
  h.finish();
  await h.session.work;
  assert.equal(h.session.status().phase, 'saved');
  assert.equal(calls, 2);
  assert.equal(h.saved[0].passToken, 'V1:renewed-synthetic-passport');
  assert.equal(h.session.status().renewalObserved, true);
});

test('read-back login failure cannot be presented as saved successfully', async (t) => {
  const h = harness(t);
  let calls = 0;
  h.session.verify = async (credentials) => {
    if (++calls === 2) throw new Error('private-login-body');
    return { credentials, renewed: false };
  };
  await h.session.start();
  h.finish();
  await h.session.work;
  assert.equal(h.session.status().phase, 'failed');
  assert.match(h.session.status().message, /重新读取/);
  assert.equal(JSON.stringify(h.session.status()).includes('private-login-body'), false);
});

test('uncompleted QR callback stops before speaker verification or saving', async (t) => {
  const h = harness(t);
  h.session.finalize = async () => { throw new Error('private-callback-data'); };
  await h.session.start();
  h.finish();
  await h.session.work;
  assert.equal(h.session.status().phase, 'failed');
  assert.equal(h.verified.length, 0);
  assert.equal(h.saved.length, 0);
  assert.equal(JSON.stringify(h.session.status()).includes('private-callback-data'), false);
});

test('QR security challenge stops the session without exposing the challenge URL', async (t) => {
  const h = harness(t);
  await h.session.start();
  h.finish('1234567890', {
    securityStatus: 16,
    notificationUrl: 'https://account.xiaomi.com/identity/authStart?context=synthetic-private',
  });
  await h.session.work;
  assert.equal(h.session.status().phase, 'verification-required');
  assert.equal(h.session.status().authObservation.hasNotificationUrl, true);
  assert.deepEqual(h.events, []);
  assert.equal(h.saved.length, 0);
  assert.equal(JSON.stringify(h.session.status()).includes('synthetic-private'), false);
});

test('post-scan validation distinguishes missing service token from passport rejection', async (t) => {
  const h = harness(t);
  h.session.verify = async () => { throw new Error('service token was not returned'); };
  await h.session.start();
  h.finish();
  await h.session.work;
  assert.deepEqual(h.session.status().failure, { code: 'SERVICE_TOKEN_MISSING' });
  assert.equal(h.session.status().authObservation.code, 0);
  assert.equal(h.saved.length, 0);
});
