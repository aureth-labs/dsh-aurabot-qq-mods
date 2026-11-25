import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mod from '../index.mjs';

function fakeApi({ settings = {}, config = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'poke-react-'));
	const handlers = {};
	const calls = [];
	const api = {
		settings: () => settings,
		dataDir: () => dir,
		config: () => ({ enabled: true, dryRun: false, botQQ: '999', ownerQQ: '10086', ...config }),
		log: { info() {}, warn() {}, error() {}, debug() {} },
		on: (n, f) => { (handlers[n] = handlers[n] || []).push(f); },
		context: () => {}, rule: () => {}, every: () => {}, later: () => {}, route: () => {},
		use: () => null, ask: async () => '', think: async () => '', send: async () => {},
		defineTool: (t) => t, tool: () => {}, command: () => {},
		onebot: async (action, params) => { calls.push({ action, params }); },
		core: { http: {}, hub: {} },
	};
	return { api, handlers, calls };
}

const base = { pokeBack: true, pokeBackChance: 100, react: true, reactChance: 100, reactMaxPerHour: 6, reactInGroup: true, reactInPrivate: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('模块声明', () => {
	assert.equal(mod.id, 'poke-react');
	assert.equal(mod.api, 1);
});

test('被戳会戳回去', async () => {
	const { api, handlers, calls } = fakeApi({ settings: base });
	mod.setup(api);
	for (const fn of handlers.poke || []) fn({ user_id: 12345, group_id: 678 });
	await sleep(2600);
	const poke = calls.find((c) => c.action === 'send_poke');
	assert.ok(poke, '应该调用 send_poke');
	assert.equal(poke.params.user_id, 12345);
	assert.equal(poke.params.group_id, 678);
});

test('概率 0 时不戳回去', async () => {
	const { api, handlers, calls } = fakeApi({ settings: { ...base, pokeBackChance: 0 } });
	mod.setup(api);
	for (const fn of handlers.poke || []) fn({ user_id: 12345 });
	await sleep(300);
	assert.equal(calls.length, 0);
});

test('贴表情会调 set_msg_emoji_like', async () => {
	const { api, handlers, calls } = fakeApi({ settings: base });
	mod.setup(api);
	for (const fn of handlers.message || []) fn({ kind: 'group', chatId: 'group:1', userId: '2', text: '今天好热啊', messageId: 'm1' });
	await sleep(2600);
	const r = calls.find((c) => c.action === 'set_msg_emoji_like');
	assert.ok(r, '应该调用 set_msg_emoji_like');
	assert.equal(r.params.message_id, 'm1');
});

test('太短的消息和 @ 她的消息不贴', async () => {
	const { api, handlers, calls } = fakeApi({ settings: base });
	mod.setup(api);
	for (const fn of handlers.message || []) fn({ kind: 'group', chatId: 'group:1', text: '好', messageId: 'm2' });
	for (const fn of handlers.message || []) fn({ kind: 'group', chatId: 'group:1', text: '今天好热啊', messageId: 'm3', mentioned: true });
	await sleep(2600);
	assert.equal(calls.length, 0);
});

test('试运行只记账不外发', async () => {
	const { api, handlers, calls } = fakeApi({ settings: base, config: { dryRun: true } });
	mod.setup(api);
	for (const fn of handlers.poke || []) fn({ user_id: 1 });
	await sleep(2600);
	assert.equal(calls.length, 0);
});
