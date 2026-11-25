import { UserError } from './errors.mjs';
export const DEFAULT_REST = { enabled: false, groups: [], start: '00:00', end: '07:00' };
const minute = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
  ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
export function validateRest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(DEFAULT_REST, k)) || typeof value.enabled !== 'boolean') throw new UserError('请选择是否启用休息时段。');
  if (!Array.isArray(value.groups) || value.groups.length > 100 || value.groups.some(id => typeof id !== 'string' || !/^[1-9]\d{4,11}$/.test(id))) throw new UserError('请填写 5～12 位数字群号，用换行或逗号分隔；最多 100 个群。');
  if (minute(value.start) === null || minute(value.end) === null || value.start === value.end) throw new UserError('请填写不同的开始、结束时间，格式如 00:00 和 07:00。');
  if (value.enabled && !value.groups.length) throw new UserError('请先填写需要休息的群号，其他群不会受影响。');
  return { enabled: value.enabled, groups: [...new Set(value.groups)], start: value.start, end: value.end };
}
export function isResting(settings, msg, now = new Date()) {
  if (msg.kind !== 'group') return false;
  const rest = settings.rest;
  if (!rest?.enabled || !Array.isArray(rest.groups) || !rest.groups.includes(String(msg.groupId))) return false;
  const start = minute(rest.start), end = minute(rest.end);
  if (start === null || end === null || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}
