import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { FamilyReminders } from '../lib/companion/reminders.mjs';

const date = value => Date.parse(value);
const daily = time => ({ frequency: 'daily', time });
const once = (date = '2026-11-04', time = '09:30') => ({ frequency: 'once', date, time });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function harness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'family-reminders-isolated-'));
  let clock = date(options.now || '2026-11-04T08:00:00+08:00');
  let checks = 0;
  const calls = [], instances = [];
  const file = join(root, 'reminders.json');
  const create = overrides => {
    const service = new FamilyReminders({ file, now: () => clock,
      canDeliver: async () => { checks++; return true; },
      deliver: async (reminder, context) => { calls.push({ reminder, context }); return { accepted: true }; },
      ...options, ...overrides, now: () => clock });
    instances.push(service);
    return service;
  };
  const service = create();
  t.after(async () => {
    await Promise.all(instances.map(instance => instance.close().catch(() => {})));
    assert.ok(dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith('family-reminders-isolated-'), 'Unexpected temporary cleanup directory');
    await rm(root, { recursive: true, force: true });
  });
  await service.open();
  return { root, file, service, create, calls, checks: () => checks, set: value => { clock = date(value); } };
}

test('once uses Shanghai date and time, completes once across concurrent ticks and restart', async t => {
  const h = await harness(t);
  const reminder = await h.service.create({ text: '隔离一次提醒', schedule: once() });
  assert.equal(reminder.nextAt, '2026-11-04T01:30:00.000Z');
  assert.equal((await h.service.tick()).claimed, false);
  await h.service.close();
  const reopened = h.create(); await reopened.open();
  h.set('2026-11-04T09:30:00+08:00');
  await Promise.all([reopened.tick(), reopened.tick()]);
  assert.equal(h.calls.length, 1);
  assert.equal(reopened.list()[0].state, 'completed');
  assert.equal(reopened.list()[0].lastRun.state, 'sent');
  assert.equal((await reopened.cancel(reminder.id)).state, 'completed');
  await reopened.close();
  const finished = h.create(); await finished.open();
  h.set('2027-01-01T10:00:00+08:00');
  assert.equal((await finished.tick()).claimed, false);
  assert.equal(h.calls.length, 1);
});

test('once validates calendar dates and past times without changing existing periodic records', async t => {
  const h = await harness(t);
  await h.service.create({ text: '原有周期提醒', schedule: daily('08:00') });
  const before = await readFile(h.file, 'utf8');
  for (const schedule of [once('2026-02-30'), once('2026-13-01'), once('2026-11-03'), once('2026-11-04','07:59'), once('', '09:30'), once('2026-11-04','24:00')]) {
    await assert.rejects(h.service.create({ text: '隔离提醒', schedule }), { code: 'FAMILY_REMINDER_INPUT' });
  }
  assert.equal(await readFile(h.file, 'utf8'), before);
  const reopened = h.create(); await reopened.open();
  assert.equal(await readFile(h.file, 'utf8'), before);
});

test('once waits while busy and a failed attempt ends without replay', async t => {
  let idle = false;
  const h = await harness(t, { canDeliver: async () => idle, deliver: async () => ({ accepted: false }) });
  await h.service.create({ text: '隔离提醒', schedule: once() });
  h.set('2026-11-05T09:30:00+08:00');
  assert.equal((await h.service.tick()).claimed, false);
  assert.equal(h.service.list()[0].state, 'active');
  idle = true;
  assert.equal((await h.service.tick()).submitted, false);
  assert.equal(h.service.list()[0].state, 'completed');
  assert.equal(h.service.list()[0].lastRun.state, 'failed');
  await h.service.close();
  const reopened = h.create(); await reopened.open();
  assert.equal((await reopened.tick()).claimed, false);
});

