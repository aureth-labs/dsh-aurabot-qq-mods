import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex } from '../lib/catalog.mjs';
const manifest = JSON.parse(readFileSync(new URL('../scripts/packs.json', import.meta.url)));
const resources = JSON.parse(readFileSync(new URL('../scripts/resources.json', import.meta.url)));
test('扩展只增加独立标识与资源，各平台均有固定发行文件', () => {
  const keys = new Set(manifest.baseKeys), paths = new Set(resources.files.map(f => f.path));
  assert.equal(keys.size, 299);
  for (const pack of manifest.packs) {
    for (const key of pack.keys) { assert.equal(keys.has(key), false, key); keys.add(key); }
    for (const file of pack.files) { assert.equal(paths.has(file.path), false, file.path); paths.add(file.path); }
    for (const platform of ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) {
      assert.ok(pack.binaries[platform].size > 0);
      assert.ok(pack.binaries[platform].url.includes('v0.0.6%2Bbuild.66'));
    }
  }
  assert.equal(keys.size, 730); assert.equal(paths.size, 9000);
});
test('共享触发词按原库优先，自定义别名仍可覆盖', () => {
  const original = {key:'original',keywords:['同词']}, addition = {key:'addition',keywords:['同词','新词']};
  assert.equal(buildIndex([original,addition]).get('同词').item.key,'original');
  assert.equal(buildIndex([original,addition]).get('新词').item.key,'addition');
  assert.equal(buildIndex([original,addition],{'同词':'addition'}).get('同词').item.key,'addition');
});
