import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { preserveFailedPreference, readPreference } from './preference-file.mjs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ListenerPreference {
  constructor(file) { this.file = file; this.enabled = false; this.queue = Promise.resolve(); }
  async open() {
    const result = await readPreference(this.file, '常驻入口开关', value => {
      if (value?.schema !== 1 || typeof value.enabled !== 'boolean') throw new Error();
      return value.enabled;
    });
    this.enabled = result.value ?? false;
    this.error = result.error;
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('常驻入口开关不可用。'));
    const operation = this.queue.then(async () => {
      if (!enabled) this.enabled = false;
      const temporary = this.file + '.tmp-' + randomUUID();
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(temporary, JSON.stringify({ schema: 1, enabled }), { mode: 0o600 });
        await preserveFailedPreference(this.file, this.error);
        await rename(temporary, this.file);
      } catch {
        await unlink(temporary).catch(() => {});
        if (!enabled) this.enabled = false;
        throw new Error('常驻入口开关未能保存。');
      }
      this.enabled = enabled;
      this.error = undefined;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