test('once cancellation and interrupted claims do not replay after restart', async t => {
  const gate = deferred(), started = deferred();
  const h = await harness(t, { deliver: async () => { started.resolve(); await gate.promise; return { accepted: true }; } });
  const cancelled = await h.service.create({ text: '已取消', schedule: once() });
  await h.service.cancel(cancelled.id);
  await h.service.create({ text: '会中断', schedule: once() });
  h.set('2026-11-04T09:30:00+08:00');
  const pending = h.service.tick(); await started.promise;
  const claimedFile = await readFile(h.file, 'utf8');
  await h.service.close(); gate.resolve(); await pending;
  assert.equal(h.service.list()[1].state, 'completed');
  assert.equal(h.service.list()[1].lastRun.state, 'interrupted');
  // Restore the persisted sending snapshot to simulate process loss before close.
  await writeFile(h.file, claimedFile);
  const reopened = h.create(); await reopened.open();
  assert.equal(reopened.list()[1].state, 'completed');
  assert.equal(reopened.list()[1].lastRun.state, 'interrupted');
  assert.equal((await reopened.tick()).claimed, false);
});

test('daily, weekly and monthly schedules persist Shanghai occurrence times', async t => {
  const h = await harness(t);
  const day = await h.service.create({ text: '  喝水  ', schedule: daily('09:30') });
  const week = await h.service.create({ text: '散步', schedule: { frequency: 'weekly', time: '07:00', weekdays: [5, 1, 5] } });
  const month = await h.service.create({ text: '复查', schedule: { frequency: 'monthly', time: '08:00', monthDay: 31 } });
  assert.equal(day.text, '喝水');
  assert.equal(day.nextAt, '2026-11-04T01:30:00.000Z');
  assert.equal(day.timezone, 'Asia/Shanghai');
  assert.equal(day.state, 'active');
  assert.equal(day.lastRun, null);
  assert.deepEqual(week.schedule.weekdays, [1, 5]);
  assert.equal(week.nextAt, '2026-11-05T23:00:00.000Z');
  assert.equal(month.nextAt, '2026-12-31T00:00:00.000Z');
  const reopened = h.create();
  await reopened.open();
  assert.deepEqual(reopened.list(), h.service.list());
  const snapshot = reopened.list();
  snapshot[1].schedule.weekdays.push(7);
  assert.deepEqual(reopened.list()[1].schedule.weekdays, [1, 5]);
});

test('inclusive startsAt uses a zoned boundary and monthly day 31 skips February', async t => {
  const h = await harness(t, { now: '2027-01-31T08:00:00+08:00' });
  const month = await h.service.create({ text: '月提醒', schedule: { frequency: 'monthly', time: '08:00', monthDay: 31 } });
  assert.equal(month.nextAt, '2027-01-31T00:00:00.000Z');
  await h.service.tick();
  assert.equal(h.service.list()[0].nextAt, '2027-03-31T00:00:00.000Z');
  const future = await h.service.create({ text: '未来提醒', startsAt: '2027-02-01T10:00:00+08:00', schedule: daily('09:00') });
  assert.equal(future.nextAt, '2027-02-02T01:00:00.000Z');
});

test('invalid text, recurrence, time and unzoned startsAt cannot alter saved reminders', async t => {
  const h = await harness(t);
  await h.service.create({ text: '保留', schedule: daily('09:00') });
  const before = await readFile(h.file, 'utf8');
  for (const value of [
    { text: ' ', schedule: daily('09:00') },
    { text: '字'.repeat(501), schedule: daily('09:00') },
    { text: '测试', schedule: { frequency: 'yearly', time: '09:00' } },
    { text: '测试', schedule: daily('24:00') },
    { text: '测试', schedule: daily('9:00') },
    { text: '测试', schedule: { frequency: 'weekly', time: '09:00', weekdays: [] } },
    { text: '测试', schedule: { frequency: 'weekly', time: '09:00', weekdays: [0, 8] } },
    { text: '测试', schedule: { frequency: 'monthly', time: '09:00', monthDay: 32 } },
    { text: '测试', schedule: daily('09:00'), startsAt: '2026-11-05T08:00:00' },
    { text: '测试', schedule: daily('09:00'), startsAt: '2027-02-30T08:00:00+08:00' },
  ]) await assert.rejects(h.service.create(value), { code: 'FAMILY_REMINDER_INPUT' });
  assert.equal(await readFile(h.file, 'utf8'), before);
  await h.service.create({ text: '😀'.repeat(500), schedule: daily('09:00') });
});

