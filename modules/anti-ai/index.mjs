// 去 AI 味 —— 出站前把客服腔清掉，并认出各种「这次不说话」的写法。
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

const SILENCE_WORDS = new Set([
	'沉默', '不回', '不回复', '不说话', '不接话', '安静', '略过', '跳过',
	'silence', 'silent', 'skip', 'pass', 'none', 'noresponse',
]);

const normWord = (s) => String(s || '').replace(/[\[\]［］【】()（）<>《》"'“”.,。!！?？~～…\s]/g, '').toLowerCase();

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
	name: '去 AI 味',
	version: '1.0.0',
	api: 1,
	description: '清掉客服腔，并认出模型写的「不说话」记号（[沉默] / [silence] / 不回）。',

	defaults: {
		polishEnabled: true,
		silenceEnabled: true,
	},
	settings: [
		{ key: 'polishEnabled', label: '清掉客服腔', type: 'switch', hint: '「作为AI」「总而言之」「希望对你有帮助」这些' },
		{ key: 'silenceEnabled', label: '认「不说话」记号', type: 'switch', hint: '[沉默] / [silence] /（不回）/ skip' },
	],

	setup(api) {
		api.on('reply', (text) => {
			if (!api.settings().silenceEnabled) return undefined;
			return stripSilence(text);
		});

		api.on('reply', (text) => {
			if (!api.settings().polishEnabled) return undefined;
			return polish(text);
		});

		return { polish, stripSilence };
	},
};
