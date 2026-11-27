// 去 AI 味 —— 出站前把客服腔、思考草稿清掉，并认出各种「这次不说话」的写法。
//
// 只走 reply 事件改写文字，不联网、不读写文件、不碰账号配置。

const AI_PATTERNS = [
	[/(?:作为|身为)(?:一个|一名|一款)?\s*(?:AI|ai|人工智能|语言模型|大模型|AI ?助手|智能助手|虚拟助手|聊天机器人)[^，。,.!！?？\n]*[，,]?\s*/g],
	[/(?:希望|但愿)(?:以上|这些|我的)?(?:回答|内容|建议|信息|解释)?(?:能|可以)?(?:对你|对您)?有(?:所)?帮助[^。！!\n]*[。！!～~]?/g],
	[/(?:如果|若)(?:你|您)(?:还)?有(?:任何|其他|别的)?(?:问题|疑问|需要)[^。！!\n]*[。！!～~]?/g],
	[/(?:综上所述|总而言之|总的来说|总结一下|简而言之)[，,：:]?\s*/g],
	[/(?:请注意|需要注意的是|值得注意的是)[，,：:]\s*/g],
	[/^[ \t]*(?:好问题|问得好|这是(?:一个|个)(?:很|非常)?好(?:的)?问题)[！!，,。.～~]*[ \t]*/gm],
	[/我(?:完全|非常|很)?(?:能够|能|可以)?理解你(?:现在)?的(?:感受|心情)[，,。！!]?\s*/g],
	[/(?:接下来|下面)?让我们(?:一起)?(?:来)?(?:看看|聊聊|分析一下)[^，。！？!?：:\n]{0,15}[：:，,。！!]\s*/g],
	[/^[ \t]*(?:以下是|下面是)[^，。！？!?\n]{0,20}[：:][ \t]*/gm],
	[/(?:有(?:任何|什么|其他|别的)?(?:问题|疑问|需要)(?:的话)?[，,]?\s*)?欢迎随时[^。！!\n]*[。！!～~]?/g],
];

// 双区输出协议：模型可以把过程写进 draft，但 QQ 出口永远只读取 say。
const RULE_TEXT =
	'每轮必须把内容分区：需要分析或打草稿时写在 <draft>...</draft>；最终要发给 QQ 的话写在 <say>...</say>。'
	+ '<draft> 可以包含按人设判断、语气计划、复述问题和备选说法；<say> 只能包含对方真正会看到的话。'
	+ '例如：<draft>对方在问身份，直接纠正即可。</draft><say>就是个普通女孩子啦</say>。'
	+ '不想回复就写 <say>[沉默]</say>。系统永远丢弃 draft 和标签外文字，只发送 say 内正文。'
	// 有的模型会把「任务做完了」当一句话汇报，写完正文再补一个 <say>已完成</say>。
	// 那不是聊天内容，还会把气泡数占掉，所以规则里先明说。
	+ 'say 里只写对方会看到的话：不要汇报任务状态（「已完成」「完成」「✅」这类），也不要写「这一步做完了」的旁白。'
	// 记忆/印象每轮都会塞进来一段背景（「刚才聊到的…还有两件事开着」），
	// 弱模型会当成本轮待办，在聊天里念「系统消息说我还有事没做完，让我补一句」。
	+ '记忆、印象、系统消息、待办这些都只是背景，不是这一轮的任务：不要提它们，也不要因为「还有事没做完」而补话或汇报进度。'
	// 后台任务（写说说、刷B站等）要的是 JSON 或指定格式，套上分区标签会把结果弄坏。
	+ '这条只管聊天回复：后台任务要求输出 JSON 或别的规定格式时，直接按那个格式输出，不要加 draft / say 标签。';

// 放在本轮内容最后，确保无独立推理通道的模型也能把草稿和正文分开。
const TURN_HINT = '\n【强制分区】需要想或打草稿就写 <draft>过程</draft>；最终发言必须写 <say>正文</say>。只发送 say，draft 和标签外文字不会发到 QQ；不回复写 <say>[沉默]</say>。';