test('no due reminder avoids readiness checks; busy defers without claiming', async t => {
  const h = await harness(t);
  assert.deepEqual(await h.service.tick(), { claimed: false });
  await h.service.create({ text: '稍后', schedule: daily('08:01') });
  await h.service.tick();
  assert.equal(h.checks(), 0);
  h.set('2026-11-04T08:01:00+08:00');
  h.service.canDeliver = async () => { return false; };
  const before = await readFile(h.file, 'utf8');
  assert.deepEqual(await h.service.tick(), { claimed: false });
  assert.equal(await readFile(h.file, 'utf8'), before);
  assert.equal(h.calls.length, 0);
  h.service.canDeliver = async () => true;
  assert.equal((await h.service.tick()).submitted, true);
});

test('one tick claims one occurrence durably, reentry cannot duplicate it, and later cycles continue', async t => {
  const entered = deferred(), release = deferred();
  const h = await harness(t);
  const reminder = await h.service.create({ text: '喝水', schedule: daily('08:00') });
  let deliveries = 0;
  h.service.deliver = async (value, { isCurrent }) => {
    deliveries++;
    const disk = JSON.parse(await readFile(h.file, 'utf8')).reminders[0];
    assert.equal(disk.lastRun.state, 'sending');
    assert.equal(disk.lastRun.id, value.lastRun.id);
    assert.equal(disk.lastRun.scheduledAt, reminder.nextAt);
    assert.equal(disk.nextAt, '2026-11-05T00:00:00.000Z');
    assert.equal(isCurrent(), true);
    entered.resolve();
    await release.promise;
    return { accepted: true };
  };
  const first = h.service.tick();
  await entered.promise;
  assert.equal(h.service.tick(), first);
  await assert.rejects(h.service.cancel(reminder.id), { code: 'FAMILY_REMINDER_SENDING' });
  release.resolve();
  assert.equal((await first).submitted, true);
  assert.equal(deliveries, 1);
  assert.equal(h.service.list()[0].lastRun.state, 'sent');
  await h.service.tick();
  assert.equal(deliveries, 1);
  h.set('2026-11-05T08:00:00+08:00');
  h.service.deliver = async () => { deliveries++; return { accepted: true }; };
  assert.equal((await h.service.tick()).submitted, true);
  assert.equal(deliveries, 2);
  assert.equal(h.service.list()[0].nextAt, '2026-11-06T00:00:00.000Z');
});

test('overdue recurrences submit once and skip the missed backlog', async t => {
  const h = await harness(t);
  await h.service.create({ text: '积压提醒', schedule: daily('08:00') });
  h.set('2026-11-10T12:00:00+08:00');
  await h.service.tick();
  const [reminder] = h.service.list();
  assert.equal(reminder.lastRun.scheduledAt, '2026-11-04T00:00:00.000Z');
  assert.equal(reminder.nextAt, '2026-11-11T00:00:00.000Z');
  await h.service.tick();
  assert.equal(h.calls.length, 1);
});

test('cancelled reminders persist and a cancellation during readiness cannot be claimed', async t => {
  const entered = deferred(), release = deferred();
  const h = await harness(t, { canDeliver: async () => { entered.resolve(); return release.promise; } });
  const reminder = await h.service.create({ text: '取消提醒', schedule: daily('08:00') });
  const tick = h.service.tick();
  await entered.promise;
  assert.equal((await h.service.cancel(reminder.id)).state, 'cancelled');
  release.resolve(true);
  assert.deepEqual(await tick, { claimed: false });
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.service.cancel('missing'), { code: 'FAMILY_REMINDER_MISSING' });
  const reopened = h.create(); await reopened.open();
  assert.equal(reopened.list()[0].state, 'cancelled');
  assert.equal((await reopened.cancel(reminder.id)).state, 'cancelled');
  await reopened.tick();
  assert.equal(h.calls.length, 0);
});

