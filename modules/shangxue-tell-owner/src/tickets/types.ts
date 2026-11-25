/** 一条多媒体附件（工单里反馈的图片 / 文件 / 语音）。 */
export interface TicketMedia {
  /** 保存到 data/media/ 后的文件名（相对 media 目录）；抓取失败时为空 */
  file: string
  /** 原始来源（OneBot 的 url 或本地路径），便于抓取失败时兜底 */
  url: string
  /** image / file / record / video / face */
  kind: string
  /** 文件名或简短说明 */
  name?: string
}

/** 一张工单：某人某事反馈给主人，等待主人处理。 */
export interface Ticket {
  /** 自增编号，字符串（如 "1"、"2"）；对外展示为 #1 */
  id: string
  /** 打卡时间（毫秒时间戳） */
  createdAt: number
  /** 来源会话：group:群号 / private:QQ号 */
  chatId: string
  /** group 或 private */
  chatKind: 'group' | 'private'
  /** 群号（群聊时） */
  groupId: string
  /** 发送者 QQ */
  userId: string
  /** 发送者昵称 */
  nickname: string
  /** 触发工单的那条原消息 id（回群时引用它） */
  messageId: string
  /** 主模型自然润色后的正文 */
  summary: string
  /** 原话（原始纯文本），留档 */
  original: string
  /** 多媒体附件 */
  media: TicketMedia[]
  /** open 未处理 / done 已处理 / closed 已关闭（不回复） */
  status: 'open' | 'done' | 'closed'
  /** 处理时间 */
  resolvedAt?: number
  /** 处理时发回群里的那段话 */
  replyText?: string
}

export type ForwardMode = 'natural' | 'natural-sign'
