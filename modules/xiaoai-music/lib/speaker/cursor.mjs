import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';

export function recordKey(record) {
  return createHash('sha256').update(JSON.stringify([record.time, record.requestId, record.query])).digest('hex');
}

export class VoiceCursor {
  constructor(file) {
    this.file = file;
    this.state = { since: 0, claimed: [] };
    this.pending = Promise.resolve();
  }
  async open() {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Number.isSafeInteger(value.since) || !Array.isArray(value.claimed) ||
          value.claimed.some((x) => !/^[a-f0-9]{64}$/.test(x))) throw new Error();
      if (Object.hasOwn(value, 'claimedAt') && (!value.claimedAt || typeof value.claimedAt !== 'object' ||
          Array.isArray(value.claimedAt) || Object.entries(value.claimedAt).some(([key, time]) =>
            !/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(time) || time < 0))) throw new Error();
      this.state = value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('语音游标损坏，未启动监听。');
    }
  }
  async save(next) {
    const temporary = this.file + '.tmp-' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    this.state = next;
  }
  enqueue(operation) {
    const pending = this.pending.then(operation);
    this.pending = pending.catch(() => {});
    return pending;
  }
  begin(now) {
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('语音游标时间不可用。');
      await this.save({ since: now, claimed: [], claimedAt: {} });
    });
  }
  claim(record) {
    return this.enqueue(async () => {
      const key = recordKey(record);
      if (record.time < this.state.since || this.state.claimed.includes(key)) return false;
      await this.save({ ...this.state, claimed: [...this.state.claimed, key],
        claimedAt: { ...this.state.claimedAt, [key]: record.time } });
      return true;
    });
  }
  advance(now, { overlapMs = 60000 } = {}) {
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(overlapMs) || overlapMs < 0) {
        throw new Error('语音游标时间不可用。');
      }
      const since = Math.max(this.state.since, now - overlapMs);
      if (since === this.state.since) return false;
      const claimedAt = this.state.claimedAt || {};
      // Legacy hashes have no timestamp; retain them until the next explicit begin.
      const claimed = this.state.claimed.filter(key => !Object.hasOwn(claimedAt, key) || claimedAt[key] >= since);
      await this.save({ ...this.state, since, claimed,
        claimedAt: Object.fromEntries(claimed.filter(key => Object.hasOwn(claimedAt, key)).map(key => [key, claimedAt[key]])) });
      return true;
    });
  }
}
