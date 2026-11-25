// 约定提醒 —— 她说「明天提醒你」，到点真的会来说。
//
// 只做三件事：记一条带时间的提醒、到点发一条消息、给主人一个 /提醒 命令。
// 不联网、不读写账号配置。

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TICK_MS = 60_000;
const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 中文数字 → 数字（0-99 够用）。 */
function cnNum(s) {
	if (/^\d+$/.test(s)) return Number(s);
	if (s === '十') return 10;
	let m;
	if ((m = /^十([一二三四五六七八九])$/.exec(s))) return 10 + CN[m[1]];
	if ((m = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(s))) return CN[m[1]] * 10 + (m[2] ? CN[m[2]] : 0);
	if ([...s].length === 1 && CN[s] !== undefined) return CN[s];
	return NaN;
}

/** 「明天早上八点」「两小时后」「20:30」「10分钟后」→ 时间戳；认不出返回 0。 */
export function parseWhen(raw, base = Date.now()) {
	const s = String(raw || '').trim();
	if (s === '') return 0;
	let m;
	if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) {
		const d = new Date(base + 8 * 3600_000);
		const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(m[1]), Number(m[2])) - 8 * 3600_000);
		return t.getTime() > base ? t.getTime() : t.getTime() + 86_400_000;
	}
	if ((m = /(半|[0-9]+|[一二两三四五六七八九十]+)\s*(?:个)?\s*(分钟|分|小时|钟头|天)(?:之后|以后|后)?/.exec(s))) {
		const n = m[1] === '半' ? 0.5 : cnNum(m[1]);
		if (Number.isFinite(n)) {
			const unit = m[2] === '天' ? 86_400_000 : /小时|钟头/.test(m[2]) ? 3600_000 : 60_000;
			return base + n * unit;
		}
	}
	if (/明天早上|明早/.test(s)) {
		const d = new Date(base + 8 * 3600_000);
		return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 8, 0) - 8 * 3600_000).getTime();
	}
	if (/明天/.test(s)) {
		const d = new Date(base + 8 * 3600_000);
		return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 9, 0) - 8 * 3600_000).getTime();
	}
	const hh = /(\d{1,2}|[一二两三四五六七八九十]+)\s*点/.exec(s);
	if (hh) {
		let h = cnNum(hh[1]);
		if (Number.isFinite(h)) {
			if (/晚上|下午|傍晚/.test(s) && h < 12) h += 12;
			const d = new Date(base + 8 * 3600_000);
			const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 0) - 8 * 3600_000);
			return t.getTime() > base ? t.getTime() : t.getTime() + 86_400_000;
		}
	}
	return 0;
}

const fmtTime = (ms) => {
	const d = new Date(Number(ms));
	const p = (n) => String(n).padStart(2, '0');
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 命令里「什么时候」和「提醒什么」怎么切。 */
const CMD_RE = /^(明天[^ ]*|明早[^ ]*|今[晚晚上]*[^ ]*|\d{1,2}:\d{2}|(?:半|\d+|[一二两三四五六七八九十]+)\s*(?:个)?\s*(?:分钟|分|小时|钟头|天)(?:后|以后|之后)?)\s+([\s\S]+)$/;

export default {
	id: 'reminder',
	name: '约定提醒',
	version: '1.0.0',
	api: 1,
	description: '她说「明天提醒你」的时候真的会到点说；主人也能发 /提醒 明天早上八点 交作业。',

	defaults: {
		enabled: true,
		maxPerDay: 20,
	},
	settings: [
		{ key: 'enabled', label: '能记约定、到点提醒', type: 'switch' },
		{ key: 'maxPerDay', label: '每天最多记几条', type: 'number' },
	],

	setup(api) {
		const log = api.log;
		const dir = api.dataDir();
		const file = join(dir, 'state.json');
		const setting = () => api.settings();

		function read() {
			try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
		}
		function write(s) {
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
			} catch (e) {
				log.warn('存提醒失败：' + e.message);
			}
		}
		const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

		async function setRemind({ text, when, chatId }) {
			if (!setting().enabled) throw new Error('记约定是关着的');
			const max = Math.max(1, Math.floor(Number(setting().maxPerDay) || 20));
			const s = read();
			const list = Array.isArray(s.reminds) ? s.reminds : [];
			const dayCount = s.day && s.day.date === today() ? s.day.count : 0;
			if (dayCount >= max) throw new Error(`今天记的约定已经到 ${max} 条了`);
			const at = parseWhen(when);
			if (!at) throw new Error(`没听懂「${when}」是什么时候，可以说「明天早上八点」「20:30」「两小时后」`);
			list.push({ at, text: String(text || '提醒一下').slice(0, 200), chatId: String(chatId || ''), createdAt: Date.now() });
			s.reminds = list.slice(-100);
			s.day = { date: today(), count: dayCount + 1 };
			write(s);
			return fmtTime(at);
		}

		// 给她的工具
		api.tool((where) => {
			if (!setting().enabled) return [];
			if (where.chat && where.chat.kind === 'system') return [];
			return api.defineTool({
				name: 'remind_set',
				description: '答应别人要提醒他某件事时用这个记下来，到点会主动说。比如「明天提醒你交作业」。',
				properties: {
					text: { type: 'string', description: '到点要说的内容，一句话' },
					when: { type: 'string', description: '什么时候，比如「明天早上八点」「20:30」「两小时后」' },
				},
				required: ['text', 'when'],
				execute: async ({ text, when }) => {
					try {
						const at = await setRemind({ text, when, chatId: where.chat?.chatId || '' });
						return { ok: true, message: `记下了，${at} 说。` };
					} catch (error) {
						return { ok: false, message: error.message };
					}
				},
			});
		});

		// 主人命令
		api.command({
			name: '提醒',
			desc: '让她记一件事，到点提醒你。用法：/提醒 明天早上八点 交作业',
			run: async (arg) => {
				const s = String(arg || '').trim();
				if (s === '') return '用法：/提醒 明天早上八点 交作业';
				const m = CMD_RE.exec(s);
				if (!m) return '没看懂。用法：/提醒 明天早上八点 交作业';
				try {
					const at = await setRemind({ text: m[2], when: m[1], chatId: '' });
					return `记下了，${at} 提醒你。`;
				} catch (error) { return error.message; }
			},
		});

		// 每分钟看一次到点没有
		api.every(TICK_MS, () => {
			const s = read();
			const list = Array.isArray(s.reminds) ? s.reminds : [];
			if (list.length === 0) return;
			const due = list.filter((r) => Number(r.at) <= Date.now());
			if (due.length === 0) return;
			s.reminds = list.filter((r) => Number(r.at) > Date.now());
			write(s);
			for (const r of due.slice(0, 5)) {
				const chatId = r.chatId || (api.config().ownerQQ ? `private:${api.config().ownerQQ}` : '');
				if (!chatId) continue;
				Promise.resolve()
					.then(() => api.send(chatId, `想起来要跟你说：${r.text}`))
					.catch((e) => log.warn('提醒没发出去：' + e.message));
			}
		}, '约定提醒');

		return { setRemind, parseWhen, list: () => read().reminds || [] };
	},
};