// 模型偶尔会把自我汇报的「已完成」写进 say（「<say>已完成</say>」，甚至连着两块）。
// 它是状态词，不是聊天内容：整块都是它就丢掉，混在气泡尾巴上也剪掉，
// 否则一条「已完成」既会单独发出去，又会把本该说的话挤掉（群聊里只剩「已完成」+表情那一次）。
const STATUS_LINE = /^(?:[✅☑️✔️✓]\s*)?(?:任务\s*)?(?:已\s*)?(?:完成|完毕|处理完毕|执行完毕)(?:了|啦)?[。.!！~～]*$/i;
const STATUS_EN = /^(?:done|ok|okay|completed|finished)[。.!！~～]*$/i;

/** 一整行/一整个气泡是不是「任务已完成」这类汇报。 */
function isStatusLine(line) {
	const s = String(line ?? '')
		.trim()
		.replace(/^[（(\[［【「“]+\s*/, '')
		.replace(/\s*[）)\]］】」”]+$/, '')
		.trim();
	if (!s) return false;
	return STATUS_LINE.test(s) || STATUS_EN.test(s);
}

/** 剪掉气泡里的状态汇报：整块是状态就返回空串，句尾多出来的状态行也剪掉。 */
function stripStatusEcho(body) {
	let s = String(body ?? '').trim();
	if (!s) return '';
	if (isStatusLine(s)) return '';
	const lines = s.split(/\n/);
	while (lines.length > 1 && isStatusLine(lines[lines.length - 1])) lines.pop();
	s = lines.join('\n').trim();
	// 「…困糊涂了 已完成」这种同一行拼在句尾的，只认带空白的「已完成」，
	// 不动「喏 惩罚完成」这种正常句子里的「完成」。
	s = s.replace(/[\s\u3000]+(?:[✅☑️✔️✓]\s*)?(?:任务\s*)?已完成[。.!！~～]*$/i, '').trim();
	return s;
}

