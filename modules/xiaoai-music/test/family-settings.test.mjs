import test from 'node:test';
import assert from 'node:assert/strict';
import { getVoiceOptions } from '../lib/companion/settings.mjs';
test('voice options expose names and guides while omitting engine paths and service addresses', () => {
  const secret = 'isolated-private-value';
  const config = { voice: { engine: 'gptsovits', gptsovits: { url: 'https://' + secret }, songVoice: 'dialogue' }, song: { voice: 'mother', root: secret } };
  const value = getVoiceOptions({ config: () => config, use: () => ({ status: () => ({ voices: [
    { id: 'mother', pth: secret, index: secret }, { id: 'dialogue', pth: secret }, { id: 'C:\\private\\model' },
  ] }) }) });
  assert.deepEqual(value.options, [{ id: '', label: '跟随 AuraBot「表达」' }, { id: 'mother', label: 'mother' }, { id: 'dialogue', label: 'dialogue' }]);
  assert.equal(value.dialogue.configured, true); assert.equal(value.singing.configured, true);
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal(JSON.stringify(value).includes('pth'), false);
  assert.equal(value.guide.dialogue.tab, 'voice');
  assert.equal(value.guide.singing.tab, 'song');
  const missing = getVoiceOptions({ config: () => ({ voice: {}, song: {} }), use: () => null });
  assert.equal(missing.dialogue.configured, false); assert.equal(missing.singing.configured, false);
  assert.equal(missing.options.length, 1);
});
