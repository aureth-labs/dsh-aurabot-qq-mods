import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, selectRule } from '../lib/rules.mjs';

const rule = (overrides = {}) => ({ id: 'rule', provider: 'provider', model: 'model', ...overrides });
const at = (config, instant, personaId = '') => selectRule(config, { now: new Date(instant), personaId });
const configWith = (overrides, timeZone = 'Asia/Shanghai') => ({ timeZone, rules: [rule(overrides)] });

test('defaults, no mutation, and original rule identity', () => {
  assert.deepEqual(validateConfig({}), []);
  assert.equal(selectRule(), null);
  assert.equal(selectRule({}), null);
  assert.equal(selectRule({ rules: [] }), null);
  const r = Object.freeze(rule());
  const config = Object.freeze({ rules: Object.freeze([r]) });
  assert.deepEqual(validateConfig(config), []);
  assert.equal(at(config, '2026-01-01T00:00:00Z'), r);
});

test('inclusive start, exclusive end, minute precision, and default zone', () => {
  const config = { rules: [rule({ start: '09:00', end: '10:00' })] };
  for (const [instant, matches] of [
    ['2026-06-01T00:59:59.999Z', false],
    ['2026-06-01T01:00:00Z', true],
    ['2026-06-01T01:59:59.999Z', true],
    ['2026-06-01T02:00:00Z', false],
  ]) assert.equal(Boolean(at(config, instant)), matches, instant);
});

test('midnight, end at midnight, and equal endpoints are all-day', () => {
  const midnight = configWith({ start: '00:00', end: '01:00' });
  assert.ok(at(midnight, '2026-06-01T16:00:00Z'));
  assert.equal(at(midnight, '2026-06-01T17:00:00Z'), null);
  const untilMidnight = configWith({ start: '23:00', end: '00:00' });
  assert.ok(at(untilMidnight, '2026-06-01T15:59:59Z'));
  assert.equal(at(untilMidnight, '2026-06-01T16:00:00Z'), null);
  const allDay = configWith({ start: '12:00', end: '12:00', dates: ['2026-06-02'] });
  assert.ok(at(allDay, '2026-06-01T16:00:00Z'));
  assert.ok(at(allDay, '2026-06-02T04:00:00Z'));
  assert.ok(at(allDay, '2026-06-02T15:59:59Z'));
  assert.equal(at(allDay, '2026-06-02T16:00:00Z'), null);
});

test('overnight weekday and date both refer to start day across week/year', () => {
  const config = configWith({ start: '22:00', end: '02:00', weekdays: [7], dates: ['2025-12-28'] }, 'UTC');
  assert.ok(at(config, '2025-12-28T22:00:00Z'));
  assert.ok(at(config, '2025-12-29T00:00:00Z'));
  assert.ok(at(config, '2025-12-29T01:59:59Z'));
  assert.equal(at(config, '2025-12-29T02:00:00Z'), null);
  assert.equal(at(config, '2025-12-28T01:00:00Z'), null);
  assert.equal(at(config, '2025-12-29T22:00:00Z'), null);
  const year = configWith({ start: '23:00', end: '03:00', dates: ['2024-12-31'], weekdays: [2] }, 'UTC');
  assert.ok(at(year, '2025-01-01T02:59:00Z'));
  assert.equal(at(year, '2025-01-01T03:00:00Z'), null);
  const leap = configWith({ start: '23:00', end: '03:00', dates: ['2024-02-29'] }, 'UTC');
  assert.ok(at(leap, '2024-03-01T01:00:00Z'));
});

test('DST spring gap follows wall time and fall overlap matches twice', () => {
  const spring = configWith({ start: '01:30', end: '03:30' }, 'America/New_York');
  assert.equal(at(spring, '2026-03-08T06:29:59Z'), null);
  assert.ok(at(spring, '2026-03-08T06:30:00Z'));
  assert.ok(at(spring, '2026-03-08T07:00:00Z'));
  assert.equal(at(spring, '2026-03-08T07:30:00Z'), null);
  const fall = configWith({ start: '01:00', end: '02:00' }, 'America/New_York');
  assert.ok(at(fall, '2026-11-01T05:30:00Z'));
  assert.ok(at(fall, '2026-11-01T06:30:00Z'));
  assert.equal(at(fall, '2026-11-01T07:00:00Z'), null);
  const overnight = configWith({ start: '22:00', end: '03:30', dates: ['2026-03-07'], weekdays: [6] }, 'America/New_York');
  assert.ok(at(overnight, '2026-03-08T07:00:00Z'));
});

