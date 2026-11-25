import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mod from '../index.mjs';

function fakeApi({ settings = {}, config = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'bili-reply-'));
	const api = {
		settings: () => settings,
		dataDir: () => dir,
		config: () => config,
		log: { info() {}, warn() {}, error() {}, debug() {} },
		on: () => {}, context: () => {}, rule: () => {}, every: () => {}, later: () => {}, route: () => {},
		use: () => null, ask: async () => '', think: async () => '谢谢', send: async () => {},
		defineTool: (t) => t, tool: () => {}, command: () => {},
		core: { http: {}, hub: {} },
	};
	return { api, dir };
}

const full = { enabled: true, dryRun: true, maxPerRun: 2, maxPerDay: 8, dynamicsPerRun: 3, minGapMinutes: 20, dynamicIds: '' };

test('模块声明', () => {
	assert.equal(mod.id, 'bili-reply');
	assert.equal(mod.api, 1);
});

test('没登录就明确报错', async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ json: async () => ({ data: { isLogin: false } }) });
	try {
		const { api } = fakeApi({ settings: full, config: { bili: { sessdata: 'x' } } });
		const out = mod.setup(api);
		const r = await out.run({ dry: true, force: true });
		assert.equal(r.ok, false);
		assert.match(r.message, /没登录|登录态/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('没动态可看时给出提示', async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		if (String(url).includes('nav')) return { json: async () => ({ data: { isLogin: true, mid: 42 } }) };
		return { json: async () => ({ code: 0, data: { replies: [] } }) };
	};
	try {
		const { api } = fakeApi({ settings: full, config: { bili: { sessdata: 'x' } } });
		const out = mod.setup(api);
		const r = await out.run({ dry: true, force: true });
		assert.equal(r.ok, true);
		assert.match(r.message, /还没记到|没有/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('试运行只列出来，不真回', async () => {
	const realFetch = globalThis.fetch;
	const posted = [];
	globalThis.fetch = async (url, opt) => {
		const u = String(url);
		if (u.includes('nav')) return { json: async () => ({ data: { isLogin: true, mid: 42 } }) };
		if (u.includes('/x/v2/reply/add')) { posted.push(u); return { json: async () => ({ code: 0 }) }; }
		return {
			json: async () => ({
				code: 0,
				data: { replies: [{ rpid: 9001, member: { mid: 7, uname: '小明' }, content: { message: '好看' } }] },
			}),
		};
	};
	try {
		const { api } = fakeApi({ settings: { ...full, dynamicIds: 'https://t.bilibili.com/123456789012' }, config: { bili: { sessdata: 'x' } } });
		const out = mod.setup(api);
		const r = await out.run({ dry: true, force: true });
		assert.equal(r.ok, true);
		assert.equal(posted.length, 0, '试运行不该发回复');
		assert.ok(Array.isArray(r.list) && r.list.length === 1);
		assert.match(r.list[0], /小明/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('状态接口有今天的计数', () => {
	const { api } = fakeApi({ settings: full, config: {} });
	const out = mod.setup(api);
	const s = out.status();
	assert.equal(s.ok, true);
	assert.equal(typeof s.day.count, 'number');
	assert.equal(s.dryRun, true);
});
