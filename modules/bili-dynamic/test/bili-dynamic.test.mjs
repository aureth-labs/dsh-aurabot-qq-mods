import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mod from '../index.mjs';

function fakeApi({ settings = {}, config = {}, think = async () => '今天好累' } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'bili-dyn-'));
	const api = {
		settings: () => settings,
		dataDir: () => dir,
		config: () => config,
		log: { info() {}, warn() {}, error() {}, debug() {} },
		on: () => {}, context: () => {}, rule: () => {}, every: () => {}, later: () => {}, route: () => {},
		use: () => null, ask: async () => '', think, send: async () => {},
		defineTool: (t) => t, tool: () => {}, command: () => {},
		core: { http: {}, hub: {} },
	};
	return { api, dir };
}

const full = { enabled: true, auto: true, maxPerDay: 4, awakeFrom: 0, awakeTo: 24 };

test('模块声明', () => {
	assert.equal(mod.id, 'bili-dynamic');
	assert.equal(mod.api, 1);
});

test('没登录就明确报错，不会瞎发', async () => {
	const { api } = fakeApi({ settings: full, config: { bili: { enabled: true } } });
	const out = mod.setup(api);
	await assert.rejects(() => out.postNow('测试内容'), /还没登录/);
});

test('拿到内容就发（用假的 fetch）', async () => {
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, opt) => {
		calls.push({ url: String(url), body: String(opt?.body || '') });
		return {
			json: async () => ({ code: 0, data: { dynamic_id_str: '123456789012' } }),
			status: 200,
		};
	};
	try {
		const { api } = fakeApi({
			settings: full,
			config: { bili: { enabled: true, sessdata: 'x', biliJct: 'csrf', cookie: 'SESSDATA=x' } },
		});
		const out = mod.setup(api);
		const r = await out.postNow('今天在水里翻了个身');
		assert.equal(r.ok, true);
		assert.equal(r.url, 'https://t.bilibili.com/123456789012');
		assert.equal(calls.length, 1);
		assert.match(calls[0].url, /dynamic_svr\/v1\/dynamic_svr\/create/);
		assert.match(calls[0].body, /content=/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('B 站返回错误码就抛出来', async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ json: async () => ({ code: -101, message: '账号未登录' }), status: 200 });
	try {
		const { api } = fakeApi({
			settings: full,
			config: { bili: { enabled: true, sessdata: 'x', biliJct: 'csrf' } },
		});
		const out = mod.setup(api);
		await assert.rejects(() => out.postNow('测试'), /-101/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('每天条数用完后不再发', async () => {
	const { api } = fakeApi({
		settings: { ...full, maxPerDay: 1 },
		config: { bili: { enabled: true, sessdata: 'x', biliJct: 'csrf' } },
	});
	const out = mod.setup(api);
	const st = out.status();
	assert.equal(st.ok, true);
	assert.equal(st.max, 1);
	assert.equal(typeof st.left, 'number');
	assert.ok(st.left <= 1);
});
