// 定时检查：每分钟比对一次模板的 HH:MM，同一天同一个模板只触发一次。
import { formatDate } from './templates.mjs'

export function dueTemplates(templates, now, lastRun) {
  const { date, time, weekdayNum } = formatDate(now)
  const due = []
  for (const template of templates || []) {
    if (!template || template.enabled === false) continue
    const schedule = template.schedule || {}
    if (schedule.enabled !== true) continue
    if (String(schedule.time || '') !== time) continue
    if (Array.isArray(schedule.days) && schedule.days.length && !schedule.days.includes(weekdayNum)) continue
    if (typeof lastRun === 'function') {
      if (lastRun(template.id) === date) continue
    } else if (lastRun && lastRun[template.id] === date) continue
    due.push(template)
  }
  return due
}

export function tick({ templates, now = new Date(), lastRun, run }) {
  const due = dueTemplates(templates, now, lastRun)
  for (const template of due) {
    Promise.resolve()
      .then(() => run(template))
      .catch(() => {})
  }
  return due
}
