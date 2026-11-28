/**
 * 存档读写：一律「不抛」。
 * 模块的档案凭证（profile.json）和行动记录（activities.jsonl）都写在模块数据目录里，
 * 目录被清掉、文件被改坏、磁盘满、权限不够，都不该把她的世界连着一起搞挂。
 *
 * 返回约定：
 *   readJsonFile(path, fallback, onError) -> 总是返回对象（读不到 / 解析失败给 fallback）
 *   writeJsonFile(path, obj, onError)     -> true 写成功 / false 写失败
 *   appendJsonl(path, obj, onError)       -> true 追加成功 / false 追加失败
 */

import fs from 'node:fs';
import { dirname } from 'node:path';

function notify(onError, e) {
  if (typeof onError === 'function') {
    try { onError(e); } catch { /* 报错回调自己也不能炸 */ }
  }
}

export function readJsonFile(path, fallback = {}, onError) {
  if (!path) return fallback;
  try {
    if (!fs.existsSync(path)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return parsed;
  } catch (e) {
    notify(onError, e);
    return fallback;
  }
}

export function writeJsonFile(path, obj, onError) {
  if (!path) return false;
  try {
    const dir = dirname(path);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path, JSON.stringify(obj, null, 1), 'utf8');
    return true;
  } catch (e) {
    notify(onError, e);
    return false;
  }
}

export function appendJsonl(path, obj, onError) {
  if (!path) return false;
  try {
    const dir = dirname(path);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path, JSON.stringify(obj) + '\n', 'utf8');
    return true;
  } catch (e) {
    notify(onError, e);
    return false;
  }
}
