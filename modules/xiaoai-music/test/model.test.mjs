import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askProbeModel, MODEL_TEST_QUESTION, MODEL_TOKEN_BUDGET } from '../lib/speaker/model.mjs';
import definition, { speakerFailure } from '../index.mjs';

test('model wrapper rejects empty output instead of treating the spoken label as an answer', async () => {
  await assert.rejects(askProbeModel(async () => ''), { code: 'MODEL_EMPTY_RESPONSE' });
  await assert.rejects(askProbeModel(async () => '  '), { code: 'MODEL_EMPTY_RESPONSE' });
});

test('upstream failures become fixed reasons with no original details', async () => {
  const cases = [
    ['401 api key private-credential', 'MODEL_AUTH'],
    ['429 private-credential', 'MODEL_QUOTA'],
    ['fetch failed private-credential', 'MODEL_NETWORK'],
    ['拿不到默认模型 private-credential', 'MODEL_CONFIG'],
    ['unsupported option private-credential', 'MODEL_OPTIONS'],
    ['arbitrary private-credential', 'MODEL_REQUEST'],
  ];
  for (const [message, code] of cases) {
    await assert.rejects(askProbeModel(async () => { throw new Error(message); }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes('private-credential'), false);
      return true;
    });
  }
});

test('diagnostic route uses the voice model request without loading credentials or playing audio', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'family-model-isolated-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const routes = new Map();
  const modelCalls = [];
  const module = await definition.setup({
    tool() {}, rule() {}, defineTool: value => value,
    id: 'xiaoai-music',
    settings: () => ({ resourceRoot: dir }),
    route: (path, handler) => routes.set(path, handler),
    every: () => {}, on: () => {}, onDispose: () => {},
    ask: async (request) => { modelCalls.push(request); return '二。'; },
    core: { http: { body: async (request) => request.body } },
  });
  const request = {
    method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' }, body: {},
  };
  const result = await routes.get('/model/check')(request);
  assert.equal(result.ok, true);
  assert.equal(result.model.hasReply, true);
  assert.equal(modelCalls[0].text, MODEL_TEST_QUESTION);
  assert.equal(modelCalls[0].maxTokens, MODEL_TOKEN_BUDGET);
  assert.equal(module.status().connected, false);
  await routes.get('/model/check')({ ...request, body: { extendedBudget: true } });
  assert.equal(modelCalls[1].maxTokens, 800);
});

test('Xiaomi authentication rejection is actionable and never echoes upstream details', () => {
  const failure = speakerFailure(new Error('authentication code 70016; private-credential'));
  assert.equal(failure.code, 'SPEAKER_AUTH_REJECTED');
  assert.equal(failure.authCode, 70016);
  assert.equal(failure.message.includes('更新'), true);
  assert.equal(JSON.stringify(failure).includes('private-credential'), false);
  assert.equal(speakerFailure(new Error('additional verification required')).code, 'SPEAKER_VERIFICATION_REQUIRED');
  assert.equal(JSON.stringify(speakerFailure(new Error('unknown private-credential'))).includes('private-credential'), false);
});
