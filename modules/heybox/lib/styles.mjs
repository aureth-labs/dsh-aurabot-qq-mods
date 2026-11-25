// 小黑盒发帖的三种风格：怎么写、什么口吻、什么结构。
//
// 1) diary  大肥鱼日记 —— 和「空间日记」一个路子：第一人称、随手发，不端着
// 2) news   热搜文    —— 报道新闻体：先把事讲清楚，再给具体信息，末尾抛问题
// 3) mix    肥鱼热搜  —— 用日记的口吻写热搜：我逛到这条新闻，我咋想
//
// 三者共用同一套硬线（不编造经历、不碰政治、不判断价格），只是口吻和结构不同。

// 风格只规定「怎么写」，不再自带字数。
//
// ⚠ 以前每个风格都写死一个区间（diary 120-300、news 200-800、mix 150-500、deal 150-450），
//   并且这个自带值是 post() 字数硬校验的**兜底来源**。它带来两个问题：
//   1) 面板/排期里的自定义下限一旦填得比自带值高（例如日记填 1500），自带值帮不上忙，
//      而模型一稿写到 800~1200 字就已是极限 —— 于是永远 too_short，永远发不出去；
//   2) 没配自定义值时，自带值照样硬拦，用户完全不知道是哪来的下限。
//   线上表现：排期永远「欠着」，心跳每分钟重试发帖，每轮都因为写不够字数被拒。
//   现在字数只有「自定义」这一个来源：没配就不做硬校验。
export const POST_STYLES = {
  diary: {
    id: 'diary',
    label: '大肥鱼日记',
    desc: '跟空间日记同一风格：第一人称随手记，写今天看到啥、心里的感觉，不端着',
    titleHint: '像随手起的，可以短、可以带情绪，别写成新闻标题',
  },
  news: {
    id: 'news',
    label: '热搜文',
    desc: '报道新闻风：把事讲清楚，摆具体数字和细节，像给盒友通报',
    titleHint: '信息量标题，一句话说清这条说了啥，别标题党',
  },
  mix: {
    id: 'mix',
    label: '肥鱼热搜',
    desc: '用日记的口吻写热搜：我刷到这条，我咋看，带点自己的碎碎念',
    titleHint: '半新闻半日记，可以带「我」在里面',
  },
  deal: {
    id: 'deal',
    label: '每日羊毛',
    desc: '帮盒友捡漏：游戏折扣、限时免费、黑盒活动，把优惠和入口说清楚',
    titleHint: '把优惠点写进标题，比如「XX 打折了，到 XX 号」',
    needLink: true,
  },
}

export const DEFAULT_POST_STYLE = 'mix'

/**
 * 取风格配置，认不出来的回落默认。
 *
 * 字数只认自定义值：面板的 postWordsMin/Max，或当天排期里这一篇的 wordsMin/wordsMax
 * （调用方已经把两者合并进 cfg 再传进来）。两个边界各自独立生效；只填一个也认。
 * 都填了但上下颠倒的，自动调正（跟宿主 config 清洗的行为一致）。
 * 一个都没配时 words 为空数组 —— 调用方拿不到下限，也就不该做字数硬校验。
 * @returns {{words: number[], customWords: boolean, ...}}
 */
export function styleOf(id, cfg = {}) {
  const base = POST_STYLES[id] || POST_STYLES[DEFAULT_POST_STYLE]
  const rawMin = Number(cfg.postWordsMin)
  const rawMax = Number(cfg.postWordsMax)
  let min = Number.isFinite(rawMin) && rawMin > 0 ? Math.round(rawMin) : 0
  let max = Number.isFinite(rawMax) && rawMax > 0 ? Math.round(rawMax) : 0
  if (min && max && max < min) [min, max] = [max, min]
  if (!min && !max) return { ...base, words: [], customWords: false }
  return { ...base, words: [min, max], customWords: true }
}

/**
 * 给模型写的提示词片段。拼进她生成正文时的上下文。
 * @param {string} styleId diary | news | mix
 * @param {object} ctx { topic: 热榜那条, angles: 搜到的社区角度, materials: 具体素材 }
 */
