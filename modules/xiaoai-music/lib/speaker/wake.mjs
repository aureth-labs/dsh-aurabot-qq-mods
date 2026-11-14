import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_WAKE_CONFIG = Object.freeze({
  names: Object.freeze(['小伴', '小半', '小办', '小瓣', '小拌', '小绊', '小扮', '小版']),
  greetingNames: Object.freeze([]),
  acknowledgement: '我在',
});

export function validateWakeConfig(value) {
  if (!value || !Array.isArray(value.names) || !Array.isArray(value.greetingNames) ||
      !value.names.length || value.names.length + value.greetingNames.length > 30) throw new Error('请填写有效的家庭称呼，最多30个。');
  const names = value.names.map(v => typeof v === 'string' ? v.trim() : '');
  const greetingNames = value.greetingNames.map(v => typeof v === 'string' ? v.trim() : '');
  const all = [...names, ...greetingNames];
  if (all.some(v => !/^[\p{L}\p{N}]{2,16}$/u.test(v)) || new Set(all).size !== all.length) {
    throw new Error('称呼需为2至16个文字或数字，且不能重复。');
  }
  const reply = value.acknowledgement;
  if (reply !== undefined && (typeof reply !== 'string' || reply.trim().length > 160)) {
    throw new Error('称呼应答最多160字。');
  }
  return { names, greetingNames, acknowledgement: reply?.trim() || DEFAULT_WAKE_CONFIG.acknowledgement };
}

export class WakePreference {
  constructor(file) { this.file = file; this.value = validateWakeConfig(DEFAULT_WAKE_CONFIG); this.queue = Promise.resolve(); }
  get() { return { ...this.value, names: [...this.value.names], greetingNames: [...this.value.greetingNames] }; }
  async open() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.schema !== 1) throw new Error();
      this.value = validateWakeConfig(data);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('家庭称呼设置不可读，未启用该配置。'); }
    return this.get();
  }
  save(value, expected) {
    let next, baseline;
    try {
      next = validateWakeConfig(value);
      if (expected !== undefined) baseline = JSON.stringify(validateWakeConfig(expected));
    } catch (error) { return Promise.reject(error); }
    const operation = this.queue.then(async () => {
      if (baseline !== undefined && baseline !== JSON.stringify(this.value)) {
        throw Object.assign(new Error('称呼设置已更新，请核对后再保存。'), { code: 'WAKE_SETTINGS_CHANGED' });
      }
      if (value.acknowledgement === undefined) next.acknowledgement = this.value.acknowledgement;
      const temporary = this.file + '.tmp-' + randomUUID();
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(temporary, JSON.stringify({ schema: 1, ...next }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } catch {
        await unlink(temporary).catch(() => {});
        throw new Error('家庭称呼设置未能保存，原设置保持不变。');
      }
      this.value = next;
      return this.get();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

export function matchWakePrefix(clean, value = DEFAULT_WAKE_CONFIG) {
  const { names } = validateWakeConfig(value);
  const escape = name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = items => [...items].sort((a, b) => b.length - a.length).map(escape).join('|');
  return new RegExp(`^(?:小爱同学|你好小爱)?(?:(?:你好|您好|嗨)?(?:${pattern(names)}))`, 'u').exec(clean);
}
