import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mod from '../index.mjs';

function fakeApi(settings = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'anti-ai-'));
	const handlers = {};
	const api = {
		settings: () => settings,
		dataDir: () => dir,
		config: () => ({}),
		log: { info() {}, warn() {}, error() {}, debug() {} },
		on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
		context: () => {}, rule: () => {}, every: () => {}, later: () => {}, route: () => {},
		use: () => null, ask: async () => '', think: async () => '', send: async () => {},
		defineTool: (t) => t, tool: () => {}, command: () => {},
		core: { http: {}, hub: {} },
	};
	return { api, handlers };
}

function runReply(handlers, text) {
	let out = text;
	for (const fn of handlers.reply || []) {
		const r = fn(out);
		if (r === null) return null;
		if (r !== undefined) out = r;
	}
	return out;
}

const boot = (settings) => {
	const { api, handlers } = fakeApi(settings);
	mod.setup(api);
	return handlers;
};

test('模块声明', () => {
	assert.equal(mod.id, 'anti-ai');
	assert.equal(mod.api, 1);
});

test('客服腔被清掉', () => {
	const h = boot({ polishEnabled: true, silenceEnabled: true });
	assert.equal(runReply(h, '作为一个AI，我觉得这个很好看。'), '我觉得这个很好看。');
	assert.equal(runReply(h, '这件衣服挺好看的！总而言之就是舒服'), '这件衣服挺好看的！就是舒服');
});

test('正常的话不动', () => {
	const h = boot({ polishEnabled: true, silenceEnabled: true });
	assert.equal(runReply(h, '这首真的绝，循环一整天了'), '这首真的绝，循环一整天了');
});

test('整句都是客套话就不发', () => {
	const h = boot({ polishEnabled: true, silenceEnabled: true });
	assert.equal(runReply(h, '希望以上内容对你有帮助！如果还有其他问题，欢迎随时问我。'), null);
});

test('认各种「不说话」写法', () => {
	const h = boot({ polishEnabled: true, silenceEnabled: true });
	for (const s of ['[silence]', 'silence', '（不回）', '[沉默]', 'skip']) {
		assert.equal(runReply(h, s), null, `${s} 应该判成不说话`);
	}
});

test('记号旁边有表情时保留表情', () => {
	const h = boot({ polishEnabled: true, silenceEnabled: true });
	const out = runReply(h, '[silence] <sticker:猫>');
	assert.ok(String(out).includes('<sticker:猫>'));
	assert.ok(!String(out).includes('silence'));
});

test('关掉开关就不处理', () => {
	const h = boot({ polishEnabled: false, silenceEnabled: false });
	assert.equal(runReply(h, '[silence]'), '[silence]');
	assert.equal(runReply(h, '作为一个AI，我觉得不错'), '作为一个AI，我觉得不错');
});
