// 小动作 —— 被戳一戳会戳回去；看到消息偶尔贴个表情回应。
//
// 只用插件已有的 OneBot 调用：send_poke / set_msg_emoji_like。
// 网关不支持时只在日志里记一句，不影响别的功能。

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOUR_MS = 3600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// QQ 表情回应用的 id（NapCat / SnowLuma 那套）
const REACT_IDS = ['76', '124', '14', '66', '182', '5'];

export default {
	id: 'poke-react',
	name: '小动作（戳回去 · 表情回应）',
	version: '1.0.0',
	api: 1,
	description: '被戳一戳会戳回去；看到消息偶尔贴个表情回应。',

	defaults: {
		pokeBack: true,
		pokeBackChance: 90,
		react: true,
		reactChance: 20,
		reactMaxPerHour: 6,
		reactInGroup: true,
		reactInPrivate: true,
	},
	settings: [
		{ key: 'pokeBack', label: '被戳会戳回去', type: 'switch' },
		{ key: 'pokeBackChance', label: '戳回去的概率（%）', type: 'number' },
		{ key: 'react', label: '给消息贴表情回应', type: 'switch', hint: '需要网关支持 set_msg_emoji_like' },
		{ key: 'reactChance', label: '每条消息回应表情的概率（%）', type: 'number' },
		{ key: 'reactMaxPerHour', label: '每小时最多贴几次', type: 'number' },
		{ key: 'reactInGroup', label: '群里也贴', type: 'switch' },
		{ key: 'reactInPrivate', label: '私聊也贴', type: 'switch' },
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
			} catch { /* 写不进去不影响贴表情 */ }
		}
		const reactedRecent = () => {
			const s = read();
			return Array.isArray(s.reacted) ? s.reacted.filter((t) => Date.now() - t < HOUR_MS) : [];
		};

		// ---------- 被戳就戳回去 ----------
		api.on('poke', (evt) => {
			if (!setting().pokeBack) return false;
			const chance = Math.max(0, Math.min(100, Number(setting().pokeBackChance ?? 90))) / 100;
			if (Math.random() >= chance) return false;

			const raw = evt || {};
			const userId = raw.user_id ?? raw.userId ?? raw.sender_id ?? '';
			const groupId = raw.group_id ?? raw.groupId ?? '';
			if (!userId) return false;
			if (String(userId) === String(api.config().botQQ || '')) return false;

			const cfg = api.config();
			if (!cfg.enabled || cfg.dryRun) {
				log.info(`试运行（没真戳）→ ${groupId ? '群' + groupId : '私聊'}：想戳回 ${userId}`);
				return false;
			}
			sleep(600 + Math.random() * 1400)
				.then(() => api.onebot('send_poke', { user_id: Number(userId), ...(groupId ? { group_id: Number(groupId) } : {}) }))
				.then(() => log.info(`戳回去了：${userId}`))
				.catch((e) => log.debug('戳回去失败：' + e.message));
			return false; // 不接管，她该怎么回还怎么回
		});

		// ---------- 给消息贴表情回应 ----------
		api.on('message', (msg) => {
			const s = setting();
			if (!s.react || !msg) return false;
			const kind = msg.kind;
			if (kind === 'group' && !s.reactInGroup) return false;
			if (kind === 'private' && !s.reactInPrivate) return false;
			if (kind !== 'group' && kind !== 'private') return false;
			if (msg.mentioned) return false; // 点她的名字 / @ 她，别光贴表情
			if (String(msg.text || '').length < 4) return false;

			const max = Math.max(0, Math.floor(Number(s.reactMaxPerHour) || 0));
			if (max <= 0) return false;
			const used = reactedRecent();
			if (used.length >= max) return false;

			// 心情不好就不贴；心情好概率高一点
			let moodLabel = '';
			try { moodLabel = String(api.use('mood')?.label?.() || ''); } catch { moodLabel = ''; }
			if (/生气|难过|失落|委屈/.test(moodLabel)) return false;
			const boost = /开心|感动|想念|高兴/.test(moodLabel) ? 1.5 : 1;
			const chance = Math.max(0, Math.min(100, Number(s.reactChance ?? 20))) / 100;
			if (Math.random() >= Math.min(1, chance * boost)) return false;

			const cfg = api.config();
			if (!cfg.enabled || cfg.dryRun) {
				log.info(`试运行（没真贴）→ ${msg.chatId}：想给这条贴个表情`);
				return false;
			}

			const messageId = msg.messageId ?? msg.message_id ?? '';
			if (!messageId) return false;
			const emoji = REACT_IDS[Math.floor(Math.random() * REACT_IDS.length)];
			sleep(800 + Math.random() * 1200)
				.then(() => api.onebot('set_msg_emoji_like', { message_id: messageId, emoji_id: emoji, set: true }))
				.then(() => {
					const st = read();
					st.reacted = [...(Array.isArray(st.reacted) ? st.reacted : []).filter((t) => Date.now() - t < HOUR_MS), Date.now()].slice(-60);
					write(st);
					log.debug(`给 ${msg.chatId} 贴了个表情 ${emoji}`);
				})
				.catch((e) => log.debug('贴表情失败（网关可能不支持）：' + e.message));
			return false; // 不接管
		});

		return { reactedLastHour: () => reactedRecent().length };
	},
};
