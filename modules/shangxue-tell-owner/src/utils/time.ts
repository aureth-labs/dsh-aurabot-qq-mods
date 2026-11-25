/** 返回 now 所在自然日的 [0点, 次日0点) 毫秒时间戳。 */
export function dayRange(now: number = Date.now()): { start: number; end: number } {
  const d = new Date(now)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime()
  return { start, end }
}
