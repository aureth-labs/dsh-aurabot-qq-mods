import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, rename, readdir, rm, unlink, realpath, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { audioFileName } from './storage.mjs';

export class FamilySongError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function songFailure(error) {
  if (error instanceof FamilySongError) return { code: error.code, message: error.message };
  const text = String(error?.message || '');
  if (/out of memory|OutOfMemoryError/i.test(text)) return { code: 'FAMILY_GPU_MEMORY', message: '显存不足，本次完整歌曲未生成。' };
  if (/size mismatch|state_dict|unexpected key|Missing key/i.test(text)) return { code: 'FAMILY_VOICE_INCOMPATIBLE', message: '妈妈音色模型与当前推理引擎不兼容，本次未生成。' };
  if (/没有人声|纯音乐|伴奏版/.test(text)) return { code: 'FAMILY_NO_VOCAL', message: '选定版本没有可用人声，请另选版本。' };
  if (/会员|版权|下载不了/.test(text)) return { code: 'FAMILY_SOURCE_UNAVAILABLE', message: '选定版本暂时无法获取完整音频，请另选版本。' };
  return { code: 'FAMILY_GENERATION_FAILED', message: '完整歌曲生成未完成，请检查翻唱环境和所选音色。' };
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function within(root, file) {
  const path = relative(resolve(root), resolve(file));
  return Boolean(path) && !isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../');
}

export class SongLibrary {
  constructor({ root, workRoot, describe, unlinkFile = unlink }) {
    Object.assign(this, { root, workRoot, describe, unlinkFile });
    this.metadataRoot = join(root, '歌曲信息');
    this.sources = new Map();
    this.entries = new Map();
    this.jobs = new Map();
    this.tail = Promise.resolve();
    this.removing = new Set();
    this.removalVersion = 0;
    this.removedVersions = new Map();
  }
  async open({ allowMissing = false } = {}) {
    await mkdir(this.root, { recursive: true });
    const ids = new Set();
    for (const folder of await readdir(this.root, { withFileTypes: true })) {
      if (folder.isDirectory() && /^[a-f0-9]{64}$/.test(folder.name)) ids.add(folder.name);
    }
    let metadata;
    try { metadata = await readdir(this.metadataRoot, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; metadata = []; }
    for (const item of metadata) {
      if (item.isFile() && /^[a-f0-9]{64}\.json$/.test(item.name)) ids.add(item.name.slice(0, -5));
    }
    for (const id of ids) {
      const entry = await this.readEntry(id, { allowMissing });
      if (entry) { this.entries.set(entry.id, entry); this.addSources([entry.source]); }
    }
  }
  addSources(sources) {
    for (const source of sources) this.sources.set(String(source.id), {
      id: String(source.id), title: String(source.title), artists: String(source.artists || ''),
      durationSec: Number(source.durationSec) || 0,
    });
  }
  publicEntry(entry) {
    return { id: entry.id, sourceId: entry.source.id, title: entry.source.title, artists: entry.source.artists,
      mode: entry.identity.voice.role === 'original' ? 'original' : 'cover',
      voice: entry.identity.voice.role === 'original' ? '原曲' : (entry.voiceName || '妈妈'), pitch: entry.identity.parameters.pitch, duration: entry.duration, full: true };
  }
  status() {
    return {
      entries: [...this.entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(entry => this.publicEntry(entry)),
      jobs: [...this.jobs.values()].map(job => ({
        id: job.id, title: job.title, state: job.state,
        stage: job.stageProvider?.() || job.state, error: job.error || null,
      })),
    };
  }
  async readEntry(id, { allowMissing = false } = {}) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new FamilySongError('FAMILY_ENTRY_INVALID', '歌曲记录不可用。');
    let text;
    let legacy = false;
    try { text = await readFile(join(this.metadataRoot, id + '.json'), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      legacy = true;
      try { text = await readFile(join(this.root, id, 'manifest.json'), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    try {
      const entry = JSON.parse(text);
      if (entry.schema !== (legacy ? 1 : 2) || entry.id !== id || entry.full !== true ||
          entry.file !== (legacy ? 'audio.mp3' : audioFileName(entry)) ||
          !(entry.duration > 0) || !(entry.sourceDuration > 0) || Math.abs(entry.duration - entry.sourceDuration) > 1 ||
          (entry.source?.durationSec > 0 && Math.abs(entry.sourceDuration - entry.source.durationSec) > 2) ||
          !['mother', 'original'].includes(entry.identity?.voice?.role) || !entry.source?.title ||
          !/^[a-f0-9]{64}$/.test(entry.audioSha256) ||
          createHash('sha256').update(JSON.stringify(stable(entry.identity))).digest('hex') !== id ||
          await hashFile(legacy ? join(this.root, id, entry.file) : join(this.root, entry.file)) !== entry.audioSha256) throw new Error();
      return entry;
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw new FamilySongError('FAMILY_CACHE_INVALID', '已保存歌曲校验未通过，未覆盖原文件。');
    }
  }
  async request(sourceId, { pitch = 0, mode = 'cover', voice = '' } = {}) {
    const source = this.sources.get(String(sourceId));
    if (!source) throw new FamilySongError('FAMILY_SOURCE_REQUIRED', '请先搜索并选择明确的歌曲版本。');
    if (!Number.isInteger(pitch) || pitch < -24 || pitch > 24) throw new FamilySongError('FAMILY_PITCH_INVALID', '变调须为-24到24的整数。');
    const startedBeforeRemoval = this.removalVersion;
    if (!['cover', 'original'].includes(mode) || typeof voice !== 'string') throw new FamilySongError('FAMILY_MODE_INVALID', '请选择原曲或有效翻唱音色。');
    const recipe = await this.describe(source, pitch, { mode, voice });
    const identity = stable(recipe.identity);
    if (identity.voice?.role !== (mode === 'original' ? 'original' : 'mother')) throw new FamilySongError('FAMILY_VOICE_REQUIRED', '歌曲类型不匹配。');
    const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const changedByRemoval = () => this.removing.has(id) || (this.removedVersions.get(id) || 0) > startedBeforeRemoval;
    if (changedByRemoval()) throw new FamilySongError('FAMILY_ENTRY_BUSY', '这首歌曲正在删除或已被移除，请刷新曲库。');
    const cached = await this.readEntry(id, { allowMissing: true });
    if (changedByRemoval()) throw new FamilySongError('FAMILY_ENTRY_BUSY', '这首歌曲正在删除或已被移除，请刷新曲库。');
    if (cached) {
      this.entries.set(id, cached);
      return { id, reused: true, state: 'ready', entry: this.publicEntry(cached) };
    }
    const previous = this.jobs.get(id);
    if (previous && ['queued', 'generating'].includes(previous.state)) return { id, reused: true, state: previous.state };
    const job = { id, title: source.title, state: 'queued', stageProvider: null, error: null };
    this.jobs.set(id, job);
    job.promise = this.tail.then(async () => {
      job.state = 'generating';
      const work = join(this.workRoot, randomUUID());
      await mkdir(work, { recursive: true });
      try {
        const result = await recipe.render(work, provider => { job.stageProvider = provider; });
        if (!within(work, result.file) || !within(work, result.source) ||
            !(result.duration > 0) || !(result.sourceDuration > 0) ||
            Math.abs(result.duration - result.sourceDuration) > 1 ||
            (source.durationSec > 0 && Math.abs(result.sourceDuration - source.durationSec) > 2)) {
          throw new FamilySongError('FAMILY_NOT_FULL', '生成结果未通过完整时长或目录校验，未保存为成品。');
        }
        const file = audioFileName({ id, source, identity, voiceName: recipe.voiceName });
        const destination = join(this.root, file);
        try { await copyFile(result.file, destination, constants.COPYFILE_EXCL); }
        catch (error) {
          if (error.code === 'EEXIST') throw new FamilySongError('FAMILY_FILE_EXISTS', '目标目录已存在同名文件，未覆盖，请检查歌曲文件。');
          throw error;
        }
        const entry = { schema: 2, id, full: true, file, createdAt: new Date().toISOString(),
          source, sourceSha256: await hashFile(result.source), identity, ...(recipe.voiceName ? { voiceName: recipe.voiceName } : {}),
          duration: result.duration, sourceDuration: result.sourceDuration, audioSha256: await hashFile(destination) };
        await mkdir(this.metadataRoot, { recursive: true });
        await writeFile(join(this.metadataRoot, id + '.pending.json'), JSON.stringify(entry, null, 2), 'utf8');
        await rename(join(this.metadataRoot, id + '.pending.json'), join(this.metadataRoot, id + '.json'));
        this.entries.set(id, entry);
        job.state = 'ready';
        return entry;
      } catch (error) {
        const failure = songFailure(error);
        job.state = 'failed';
        job.error = failure;
        if (['准备完整歌曲', '下载歌曲', '截取要唱的那一段', '分离人声和伴奏', '换成她的声音', '混音', '换一版重下'].includes(error?.familyStage)) job.error.stage = error.familyStage;
        throw new FamilySongError(failure.code, failure.message);
      } finally {
        job.stageProvider = null;
        // This directory is created above from a UUID inside this module's private work root.
        if (within(this.workRoot, work)) await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    });
    this.tail = job.promise.catch(() => {});
    return { id, reused: false, state: 'queued' };
  }
  async wait(id) {
    const job = this.jobs.get(id);
    return job ? job.promise : this.get(id);
  }
  async get(id) {
    const key = String(id);
    const startedBeforeRemoval = this.removalVersion;
    if (this.removing.has(key)) throw new FamilySongError('FAMILY_ENTRY_BUSY', '这首歌曲正在删除，请稍后刷新曲库。');
    const entry = await this.readEntry(String(id));
    if (this.removing.has(key) || (this.removedVersions.get(key) || 0) > startedBeforeRemoval) {
      throw new FamilySongError('FAMILY_ENTRY_BUSY', '这首歌曲正在删除或已被移除，请刷新曲库。');
    }
    if (!entry) throw new FamilySongError('FAMILY_ENTRY_MISSING', '尚无这首完整成品。');
    return { ...entry, absoluteFile: entry.schema === 1 ? join(this.root, entry.id, entry.file) : join(this.root, entry.file) };
  }
  async remove(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) {
      throw new FamilySongError('FAMILY_ENTRY_INVALID', '歌曲记录不可用。');
    }
    if (!this.entries.has(id)) throw new FamilySongError('FAMILY_ENTRY_MISSING', '尚无这首完整成品。');
    if (this.removing.has(id) || ['queued', 'generating'].includes(this.jobs.get(id)?.state)) {
      throw new FamilySongError('FAMILY_ENTRY_BUSY', '这首歌曲仍在处理中，请稍后再删除。');
    }
    this.removing.add(id);
    this.removedVersions.set(id, ++this.removalVersion);
    try {
      const entry = await this.readEntry(id);
      if (!entry) throw new FamilySongError('FAMILY_ENTRY_MISSING', '尚无这首完整成品。');
      const audio = entry.schema === 1 ? join(this.root, id, 'audio.mp3') : join(this.root, entry.file);
      const metadata = entry.schema === 1 ? join(this.root, id, 'manifest.json') : join(this.metadataRoot, id + '.json');
      const root = await realpath(this.root);
      for (const file of [audio, metadata]) {
        if (!within(root, await realpath(file)) || !(await lstat(file)).isFile()) {
          throw new FamilySongError('FAMILY_ENTRY_DELETE_UNSAFE', '歌曲记录路径不属于当前曲库，未删除文件。');
        }
      }
      const record = await readFile(metadata);
      await this.unlinkFile(metadata);
      try { await this.unlinkFile(audio); }
      catch {
        try { await writeFile(metadata, record, { flag: 'wx' }); }
        catch {
          this.entries.delete(id);
          this.jobs.delete(id);
          throw new FamilySongError('FAMILY_ENTRY_DELETE_INCOMPLETE', '歌曲删除未完成，记录未能恢复，请检查曲库文件。');
        }
        throw new FamilySongError('FAMILY_ENTRY_DELETE_FAILED', '歌曲未能删除，原歌曲记录已恢复。');
      }
      this.entries.delete(id);
      this.jobs.delete(id);
      return this.publicEntry(entry);
    } catch (error) {
      if (error instanceof FamilySongError) throw error;
      throw new FamilySongError('FAMILY_ENTRY_DELETE_FAILED', '歌曲未能删除，原文件已保留。');
    } finally { this.removing.delete(id); }
  }
}
