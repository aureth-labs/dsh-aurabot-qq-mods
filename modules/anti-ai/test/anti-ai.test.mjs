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

const boot = (settings = { polishEnabled: true, draftEnabled: true, silenceEnabled: true }) => {
	const { api, handlers } = fakeApi(settings);
	mod.setup(api);
	return handlers;
};

test('模块声明', () => {
	assert.equal(mod.id, 'anti-ai');
	assert.equal(mod.api, 1);
});

test('客服腔被清掉', () => {
	const h = boot();
	assert.equal(runReply(h, '作为一个AI，我觉得这个很好看。'), '我觉得这个很好看。');
	assert.equal(runReply(h, '这件衣服挺好看的！总而言之就是舒服'), '这件衣服挺好看的！就是舒服');
});

test('正常的话不动', () => {
	const h = boot();
	assert.equal(runReply(h, '这首真的绝，循环一整天了'), '这首真的绝，循环一整天了');
	assert.equal(runReply(h, '你在那儿一直问我，我就说出来了嘛 现在脸上还有点热'), '你在那儿一直问我，我就说出来了嘛 现在脸上还有点热');
	assert.equal(runReply(h, '嗯…你们俩说话我都一半听不懂 反正我不掺和，我继续找零食'), '嗯…你们俩说话我都一半听不懂 反正我不掺和，我继续找零食');
});

test('思考草稿被切掉，只留要说的话', () => {
	const h = boot();
	assert.equal(
		runReply(h, 'Vega问怎么看视频少了。可以轻松说句最近就看看猫和烟花之类的。视频看得少…最近都在看猫打呼噜和烟花'),
		'视频看得少…最近都在看猫打呼噜和烟花'
	);
	assert.equal(
		runReply(h, 'Vega问"怎么又这样了"，大概是说我太安静。可以轻轻应，别装可怜。 我没说什么呀…刚在数泡泡，数着数着就闭嘴了'),
		'我没说什么呀…刚在数泡泡，数着数着就闭嘴了'
	);
	assert.equal(
		runReply(h, '阿牛还补一句"何止豆姐"，有点被围攻的感觉。可以稍微不服气但软。 你们俩合起来欺负我一条鱼'),
		'你们俩合起来欺负我一条鱼'
	);
	assert.equal(
		runReply(h, '哦鲸鲸发语音了，没听清。可以问一句。你说啥，听不清'),
		'你说啥，听不清'
	);
});

test('整段都是草稿就不发', () => {
	const h = boot();
	assert.equal(runReply(h, '哦鲸鲸在损阿牛，我不掺和站队。可以轻轻一句不站队。或沉默。按经验别站队。沉默。[沉默]'), null);
});

test('「可以说：」只取冒号后面', () => {
	const h = boot();
	assert.equal(runReply(h, '他在问我干嘛，可以说：在漂着呀'), '在漂着呀');
});

test('整句都是客套话就不发', () => {
	const h = boot();
	assert.equal(runReply(h, '希望以上内容对你有帮助！如果还有其他问题，欢迎随时问我。'), null);
});

test('认各种「不说话」写法', () => {
	const h = boot();
	for (const s of ['[silence]', 'silence', '（不回）', '[沉默]', 'skip']) {
		assert.equal(runReply(h, s), null, `${s} 应该判成不说话`);
	}
});

test('记号旁边有表情时保留表情', () => {
	const h = boot();
	const out = runReply(h, '[silence] <sticker:猫>');
	assert.ok(String(out).includes('<sticker:猫>'));
	assert.ok(!String(out).includes('silence'));
});

test('输出安全出口始终开启', () => {
	const h = boot({ polishEnabled: false, draftEnabled: false, silenceEnabled: false });
	assert.equal(runReply(h, '[silence]'), null);
	assert.equal(runReply(h, '作为一个AI，我觉得不错'), '我觉得不错');
	assert.equal(runReply(h, '他问我在干嘛。可以说：在漂着'), '在漂着');
});