test('personas, dates, weekdays and time are AND conditions', () => {
  const config = configWith({ personas: ['alice'], dates: ['2026-06-01'], weekdays: [1], start: '09:00', end: '10:00' }, 'UTC');
  assert.ok(at(config, '2026-06-01T09:30:00Z', 'alice'));
  assert.equal(at(config, '2026-06-01T09:30:00Z', 'bob'), null);
  assert.equal(at(config, '2026-06-01T09:30:00Z'), null);
  assert.equal(at(config, '2026-06-08T09:30:00Z', 'alice'), null);
  assert.equal(at(config, '2026-06-01T11:00:00Z', 'alice'), null);
  config.rules[0].weekdays = [2];
  assert.equal(at(config, '2026-06-01T09:30:00Z', 'alice'), null);
});

test('larger priority wins, ties keep array order, fallback has no special precedence', () => {
  const fallback = rule({ id: 'fallback', priority: -1 });
  const alice = rule({ id: 'alice', personas: ['alice'], priority: 3 });
  const tie = rule({ id: 'tie', priority: 3 });
  const config = { rules: [fallback, alice, tie] };
  assert.equal(at(config, '2026-01-01T00:00:00Z', 'alice'), alice);
  assert.equal(at(config, '2026-01-01T00:00:00Z', 'bob'), tie);
  tie.enabled = false;
  assert.equal(at(config, '2026-01-01T00:00:00Z', 'bob'), fallback);
  fallback.priority = 4;
  assert.equal(at(config, '2026-01-01T00:00:00Z', 'alice'), fallback);
  assert.equal(at({ rules: [rule({ id: 'negative', priority: -1 }), rule()] }, '2026-01-01T00:00:00Z').id, 'rule');
});

test('empty arrays impose no constraints; disabled config/rules never match', () => {
  const config = configWith({ personas: [], weekdays: [], dates: [] });
  assert.ok(at(config, '2026-01-01T00:00:00Z'));
  config.enabled = false;
  assert.equal(at(config, '2026-01-01T00:00:00Z'), null);
  config.enabled = true;
  config.rules[0].enabled = false;
  assert.equal(at(config, '2026-01-01T00:00:00Z'), null);
});

test('valid dates use Gregorian leap-year and month lengths', () => {
  for (const date of ['2024-02-29', '2000-02-29', '2026-04-30', '0000-02-29', '0099-12-31']) {
    assert.deepEqual(validateConfig(configWith({ dates: [date] })), [], date);
  }
  for (const date of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-01-32', '2026-1-01', '2026-01-1', '2026-01-01T00:00:00Z', '', 20260101]) {
    assert.ok(validateConfig(configWith({ dates: [date] })).length > 0, String(date));
  }
});

test('four-digit years below 100 retain their calendar year', () => {
  assert.ok(at(configWith({ dates: ['0099-12-31'] }, 'UTC'), '0099-12-31T12:00:00Z'));
  assert.ok(at(configWith({ dates: ['0000-02-29'] }, 'UTC'), '0000-02-29T12:00:00Z'));
});

test('arbitrary JSON inputs never throw and malformed configurations fail', () => {
  for (const config of [null, false, true, 0, 1, '', 'config', [], [null], { rules: null }, { rules: {} }, { rules: [null, false, 1, '', []] }]) {
    assert.doesNotThrow(() => validateConfig(config));
    assert.ok(validateConfig(config).length > 0, JSON.stringify(config));
  }
  for (const patch of [{ enabled: 1 }, { timeZone: null }, { timeZone: '' }, { timeZone: 'No/Such_Zone' }, { unknown: true }]) {
    assert.ok(validateConfig(patch).length > 0, JSON.stringify(patch));
  }
  assert.deepEqual(validateConfig({ timeZone: 'UTC' }), []);
  assert.deepEqual(validateConfig({ timeZone: 'America/New_York' }), []);
});

test('strict rule fields, unknown fields, and duplicate IDs including disabled rules', () => {
  for (const patch of [
    { id: '' }, { id: '  ' }, { id: 1 }, { provider: '' }, { provider: null }, { model: false },
    { enabled: 'true' }, { priority: '1' }, { priority: null }, { priority: Infinity }, { priority: NaN },
    { reasoningEffort: 1 }, { personas: 'alice' }, { personas: [1] }, { personas: null },
    { weekdays: [0] }, { weekdays: [8] }, { weekdays: [1.5] }, { weekdays: ['1'] },
    { dates: '2026-01-01' }, { start: '09:00' }, { end: '10:00' },
    { start: '24:00', end: '10:00' }, { start: '9:00', end: '10:00' },
    { start: '09:60', end: '10:00' }, { start: null, end: null }, { typo: true },
  ]) assert.ok(validateConfig(configWith(patch)).length > 0, JSON.stringify(patch));
  assert.ok(validateConfig({ rules: [rule(), rule({ enabled: false })] }).some((error) => error.includes('unique')));
  assert.ok(validateConfig({ rules: [{}] }).length >= 3);
  assert.deepEqual(validateConfig(configWith({ priority: -0.5, reasoningEffort: '', personas: [''], weekdays: [], dates: [] })), []);
});
