import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mod, { parseWhen } from '../index.mjs';

const HOUR = 3600_000;
const DAY = 86_400_000;

function fakeApi(settings = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'reminder-'));
	const api = {
		settings: () => settings,
		dataDir: () => dir,
		config: () => ({ ownerQQ: '10086' }),
		log: { info() {}, warn() {}, error() {}, debug() {} },
		on: () => {}, context: () => {}, rule: () => {}, every: () => {}, later: () => {}, route: () => {},
		use: () => null, ask: async () => '', think: async () => '', send: async () => {},
		defineTool: (t) => t, tool: () => {}, command: () => {},
		core: { http: {}, hub: {} },
	};
	return { api, dir };
}

test('模块声明', () => {
	assert.equal(mod.id, 'reminder');
	assert.equal(mod.api, 1);
});

test('认「两小时后」这类中文写法', () => {
	const base = new Date('2026-11-05T02:00:00Z').getTime();
	const t = parseWhen('两小时后', base);
	assert.ok(Math.abs(t - (base + 2 * HOUR)) < 1000);
});

test('认「半小时后」', () => {
	const base = new Date('2026-11-05T02:00:00Z').getTime();
	const t = parseWhen('半小时后', base);
	assert.ok(Math.abs(t - (base + 30 * 60_000)) < 1000);
});

test('认「10分钟后」', () => {
	const base = new Date('2026-11-05T02:00:00Z').getTime();
	const t = parseWhen('10分钟后', base);
	assert.ok(Math.abs(t - (base + 10 * 60_000)) < 1000);
});

test('认「20:30」这种时刻，过了就排到明天', () => {
	const base = new Date('2026-11-05T02:00:00Z').getTime();
	const t = parseWhen('20:30', base);
	assert.ok(t > base);
	assert.ok(t - base <= DAY);
});

test('认「明天早上八点」', () => {
	const base = new Date('2026-11-05T02:00:00Z').getTime();
	const t = parseWhen('明天早上八点', base);
	assert.ok(t > base);
	assert.ok(t - base <= DAY + HOUR);
});

test('认不出来返回 0', () => {
	assert.equal(parseWhen('哪天都行'), 0);
	assert.equal(parseWhen(''), 0);
});

test('记一条提醒会返回时间', async () => {
	const { api } = fakeApi({ enabled: true, maxPerDay: 20 });
	const out = mod.setup(api);
	const at = await out.setRemind({ text: '交作业', when: '两小时后', chatId: 'private:10086' });
	assert.match(at, /^\d{2}-\d{2} \d{2}:\d{2}$/);
	assert.equal(out.list().length, 1);
});

test('关掉就拒绝记', async () => {
	const { api } = fakeApi({ enabled: false });
	const out = mod.setup(api);
	await assert.rejects(() => out.setRemind({ text: 'x', when: '两小时后' }), /关着/);
});
