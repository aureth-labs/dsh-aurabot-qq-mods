import { constants } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function readPreference(file, label, decode) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    return { error: { code: 'PREFERENCE_READ', message: `${label}读取失败（${error.code}），请恢复文件访问后重新加载模块。` } };
  }
  try { return { value: decode(JSON.parse(text)) }; }
  catch {
    return { error: { code: 'PREFERENCE_INVALID', message: `${label}文件损坏。请重新保存${label}，保存时会备份原文件。` } };
  }
}

export async function preserveFailedPreference(file, error) {
  if (!error) return;
  if (error.code !== 'PREFERENCE_INVALID') throw new Error(error.message);
  await copyFile(file, file + '.corrupt-' + randomUUID() + '.bak', constants.COPYFILE_EXCL);
}
