import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FamilySongError } from './library.mjs';

const validIds = (ids, allowEmpty = false) => Array.isArray(ids) && (allowEmpty || ids.length > 0) &&
  ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id));

export class SongPlaylists {
  constructor({ file, library }) {
    Object.assign(this, { file, library });
    this.lists = [];
    this.tail = Promise.resolve();
    this.loadFailed = false;
  }
  async open() {
    let value;
    try { value = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') { this.loadFailed = false; return; }
      this.loadFailed = true;
      throw new FamilySongError('FAMILY_PLAYLIST_INVALID', '歌单文件无法读取，原文件已保留。');
    }
    if (value?.schema !== 1 || !Array.isArray(value.lists) || value.lists.some(list =>
      typeof list?.id !== 'string' || !list.id || typeof list.name !== 'string' || !list.name.trim() ||
      !validIds(list.ids, true) || new Set(list.ids).size !== list.ids.length) ||
      new Set(value.lists.map(list => list.id)).size !== value.lists.length) {
      this.loadFailed = true;
      throw new FamilySongError('FAMILY_PLAYLIST_INVALID', '歌单文件无法读取，原文件已保留。');
    }
    this.lists = value.lists;
    this.loadFailed = false;
  }
  status() { return this.lists.map(list => ({ id: list.id, name: list.name, ids: [...list.ids] })); }
  get(id) {
    const list = this.status().find(list => list.id === id);
    if (!list) throw new FamilySongError('FAMILY_PLAYLIST_MISSING', '请先选择已保存的妈妈歌单。');
    return list;
  }
  enqueue(operation) {
    const result = this.tail.then(async () => {
      if (this.loadFailed) throw new FamilySongError('FAMILY_PLAYLIST_INVALID', '歌单文件无法读取，原文件已保留。');
      return operation();
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async persist(next) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = this.file + '.pending-' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify({ schema: 1, lists: next }, null, 2), 'utf8');
      await rename(temporary, this.file);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    this.lists = next;
  }
  async store(name, ids, previous, allowEmpty) {
    const title = String(name || '').trim();
    if (!title || title.length > 80 || !validIds(ids, allowEmpty)) {
      throw new FamilySongError('FAMILY_PLAYLIST_INPUT', '请输入简短歌单名称，并选择已保存的妈妈歌曲。');
    }
    if (this.lists.some(list => list.name === title && list.id !== previous?.id)) {
      throw new FamilySongError('FAMILY_PLAYLIST_NAME_EXISTS', '已有同名歌单，请换个名称。');
    }
    const unique = [...new Set(ids)];
    for (const id of unique) await this.library.get(id);
    const list = { id: previous?.id || randomUUID(), name: title, ids: unique };
    const next = previous ? this.lists.map(item => item.id === previous.id ? list : item) : [...this.lists, list];
    await this.persist(next);
    return this.get(list.id);
  }
  create(name, ids = []) {
    return this.enqueue(() => this.store(name, ids, null, true));
  }
  update(id, changes = {}) {
    return this.enqueue(() => {
      const previous = this.get(id);
      return this.store(changes.name === undefined ? previous.name : changes.name,
        changes.ids === undefined ? previous.ids : changes.ids, previous, true);
    });
  }
  remove(id) {
    return this.enqueue(async () => {
      const previous = this.get(id);
      await this.persist(this.lists.filter(list => list.id !== id));
      return previous;
    });
  }
  removeSong(id, removeFile) {
    return this.enqueue(async () => {
      if (!validIds([id]) || typeof removeFile !== 'function') {
        throw new FamilySongError('FAMILY_PLAYLIST_INPUT', '请选择已保存的歌曲。');
      }
      const previous = this.status();
      const affectedPlaylists = previous.filter(list => list.ids.includes(id)).length;
      if (affectedPlaylists) await this.persist(previous.map(list => ({ ...list, ids: list.ids.filter(entry => entry !== id) })));
      try { return { entry: await removeFile(), affectedPlaylists }; }
      catch (error) {
        if (affectedPlaylists && error?.code !== 'FAMILY_ENTRY_DELETE_INCOMPLETE') {
          try { await this.persist(previous); }
          catch { throw new FamilySongError('FAMILY_PLAYLIST_RESTORE_FAILED', '歌曲未删除，但歌单引用未能恢复，请检查歌单。'); }
        }
        throw error;
      }
    });
  }
  removeMissing(ids, clearIndex) {
    return this.enqueue(async () => {
      const previous = this.status(), missing = new Set(ids);
      const affected = previous.filter(list => list.ids.some(id => missing.has(id))).length;
      if (affected) await this.persist(previous.map(list => ({ ...list, ids: list.ids.filter(id => !missing.has(id)) })));
      try { await clearIndex(); }
      catch (error) {
        if (affected) {
          try { await this.persist(previous); }
          catch { throw new FamilySongError('FAMILY_PLAYLIST_RESTORE_FAILED', '清理未完成，歌单引用恢复失败，请检查歌单；磁盘文件未删除。'); }
        }
        throw error;
      }
      return affected;
    });
  }
  save(name, ids, { id } = {}) {
    if (id !== undefined) return this.update(id, { name, ids });
    return this.enqueue(() => this.store(name, ids, this.lists.find(list => list.name === String(name || '').trim()), false));
  }
}
