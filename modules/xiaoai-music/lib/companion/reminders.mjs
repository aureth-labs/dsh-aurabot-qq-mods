import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

const OFFSET = 8 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const runStates = ['sending', 'sent', 'failed', 'interrupted'];
const messages = {
  FAMILY_REMINDER_CONFIG: '提醒服务配置不可用。',
  FAMILY_REMINDER_INPUT: '请填写500字以内的提醒内容，并选择有效的周期计划或尚未到时的一次提醒日期与时间。',
  FAMILY_REMINDER_INVALID: '提醒文件无法读取，原文件已保留。',
  FAMILY_REMINDER_STORAGE: '提醒状态未能保存，未自动重试本次投送。',
  FAMILY_REMINDER_CLOSED: '提醒服务已关闭。',
  FAMILY_REMINDER_MISSING: '未找到这条提醒。',
  FAMILY_REMINDER_SENDING: '这条提醒正在投送，不能将本次执行标为已取消。',
  FAMILY_REMINDER_CHECK_FAILED: '暂时无法检查提醒投送状态。',
  FAMILY_REMINDER_DELIVERY_FAILED: '本次提醒未能提交播放，未自动重试。',
};

export class FamilyReminderError extends Error {
  constructor(code) { super(messages[code] || messages.FAMILY_REMINDER_INVALID); this.code = code; }
}
const copy = value => JSON.parse(JSON.stringify(value));
const iso = value => new Date(value).toISOString();
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value);
const inputError = () => new FamilyReminderError('FAMILY_REMINDER_INPUT');

function timestamp(value) {
  if (typeof value !== 'string') throw inputError();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw inputError();
  const [, y, m, d, h, minute, second = '0', , zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > days ||
      Number(h) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))) throw inputError();
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw inputError();
  return result;
}

function scheduleOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['daily', 'weekly', 'monthly', 'once'].includes(value.frequency) ||
      typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw inputError();
  const result = { frequency: value.frequency, time: value.time };
  if (value.frequency === 'once') {
    if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw inputError();
    timestamp(value.date + 'T' + value.time + ':00+08:00');
    result.date = value.date;
  }
  if (value.frequency === 'weekly') {
    if (!Array.isArray(value.weekdays) || !value.weekdays.length ||
        value.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw inputError();
    result.weekdays = [...new Set(value.weekdays)].sort((a, b) => a - b);
  }
  if (value.frequency === 'monthly') {
    if (!Number.isInteger(value.monthDay) || value.monthDay < 1 || value.monthDay > 31) throw inputError();
    result.monthDay = value.monthDay;
  }
  return result;
}

// Asia/Shanghai uses UTC+08 for the current and future schedules accepted here.
// A monthly date missing from a month is skipped, never clamped to month-end.
function nextOccurrence(schedule, minimum) {
  if (schedule.frequency === 'once') {
    const target = timestamp(schedule.date + 'T' + schedule.time + ':00+08:00');
    if (target < minimum) throw inputError();
    return target;
  }
  const local = new Date(minimum + OFFSET);
  const year = local.getUTCFullYear(), month = local.getUTCMonth();
  const [hour, minute] = schedule.time.split(':').map(Number);
  if (schedule.frequency === 'monthly') {
    for (let step = 0; step <= 12; step++) {
      const first = new Date(Date.UTC(year, month + step, 1));
      if (first.getUTCFullYear() > 9999) break;
      const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      if (schedule.monthDay > days) continue;
      const candidate = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), schedule.monthDay, hour, minute) - OFFSET;
      if (candidate >= minimum) return candidate;
    }
  } else {
    const midnight = Date.UTC(year, month, local.getUTCDate()) - OFFSET;
    for (let step = 0; step <= 7; step++) {
      const day = midnight + step * DAY;
      const weekday = ((new Date(day + OFFSET).getUTCDay() + 6) % 7) + 1;
      const candidate = day + (hour * 60 + minute) * 60000;
      if (candidate >= minimum && (schedule.frequency === 'daily' || schedule.weekdays.includes(weekday))) return candidate;
    }
  }
  throw inputError();
}