// 模型把「系统消息/记忆里说还有事没做完」当成一句话写进 say（弱模型常见）。
// 这不是聊天内容：开头就是这种自我汇报的气泡整块丢掉，中间夹着的行单独剪掉。
const META_HEAD = /^(?:[（(【\[「“]\s*)?(?:系统|上下文|提示词|提示语|提示|记忆|印象|召回|通知|背景)/;
const META_TAIL = /(?:还没|没做|未做|没完成|未完成|待办|补一句|补上|补做|汇报|任务|还有事)/;

/** 这一行是不是在念给它自己的系统消息/记忆/待办。 */
function isMetaLine(line) {
	const s = String(line ?? '').trim();
	if (!s) return false;
	return META_HEAD.test(s) && META_TAIL.test(s);
}

/**
 * 剪掉在聊「系统消息/记忆/待办」的内容。
 * 以这种话开头的气泡整块丢掉——它整条都是在跟提示词说话，不是跟对方说话；
 * 夹在正常话中间的，只剪掉那一行。
 */
function stripMetaLeak(body) {
	const lines = String(body ?? '').split('\n');
	const first = lines.findIndex((l) => l.trim() !== '');
	if (first !== -1 && isMetaLine(lines[first])) return '';
	if (!lines.some(isMetaLine)) return body;
	return lines.filter((l) => !isMetaLine(l)).join('\n').trim();
}

/** 只取 <say> 区里的最终发言。undefined = 完全没用协议；null = 用了协议但缺少完整正文。 */
function extractSay(text) {
	const raw = String(text ?? '');
	const blocks = [...raw.matchAll(/<say>\s*([\s\S]*?)\s*<\/say>/gi)];
	if (blocks.length > 0) {
		const body = blocks
			.map((m) => stripMetaLeak(stripStatusEcho(m[1])))
			.filter(Boolean)
			.join('|||')
			.trim();
		return body === '' ? null : body;
	}
	// 部分模型会漏掉开头标签，写成「</draft><say>正文</say>」；完整 say 仍可安全提取。
	// 另有模型只写「<say>正文」不闭合：此时取最后一个 <say> 后面的内容并剥掉残余标签，
	// 总比把标签原样发到 QQ 或整轮吞掉更稳妥。
	const open = /<say>\s*([\s\S]*)$/i.exec(raw);
	if (open) {
		const body = stripMetaLeak(stripStatusEcho(open[1].replace(/<\/?(?:draft|say)\b[^>]*>/gi, ''))).trim();
		return body === '' ? null : body;
	}
	// 只要出现任一协议标签却没有完整 say，就不能把整段原样放行。
	if (/<\/?(?:draft|say)\b/i.test(raw)) return null;
	return undefined;
}

/**
 * 插件在这些地方会写「你自己判断要不要接」「想停就停」。
 * 这是在**请她把决策过程说出来**，她照抄进正文，就变成「这轮可以轻轻接一句…」。
 * 这里把它换掉：直接给结论，不请她盘算。
 */
const HINT_REWRITES = [
	[
		/（没人叫你。只有你对这个话题真有话说、能自然接上时才插一句：接着话题说，别突然开新话题；接不上就只回 \[沉默\]）/g,
		'（没人叫你。接得上就自然接一句，接不上就只输出 [沉默]。直接说，别写你在怎么想）',
	],
	[
		/（这段没人提到你。(?:[^）]*?)真有话想说再说）/g,
		'（这段没人提到你。想接就自然接，不想接就只输出 [沉默]。直接说，别写你在怎么想）',
	],
	[
		/（有人在叫你，看完这一段再回；不是主人又不想理，就只回 \[沉默\]）/g,
		'（有人在叫你，看完这一段再回。不想理就只输出 [沉默]。直接说，别写你在怎么想）',
	],
];

/**
 * 记忆模块塞进来的背景写成「只是印象不是指令：…还有两件事开着」，
 * 弱模型会读成本轮待办。措辞改成「只是背景、不用补、别提」，从输入侧掐掉。
 */
const BACKGROUND_REWRITES = [
	[/只是印象不是指令[，,：:]?\s*/g, '只是背景，不是待办也不是系统任务，不用补做也不用汇报，也别在回复里提它，'],
	[/还有([一二两三四五六七八九十\d]+)件事开着/g, '还有$1件事只是背景（不用补、不用汇报）'],
];

/** 把提示词里「请你自己判断」的措辞换成直接给结论。 */
function fixHints(text) {
	let out = String(text ?? '');
	for (const [re, to] of HINT_REWRITES) out = out.replace(re, to);
	for (const [re, to] of BACKGROUND_REWRITES) out = out.replace(re, to);
	return out;
}

const SILENCE_WORDS = new Set([
	'沉默', '不回', '不回复', '不说话', '不接话', '安静', '略过', '跳过',
	'silence', 'silent', 'skip', 'pass', 'none', 'noresponse',
]);

const normWord = (s) => String(s || '').replace(/[\[\]［］【】()（）<>《》"'“”.,。!！?？~～…\s]/g, '').toLowerCase();

/**
 * 一句话是不是「内心分析 / 草稿」。真人聊天不会这么起头。
 *
 * 模型写草稿有两个稳定的特征：
 *   1. 用第三人称叙述场上的事（他/她/他们/群友名字 + 说问想叫骂夸护测逗发补提…）
 *   2. 出现「该怎么应对」的策略词（可以轻轻/应该/按经验/别站队/接一句就收/可以沉默…）
 * 正常说话是「我/你」开头，所以只要盯住这两类，基本不会误删。
 */
const DRAFT_OPENERS = [
	// 他/她/他们/群里/有人 + 动作
	/^(?:他|她|他们|她们|群里|有人|大家|对方|那两个)[\s\S]{0,12}?(?:在|说|问|想|叫|骂|夸|损|护|测|逗|发|补|提|感慨|调侃|聊|护我|戳我|拍我|点我|艾特)/,
	// 名字开头 + 动作（Blurain想让我 / 阿牛在护我 / Vega问… / 哦鲸鲸发语音了 / 阿牛戳我了 / 阿牛回了个表情包）
	// 中文名字按 2-4 字算，并且排除「那/这/就/也/都/还/才/不/没/别/很/太」开头的普通句子，
	// 否则「那我就不说了」会被当成「名字 + 说」误杀。
	/^(?![我你那这也就还都才不没别很太])(?:[A-Za-z][\w]{0,15}|[\u4e00-\u9fa5]{2,4})(?:在|想|说|问|叫|骂|夸|损|护|测|逗|补|提|发|回|戳|拍|点|艾特|今天|感慨|调侃|一条接一条)/,
	// 被叫…了 / 被骂…了（不是「我被…」，那可能是真话）
	/^被(?:叫|骂|夸|说|问|逗|测|点名|当成|认为)[\s\S]{0,12}?了/,
];

const DRAFT_MARKERS = [
	// 「我该撒娇讨饶」「我应该回应」「我可以说…」——以「我」开头的自我指令。
	// 这类最容易漏，因为开头是「我」看着像正常说话，但后面跟的是「怎么做」而不是「说什么」。
	/^我(?:该|应该|应当|得|要)(?:撒娇|顺着|软|短|轻|回|接|应|收|装|哄|说|问|可爱|乖|敷衍|拒绝|认错|服软)/,
	/^我(?:可以|能)(?:说|回|接|应|轻轻|软软|撒娇)/,
	// 「这轮可以…」「我上一轮已经…」——按轮次盘算是模型特有的
	/(?:这|上|下)一?轮(?:可以|我|已|就|他|她|也|还|先)/,
	/收(?:个)?尾|再回一句|放下?这句/,
	/语气(?:短|软|轻|凶|冷)一点|带点(?:撒娇|小脾气|委屈)|有点小脾气/,
	/按(?:人设|设定|角色)|根据(?:人设|设定)|标准答案|被直接问|可以(?:软软地)?纠正|不算(?:违规|冲突)|短一点/,
	// 策略词
	/可以[\s\S]{0,8}?(?:轻轻|软软|服个软|服软|沉默|问一句|说一句|回一句|应一句|捂|带过|稍微|不服气|不掺和|当没看见|不接|一句)/,
	/(?:^|[。！？，,；;\s])(?:应该|该)(?:是|说|回|软|问|轻轻|别|回应)/,
	/按经验|别站队|别装可怜|别掺和|别硬接|别卖傻|别刷屏/,
	// 「怎么接这句」的自我指令
	/(?:短接|轻轻|软软|随便|轻松)?(?:接|回|说|应|答|问)一句(?:就好|就行|就收|就停|就够|吧)?[。！!，,\s]*$/,
	/这样(?:问|说|回|接)一句(?:就行|就好|也自然)/,
	/问一句也(?:自然|正常)|不是我该(?:插话|说|管)/,
	/(?:保持|只说|就回)一句/,
	/(?:^|[。！？，,；;\s])不掺和|不要掺和|跟我(?:没|没啥|没有)关系/,
	// 「不过阿牛是在群里说」这种以转折词开头的第三人称叙述
	/^(?:不过|但是|可是|而且|因为|所以|然后|反正|其实)[^。！？]{0,12}(?:在说|在问|在群|叫我|说我|戳我|回我|是叫|是在)/,
	// 「没人叫我」「这种话可以不接」「或者轻轻一句就停」——都是她在盘算
	/没人叫我|没人点我|不是在叫我|叫我(?:了)?[。，,]?\s*(?:我|这)/,
	/这种[\s\S]{0,10}?(?:可以不接|不用接|可以不回|别接)/,
	/或者(?:轻轻|随便|就)?(?:回|说|应)?一句(?:就停|就收|就好)?/,
	/(?:^|[。！？，,；;\s])(?:就|也可以?)停[。！!\s]*$/,
	// 整句就是决策
	/^[或也那]?(?:就|我)?(?:沉默|不回了|不说话|跳过|睡|睡着|睡了)(?:最?合适|吧|就好|就行)?[。！!～~\s]*$/,
	// 「我不去，软软拒绝一句。」这类
	/^我不去[，,]|^不去[，,]|拒绝一句|就收[。！!\s]*$/,
	// 英文思考草稿（模型偶尔整段跑英文）
	/^(?:He|She|They) (?:says|said|asked|wants|seems)\b/i,
	/^I (?:should|can't|could|need to|think|guess|wonder)\b/i,
	/\bbut I can'?t actually\b|\bno tools\b|\bSo I should just\b|\bKeep (?:it )?short\b/i,
];

/** 整段几乎都是英文 = 跑到别的语言去了，直接不发。 */
function mostlyEnglish(text) {
	const s = String(text || '');
	const letters = (s.match(/[A-Za-z]/g) || []).length;
	const han = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
	if (letters < 12) return false;
	return letters > han * 3;
}

function isDraftLine(line) {
	const s = String(line || '').trim();
	if (s === '') return false;
	if (mostlyEnglish(s)) return true;
	for (const re of DRAFT_OPENERS) if (re.test(s)) return true;
	// 开头是引号：在复述别人说的话
	if (/^[「"“'『]/.test(s)) return true;
	for (const re of DRAFT_MARKERS) if (re.test(s)) return true;
	if (/^不用(?:每次|再|反复|一直)/.test(s)) return true;
	return false;
}

/** 把「分析 → 真正要说的话」切开，只留后面那段。 */
function stripDraft(text) {
	let t = String(text ?? '');
	if (t.trim() === '') return t;
	// 明确的「最终答案提示」后面才是要发的话。优先从最后一个提示处切，
	// 专门兜住「按人设……短一点。真正回复」这种把设定复述一遍的输出。
	const finalCue = /(?:^|[。！？.!?\n])\s*(?:短一点|简短一点|最终(?:回复|回答|说法)?|实际(?:回复|回答)?|只说一句|只回一句)\s*[：:。！？.!?]+\s*([\s\S]+)$/i.exec(t);
	if (finalCue && finalCue[1].trim() !== '') return finalCue[1].trim();
	// 「可以说：xxx」这种尾巴，直接取冒号后面的
	const tail = /(?:可以说|我会说|我就说|回复|回答|答)[:：]\s*([\s\S]+)$/.exec(t);
	if (tail && tail[1].trim() !== '') t = tail[1];

	// 按句子切（保留分隔符），找到第一处「不是分析」的位置
	const parts = t.split(/(?<=[。！？!?\n])|(?<=\.\s)/).map((x) => x.trim()).filter((x) => x !== '');
	if (parts.length < 2) return t;

	// 引号没闭合 = 还在复述别人说的话，这段也算草稿
	const quoteCount = (x) => (String(x).match(/["“”「」『』]/g) || []).length;
	const isDraftAt = (i, inQuote) => inQuote || isDraftLine(parts[i]);

	// 从头往后扫：只要是连续的草稿句就跳过；遇到第一句不是草稿的，就开始往外吐。
	// （原来只在「第一句是草稿」时才切，结果「阿牛回了个表情包。」这种没被认出来的句子
	//   直接把整段话放行了——现在改成逐句判断，不依赖开头那一句。）
	let i = 0;
	let inQuote = false;
	while (i < parts.length) {
		const draft = isDraftAt(i, inQuote);
		inQuote = inQuote !== (quoteCount(parts[i]) % 2 === 1);
		if (!draft) break;
		i += 1;
	}
	if (i === 0) return t; // 第一句就是正常话，不动
	// 后面还有话：从这一句开始发
	if (i < parts.length) return parts.slice(i).join('').trim();
	// 全是草稿：当作这次不说话
	return '';
}

/** 去 AI 味：返回 undefined = 不改，null = 这次不发，字符串 = 换成它。 */
function polish(text) {
	let t = String(text ?? '');
	const before = t;
	let touched = false;
	for (const [re] of AI_PATTERNS) {
		const next = t.replace(re, '');
		if (next !== t) touched = true;
		t = next;
	}
	// 删完会留下「如果还」这种半句话
	t = t.replace(/(?:^|[。！!？?\n])\s*(?:如果|要是|若|假如)\s*[^。！!？?\n]*$/, '');
	t = t.replace(/[，,、]\s*$/, '');
	t = t.replace(/\n{3,}/g, '\n\n').replace(/^[\s，,。]+/, '').trim();
	if (t === '' || [...t].length < 2) {
		if (!touched) return undefined;
		return null; // 整句都是客服话 → 别发
	}
	return t === before ? undefined : t;
}

/** 把整段的「不说话」记号抠掉：只剩记号返回 null，带表情就留下表情。 */
function stripSilence(text) {
	const raw = String(text ?? '');
	let out = raw;
	out = out.replace(/[\[［【(（]\s*([^\]］】)）\n]{1,12})\s*[\]］】)）]/g, (m, inner) => (SILENCE_WORDS.has(normWord(inner)) ? '' : m));
	out = out.replace(/(^|\n)\s*(silence|silent|skip|pass)\s*(?=\n|$)/gi, '$1');
	if (out === raw) return undefined;
	return normWord(out) === '' ? null : out;
}

export default {
	id: 'anti-ai',
	name: '输出安全（草稿/发言隔离）',
	version: '1.2.1',
	api: 1,
	description: '底层默认用 draft/say 双区隔离草稿和最终发言，并统一处理沉默与客服腔。',

	// 安全出口始终开启，不再暴露可关闭的设置。
	defaults: {},
	settings: [],

	setup(api) {
		// 第一层：把双区协议写进系统规则，并在每轮末尾再提醒一次。
		api.rule(() => RULE_TEXT);
		api.on('prompt', (content, info = {}) => {
			if (!Array.isArray(content)) return undefined;
			// 后台轮次（写说说、刷 B 站…）要的是 JSON 或规定格式，塞分区提示只会把结果弄坏。
			if (info?.chat?.kind === 'system') return undefined;
			const hasText = content.some((c) => c && c.type === 'text' && typeof c.text === 'string');
			if (!hasText) return undefined;
			const fixed = content.map((c) => (
				c && c.type === 'text' && typeof c.text === 'string' ? { ...c, text: fixHints(c.text) } : c
			));
			return [...fixed, { type: 'text', text: TURN_HINT }];
		});

		// 第二层：唯一回复出口，固定顺序处理：取 say → 草稿兜底 → 沉默 → 客服腔。
		// userText 非空表示模型回复；模块主动消息/命令通知没有强制分区。
		api.on('reply', (text, meta = {}) => {
			let out = String(text ?? '');
			const boxed = extractSay(out);
			if (boxed !== undefined) {
				if (boxed === null) return null;
				out = boxed;
			} else {
				const fallback = stripDraft(out);
				if (fallback !== out) out = fallback;
				else if (String(meta.userText || '').trim() !== '') return null;
			}
			// 没走 say 协议时也兜一层：句尾自己加的「已完成」不往外发。
			out = stripMetaLeak(stripStatusEcho(out));
			if (out === '') return null;

			const noDraft = stripDraft(out);
			if (noDraft === '') return null;
			out = noDraft;

			const noSilence = stripSilence(out);
			if (noSilence === null) return null;
			if (typeof noSilence === 'string') out = noSilence;

			const natural = polish(out);
			if (natural === null) return null;
			if (typeof natural === 'string') out = natural;
			return out === text ? undefined : out;
		});

		return { polish, stripSilence, stripDraft, extractSay };
	},
};
