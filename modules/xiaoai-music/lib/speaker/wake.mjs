import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { preserveFailedPreference, readPreference } from './preference-file.mjs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pinyin } from '../vendor/pinyin-pro/index.mjs';

export const wakePinyin = text => pinyin(text, { toneType: 'none', type: 'array', v: true }).join(' ').toLowerCase();

const isHan = text => /^[\p{Script=Han}]+$/u.test(text);

function validateReading(reading, name) {
  if (typeof reading !== 'string') throw new Error('称呼读音必须是文字。');
  const normalized = reading.trim().toLowerCase().replace(/ü/g, 'v').replace(/\s+/g, ' ');
  if (normalized && (!isHan(name) || normalized.split(' ').length !== [...name].length || !/^[a-zv]+(?: [a-zv]+)*$/.test(normalized))) {
    throw new Error('称呼读音请为每个汉字填写一个无声调拼音，用空格分隔。');
  }
  return normalized;
}

export function wakeReadings({ names, primaryPinyin, pronunciations }) {
  return names.map((name, index) => pronunciations?.[index] || (index === 0 && primaryPinyin) || wakePinyin(name));
}

export const DEFAULT_WAKE_CONFIG = Object.freeze({
  names: Object.freeze(['小伴']),
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
  if (value.pronunciations !== undefined) {
    if (!Array.isArray(value.pronunciations) || value.pronunciations.length !== names.length) {
      throw new Error('请用逗号分隔读音，与称呼逐项对应。');
    }
  }
  const pronunciations = value.pronunciations?.map((reading, index) => {
    if (reading === wakePinyin(names[index])) return '';
    return validateReading(reading, names[index]);
  });
  const primaryPinyin = value.pronunciations === undefined ? validateReading(value.primaryPinyin ?? '', names[0]) : '';
  return { names, greetingNames, acknowledgement: reply?.trim() || DEFAULT_WAKE_CONFIG.acknowledgement,
    ...(pronunciations?.some(Boolean) ? { pronunciations } : {}),
    ...(primaryPinyin ? { primaryPinyin } : {}) };
}

export class WakePreference {
  constructor(file) { this.file = file; this.value = validateWakeConfig(DEFAULT_WAKE_CONFIG); this.queue = Promise.resolve(); }
  get() {
    const { names, greetingNames, pronunciations } = this.value;
    return { ...this.value, names: [...names], greetingNames: [...greetingNames],
      ...(pronunciations ? { pronunciations: [...pronunciations] } : {}) };
  }
  async open() {
    const result = await readPreference(this.file, '家庭称呼', data => {
      if (data?.schema !== 1) throw new Error();
      return validateWakeConfig(data);
    });
    this.value = result.value ?? validateWakeConfig(DEFAULT_WAKE_CONFIG);
    this.error = result.error;
    this.saved = result.value !== undefined;
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
      if (value.pronunciations === undefined) {
        if (this.value.pronunciations) {
          const readings = next.names.map(name => this.value.pronunciations[this.value.names.indexOf(name)] || '');
          if (value.primaryPinyin !== undefined) readings[0] = next.primaryPinyin || '';
          if (readings.some(Boolean)) next.pronunciations = readings;
          delete next.primaryPinyin;
        }
        if (value.primaryPinyin === undefined && next.names[0] === this.value.names[0] && this.value.primaryPinyin) next.primaryPinyin = this.value.primaryPinyin;
      }
      const temporary = this.file + '.tmp-' + randomUUID();
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(temporary, JSON.stringify({ schema: 1, ...next }), { mode: 0o600, flag: 'wx' });
        await preserveFailedPreference(this.file, this.error);
        await rename(temporary, this.file);
      } catch {
        await unlink(temporary).catch(() => {});
        throw new Error('家庭称呼设置未能保存，原设置保持不变。');
      }
      this.value = next;
      this.error = undefined;
      this.saved = true;
      return this.get();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

export function matchWakePrefix(clean, value = DEFAULT_WAKE_CONFIG) {
  const match = describeWakeMatch(clean, value);
  return match.matched ? [match.prefix] : null;
}

export function describeWakeMatch(clean, value = DEFAULT_WAKE_CONFIG) {
  const config = validateWakeConfig(value);
  const { names } = config;
  const readings = wakeReadings(config);
  const groups = new Map();
  for (const [index, name] of names.entries()) {
    const length = [...name].length;
    if (!groups.has(length)) groups.set(length, { exact: new Map(), phonetic: new Map() });
    const { exact, phonetic } = groups.get(length);
    const reading = readings[index];
    exact.set(name, reading);
    if (isHan(name) && !phonetic.has(reading)) phonetic.set(reading, name);
  }
  const lengths = [...groups.keys()].sort((a, b) => b - a);
  for (const hardware of ['小爱同学', '你好小爱', '']) {
    if (!clean.startsWith(hardware)) continue;
    const tail = clean.slice(hardware.length);
    for (const greeting of ['你好', '您好', '嗨', '']) {
      if (!tail.startsWith(greeting)) continue;
      const spoken = [...tail.slice(greeting.length)];
      for (const length of lengths) {
        if (spoken.length < length) continue;
        const heard = spoken.slice(0, length).join('');
        const heardPinyin = wakePinyin(heard);
        const { exact, phonetic } = groups.get(length);
        const name = exact.has(heard) ? heard : isHan(heard) ? phonetic.get(heardPinyin) : undefined;
        if (name) return { matched: true, prefix: hardware + greeting + heard, name, heardPinyin, targetPinyin: exact.get(name) };
      }
    }
  }
  const spoken = clean.replace(/^(?:小爱同学|你好小爱)/u, '').replace(/^(?:你好|您好|嗨)/u, '');
  return { matched: false, heardPinyin: wakePinyin([...spoken].slice(0, [...names[0]].length).join('')),
    targetPinyin: [...new Set(readings)].join('，') };
}
