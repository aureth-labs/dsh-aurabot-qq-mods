// 她的一天 —— 每天给她排一张 24 小时的时间表，聊天时她知道自己在干嘛。
//
// 只做两件事：调一次模型排表；每轮聊天前往提示词里加一句「你现在在做什么」。
// 不联网抓取、不碰账号配置，数据只存在模块自己的目录里。

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TICK_MS = 30 * 60_000;
const AVAIL = new Set(['sleeping', 'busy', 'idle']);

const nowParts = () => {
	const d = new Date(Date.now() + 8 * 3600_000);
	return {
		date: d.toISOString().slice(0, 10),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		min: d.getUTCHours() * 60 + d.getUTCMinutes(),
	};
};

const toMin = (hhmm) => {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
	return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

const stripFence = (s) => String(s || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();

/** 从模型输出里抠 JSON；被截断时把完整的对象一个个捞出来。 */
function takeJson(raw) {
	const t = stripFence(raw);
	const i = t.search(/[[{]/);
	if (i < 0) return null;
	for (let j = t.length; j > i; j--) {
		try { return JSON.parse(t.slice(i, j)); } catch { /* 继续缩 */ }
	}
	const objs = [];
	const re = /\{[^{}]*\}/g;
	let m;
	while ((m = re.exec(t)) !== null) {
		try { objs.push(JSON.parse(m[0])); } catch { /* 跳过残缺的 */ }
	}
	return objs.length > 0 ? objs : null;
}

export default {
	id: 'schedule',
	name: '她的一天',
	version: '1.0.0',
	api: 1,
	description: '每天给她排一张时间表（几点在干嘛、忙不忙），聊天时她知道自己在做什么。',

	defaults: {
		enabled: true,
	},
	settings: [
		{ key: 'enabled', label: '每天给她排日程', type: 'switch', hint: '关掉她就不知道自己这会儿在干嘛' },
	],

	setup(api) {
		const log = api.log;
		const dir = api.dataDir();
		const file = join(dir, 'state.json');

		function readState() {
			try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
		}
		function writeState(s) {
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
			} catch (e) {
				log.warn('存日程失败：' + e.message);
			}
		}

		function currentSlot(plan) {
			const { min } = nowParts();
			if (!Array.isArray(plan) || plan.length === 0) return null;
			let best = null;
			for (const s of plan) {
				const [a, b] = String(s.range || '').split('-').map(toMin);
				if (a < 0 || b < 0) continue;
				if (min >= a && min < b) return s;
				if (a <= min) best = s; // 落在空档里就当上一段还在继续
			}
			return best;
		}

		const FALLBACK = [
			{ range: '00:00-08:00', activity: '睡着', availability: 'sleeping' },
			{ range: '08:00-12:00', activity: '在忙自己的事', availability: 'busy' },
			{ range: '12:00-14:00', activity: '吃饭、歇一会儿', availability: 'idle' },
			{ range: '14:00-18:00', activity: '继续忙', availability: 'busy' },
			{ range: '18:00-24:00', activity: '闲着，随便看看', availability: 'idle' },
		];

		async function makePlan(date) {
			let brief = '';
			let who = '她';
			try {
				const cur = api.core.personas.current();
				brief = String(typeof cur === 'string' ? cur : (cur?.text || '')).slice(0, 1600);
				const list = api.core.personas.list?.() || [];
				const id = api.config()?.persona?.current || '';
				const hit = Array.isArray(list) ? list.find((x) => (x?.id ?? x) === id) : null;
				if (hit && typeof hit === 'object') who = String(hit.name || hit.title || who);
			} catch { /* 拿不到设定就空着 */ }

			const raw = await api.ask({
				system: '你只输出 JSON，不要解释。',
				text:
					`角色「${who}」的设定：\n${brief}\n\n` +
					`请按这个角色的身份和生活方式，给她排 ${date} 这一天的时间表。要求：\n` +
					'1. 从 00:00 排到 24:00，首尾相接，不许留空档；\n' +
					'2. 每段 activity 用中文写她在干嘛（6～14 字，具体一点）；\n' +
					'3. 要和她的设定对得上——她是什么身份就过什么日子，别写成普通上班族；\n' +
					'4. availability 只能是 "sleeping"（睡着）、"busy"（在忙、不方便多聊）、"idle"（闲着）；\n' +
					'5. 一共 6～10 段，像真人一天那样有起伏。\n' +
					'只输出 JSON 数组，例如 [{"range":"00:00-07:30","activity":"睡着","availability":"sleeping"}]',
				maxTokens: 1600,
			});
			const arr = takeJson(raw);
			if (!Array.isArray(arr) || arr.length === 0) return null;
			const plan = arr
				.map((s) => ({
					range: String(s?.range || '').trim(),
					activity: String(s?.activity || '').trim().slice(0, 24),
					availability: AVAIL.has(String(s?.availability)) ? String(s.availability) : 'idle',
				}))
				.filter((s) => toMin(String(s.range).split('-')[0] || '') >= 0 && toMin(String(s.range).split('-')[1] || '') > 0);
			return plan.length > 0 ? plan.sort((a, b) => toMin(a.range.split('-')[0]) - toMin(b.range.split('-')[0])) : null;
		}

		async function ensurePlan() {
			if (!api.settings().enabled) return;
			const { date } = nowParts();
			const s = readState();
			if (s.plan && s.planDate === date && Array.isArray(s.plan) && s.plan.length > 0) return;
			let plan = null;
			try { plan = await makePlan(date); } catch (e) { log.warn('排日程失败：' + e.message); }
			if (!plan || plan.length === 0) plan = FALLBACK;
			const st = readState();
			st.plan = plan;
			st.planDate = date;
			writeState(st);
			log.info(`排好了 ${date} 的日程（${plan.length} 段）`);
		}

		// 每轮聊天前塞一句「你现在在干嘛」
		api.context(() => {
			if (!api.settings().enabled) return '';
			const slot = currentSlot(readState().plan);
			if (!slot) return '';
			const { hour, minute } = nowParts();
			const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
			const hint = slot.availability === 'sleeping' ? '在睡，回得又慢又短'
				: slot.availability === 'busy' ? '在忙，回得短、别长篇大论'
					: '闲着，可以多聊两句';
			return `[你现在] ${clock}，你正在${slot.activity}（${hint}）。别人问你在干嘛就照这个说，不用刻意提。`;
		});

		api.every(TICK_MS, () => ensurePlan().catch((e) => log.warn('日程巡检失败：' + e.message)), '排日程');
		api.later(15_000, () => { ensurePlan().catch(() => {}); });

		return {
			plan: () => readState().plan || null,
			slot: () => currentSlot(readState().plan),
			availability: () => {
				const slot = currentSlot(readState().plan);
				return slot ? String(slot.availability || '') : '';
			},
			ensurePlan,
		};
	},
};
