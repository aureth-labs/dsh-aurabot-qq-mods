// B站发动态 —— 她自己会发，主人也能让她发。
//
// 只调 B 站自己的接口（纯 HTTP），不开浏览器。
// 登录态用插件「B站」页里已经存好的 Cookie（plugin-config）。

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TICK_MS = 15 * 60_000;
const MIN_GAP_MS = 3 * 3600_000;

/** 模型偶尔把前言、引号、聊天记号带出来，抠成干净的正文。 */
function cleanText(raw) {
	let t = String(raw ?? '').trim();
	t = t.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
	t = t.replace(/^(?:好的|嗯+|发一条|动态正文|正文)[:：]\s*/i, '');
	t = t.replace(/<[^>\n]{1,20}>/g, '');
	t = t.replace(/\|\|\|/g, '\n');
	t = t.replace(/\[[^\]\n]{1,20}\]/g, '');
	t = t.replace(/^["'「『]+|["'」』]+$/g, '').trim();
	return t.split('\n').map((s) => s.trim()).filter((s) => s !== '').join('\n').trim();
}

export default {
	id: 'bili-dynamic',
	name: 'B站发动态',
	version: '1.0.0',
	api: 1,
	description: '她自己会发 B 站动态（文案自己写），也能主人让她发一条；每天有上限，可随时关掉。',

	defaults: {
		enabled: true,
		auto: true,
		maxPerDay: 4,
		awakeFrom: 8,
		awakeTo: 23,
	},
	settings: [
		{ key: 'enabled', label: '能发 B 站动态', type: 'switch' },
		{ key: 'auto', label: '她自己发', type: 'switch', hint: '关掉就只有你让她发才发' },
		{ key: 'maxPerDay', label: '每天最多几条', type: 'number', hint: '0 = 不发' },
		{ key: 'awakeFrom', label: '从几点开始可能发', type: 'number' },
		{ key: 'awakeTo', label: '到几点就不发了', type: 'number' },
	],

	setup(api) {
		const log = api.log;
		const dir = api.dataDir();
		const file = join(dir, 'state.json');
		const setting = () => api.settings();
		let posting = false;
		let lastRealAt = 0;

		function readState() {
			try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
		}
		function writeState(s) {
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
			} catch (e) { log.warn('存状态失败：' + e.message); }
		}
		const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
		const hourNow = () => new Date(Date.now() + 8 * 3600_000).getUTCHours();

		function dayState() {
			const s = readState();
			return s.day && s.day.date === today() ? s.day : { date: today(), count: 0, tries: 0, lastAt: 0 };
		}
		function bump({ tries = 0, counted = 0, text = '', url = '' } = {}) {
			const s = readState();
			const cur = dayState();
			s.day = { date: cur.date, count: cur.count + counted, tries: cur.tries + tries, lastAt: counted > 0 ? Date.now() : cur.lastAt };
			if (counted > 0) {
				const list = Array.isArray(s.history) ? s.history : [];
				list.unshift({ text: String(text).slice(0, 300), url: String(url || ''), at: Date.now() });
				s.history = list.slice(0, 30);
			}
			writeState(s);
		}
		const left = () => {
			const max = Math.max(0, Math.floor(Number(setting().maxPerDay) || 0));
			return Math.max(0, max - dayState().count);
		};

		function auth() {
			const b = api.config().bili || {};
			return { cookie: String(b.cookie || ''), csrf: String(b.biliJct || ''), sessdata: String(b.sessdata || '') };
		}

		async function postDynamic(text) {
			const b = api.config().bili || {};
			const a = auth();
			if (!b.enabled || !a.sessdata) throw new Error('B 站还没登录（面板「B站」页里要有登录态）');
			if (a.csrf === '') throw new Error('B 站登录态里少了 bili_jct（csrf），重新登录一次');
			const content = String(text || '').trim();
			if (content === '') throw new Error('动态内容是空的，没发');
			if ([...content].length > 2000) throw new Error('动态太长了（B 站上限 2000 字）');

			const body = new URLSearchParams({ dynamic_id: '0', type: '4', content, csrf: a.csrf, at_uids: '', ctrl: '[]' }).toString();
			const r = await fetch('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/create', {
				method: 'POST',
				headers: {
					'user-agent': UA,
					referer: 'https://t.bilibili.com/',
					origin: 'https://t.bilibili.com',
					cookie: a.cookie || `SESSDATA=${a.sessdata}; bili_jct=${a.csrf}`,
					'content-type': 'application/x-www-form-urlencoded',
				},
				body,
				signal: AbortSignal.timeout(20_000),
			});
			const j = await r.json().catch(() => ({ code: r.status, message: 'HTTP ' + r.status }));
			if (j.code !== 0) throw new Error(`B 站返回 ${j.code}${j.message ? '：' + j.message : ''}`);
			const id = String(j.data?.dynamic_id_str || j.data?.dynamic_id || '');
			return { id, url: id ? `https://t.bilibili.com/${id}` : '' };
		}

		async function askText() {
			const raw = await api.think(
				'你想在自己的 B 站账号上随手发一条动态，像真人发的那种：碎碎念、今天在干嘛、刚看到的东西的想法。\n' +
				'第一人称、口语，一般 15～80 字。不要话题标签、不要 @ 人、不要链接、不要「大家好」这种开场，' +
				'不要提任何别人的私事，不要说自己是 AI。现在没什么想发的就只输出 [不发]。只输出动态正文。',
				{ title: 'B站动态', timeoutMs: 90_000 }
			);
			return cleanText(raw);
		}

		function remember(text, url) {
			try {
				api.use('memory')?.addEvent?.({ text: `我在 B 站发了一条动态：${text}${url ? `（${url}）` : ''}`, tags: ['发布'] });
			} catch { /* 记不上不影响发 */ }
		}

		async function postNow(text) {
			if (!setting().enabled) throw new Error('B 站动态是关着的');
			const t = String(text || '').trim() || await askText();
			if (t === '' || /\[不发\]/.test(t)) throw new Error('她这次没写出来（可以自己填一段再发）');
			const r = await postDynamic(t);
			bump({ counted: 1, text: t, url: r.url });
			remember(t, r.url);
			return { ok: true, text: t, url: r.url };
		}

		async function tick() {
			if (posting) return;
			const s = setting();
			if (!s.enabled || !s.auto) return;
			const hour = hourNow();
			if (hour < Number(s.awakeFrom ?? 8) || hour >= Number(s.awakeTo ?? 23)) return;
			if (Date.now() - lastRealAt < 20 * 60_000) return;
			const max = Math.max(0, Math.floor(Number(s.maxPerDay) || 0));
			if (max <= 0) return;
			const cur = dayState();
			if (cur.count >= max) return;
			if (cur.lastAt > 0 && Date.now() - cur.lastAt < MIN_GAP_MS) return;
			if (cur.tries >= max + 2) return;
			const ticksLeft = Math.max(1, (Number(s.awakeTo ?? 23) - hour) * 4);
			if (Math.random() >= left() / ticksLeft) return;

			posting = true;
			lastRealAt = Date.now();
			bump({ tries: 1 });
			try {
				const text = await askText();
				if (text === '' || /\[不发\]/.test(text)) { log.info('这次她不想发'); return; }
				const r = await postDynamic(text);
				bump({ counted: 1, text, url: r.url });
				remember(text, r.url);
				log.info(`她自己发了 B 站动态：${text.slice(0, 30)}`);
			} catch (error) {
				log.warn('自动发动态失败：' + error.message);
			} finally {
				posting = false;
			}
		}

		api.every(TICK_MS, tick, 'B站动态巡检');

		api.tool((where) => {
			if (!setting().enabled) return [];
			if (where.chat && where.chat.kind === 'system') return [];
			return api.defineTool({
				name: 'bili_post_dynamic',
				description: '在 B 站发一条动态（纯文字，像随手发的日常或感想）。',
				properties: { text: { type: 'string', description: '动态正文，2000 字以内，口语一点' } },
				required: ['text'],
				execute: async ({ text }) => {
					if (left() <= 0) return { ok: false, message: '今天的 B 站动态已经发够了' };
					try {
						const r = await postNow(text);
						return { ok: true, message: `发好了${r.url ? '：' + r.url : ''}` };
					} catch (error) {
						log.warn('发动态失败：' + error.message);
						return { ok: false, message: error.message };
					}
				},
			});
		});

		api.command({
			name: '发动态',
			aliases: ['发b站动态'],
			desc: '让她现在发一条 B 站动态，内容可以自己指定',
			run: async (arg) => {
				try {
					const r = await postNow(String(arg || '').trim());
					return `发了：${r.text}${r.url ? '\n' + r.url : ''}`;
				} catch (error) {
					return '没发成：' + error.message;
				}
			},
		});

		api.rule(() => (setting().enabled ? '你想随手发条 B 站动态时，用 bili_post_dynamic（纯文字，别写成文案）。' : ''));

		function statusNow() {
			const cur = dayState();
			const s = readState();
			return { ok: true, today: cur.count, max: Number(setting().maxPerDay) || 0, left: left(), lastAt: cur.lastAt, history: (s.history || []).slice(0, 10) };
		}

		api.route('/state', async () => statusNow());
		api.route('/post', async (req) => {
			let body = {};
			try { body = (await api.core.http.body(req)) || {}; } catch { body = {}; }
			try { return await postNow(String(body.text || '')); } catch (error) { return { ok: false, message: error.message }; }
		});

		return { postDynamic, postNow, tick, status: statusNow, recent: () => (readState().history || []).slice(0, 10) };
	},
};
