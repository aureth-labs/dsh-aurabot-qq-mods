import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mod from '../index.mjs';

const PLAN = JSON.stringify([
	{ range: '00:00-07:00', activity: '睡着', availability: 'sleeping' },
	{ range: '07:00-12:00', activity: '在忙', availability: 'busy' },
	{ range: '12:00-24:00', activity: '闲着', availability: 'idle' },
]);

function fakeApi({ ask = async () => PLAN, settings = { enabled: true } } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'schedule-'));
	const hooks = {};
	const api = {
		settings: () => settings,
		dataDir: () => dir,
		config: () => ({ persona: { current: 'x' } }),
		log: { info() {}, warn() {}, error() {}, debug() {} },
		on: () => {}, context: (fn) => { hooks.context = fn; }, rule: () => {},
		every: () => {}, later: () => {}, route: () => {},
		use: () => null, ask, think: async () => '', send: async () => {},
		defineTool: (t) => t, tool: () => {}, command: () => {},
		core: {
			http: {}, hub: {},
			personas: { current: () => '你是一头鲸鱼', list: () => [{ id: 'x', name: '肥鱼鱼' }] },
		},
	};
	return { api, hooks, dir };
}

test('模块声明', () => {
	assert.equal(mod.id, 'schedule');
	assert.equal(mod.api, 1);
});

test('排出来的一天是 24 小时连续的', async () => {
	const { api } = fakeApi();
	const out = mod.setup(api);
	await out.ensurePlan();
	const plan = out.plan();
	assert.ok(Array.isArray(plan));
	assert.equal(plan[0].range.split('-')[0], '00:00');
	assert.equal(plan[plan.length - 1].range.split('-')[1], '24:00');
});

test('当前时段能从表里查出来', async () => {
	const { api } = fakeApi();
	const out = mod.setup(api);
	await out.ensurePlan();
	const slot = out.slot();
	assert.ok(slot && slot.range);
	assert.ok(['sleeping', 'busy', 'idle'].includes(out.availability()));
});

test('模型返回坏 JSON 时用保底日程', async () => {
	const { api } = fakeApi({ ask: async () => '不是 JSON' });
	const out = mod.setup(api);
	await out.ensurePlan();
	assert.ok(out.plan().length >= 3);
});

test('上下文里会告诉她现在在干嘛', async () => {
	const { api, hooks } = fakeApi();
	const out = mod.setup(api);
	await out.ensurePlan();
	const line = hooks.context();
	assert.match(line, /\[你现在\] \d{2}:\d{2}，你正在/);
});

test('关掉后不再插话', async () => {
	const { api, hooks } = fakeApi({ settings: { enabled: false } });
	mod.setup(api);
	assert.equal(hooks.context(), '');
});