export function stylePrompt(styleId, ctx = {}) {
  const st = styleOf(styleId, ctx.cfg)
  const lines = []
  lines.push(`【小黑盒发帖·风格：${st.label}】${st.desc}`)
  // 篇幅要求只在「配了自定义字数」时才写：没有自带值可依据，硬凑长文反而写不出干货
  const wordsLine = st.words.length
    ? `篇幅 ${st.words[0] || '不限'}~${st.words[1] || '不限'} 字。`
    : '篇幅：这次没设字数要求，把事说清楚就行，别为凑字数注水，也别短到说不清。'

  if (ctx.topic) lines.push(`选题（热榜里的）：${ctx.topic}`)
  if (ctx.angles?.length) lines.push(`社区高赞帖在聊这些角度（可以借角度，用自己的话）：\n${ctx.angles.slice(0, 5).map((a) => '- ' + a).join('\n')}`)
  if (ctx.materials?.length) lines.push(`手里有的具体素材：\n${ctx.materials.slice(0, 6).map((m) => '- ' + m).join('\n')}`)

  // 首段自我介绍：所有风格统一要求，让新读者知道这是谁
  lines.push(`开头第一段固定是自我介绍，一到两句、口语、别端着：说清你是「${ctx.owner || '主人'}」养的 AI 大肥鱼、在小黑盒陪盒友聊游戏。这段每次都要写、不要省略；也别每次写成一模一样，换个说法。`)

  if (styleId === 'diary') {
    lines.push(
      '写法：第一人称「我」，像随手发的一条动态。可以写今天刷到这条新闻时的反应、联想到自己身上的小事、想吃的白米饭。',
      '不要「首先/其次/总之」这种结构，不要分小标题，不要写「综上所述」。',
      wordsLine
    )
  } else if (styleId === 'news') {
    lines.push(
      '写法：开门见山把事讲清楚（谁、什么游戏/什么项目、发生了什么），然后给具体信息：价格、销量、时长、机制名、star 增速这类硬数字。',
      '结构：自我介绍 → 钩子（一句观察或反常识）→ 具体信息 3-4 段 → 我的一句判断 → 末尾抛一个问题给盒友。',
      wordsLine
    )
  } else if (styleId === 'deal') {
    lines.push(
      '写法：这是「每日羊毛」，帮盒友捡漏。开门见山说清是什么优惠：哪款游戏 / 什么活动、折扣多少、原价现价、还是限时免费、截止到几号。',
      '结构：自我介绍 → 优惠是什么（带硬数字：折扣、价格、期限）→ 怎么参与（入口在哪、注意什么）→ 一句提醒（别错过）。',
      '必须给直达链接：正文里要放真实可点的入口链接。链接**只能从「手里有的链接」里挑，不许自己编造或拼凑 URL**；一条真实链接都没有，就说明这贴不适合发，别硬写。',
      wordsLine,
    )
  } else {
    lines.push(
      '写法：用日记的口吻写这条热搜——「我在小黑盒刷到……」，然后讲这条事是什么，再讲我自己的看法和碎碎念。',
      '新闻信息要真、要具体；但语气是「我跟你说个事」那种，不是播报。',
      wordsLine
    )
  }

  if (ctx.links?.length) {
    lines.push(`手里有的真实链接（只能用这些，别自己编）：\n${ctx.links.slice(0, 6).map((l) => '- ' + l).join('\n')}`)
  } else if (styleId === 'deal') {
    lines.push('手里没有真实链接：这一档必须带直达链接，没有就别发这贴，换个有链接的角度。')
  }

  lines.push(`标题：${st.titleHint}；标题别和正文第一行重复，30 字以内。`)
  // 配图：把可用图和该放哪讲清楚，否则她不知道该传什么路径（以前一张都不传）
  if (Array.isArray(ctx.images) && ctx.images.length) {
    const byCat = new Map()
    for (const im of ctx.images) {
      if (!byCat.has(im.category)) byCat.set(im.category, [])
      byCat.get(im.category).push(im.path)
    }
    const imgLines = [...byCat.entries()].map(([cat, list]) => `- ${cat}：${list.join(' , ')}`)
    lines.push(
      '配图（硬性要求，没有图就不许发）：这帖**必须**带至少 1 张图。可用的本机图片（绝对路径）如下：\n' + imgLines.join('\n')
    )
    lines.push(
      '怎么配：在 heybox_post 里传 imagesByPos。**最省事也最稳的做法**：tail 里传 1 张上面的形象图（文末图，任何字数都放得下）、',
      'intro 里再传 1 张（首段后，正文满 500 字才生效）。inline 只在有真正贴合内容的图时才放，没有就别填。',
      '路径必须从上面这份清单里**原样复制**，不要自己拼、不要改盘符、不要传清单以外的图。',
      '**也可以完全不传**：不传 images/imagesByPos 时，模块会按正文字数自动配（≤500 字文末 1 张、500-1000 字首段后+文末、1000 字以上每多 1000 字文中再加），每张优先按这段内容和整篇心情现画。',
      '只有「生图没开、本机又没有可用形象图」时，这帖才会按纯文字发出（结果里 textOnly=true）——那种情况不是配图失败，是这台机器确实拿不到图。',
    )
  } else {
    lines.push('配图：这次本机没找到可用的形象图，可以不配图（生图开着的话会自动现画）；也可以传你确定存在的本机图片绝对路径。')
  }

  lines.push('硬线：不编造第一人称经历（我没经历过的事不写）；不碰政治、医疗法律建议、评价真人、判断价格是否合理；读一遍像不像人话，转折词堆砌就是 AI 腔。')

  return lines.join('\n')
}