function validRecord(value) {
  try {
    if (!value || !safeId(value.id) || typeof value.text !== 'string' || !value.text.trim() || [...value.text].length > 500 ||
        !['active', 'cancelled', 'completed'].includes(value.state) || value.timezone !== 'Asia/Shanghai') return false;
    const schedule = scheduleOf(value.schedule);
    const once = schedule.frequency === 'once';
    if (value.state === 'completed' && (!once || !value.lastRun || value.lastRun.state === 'sending')) return false;
    if (once && value.lastRun && value.state !== (value.lastRun.state === 'sending' ? 'active' : 'completed')) return false;
    const start = timestamp(value.startsAt), next = timestamp(value.nextAt);
    if (next < start || nextOccurrence(schedule, next) !== next) return false;
    if (value.lastRun !== null) {
      const run = value.lastRun;
      if (!run || !safeId(run.id) || !runStates.includes(run.state)) return false;
      const scheduled = timestamp(run.scheduledAt);
      if (scheduled < start || (once ? scheduled !== next : scheduled >= next) || nextOccurrence(schedule, scheduled) !== scheduled) return false;
      if (run.error && (run.error.code !== 'FAMILY_REMINDER_DELIVERY_FAILED' ||
          run.error.message !== messages.FAMILY_REMINDER_DELIVERY_FAILED)) return false;
    }
    return true;
  } catch { return false; }
}

