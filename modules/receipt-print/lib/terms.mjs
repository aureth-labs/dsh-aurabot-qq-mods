// 使用协议：必须在确认后才能打印。
// 条款有实质更新时提升 TERMS_VERSION，已确认过的用户需要重新确认。
export const TERMS_VERSION = '1.1'
export const TERMS_TITLE = '热敏打印使用协议'

// 顺序固定为：用户需知 → 法律 → 创意
export const TERMS_SECTIONS = [
  {
    title: '一、用户需知',
    items: [
      '【适用范围】本协议适用于「热敏打印」模块的全部功能，包括模板生成、预览、打印、自检、校准、定时任务、说说自动打印、打印机状态查询与错误汇报。未确认本协议时，上述功能不可用。',
      '【确认与后续版本】首次使用前，需在面板点「我已阅读并同意」或发送 /小票 同意。条款有实质更新（例如新增法律、隐私或责任限制内容）时会提升版本号并重新展示，你需要再次确认后功能才会继续启用，旧版本的确认不会继续生效。不同意更新后的条款时，请停止使用并卸载本模块。',
      '【数据与隐私】模板、设置和打印记录保存在本机；打印备份包含正文，也保存在本机备份目录，不上传。生成模板时，提示词会通过宿主发给你自己配置的模型服务；图片按原始地址下载后在本机处理。本模块不含遥测，不向作者或第三方上传数据。请勿在模板中写入你不希望发给模型服务或留在本机备份里的敏感信息。',
    ],
  },
  {
    title: '二、法律',
    items: [
      '【合法使用】你承诺只将本模块用于合法用途，并对打印内容和使用场景负责：不得用于伪造票据、发票、收据、证明、门票、证件等具有法律效力或用于欺骗的文件；不得打印、传播违反法律法规或侵犯他人著作权、肖像权、隐私权、名誉权、商业秘密的内容；不得用于骚扰、诈骗或其他侵害他人权益的行为。',
      '【责任边界】本模块只提供排版和打印工具，打印结果不构成票据、凭证或任何法律文件。打印内容是否真实、合法、完整，以及你用打印结果做什么，由你自行负责；因打印机、驱动、纸张、网络、第三方服务或自身配置造成的故障和损失，作者不承担责任。',
      '【无担保与责任限制】本模块按「现状」提供，不作任何明示或默示担保，包括适销性、特定用途适用性和不侵权担保。在法律允许的最大范围内，作者不对间接、附带、特殊或后果性损失承担责任；法律不允许排除或限制的责任除外，你依法享有的消费者权利不受影响。',
      '【第三方与商标】ESC/POS 是 Seiko Epson Corporation 的指令集与商标；Windows、CUPS 等名称归各自权利人所有。本模块是独立实现，与上述公司无隶属、赞助或背书关系。使用第三方驱动或服务时，还需遵守其许可和条款。',
      '【法律说明】本协议是你使用本模块的约定，不构成法律意见。若你所在地区对打印内容、票据凭证、个人信息或特定行业（如发票、税务、医疗、金融）另有要求，请自行确认合规并咨询专业人士。本协议不排除或限制法律强制赋予你的权利。',
      '【变更与终止】作者可随版本更新调整本协议，并在模块更新说明与 README 中标注。你继续使用即视为接受更新后的协议；不同意时请停止使用并卸载本模块。你随时可以停止使用本模块来终止本协议。',
    ],
  },
  {
    title: '三、创意',
    items: [
      '【创意与署名】本模块的创意与设计、原创模板提示词的写法、排版与校准方案、面板与文档文案，以及名称「热敏打印」，均由作者创作。代码部分按仓库的 MIT 许可使用；上述非代码内容不在 MIT 授权范围内，转载、改编或二次发布时请保留作者与来源，不要删除署名，也不要整体改名后作为自己的原创作品发布。',
    ],
  },
]

export const TERMS_ITEMS = TERMS_SECTIONS.flatMap((section) => section.items)

export function termsAccepted(settings = {}) {
  // 版本升级后必须重新确认，旧版本的确认不继续生效。
  return String(settings?.termsVersion || '') === TERMS_VERSION
}

export function termsPublic(settings = {}) {
  return {
    version: TERMS_VERSION,
    title: TERMS_TITLE,
    sections: TERMS_SECTIONS,
    items: TERMS_ITEMS,
    accepted: termsAccepted(settings),
    acceptedVersion: String(settings?.termsVersion || ''),
  }
}

export function termsText() {
  const lines = [`《${TERMS_TITLE}》v${TERMS_VERSION}`, '']
  let number = 1
  for (const section of TERMS_SECTIONS) {
    lines.push(section.title)
    for (const item of section.items) lines.push(`${number++}. ${item}`)
    lines.push('')
  }
  lines.push('条款更新后会提升版本号，需要重新确认。', '确认：/小票 同意')
  return lines.join('\n')
}

export function termsGate(settings = {}) {
  if (termsAccepted(settings)) return ''
  return `使用前需要先同意《${TERMS_TITLE}》v${TERMS_VERSION}。\n发 /小票 协议 查看全文，再发 /小票 同意 确认。`
}
