// B站回动态评论 —— 回她自己动态下面的评论。
//
// 走 B 站接口（不点页面、不开浏览器）：
//   读评论 GET  /x/v2/reply?type=17&oid=<动态id>
//   回评论 POST /x/v2/reply/add  (root/parent = 那条评论的 rpid)
// 动态 id 来源：装了 bili-dynamic 就用它记下的；没装就用设置里手填的链接。

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TICK_MS = 10 * 60_000;

export default {
	id: 'bili-reply',
	name: 'B站回动态评论',
	version: '1.0.0',
	api: 1,
	description: '回她自己 B 站动态下面的评论：读评论、写一句、发出去。默认只读不回。',

	defaults: {
		enabled: true,
		dryRun: true,
		maxPerRun: 2,
		maxPerDay: 8,
		dynamicsPerRun: 3,
		minGapMinutes: 20,
		dynamicIds: '',
	},
	settings: [
		{ key: 'enabled', label: '开启', type: 'switch' },
		{ key: 'dryRun', label: '只读不回（试运行）', type: 'switch' },
		{ key: 'maxPerRun', label: '每轮回几条', type: 'number' },
		{ key: 'maxPerDay', label: '每天最多回几条', type: 'number' },
		{ key: 'dynamicsPerRun', label: '每轮看几条动态', type: 'number' },
		{ key: 'minGapMinutes', label: '两轮之间隔几分钟', type: 'number' },
		{ key: 'dynamicIds', label: '手填动态链接', type: 'textarea', hint: '一行一个；装了 bili-dynamic 可以留空' },
	],

	setup(api) {
		const log = api.log;
		const dir = api.dataDir();
		const file = join(dir, 'state.json');
		const setting = () => api.settings();
		let busy = false;

		function read() {
			try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
		}
		function write(s) {
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
			} catch (e) { log.warn('存状态失败：' + e.message); }
		}
		const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

		function auth() {
			const b = api.config().bili || {};
			return { cookie: String(b.cookie || ''), csrf: String(b.biliJct || ''), sessdata: String(b.sessdata || '') };
		}

		async function req(url, { method = 'GET', form } = {}) {
			const a = auth();
			const headers = {
				'user-agent': UA,
				referer: 'https://t.bilibili.com/',
				origin: 'https://t.bilibili.com',
				cookie: a.cookie || (a.sessdata ? `SESSDATA=${a.sessdata}; bili_jct=${a.csrf}` : ''),
			};
			let body;
			if (form) {
				headers['content-type'] = 'application/x-www-form-urlencoded';
				body = new URLSearchParams(form).toString();
			}
			const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20_000) });
			return r.json().catch(() => ({ code: r.status, message: 'HTTP ' + r.status }));
		}

		async function myMid() {
			const a = auth();
			if (!a.cookie && !a.sessdata) throw new Error('B 站没登录（面板「B站」页要有登录态）');
			const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
				headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: a.cookie },
				signal: AbortSignal.timeout(15_000),
			});
			const j = await r.json().catch(() => ({}));
			if (!j?.data?.isLogin) throw new Error('B 站没登录（面板「B站」页要有登录态）');
			return String(j.data.mid || '');
		}

		/** 动态 id：优先用 bili-dynamic 记下的，其次设置里手填的。 */
		function dynamicIds(limit) {
			const want = Math.max(1, Math.min(10, Number(limit) || 3));
			const out = [];
			try {
				const mod = api.use('bili-dynamic');
				const recent = mod?.recent?.() || [];
				for (const it of recent) {
					const id = (String(it.url || '').match(/(\d{8,})/) || [])[1];
					if (id && !out.includes(id)) out.push(id);
					if (out.length >= want) break;
				}
			} catch { /* 没有就算了 */ }
			if (out.length < want) {
				const manual = String(setting().dynamicIds || '')
					.split(/[\s,，;；]+/)
					.map((x) => (x.match(/(\d{8,})/) || [])[1])
					.filter(Boolean);
				for (const id of manual) {
					if (!out.includes(id)) out.push(id);
					if (out.length >= want) break;
				}
			}
			return out;
		}

		async function readComments(dynId) {
			const j = await req(`https://api.bilibili.com/x/v2/reply?type=17&oid=${encodeURIComponent(dynId)}&sort=2&ps=20&pn=1`);
			if (j.code === -404) return [];
			if (j.code !== 0) throw new Error(`B 站返回 ${j.code}：${j.message || ''}`);
			return (j.data?.replies || []).map((x) => ({
				rpid: String(x.rpid || ''),
				mid: String(x.member?.mid || ''),
				name: String(x.member?.uname || '').slice(0, 30),
				text: String(x.content?.message || '').slice(0, 200),
			})).filter((x) => x.rpid && x.text);
		}

		async function sendReply(dynId, comment, text) {
			const a = auth();
			if (!a.csrf) throw new Error('B 站登录态里少了 bili_jct（csrf）');
			const j = await req('https://api.bilibili.com/x/v2/reply/add', {
				method: 'POST',
				form: { oid: dynId, type: '17', message: text, root: comment.rpid, parent: comment.rpid, csrf: a.csrf, plat: '1' },
			});
			if (j.code !== 0) throw new Error(`B 站返回 ${j.code}：${j.message || ''}`);
			return String(j.data?.rpid_str || j.data?.rpid || '');
		}

		/** 让她写一句回复；后台会话偶尔会卡住，清掉重试一次，再不行直接问模型。 */
		async function say(prompt) {
			const opts = { title: 'B站回动态', timeoutMs: 90_000 };
			try { return await api.think(prompt, opts); } catch (e1) { log.warn('想回复内容失败，清会话重试：' + e1.message); }
			try { api.core.hub.resetChat?.('system:ext-bili-reply'); } catch { /* 清不掉就算了 */ }
			await new Promise((r) => setTimeout(r, 1500));
			try { return await api.think(prompt, opts); } catch (e2) { log.warn('清会话后还是不行，改成直接问模型：' + e2.message); }
			try { return await api.ask({ system: '说话软软的、短、口语，不客套。只输出要说的那句话。', text: prompt, maxTokens: 200 }); } catch { return ''; }
		}

		async function run({ dry = false, force = false } = {}) {
			const s = setting();
			if (busy) return { ok: false, message: '上一轮还没跑完' };
			if (!s.enabled && !force) return { ok: false, message: 'B站回动态是关着的' };
			const st0 = read();
			const day = st0.day && st0.day.date === today() ? st0.day : { date: today(), count: 0 };
			const maxDay = Math.max(0, Math.floor(Number(s.maxPerDay) || 0));
			if (!dry && day.count >= maxDay) return { ok: false, message: '今天回够了' };
			if (!dry && !force && st0.lastRunAt && Date.now() - st0.lastRunAt < Math.max(1, Number(s.minGapMinutes) || 20) * 60_000) {
				return { ok: false, message: `刚跑过，再等一会儿（${s.minGapMinutes} 分钟一轮）` };
			}

			busy = true;
			try {
				const mid = await myMid();
				const ids = dynamicIds(s.dynamicsPerRun);
				if (ids.length === 0) return { ok: true, message: '还没记到她的 B 站动态（装个「B站发动态」，或在设置里手填动态链接）' };

				const replied = Array.isArray(st0.replied) ? st0.replied : [];
				const found = [];
				const seen = [];
				for (const id of ids) {
					let rows = [];
					try { rows = await readComments(id); } catch (e) { seen.push({ id, error: e.message }); continue; }
					seen.push({ id, rows: rows.length });
					for (const r of rows) {
						if (r.mid === mid) continue;
						if (replied.includes(r.rpid)) continue;
						found.push({ ...r, dynId: id });
					}
				}
				if (found.length === 0) {
					write({ ...read(), lastRunAt: Date.now() });
					return dry
						? { ok: true, message: `看了 ${ids.length} 条动态，没有没回过的评论`, seen }
						: { ok: true, message: '没有新评论' };
				}
				if (dry) {
					return { ok: true, message: `找到 ${found.length} 条没回过的评论（试运行，没回）`, list: found.slice(0, 10).map((x) => `${x.name}：${x.text}`) };
				}

				const maxRun = Math.max(1, Math.min(5, Number(s.maxPerRun) || 2));
				let done = 0;
				const did = [];
				const failed = [];
				for (const c of found.slice(0, maxRun)) {
					let text = String(await say(
						`有人在你自己的 B 站动态下面评论了：\n「${c.text}」\n（${c.name}）\n\n` +
						'写一句回复，像真人那样：一两句、口语、30 字以内，不要客套的「感谢支持」，不要说自己是 AI。只输出回复正文。'
					) || '').trim();
					text = text.replace(/^["'「『]+|["'」』]+$/g, '').replace(/\|\|\|/g, ' ').replace(/<[^>\n]{1,20}>/g, '').trim().slice(0, 60);
					if (text === '') { failed.push(`${c.name}：没想出回复内容`); continue; }
					try {
						await sendReply(c.dynId, c, text);
						done += 1;
						did.push(`${c.name}：${text}`);
						const st = read();
						st.replied = [...(Array.isArray(st.replied) ? st.replied : []), c.rpid].slice(-500);
						st.day = { date: today(), count: (st.day && st.day.date === today() ? st.day.count : 0) + 1 };
						write(st);
						await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
					} catch (e) {
						failed.push(`${c.name}：${e.message}`);
						log.warn(`回 ${c.name} 的评论没成：${e.message}`);
					}
				}
				write({ ...read(), lastRunAt: Date.now() });
				if (done > 0) return { ok: true, message: `回了 ${done} 条：${did.join('；')}`, failed };
				return { ok: false, message: '一条也没回成：' + (failed.join('；') || '看日志'), failed };
			} catch (error) {
				log.warn('B站回动态出错：' + error.message);
				return { ok: false, message: error.message };
			} finally {
				busy = false;
			}
		}

		function statusNow() {
			const st = read();
			return {
				ok: true,
				day: st.day && st.day.date === today() ? st.day : { date: today(), count: 0 },
				lastRunAt: st.lastRunAt || 0,
				repliedCount: (st.replied || []).length,
				dryRun: Boolean(setting().dryRun),
				enabled: Boolean(setting().enabled),
				dynamics: dynamicIds(setting().dynamicsPerRun).length,
				lastResult: st.lastResult || null,
			};
		}

		api.every(TICK_MS, () => { run({}).catch(() => {}); }, 'B站回动态');

		api.route('/status', async () => statusNow());
		api.route('/run', async (req) => {
			let body = {};
			try { body = (await api.core.http.body(req)) || {}; } catch { body = {}; }
			if (busy) return { ok: false, message: '上一轮还在跑' };
			const dry = body.dry === true || (body.dry === undefined && setting().dryRun === true);
			Promise.resolve()
				.then(() => run({ dry, force: body.force === true }))
				.then((r) => { const s = read(); s.lastResult = { ...r, dry, at: Date.now() }; write(s); })
				.catch(() => {});
			return { ok: true, message: dry ? '开始检查了，过几秒刷新看结果' : '开始回了，过一会儿刷新看结果' };
		});

		return { run, status: statusNow };
	},
};
