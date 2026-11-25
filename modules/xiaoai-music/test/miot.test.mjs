import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { rc4Drop, createL05CControl } from '../lib/speaker/miot.mjs';
import { MiNASpeaker } from '../lib/speaker/mina.mjs';

const credentials = { userId: '1234567890', passToken: 'V1:synthetic-only', deviceId: 'synthetic-browser' };
const security = Buffer.from('synthetic-secret').toString('base64');

test('Xiaomi RC4 drop matches the RFC 6229 stream at byte 1024', () => {
  assert.equal(rc4Drop(Buffer.from('0102030405', 'hex'), Buffer.alloc(16)).toString('hex'),
    '30abbcc7c20b01609f23ee2d5f6bb7df');
});

function mockCloud(t, result = { code: 0, result: { code: 0 } }) {
  const actions = [];
  const logins = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'account.xiaomi.com') {
      logins.push(url.searchParams.get('sid'));
      return Response.json({ code: 0, ssecurity: security, nonce: '1234567890',
        location: 'https://api.io.mi.com/synthetic-sts' });
    }
    if (url.pathname === '/synthetic-sts') return new Response('', {
      headers: { 'set-cookie': 'serviceToken=synthetic-service; Path=/' },
    });
    assert.equal(url.href, 'https://api.io.mi.com/app/miotspec/action');
    assert.equal(options.method, 'POST');
    assert.match(options.headers.Cookie, /serviceToken=synthetic-service/);
    const params = new URLSearchParams(options.body);
    const nonce = Buffer.from(params.get('_nonce'), 'base64');
    assert.equal(nonce.length, 12);
    const signed = createHash('sha256').update(Buffer.concat([Buffer.from(security, 'base64'), nonce])).digest();
    const signature = createHash('sha1').update([
      'POST', '/miotspec/action', 'data=' + params.get('data'),
      'rc4_hash__=' + params.get('rc4_hash__'), signed.toString('base64'),
    ].join('&')).digest('base64');
    assert.equal(params.get('signature'), signature);
    actions.push(JSON.parse(rc4Drop(signed, Buffer.from(params.get('data'), 'base64')).toString()));
    return new Response(rc4Drop(signed, gzipSync(Buffer.from(JSON.stringify(result)))).toString('base64'), {
      headers: { 'miot-content-encoding': 'GZIP' },
    });
  });
  return { actions, logins };
}

test('L05C uses lazy xiaomiio login, text action 5-3 and control actions without a MiNA fallback', async (t) => {
  const h = mockCloud(t);
  const control = createL05CControl(credentials, '123456789');
  assert.equal(h.logins.length, 0);
  await control.say('家庭模块回答，二。');
  await control.operate('pause');
  await control.operate('play');
  assert.deepEqual(h.logins, ['xiaomiio']);
  assert.deepEqual(h.actions[0], { params: { did: '123456789', siid: 5, aiid: 3, in: ['家庭模块回答，二。'] }, datasource: 2 });
  assert.deepEqual(h.actions.slice(1).map(value => [value.params.siid, value.params.aiid]), [[3, 3], [3, 2]]);
});

test('MIoT rejection is not accepted and does not expose response details', async (t) => {
  const h = mockCloud(t, { code: 0, result: { code: -704220025, message: 'synthetic-private-detail' } });
  await assert.rejects(createL05CControl(credentials, '123456789').say('隔离测试'), (error) => {
    assert.equal(error.message, 'MIoT action rejected: -704220025');
    assert.equal(error.message.includes('synthetic-private'), false);
    return true;
  });
  assert.equal(h.actions.length, 1);
});

test('missing MIoT device id cannot fall back to an apparently successful silent command', async (t) => {
  const h = mockCloud(t);
  await assert.rejects(createL05CControl(credentials, undefined).say('隔离测试'), /device unavailable/);
  assert.equal(h.logins.length, 0);
});

test('successful response without playback info stays unknown and keeps the accepted audio available', async (t) => {
  let audioUrl;
  const controls = [];
  const speaker = new MiNASpeaker({
    localAddress: '127.0.0.1',
    control: { say: async () => controls.push('say'), operate: async action => controls.push(action) },
    call: async (scope, method, message) => {
      if (method === 'player_play_music') {
        audioUrl = JSON.parse(JSON.parse(message).music).payload.audio_items[0].stream.url;
      }
      return { code: 0 };
    },
  });
  t.after(() => speaker.close());
  const played = await speaker.playProbe();
  assert.equal(played.playback, 'unknown');
  assert.equal(played.playbackReadable, false);
  assert.equal((await fetch(audioUrl, { method: 'HEAD' })).status, 200);
  assert.equal((await speaker.operate('pause')).playback, 'unknown');
  await speaker.operate('stop');
  assert.equal(speaker.server, null);
  await assert.rejects(speaker.operate('play'), /没有可继续/);
  const spoken = await speaker.say('隔离测试');
  assert.equal(spoken.output, 'miot-5-3');
  await speaker.close();
  assert.deepEqual(controls, ['pause', 'pause', 'say', 'pause']);
});