export class FamilyReminders {
  constructor({ file, deliver, canDeliver, now = Date.now }) {
    if (typeof file !== 'string' || !isAbsolute(file) || typeof deliver !== 'function' ||
        typeof canDeliver !== 'function' || typeof now !== 'function') throw new FamilyReminderError('FAMILY_REMINDER_CONFIG');
    Object.assign(this, { file, deliver, canDeliver, now });
    this.reminders = [];
    this.queue = Promise.resolve();
    this.opened = false;
    this.closed = false;
    this.generation = 0;
    this.ticking = null;
    this.closing = null;
  }
  time() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) throw inputError();
    return value;
  }
  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  assertOpen() {
    if (this.closed) throw new FamilyReminderError('FAMILY_REMINDER_CLOSED');
    if (!this.opened) throw new FamilyReminderError('FAMILY_REMINDER_INVALID');
  }
  async persist(next) {
    const temporary = this.file + '.tmp-' + randomUUID();
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(temporary, JSON.stringify({ schema: 1, reminders: next }, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } catch {
      await unlink(temporary).catch(() => {});
      throw new FamilyReminderError('FAMILY_REMINDER_STORAGE');
    }
    this.reminders = next;
  }
  open() {
    return this.enqueue(async () => {
      if (this.closed) throw new FamilyReminderError('FAMILY_REMINDER_CLOSED');
      if (this.opened) return this.list();
      let value;
      try { value = JSON.parse(await readFile(this.file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new FamilyReminderError('FAMILY_REMINDER_INVALID');
        if (this.closed) throw new FamilyReminderError('FAMILY_REMINDER_CLOSED');
        this.opened = true;
        return this.list();
      }
      if (value?.schema !== 1 || !Array.isArray(value.reminders) || value.reminders.some(record => !validRecord(record)) ||
          new Set(value.reminders.map(record => record.id)).size !== value.reminders.length) {
        throw new FamilyReminderError('FAMILY_REMINDER_INVALID');
      }
      if (this.closed) throw new FamilyReminderError('FAMILY_REMINDER_CLOSED');
      const recovered = value.reminders.map(record => record.lastRun?.state === 'sending'
        ? { ...record, state: record.schedule.frequency === 'once' ? 'completed' : record.state, lastRun: { ...record.lastRun, state: 'interrupted' } } : record);
      if (value.reminders.some(record => record.lastRun?.state === 'sending')) await this.persist(recovered);
      else this.reminders = recovered;
      this.opened = true;
      return this.list();
    });
  }
  list() { return copy(this.reminders); }
  create(value = {}) {
    return this.enqueue(async () => {
      this.assertOpen();
      const text = typeof value?.text === 'string' ? value.text.trim() : '';
      if (!text || [...text].length > 500) throw inputError();
      const schedule = scheduleOf(value.schedule);
      const now = this.time(), start = value.startsAt === undefined ? now : timestamp(value.startsAt);
      const reminder = { id: randomUUID(), text, schedule, timezone: 'Asia/Shanghai', startsAt: iso(start),
        nextAt: iso(nextOccurrence(schedule, Math.max(start, now))), state: 'active', lastRun: null };
      await this.persist([...this.reminders, reminder]);
      return copy(reminder);
    });
  }
  cancel(id) {
    return this.enqueue(async () => {
      this.assertOpen();
      const reminder = this.reminders.find(item => item.id === id);
      if (!reminder) throw new FamilyReminderError('FAMILY_REMINDER_MISSING');
      if (reminder.lastRun?.state === 'sending') throw new FamilyReminderError('FAMILY_REMINDER_SENDING');
      if (reminder.state !== 'active') return copy(reminder);
      const cancelled = { ...reminder, state: 'cancelled' };
      await this.persist(this.reminders.map(item => item.id === id ? cancelled : item));
      return copy(cancelled);
    });
  }
  tick() {
    if (this.closed) return Promise.resolve({ claimed: false, closed: true });
    if (this.ticking) return this.ticking;
    const ticket = this.generation;
    const ticking = this.runTick(ticket);
    this.ticking = ticking;
    ticking.finally(() => { if (this.ticking === ticking) this.ticking = null; }).catch(() => {});
    return ticking;
  }
  async runTick(ticket) {
    this.assertOpen();
    const now = this.time();
    const due = this.reminders.filter(item => item.state === 'active' && item.lastRun?.state !== 'sending' && timestamp(item.nextAt) <= now)
      .sort((a, b) => timestamp(a.nextAt) - timestamp(b.nextAt))[0];
    if (!due) return { claimed: false };
    let idle;
    try { idle = await this.canDeliver(); }
    catch {
      if (this.closed || ticket !== this.generation) return { claimed: false, closed: true };
      throw new FamilyReminderError('FAMILY_REMINDER_CHECK_FAILED');
    }
    if (!idle || this.closed || ticket !== this.generation) return { claimed: false };
    const claimed = await this.enqueue(async () => {
      if (this.closed || ticket !== this.generation) return null;
      const current = this.reminders.find(item => item.id === due.id);
      const now = this.time();
      if (!current || current.state !== 'active' || current.lastRun?.state === 'sending' || timestamp(current.nextAt) > now) return null;
      const run = { id: randomUUID(), scheduledAt: current.nextAt, state: 'sending' };
      const next = { ...current, nextAt: current.schedule.frequency === 'once' ? current.nextAt : iso(nextOccurrence(current.schedule, Math.max(now, timestamp(current.nextAt)) + 1)), lastRun: run };
      await this.persist(this.reminders.map(item => item.id === next.id ? next : item));
      return copy(next);
    });
    if (!claimed) return { claimed: false };
    const isCurrent = () => !this.closed && ticket === this.generation && this.reminders.some(item =>
      item.id === claimed.id && item.state === 'active' && item.lastRun?.id === claimed.lastRun.id && item.lastRun.state === 'sending');
    if (!isCurrent()) return { claimed: true, submitted: false, interrupted: true };
    let accepted = false;
    try { accepted = (await this.deliver(copy(claimed), { isCurrent }))?.accepted === true; }
    catch {}
    if (!isCurrent()) return { claimed: true, submitted: false, interrupted: true };
    const completed = await this.enqueue(async () => {
      if (!isCurrent()) return null;
      const lastRun = { ...claimed.lastRun, state: accepted ? 'sent' : 'failed' };
      if (!accepted) lastRun.error = { code: 'FAMILY_REMINDER_DELIVERY_FAILED', message: messages.FAMILY_REMINDER_DELIVERY_FAILED };
      const next = this.reminders.map(item => item.id === claimed.id ? { ...item, state: item.schedule.frequency === 'once' ? 'completed' : item.state, lastRun } : item);
      await this.persist(next);
      return copy(next.find(item => item.id === claimed.id));
    });
    return completed ? { claimed: true, submitted: accepted, reminder: completed }
      : { claimed: true, submitted: false, interrupted: true };
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.generation++;
    this.closing = this.enqueue(async () => {
      if (!this.opened || !this.reminders.some(item => item.lastRun?.state === 'sending')) return;
      await this.persist(this.reminders.map(item => item.lastRun?.state === 'sending'
        ? { ...item, state: item.schedule.frequency === 'once' ? 'completed' : item.state, lastRun: { ...item.lastRun, state: 'interrupted' } } : item));
    });
    return this.closing;
  }
}
