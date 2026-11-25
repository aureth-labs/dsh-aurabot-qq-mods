import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename, unlink, mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import { join, dirname, basename, extname, resolve, relative, isAbsolute } from 'node:path';
import { SongLibrary, FamilySongError, hashFile } from './library.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const inside = (root, file) => { const rest = relative(root, file); return rest && !isAbsolute(rest) && rest !== '..' && !rest.startsWith('..\\') && !rest.startsWith('../'); };
const fail = message => new FamilySongError('FAMILY_DIRECTORY', message);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const copy = value => JSON.parse(JSON.stringify(value));

// External folders are indexed only. Their files and manifests are never written or deleted.
export class DirectoryLibrary {
  constructor({ primary, file, durationOf }) {
    Object.assign(this, { primary, file, durationOf });
    this.dirs = []; this.tail = Promise.resolve();
  }
  get root() { return this.primary.root; }
  get sources() { return this.primary.sources; }
  get jobs() { return this.primary.jobs; }
  get entries() {
    const merged = new Map();
    for (const dir of this.dirs) for (const record of dir.records) {
      const old = merged.get(record.id);
      const available = dir.phase === 'ready' && !record.missing && !record.unreadable;
      if (!old || available && !old.available) merged.set(record.id, { ...record.entry, id: record.id, available });
    }
    const primary = this.dirs.find(dir => dir.id === 'primary');
    if (primary?.phase === 'ready') for (const [id, entry] of this.primary.entries) merged.set(id, { ...entry, available: !primary.records.find(r => r.id === id)?.missing });
    return merged;
  }
  enqueue(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  requireIdle() {
    if ([...this.primary.jobs.values()].some(job => ['queued','generating'].includes(job.state))) throw fail('请等待歌曲生成结束，再更新目录。');
  }
  async persist(dirs) {
    const temp = this.file + '.pending-' + randomUUID();
    await mkdir(dirname(this.file), { recursive: true });
    try { await writeFile(temp, JSON.stringify({ schema: 1, directories: dirs }, null, 2), { flag: 'wx' }); await rename(temp, this.file); }
    catch { await unlink(temp).catch(() => {}); throw fail('目录索引保存失败，原索引已保留。'); }
    this.dirs = dirs;
  }
  async open() {
    let saved;
    try { saved = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw fail('目录索引无法读取，原文件已保留。'); }
    if (saved) {
      if (saved.schema !== 1 || !Array.isArray(saved.directories) || saved.directories.filter(d => d.id === 'primary').length !== 1 ||
          new Set(saved.directories.map(d => d.id)).size !== saved.directories.length || saved.directories.some(d =>
            typeof d.path !== 'string' || !isAbsolute(d.path) || !Array.isArray(d.records) || d.records.some(r =>
              !digest(r.id) || !digest(r.sha) || typeof r.file !== 'string' || !inside(d.path, resolve(d.path, r.file)) ||
              !r.entry?.source?.title || !r.public?.title || !(r.entry.duration > 0)))) throw fail('目录索引格式不正确，未覆盖原文件。');
      this.dirs = saved.directories;
      const root = this.dirs.find(d => d.id === 'primary').path;
      this.primary.root = root; this.primary.metadataRoot = join(root, '歌曲信息');
      await this.checkPaths();
      const primaryDir = this.dirs.find(d => d.id === 'primary');
      if (primaryDir.phase === 'ready') {
        try { await this.primary.open({ allowMissing: true }); }
        catch (error) {
          if (error.code !== 'FAMILY_CACHE_INVALID') throw error;
          this.primary.entries.clear(); primaryDir.phase = 'invalid';
        }
      }
    } else {
      await this.primary.open({ allowMissing: true });
      const scanned = await this.scan(this.root, this.primary);
      await this.persist([{ id: 'primary', path: this.root, ...scanned, phase: 'ready' }]);
    }
    if (this.dirs.find(d => d.id === 'primary').phase === 'ready') await this.rememberPrimary();
    await this.checkPaths();
    for (const dir of this.dirs) this.primary.addSources(dir.records.map(r => r.entry.source));
  }
  async scan(path, existing = null) {
    if (!isAbsolute(path)) throw fail('请输入音乐文件夹的完整路径。');
    let root;
    try { root = await realpath(path); if (!(await lstat(root)).isDirectory()) throw new Error(); }
    catch { throw fail('目录不存在或无法读取，请检查磁盘连接或重新添加目录。'); }
    const managed = existing || new SongLibrary({ root, workRoot: '', describe: () => { throw fail('外部曲库只读。'); } });
    if (!existing) await managed.open({ allowMissing: true });
    const records = [], known = new Set();
    for (const entry of managed.entries.values()) {
      const file = entry.schema === 1 ? join(entry.id, entry.file) : entry.file;
      known.add(key(join(root, file)));
      records.push({ id: entry.id, file, sha: entry.audioSha256, entry, public: managed.publicEntry(entry), managed: true });
    }
    let skipped = 0;
    const walk = async folder => {
      for (const item of await readdir(folder, { withFileTypes: true })) {
        const file = join(folder, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) { if (item.name !== '歌曲信息') await walk(file); continue; }
        if (!item.isFile() || !['.mp3','.wav','.ogg'].includes(extname(item.name).toLowerCase()) || known.has(key(file))) continue;
        const sha = await hashFile(file), id = hash('local-audio-v1:' + sha);
        const previous = this.dirs.flatMap(d => d.records).find(r => r.id === id);
        const duration = previous?.entry.duration || await this.durationOf(file);
        if (!(duration > 0) || !Number.isFinite(duration)) { skipped++; continue; }
        const source = { id: 'local:' + sha, title: basename(file, extname(file)), artists: '', durationSec: duration };
        const entry = { id, source, duration, audioSha256: sha, createdAt: '', identity: { voice: { role: 'local' }, parameters: { pitch: 0 } } };
        records.push({ id, file: relative(root, file), sha, entry, managed: false,
          public: { id, sourceId: source.id, title: source.title, artists: '', mode: 'local', voice: '本地音乐', pitch: 0, duration, full: true } });
      }
    };
    await walk(root);
    return { records, skipped };
  }
  async checkPaths() {
    for (const dir of this.dirs) {
      try { if (!(await lstat(dir.path)).isDirectory()) throw new Error(); if (dir.phase === 'missing') dir.phase = 'rescan'; else if (!dir.phase) dir.phase = 'ready'; }
      catch { dir.phase = 'missing'; }
      for (const record of dir.records) {
        try { record.missing = !await this.filePresent(join(dir.path, record.file)); }
        catch { record.unreadable = true; continue; }
        record.unreadable = false;
      }
    }
    return this.directories();
  }
  directories() { return this.dirs.map(d => ({ id: d.id, path: d.path, primary: d.id === 'primary', phase: d.phase,
    count: new Set(d.records.map(r => r.id)).size, missing: d.records.filter(r => r.missing).length, skipped: d.skipped || 0 })); }
  status() {
    const all = new Map();
    for (const dir of this.dirs) for (const record of dir.records) {
      const available = dir.phase === 'ready' && !record.missing && !record.unreadable;
      const old = all.get(record.id);
      const primaryManaged = dir.id === 'primary' && record.managed;
      if (!old) all.set(record.id, { ...record.public, directoryIds: [dir.id], available, readOnly: !primaryManaged });
      else { if (!old.directoryIds.includes(dir.id)) old.directoryIds.push(dir.id); old.available ||= available; old.readOnly &&= !primaryManaged; }
    }
    const primary = this.dirs.find(d => d.id === 'primary');
    for (const item of this.primary.status().entries) {
      const old = all.get(item.id);
      all.set(item.id, { ...item, directoryIds: [...new Set([...(old?.directoryIds || []),'primary'])],
        available: (primary?.phase === 'ready' && !primary.records.find(r => r.id === item.id)?.missing) || old?.available === true, readOnly: false });
    }
    return { entries: [...all.values()], jobs: this.primary.status().jobs, directories: this.directories(), indexError: this.indexError || '' };
  }
  async add(path) {
    return this.enqueue(async () => {
      this.requireIdle();
      if (typeof path !== 'string' || !isAbsolute(path)) throw fail('请输入音乐文件夹的完整路径。');
      const canonical = await realpath(path).catch(() => { throw fail('目录不存在或无法读取。'); });
      if (this.dirs.some(d => key(d.path) === key(canonical) || inside(d.path,canonical) || inside(canonical,d.path))) throw fail('该目录已添加或与已有目录重叠，请直接选择已有目录查看。');
      const scanned = await this.scan(canonical);
      const dir = { id: randomUUID(), path: canonical, ...scanned, phase: 'ready' };
      await this.persist([...this.dirs,dir]); this.primary.addSources(scanned.records.map(r => r.entry.source));
      return this.directories();
    });
  }
  async refresh(id) {
    return this.enqueue(async () => {
      this.requireIdle();
      const dir = this.dirs.find(d => d.id === id); if (!dir) throw fail('请先选择目录。');
      await this.checkPaths(); if (dir.phase === 'missing') throw fail('原目录已离线或搬走，请重新添加现有目录。');
      const scanned = await this.scan(dir.path);
      const ids = new Set(scanned.records.map(r => r.id));
      const records = [...scanned.records,...dir.records.filter(r => !ids.has(r.id)).map(r => ({ ...r, missing: true }))];
      await this.persist(this.dirs.map(d => d.id === id ? { ...d,...scanned,records,phase:'ready' } : d));
      if (id === 'primary') { this.primary.entries.clear(); await this.primary.open({ allowMissing: true }); }
      this.primary.addSources(records.map(r => r.entry.source));
      if (id === 'primary') this.indexError = '';
      return this.directories();
    });
  }
  async filePresent(file) {
    try { const info = await lstat(file); if (!info.isFile() && !info.isSymbolicLink()) throw fail('歌曲路径不是文件，请检查后再清理。'); return true; }
    catch (error) { if (['ENOENT','ENOTDIR'].includes(error.code)) return false; throw error; }
  }
  async clearMissing(playlists) {
    return this.enqueue(async () => {
      this.requireIdle();
      const ids = new Set([...this.entries.keys(), ...playlists.status().flatMap(list => list.ids)]);
      const missing = [];
      for (const id of ids) {
        let present = false;
        const current = this.primary.entries.get(id);
        if (current) {
          const file = current.schema === 1 ? join(id, current.file) : current.file;
          try { present = await this.filePresent(join(this.root, file)); }
          catch { throw fail('有歌曲无法检查，请检查磁盘连接和访问权限后重试；未清除记录。'); }
        }
        for (const dir of this.dirs) for (const record of dir.records) {
          if (record.id !== id) continue;
          try { if (await this.filePresent(join(dir.path, record.file))) present = true; }
          catch { throw fail('有歌曲无法检查，请检查磁盘连接和访问权限后重试；未清除记录。'); }
        }
        if (!present) missing.push(id);
      }
      if (!missing.length) return { removed: 0, affectedPlaylists: 0 };
      const gone = new Set(missing);
      const next = this.dirs.map(dir => ({ ...dir, records: dir.records.filter(record => !gone.has(record.id)) }));
      const affectedPlaylists = await playlists.removeMissing(missing, () => this.persist(next));
      for (const id of missing) { this.primary.entries.delete(id); this.primary.jobs.delete(id); }
      return { removed: missing.length, affectedPlaylists };
    });
  }
  addSources(sources) { return this.primary.addSources(sources); }
  async request(...args) {
    return this.enqueue(async () => {
    await this.checkPaths(); if (this.dirs.find(d => d.id === 'primary')?.phase !== 'ready') throw fail('新增歌曲保存目录不可用，请恢复原保存目录后刷新；其他位置可作为外部目录添加。');
    const result = await this.primary.request(...args);
    const job = this.primary.jobs.get(result.id);
    if (job?.promise && !job.indexPromise) {
      job.indexPromise = job.promise.then(() => this.rememberPrimary());
      job.indexPromise.catch(error => { if (job.state === 'ready') this.indexError = error.message; });
    }
    return result;
    });
  }
  rememberPrimary() { return this.enqueue(async () => {
    const dir = this.dirs.find(d => d.id === 'primary');
    const records = dir.records.filter(r => !r.managed || !this.primary.entries.has(r.id));
    for (const entry of this.primary.entries.values()) records.push({ id:entry.id, file:entry.schema === 1 ? join(entry.id,entry.file) : entry.file,
      sha:entry.audioSha256, entry, public:this.primary.publicEntry(entry), managed:true });
    if (JSON.stringify(records) !== JSON.stringify(dir.records)) await this.persist(this.dirs.map(d => d.id === 'primary' ? { ...d,records } : d));
    this.indexError = '';
  }); }
  async wait(id) { const job = this.primary.jobs.get(id); if (job) await (job.indexPromise || job.promise); return this.get(id); }
  async get(id) {
    const primary = this.dirs.find(d => d.id === 'primary');
    if (primary?.phase === 'ready' && this.primary.entries.has(id)) {
      try { return await this.primary.get(id); } catch {}
    }
    for (const dir of this.dirs) for (const record of dir.records) {
      if (record.id !== id || record.missing || dir.phase !== 'ready') continue;
      const path = join(dir.path,record.file);
      try {
        if (!inside(await realpath(dir.path),await realpath(path)) || await hashFile(path) !== record.sha) continue;
        return { ...copy(record.entry), absoluteFile:path };
      } catch {}
    }
    throw fail('歌曲文件已移动、改变或离线，请重新添加现有目录，或清除失效歌曲；歌单关联暂时保留。');
  }
  async remove(id, { directoryId = '' } = {}) {
    const shared = this.dirs.some(d => d.id !== 'primary' && d.records.some(r => r.id === id));
    if ((directoryId && directoryId !== 'primary') || (shared && directoryId !== 'primary')) throw fail('请进入新增歌曲保存目录后删除主目录文件；外部目录只读。');
    if (!this.primary.entries.has(id)) throw fail('外部目录中的音乐只建立索引，不删除原文件。');
    const result = await this.primary.remove(id);
    const next = this.dirs.map(d => d.id === 'primary' ? { ...d, records: d.records.filter(r => r.id !== id) } : d);
    try { await this.persist(next); }
    catch {
      this.dirs = next; this.indexError = '歌曲文件已删除，但目录索引保存失败，请刷新曲库或清除失效记录。';
      throw new FamilySongError('FAMILY_ENTRY_DELETE_INCOMPLETE', this.indexError);
    }
    return result;
  }
}
