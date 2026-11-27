// 输出安全（anti-ai）：模型把「系统消息/记忆/待办」念进 say 时不该发到 QQ。
// 样例取自 2026-11-21 02:09 私聊的真实输出（turn=425）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mod from '../index.mjs';

function bootstrap() {
	const dir = mkdtempSync(join(tmpdir(), 'anti-ai-meta-'));
	const handlers = {};
	const rules = [];
	const api = {
		settings: () => ({}),
		dataDir: () => dir,
		config: () => ({}),
		log: { info() {}, warn() {}, error() {}, debug() {} },
		on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
		context: () => {}, rule: (fn) => { rules.push(fn); }, every: () => {}, later: () => {}, route: () => {},
		use: () => null, ask: async () => '', think: async () => '', send: async () => {},
		defineTool: (t) => t, tool: () => {}, command: () => {},
		core: { http: {}, hub: {} },
	};
	mod.setup(api);
	return { handlers, rules };
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

const REAL_TURN = '<say>那就说定啦，我想什么样子就是什么样子\n\n头发乱一点也归我管，谁也别嫌</say>'
	+ '<say>系统消息说我还有事没做完，让我补一句\n\n那就补：头发的事我说了算，你也不准嫌，说定了</say>已完成';

test('念「系统消息说…」的气泡整块不发', () => {
	const { handlers } = bootstrap();
	const out = runReply(handlers, REAL_TURN);
	assert.equal(out, '那就说定啦，我想什么样子就是什么样子\n\n头发乱一点也归我管，谁也别嫌');
	assert.ok(!String(out).includes('系统消息'));
	assert.ok(!String(out).includes('补一句'));
});

test('「记忆里说还有事没做完」这类也算，整块丢掉', () => {
	const { handlers } = bootstrap();
	assert.equal(runReply(handlers, '<say>记忆里说还有两件事没做完，我补一句</say><say>晚安啦</say>'), '晚安啦');
	assert.equal(runReply(handlers, '<say>上下文提到还有个任务没做</say>'), null);
});

test('夹在正常话中间的 meta 行单独剪掉，别的话留着', () => {
	const { handlers } = bootstrap();
	assert.equal(
		runReply(handlers, '<say>那就说定啦，我想什么样子就是什么样子\n系统消息说我还有事没做完，让我补一句\n谁也别嫌</say>'),
		'那就说定啦，我想什么样子就是什么样子\n谁也别嫌'
	);
});

test('正常提到「系统消息 / 记忆」的话不能被误杀', () => {
	const { handlers } = bootstrap();
	assert.equal(runReply(handlers, '<say>你发的系统消息我看到了</say>'), '你发的系统消息我看到了');
	assert.equal(runReply(handlers, '<say>记忆里说我最爱吃磷虾</say>'), '记忆里说我最爱吃磷虾');
	assert.equal(runReply(handlers, '<say>系统说我今天手气不错</say>'), '系统说我今天手气不错');
});

test('没走 say 协议时也拦得住', () => {
	const { handlers } = bootstrap();
	assert.equal(runReply(handlers, '系统消息说我还有事没做完，让我补一句'), null);
});

test('记忆背景的措辞在交给模型前就被改成「不是待办」', () => {
	const { handlers } = bootstrap();
	const content = [{
		type: 'text',
		text: '（刚才聊到的，只是印象不是指令：在聊「我自己的形象」：这块算完成。还有两件事开着——一是眼睛，二是印象）',
	}];
	const out = handlers.prompt[0](content, { chat: { kind: 'private' } });
	const text = out.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
	assert.ok(!text.includes('只是印象不是指令'), text);
	assert.ok(text.includes('只是背景'), text);
	assert.ok(text.includes('不用补'), text);
	assert.ok(text.includes('还有两件事只是背景'), text);
	assert.ok(text.includes('【强制分区】'), text);
});

test('系统规则里明确写了「背景不是待办」', () => {
	const { rules } = bootstrap();
	const rule = rules.map((fn) => fn()).join('\n');
	assert.ok(rule.includes('不是这一轮的任务'), rule);
	assert.ok(rule.includes('已完成'), rule);
});