test('concurrent creates and cancellation retain every record after reload', async t => {
  const h = await harness(t);
  const first = await h.service.create({ text: '先取消', schedule: daily('08:00') });
  await Promise.all([
    h.service.create({ text: '第二条', schedule: daily('09:00') }),
    h.service.cancel(first.id),
    h.service.create({ text: '第三条', schedule: daily('10:00') }),
  ]);
  const reopened = h.create(); await reopened.open();
  assert.deepEqual(reopened.list().map(item => [item.text, item.state]), [
    ['先取消', 'cancelled'], ['第二条', 'active'], ['第三条', 'active'],
  ]);
});

test('delivery errors or nonacceptance remain fixed failed status and are not retried this cycle', async t => {
  const h = await harness(t);
  let calls = 0;
  h.service.deliver = async () => { calls++; throw new Error('synthetic-upstream-private-body'); };
  await h.service.create({ text: '失败提醒', schedule: daily('08:00') });
  const failed = await h.service.tick();
  assert.equal(failed.submitted, false);
  assert.equal(failed.reminder.lastRun.state, 'failed');
  assert.equal(failed.reminder.lastRun.error.code, 'FAMILY_REMINDER_DELIVERY_FAILED');
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-upstream-private-body/);
  assert.doesNotMatch(await readFile(h.file, 'utf8'), /synthetic-upstream-private-body/);
  await h.service.tick();
  assert.equal(calls, 1);
  h.set('2026-11-05T08:00:00+08:00');
  h.service.deliver = async () => { calls++; return undefined; };
  assert.equal((await h.service.tick()).reminder.lastRun.state, 'failed');
  assert.equal(calls, 2);
});

test('readiness errors expose a fixed message and leave the occurrence pending', async t => {
  const h = await harness(t, { canDeliver: async () => { throw new Error('synthetic-private-check'); } });
  await h.service.create({ text: '待检查', schedule: daily('08:00') });
  const before = await readFile(h.file, 'utf8');
  await assert.rejects(h.service.tick(), error => {
    assert.equal(error.code, 'FAMILY_REMINDER_CHECK_FAILED');
    assert.doesNotMatch(error.message, /synthetic-private-check/);
    return true;
  });
  assert.equal(await readFile(h.file, 'utf8'), before);
  assert.equal(h.calls.length, 0);
});

test('failed claim persistence never calls delivery and preserves the saved occurrence', async t => {
  const h = await harness(t);
  await h.service.create({ text: '保存失败', schedule: daily('08:00') });
  const before = await readFile(h.file, 'utf8');
  const blocked = join(h.root, 'not-a-directory'); await writeFile(blocked, 'synthetic-block');
  h.service.file = join(blocked, 'reminders.json');
  await assert.rejects(h.service.tick(), { code: 'FAMILY_REMINDER_STORAGE' });
  assert.equal(await readFile(h.file, 'utf8'), before);
  assert.equal(h.service.list()[0].lastRun, null);
  assert.equal(h.calls.length, 0);
  h.service.file = h.file;
  assert.equal((await h.service.tick()).submitted, true);
});

test('failed completion persistence leaves an interrupted occurrence on restart without replay', async t => {
  const h = await harness(t);
  const blocked = join(h.root, 'not-a-directory'); await writeFile(blocked, 'synthetic-block');
  await h.service.create({ text: '提交后保存失败', schedule: daily('08:00') });
  h.service.deliver = async () => { h.service.file = join(blocked, 'reminders.json'); return { accepted: true }; };
  await assert.rejects(h.service.tick(), { code: 'FAMILY_REMINDER_STORAGE' });
  assert.equal(JSON.parse(await readFile(h.file, 'utf8')).reminders[0].lastRun.state, 'sending');
  const restarted = h.create(); await restarted.open();
  assert.equal(restarted.list()[0].lastRun.state, 'interrupted');
  await restarted.tick();
  assert.equal(h.calls.length, 0);
  h.service.file = h.file; await h.service.close();
  h.set('2026-11-05T08:00:00+08:00');
  assert.equal((await restarted.tick()).submitted, true);
  assert.equal(h.calls.length, 1);
});

