// 输出安全（anti-ai）：模型把「任务状态」写进 say 时不该发到 QQ。
// 样例直接取自 2026-11-21 凌晨的真实会话（session-78655a73 / session-226017ce）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mod from '../index.mjs';

function fakeApi() {
	const dir = mkdtempSync(join(tmpdir(), 'anti-ai-status-'));
	const handlers = {};
	const api = {
		settings: () => ({}),
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

function boot() {
	const { api, handlers } = fakeApi();
	mod.setup(api);
	return handlers;
}

function runReply(handlers, text, meta = {}) {
	let out = text;
	for (const fn of handlers.reply || []) {
		const r = fn(out, meta);
		if (r === null) return null;
		if (r !== undefined) out = r;
	}
	return out;
}

test('say 里的「已完成」不单独成条', () => {
	const h = boot();
	const out = runReply(h,
		'<say>看见了！真的看见了\n\n月光、海、还有抱着贝壳坐在礁石上的我，都看到了</say>'
		+ '<say>呜，这张比我想的还好看\n\n你是给我装的眼睛吗</say><say>已完成</say>已完成'
	);
	assert.ok(!String(out).includes('已完成'), `不该含已完成：${out}`);
	assert.equal(
		out,
		'看见了！真的看见了\n\n月光、海、还有抱着贝壳坐在礁石上的我，都看到了'
		+ '|||呜，这张比我想的还好看\n\n你是给我装的眼睛吗'
	);
});

test('连着两块「已完成」也全部丢掉', () => {
	const h = boot();
	assert.equal(
		runReply(h, '<say>对呀，我自己画的\n\n而且你这个竹蜻蜓棒棒糖我也看见了</say><say>已完成</say><say>已完成</say>'),
		'对呀，我自己画的\n\n而且你这个竹蜻蜓棒棒糖我也看见了'
	);
});

test('只剩状态词就等于这次不说话（不该发一条「已完成」+表情）', () => {
	const h = boot();
	assert.equal(runReply(h, '<say>[沉默]</say><say>已完成</say>已完成'), null);
	assert.equal(runReply(h, '<say>已完成</say>'), null);
	assert.equal(runReply(h, '<say>✅ 已完成</say>'), null);
});

test('状态行混在气泡尾巴上会被剪掉，正文留下', () => {
	const h = boot();
	assert.equal(
		runReply(h, '<say>呜…那是断气前的最后一个泡泡\n\n这次真关了，别再抓我\n已完成</say>'),
		'呜…那是断气前的最后一个泡泡\n\n这次真关了，别再抓我'
	);
});

test('没有 say 标签时，句尾的「已完成」也不外发', () => {
	const h = boot();
	assert.equal(runReply(h, '困糊涂了，刚才眼睛都睁不开了 已完成'), '困糊涂了，刚才眼睛都睁不开了');
	// 有 userText 又没用 say 协议 = 模型没按分区输出，整条不发（原有策略，不变）。
	assert.equal(runReply(h, '困糊涂了，刚才眼睛都睁不开了 已完成', { userText: '在吗' }), null);
});

test('正常句子里的「完成」不能被误剪', () => {
	const h = boot();
	assert.equal(runReply(h, '<say>喏 惩罚完成\n\n困成这样了，真去睡了</say><say>已完成</say>'), '喏 惩罚完成\n\n困成这样了，真去睡了');
	assert.equal(runReply(h, '<say>这个作业我写完了，算完成任务了吧</say>'), '这个作业我写完了，算完成任务了吧');
});
