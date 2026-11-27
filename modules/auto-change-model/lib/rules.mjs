const TOP_FIELDS = new Set(['enabled', 'timeZone', 'rules']);
const RULE_FIELDS = new Set([
  'id', 'enabled', 'priority', 'provider', 'model', 'reasoningEffort',
  'personas', 'weekdays', 'dates', 'start', 'end',
]);
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonemptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const validTime = (value) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

/** Return all configuration errors without mutating the supplied JSON value. */
export function validateConfig(config) {
  const errors = [];
  if (!isObject(config)) return ['config must be an object'];
  for (const key of Object.keys(config)) {
    if (!TOP_FIELDS.has(key)) errors.push(`config.${key} is an unknown field`);
  }
  if (owns(config, 'enabled') && typeof config.enabled !== 'boolean') {
    errors.push('config.enabled must be a boolean');
  }
  if (owns(config, 'timeZone')) {
    if (!nonemptyString(config.timeZone)) {
      errors.push('config.timeZone must be a nonempty string');
    } else {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone });
      } catch {
        errors.push('config.timeZone must be a valid Intl time zone');
      }
    }
  }
  if (!owns(config, 'rules')) return errors;
  if (!Array.isArray(config.rules)) return [...errors, 'config.rules must be an array'];
  const ids = new Set();
  config.rules.forEach((rule, index) => {
    const path = `config.rules[${index}]`;
    if (!isObject(rule)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const key of Object.keys(rule)) {
      if (!RULE_FIELDS.has(key)) errors.push(`${path}.${key} is an unknown field`);
    }
    for (const key of ['id', 'provider', 'model']) {
      if (!nonemptyString(rule[key])) errors.push(`${path}.${key} must be a nonempty string`);
    }
    if (nonemptyString(rule.id)) {
      if (ids.has(rule.id)) errors.push(`${path}.id must be unique`);
      ids.add(rule.id);
    }
    if (owns(rule, 'enabled') && typeof rule.enabled !== 'boolean') {
      errors.push(`${path}.enabled must be a boolean`);
    }
    if (owns(rule, 'priority') && (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority))) {
      errors.push(`${path}.priority must be a finite number`);
    }
    if (owns(rule, 'reasoningEffort') && typeof rule.reasoningEffort !== 'string') {
      errors.push(`${path}.reasoningEffort must be a string`);
    }
    for (const [key, predicate, description] of [
      ['personas', (value) => typeof value === 'string', 'strings'],
      ['weekdays', (value) => Number.isInteger(value) && value >= 1 && value <= 7, 'ISO weekday integers from 1 to 7'],
      ['dates', validDate, 'valid YYYY-MM-DD dates'],
    ]) {
      if (owns(rule, key) && (!Array.isArray(rule[key]) || !rule[key].every(predicate))) {
        errors.push(`${path}.${key} must be an array of ${description}`);
      }
    }
    if (owns(rule, 'start') !== owns(rule, 'end')) {
      errors.push(`${path}.start and end must be specified together`);
    }
    for (const key of ['start', 'end']) {
      if (owns(rule, key) && !validTime(rule[key])) errors.push(`${path}.${key} must be HH:mm (00:00–23:59)`);
    }
  });
  return errors;
}

function localClock(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  // UTC is used only as a calendar arithmetic container, never as the rule's zone.
  const day = new Date(0);
  const year = fields.era === 'BC' ? 1 - Number(fields.year) : Number(fields.year);
  day.setUTCFullYear(year, Number(fields.month) - 1, Number(fields.day));
  day.setUTCHours(0, 0, 0, 0);
  return { day, minute: Number(fields.hour) * 60 + Number(fields.minute) };
}

const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const constrained = (values) => Array.isArray(values) && values.length > 0;

/** Select the original winning rule object. Call validateConfig before using external input. */
export function selectRule(config = {}, { now = new Date(), personaId = '' } = {}) {
  if (config.enabled === false || !config.rules?.length) return null;
  const { day, minute } = localClock(now, config.timeZone ?? DEFAULT_TIME_ZONE);
  let winner = null;
  let bestPriority = -Infinity;
  for (const rule of config.rules) {
    if (rule.enabled === false) continue;
    if (constrained(rule.personas) && !rule.personas.includes(personaId)) continue;
    const startDay = new Date(day);
    if (rule.start !== undefined) {
      const start = minutes(rule.start);
      const end = minutes(rule.end);
      if (start < end && (minute < start || minute >= end)) continue;
      if (start > end) {
        if (minute >= end && minute < start) continue;
        if (minute < end) startDay.setUTCDate(startDay.getUTCDate() - 1);
      }
      // Equal endpoints mean all day, associated with the current local date.
    }
    const weekday = startDay.getUTCDay() || 7;
    const date = startDay.toISOString().slice(0, 10);
    if (constrained(rule.weekdays) && !rule.weekdays.includes(weekday)) continue;
    if (constrained(rule.dates) && !rule.dates.includes(date)) continue;
    const priority = rule.priority ?? 0;
    if (priority > bestPriority) {
      winner = rule;
      bestPriority = priority;
    }
  }
  return winner;
}
