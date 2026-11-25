import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

class ResourceCheckError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const fail = (code, message) => { throw new ResourceCheckError(code, message); };
const normalized = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
const inside = (root, value) => {
  const rest = relative(root, value);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + sep));
};
const excluded = parts => {
  const names = process.platform === 'win32' ? parts.map(value => value.toLowerCase()) : parts;
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return names[0] === key('AuraBot-Family') && (
    names[1] === key('Generation-Work') || names[1] === key('Dialogue-Work') ||
    (names[1] === key('Conversations') && names[2] === key('Workspace'))
  );
};

async function checkedRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('RESOURCE_PATH_INVALID', '请选择绝对路径。');
  const root = resolve(value);
  try {
    let cursor = root;
    while (true) {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) fail('RESOURCE_LINK_OR_TYPE', '目录包含链接或不是文件夹，无法验证。');
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return { path: root, real: await realpath(root) };
  } catch (error) {
    if (error instanceof ResourceCheckError) throw error;
    fail('RESOURCE_ROOT_UNAVAILABLE', '目录不存在或无法读取。');
  }
}

async function inventory(root) {
  const files = new Map();
  let rootsFound = 0;
  async function visit(parts) {
    if (excluded(parts)) return;
    const path = join(root, ...parts);
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT' && parts.length === 1) return; throw error; }
    if (info.isSymbolicLink()) fail('RESOURCE_LINK_OR_TYPE', '资源中包含链接，无法安全验证。');
    if (parts.length === 1) {
      if (!info.isDirectory()) fail('RESOURCE_LINK_OR_TYPE', '资源目录不可用。');
      rootsFound++;
    }
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit([...parts, name]);
      return;
    }
    if (!info.isFile()) fail('RESOURCE_LINK_OR_TYPE', '资源包含不支持的文件类型。');
    const key = parts.join('/');
    const canonical = process.platform === 'win32' ? key.toLowerCase() : key;
    if (files.has(canonical)) fail('RESOURCE_NAME_COLLISION', '资源文件名发生冲突。');
    files.set(canonical, { path, size: info.size, mtimeMs: info.mtimeMs });
  }
  try { for (const name of ['song DB', 'AuraBot-Family']) await visit([name]); }
  catch (error) {
    if (error instanceof ResourceCheckError) throw error;
    fail('RESOURCE_READ_FAILED', '资源文件无法读取，请检查权限。');
  }
  return { files, rootsFound };
}

async function digest(item) {
  try {
    const before = await lstat(item.path);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== item.size || before.mtimeMs !== item.mtimeMs) throw new Error();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(item.path)) hash.update(chunk);
    const after = await lstat(item.path);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error();
    return hash.digest('hex');
  } catch { fail('RESOURCE_CHANGED_OR_UNREADABLE', '文件正在变化或无法读取，请在空闲时重试。'); }
}

function sameInventory(before, after) {
  if (before.rootsFound !== after.rootsFound || before.files.size !== after.files.size) return false;
  for (const [key, item] of before.files) {
    const current = after.files.get(key);
    if (!current || current.size !== item.size || current.mtimeMs !== item.mtimeMs) return false;
  }
  return true;
}

// Read-only: verifies a user-made copy. Progress reports aggregate counts only.
export async function checkResourceCopy(oldRoot, newRoot, { onProgress = () => {} } = {}) {
  const [oldDir, newDir] = await Promise.all([checkedRoot(oldRoot), checkedRoot(newRoot)]);
  const oldPath = normalized(oldDir.path), newPath = normalized(newDir.path);
  const oldReal = normalized(oldDir.real), newReal = normalized(newDir.real);
  if (inside(oldPath, newPath) || inside(newPath, oldPath) || inside(oldReal, newReal) || inside(newReal, oldReal)) {
    fail('RESOURCE_ROOT_OVERLAP', '新旧位置不能相同，也不能互相包含。');
  }
  const [source, target] = await Promise.all([inventory(oldDir.path), inventory(newDir.path)]);
  if (!source.rootsFound || !source.files.size) fail('RESOURCE_SOURCE_EMPTY', '原位置没有可核验的家庭资料。');
  const progress = { total: source.files.size, checked: 0, missing: 0, conflicts: 0, extra: 0 };
  const notify = () => onProgress({ ...progress });
  for (const key of target.files.keys()) if (!source.files.has(key)) progress.extra++;
  notify();
  for (const [key, from] of source.files) {
    const to = target.files.get(key);
    if (!to) progress.missing++;
    else if (from.size !== to.size || await digest(from) !== await digest(to)) progress.conflicts++;
    progress.checked++;
    notify();
  }
  const [sourceAfter, targetAfter] = await Promise.all([inventory(oldDir.path), inventory(newDir.path)]);
  if (!sameInventory(source, sourceAfter) || !sameInventory(target, targetAfter)) {
    fail('RESOURCE_CHANGED_OR_UNREADABLE', '文件正在变化或无法读取，请在空闲时重试。');
  }
  return { ok: !progress.missing && !progress.conflicts && !progress.extra, ...progress };
}