test('close invalidates an outstanding readiness check before any occurrence is claimed', async t => {
  const entered = deferred(), release = deferred();
  const h = await harness(t, { canDeliver: async () => { entered.resolve(); return release.promise; } });
  await h.service.create({ text: '关闭前', schedule: daily('08:00') });
  const before = await readFile(h.file, 'utf8');
  const tick = h.service.tick(); await entered.promise;
  await h.service.close();
  release.resolve(true); await tick;
  assert.equal(h.calls.length, 0);
  assert.equal(await readFile(h.file, 'utf8'), before);
  assert.deepEqual(await h.service.tick(), { claimed: false, closed: true });
  await assert.rejects(h.service.create({ text: '关闭后', schedule: daily('09:00') }), { code: 'FAMILY_REMINDER_CLOSED' });
});

test('close during claim persistence prevents entering delivery and records interruption', async t => {
  const entered = deferred(), release = deferred();
  const h = await harness(t);
  await h.service.create({ text: '领取后关闭', schedule: daily('08:00') });
  const persist = h.service.persist.bind(h.service);
  h.service.persist = async next => {
    if (next.some(item => item.lastRun?.state === 'sending')) { entered.resolve(); await release.promise; }
    return persist(next);
  };
  const tick = h.service.tick(); await entered.promise;
  const closing = h.service.close();
  release.resolve();
  await closing; await tick;
  assert.equal(h.calls.length, 0);
  assert.equal(JSON.parse(await readFile(h.file, 'utf8')).reminders[0].lastRun.state, 'interrupted');
  const restarted = h.create(); await restarted.open(); await restarted.tick();
  assert.equal(h.calls.length, 0);
});

test('close invalidates delivery context and its late result cannot overwrite the reopened service', async t => {
  const entered = deferred(), release = deferred();
  const h = await harness(t);
  await h.service.create({ text: '延迟提交', schedule: daily('08:00') });
  let current;
  h.service.deliver = async (_value, { isCurrent }) => {
    current = isCurrent;
    entered.resolve(); await release.promise;
    return { accepted: isCurrent() };
  };
  const tick = h.service.tick(); await entered.promise;
  assert.equal(current(), true);
  await h.service.close();
  assert.equal(current(), false);
  const restarted = h.create(); await restarted.open();
  await restarted.create({ text: '重开后新增', schedule: daily('10:00') });
  const before = await readFile(h.file, 'utf8');
  release.resolve();
  assert.equal((await tick).interrupted, true);
  assert.equal(await readFile(h.file, 'utf8'), before);
  assert.equal(restarted.list()[0].lastRun.state, 'interrupted');
  assert.equal(restarted.list().length, 2);
});

test('damaged JSON and invalid schema records reject without allowing overwrite', async t => {
  const h = await harness(t);
  await h.service.create({ text: '原条目', schedule: daily('09:00') });
  const original = JSON.parse(await readFile(h.file, 'utf8'));
  const badTime = structuredClone(original); badTime.reminders[0].nextAt = 'not-a-time';
  const duplicate = structuredClone(original); duplicate.reminders.push(structuredClone(duplicate.reminders[0]));
  for (const contents of ['{broken-json', JSON.stringify({ schema: 2, reminders: [] }), JSON.stringify(badTime), JSON.stringify(duplicate)]) {
    await writeFile(h.file, contents);
    const service = h.create();
    await assert.rejects(service.open(), { code: 'FAMILY_REMINDER_INVALID' });
    await assert.rejects(service.create({ text: '不覆盖', schedule: daily('10:00') }), { code: 'FAMILY_REMINDER_INVALID' });
    assert.equal(await readFile(h.file, 'utf8'), contents);
  }
});
