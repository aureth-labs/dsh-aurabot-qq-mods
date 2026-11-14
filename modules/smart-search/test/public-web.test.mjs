import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { publicUrl, publicIp, resolvePublic, readPublicPage } from '../lib/public-web.mjs';
import { searchResult, pageResult } from '../lib/results.mjs';
test('rejects loopback, private, reserved, IPv6 mapped, non-http, credentials and unusual ports', () => {
  for (const url of ['file:///etc/passwd', 'http://127.1/', 'http://2130706433/', 'http://10.0.0.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/', 'http://198.18.0.1/', 'http://localhost/', 'http://foo.local/', 'https://user:pass@example.com/', 'http://example.com:22/']) assert.throws(() => publicUrl(url), { code: 'url' });
  assert.equal(publicUrl('https://example.com/#test').href, 'https://example.com/');
  assert.equal(publicIp('8.8.8.8'), true); assert.equal(publicIp('2001:db8::1'), false);
});
test('rejects mixed public/private DNS answers', async () => {
  await assert.rejects(resolvePublic(new URL('https://example.com'), async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), { code: 'url' });
});
test('checks every redirect and passes resolved addresses to the connection', async () => {
  let called = 0;
  await assert.rejects(readPublicPage('https://example.com', AbortSignal.timeout(1000), {
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async (_url, addresses) => { called++; assert.equal(addresses[0].address, '8.8.8.8'); return { statusCode: 302, headers: { location: 'http://127.0.0.1/' }, destroy() {} }; },
  }), { code: 'url' }); assert.equal(called, 1);
});
test('reads bounded HTML and removes scripts/styles without executing them', async () => {
  const raw = await readPublicPage('https://example.com', AbortSignal.timeout(1000), {
    resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport: async () => Object.assign(Readable.from([Buffer.from('<h1>Title</h1><script>SECRET()</script><p>Hello</p>')]), { statusCode: 200, headers: { 'content-type': 'text/html' } }),
  });
  const result = pageResult(raw, 'dsh'); assert.match(result.text, /Hello/); assert.doesNotMatch(result.text, /SECRET/);
});
test('normalization validates links, deduplicates, applies domains and drops generated answers', () => {
  const result = searchResult({ content: 'unverified answer', sources: [
    { url: 'https://example.com/', snippet: 'a' }, { url: 'https://example.com/#x' },
    { url: 'http://127.0.0.1/' }, { url: 'javascript:alert(1)' }, { url: 'https://other.example/' },
  ] }, { query: 'q', provider: 'dsh', limit: 5, domains: ['example.com'] });
  assert.equal(result.sources.length, 1); assert.doesNotMatch(result.message, /unverified answer/); assert.equal(result.truncated, true);
});
test('oversized page output is marked as truncated', () => {
  const result = pageResult({ url: 'https://example.com', content: 'a'.repeat(13000) }, 'dsh');
  assert.equal(result.text.length, 12000); assert.equal(result.truncated, true);
});
test('rejects compressed responses rather than returning unreadable page text', async () => {
  let destroyed = false;
  await assert.rejects(readPublicPage('https://example.com', AbortSignal.timeout(1000), {
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, destroy() { destroyed = true; } }),
  }), { code: 'page' });
  assert.equal(destroyed, true);
});
