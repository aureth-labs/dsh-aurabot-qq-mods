import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { SongLibrary, FamilySongError, hashFile } from './library.mjs';
import { DirectoryLibrary } from './directories.mjs';
import { createSongStudio, pathsOf, defaultRoot, listVoices, APPLIO_COMMIT } from './studio.mjs';
import { resourcePaths } from './storage.mjs';

const quiet = { info() {}, warn() {}, debug() {} };

export function selectSingingVoice(voices, override = '', expressionVoice = '') {
  const id = String(override || expressionVoice || '');
  const candidates = voices.filter(voice => voice.id === id);
  if (!id || candidates.length !== 1) {
    throw new FamilySongError('FAMILY_MOTHER_REQUIRED', '请在表达模块选择翻唱音色，或在小爱音响接入下拉选择。');
  }
  return candidates[0];
}

export async function createFamilySongs(api, resources = resourcePaths(api.settings().resourceRoot)) {
  const primary = new SongLibrary({
    root: resources.songRoot, workRoot: resources.workRoot,
    describe: async (source, pitch, { mode = 'cover', voice: selectedVoice = '' } = {}) => {
      const config = { ...api.config().song };
      if (mode === 'original') {
        return {
          identity: { version: 'family-original-v1', source: { provider: 'netease', id: source.id },
            voice: { role: 'original' }, parameters: { pitch: 0 } },
          voiceName: '原曲',
          render: async (workDir, stage) => {
            const studio = createSongStudio({
              getConfig: () => ({ song: { ...config, enabled: true, keepWork: false } }),
              workDir, fullLength: true, local: null, log: quiet,
              sendVoiceFile: async () => { throw new Error('Family generation does not send QQ'); },
            });
            stage(() => studio.status().current?.stage || '下载歌曲');
            return studio.makeOriginal({ song: source.title, songId: source.id });
          },
        };
      }
      if (mode !== 'cover') throw new FamilySongError('FAMILY_MODE_INVALID', '请选择原曲或生成。');
      const paths = pathsOf(config.root || defaultRoot());
      const voices = listVoices(paths.models);
      const explicit = String(selectedVoice || api.settings().motherVoice || '');
      const voice = selectSingingVoice(voices, explicit, config.voice);
      const model = await hashFile(voice.pth);
      const index = voice.index ? await hashFile(voice.index) : '';
      const digest = createHash('sha256').update(model + ':' + index).digest('hex');
      const parameters = { pitch, separatorModel: config.separatorModel,
        vocalVolume: Math.max(0.2, Math.min(2, Number(config.vocalVolume) || 1)),
        instVolume: Math.max(0.1, Math.min(2, Number(config.instVolume) || 0.8)),
        indexRate: voice.index ? 0.5 : 0, protect: 0.33, f0: 'rmvpe' };
      const identity = { version: 'family-full-song-v1', engine: APPLIO_COMMIT,
        source: { provider: 'netease', id: source.id }, voice: { role: 'mother', digest }, parameters };
      return {
        identity,
        voiceName: voice.id,
        render: async (workDir, stage) => {
          const studio = createSongStudio({
            getConfig: () => ({ song: { ...config, enabled: true, keepWork: false } }),
            workDir, fullLength: true, local: null, log: quiet,
            sendVoiceFile: async () => { throw new Error('Family generation does not send QQ'); },
          });
          stage(() => studio.status().current?.stage || '生成完整歌曲');
          const result = await studio.makeFull({ song: source.title, songId: source.id, pitch, voice: voice.id });
          return { ...result, duration: await studio.durationOf(result.file) };
        },
      };
    },
  });
  const library = new DirectoryLibrary({ primary, file: resources.directoriesFile, durationOf: file => {
    const studio = createSongStudio({ getConfig: () => ({ song: api.config().song || {} }),
      workDir: resources.workRoot, fullLength: true, local: null, log: quiet, sendVoiceFile: async () => { throw new Error('Directory scanning does not send QQ'); } });
    const ffmpeg = pathsOf(api.config().song?.root || defaultRoot()).ffmpeg;
    return studio.durationOf(file, existsSync(ffmpeg) ? ffmpeg : 'ffmpeg');
  } });
  await library.open();
  return {
    library,
    select: async (id) => {
      const sourceId = String(id || '');
      if (!/^\d{1,20}$/.test(sourceId)) throw new FamilySongError('FAMILY_SOURCE_REQUIRED', '请先选择明确的歌曲版本。');
      if (library.sources.has(sourceId)) return library.sources.get(sourceId);
      try {
        const response = await fetch('https://music.163.com/api/song/detail/?ids=' + encodeURIComponent('[' + sourceId + ']'),
          { signal: AbortSignal.timeout(20000) });
        const data = await response.json();
        const song = data.songs?.find(item => String(item.id) === sourceId);
        const artists = song?.artists || song?.ar;
        const duration = Number(song?.duration || song?.dt);
        if (!response.ok || data.code !== 200 || !song?.name || !Array.isArray(artists) || !(duration > 0)) throw new Error();
        const source = { id: sourceId, title: song.name, artists: artists.map(artist => artist.name).join(' / '), durationSec: Math.round(duration / 1000) };
        library.addSources([source]);
        return source;
      } catch { throw new FamilySongError('FAMILY_SOURCE_UNAVAILABLE', '选定歌曲版本的信息暂时无法读取。'); }
    },
    search: async (query) => {
      const keyword = String(query || '').trim();
      if (!keyword || keyword.length > 80) throw new FamilySongError('FAMILY_QUERY_INVALID', '请输入简短歌名。');
      const song = api.use('song');
      if (!song?.search) throw new FamilySongError('FAMILY_SONG_MODULE_MISSING', '内置翻唱模块不可用。');
      let list;
      try { list = (await song.search(keyword)).map(item => ({ id: String(item.id), title: item.name,
        artists: item.artists || '', durationSec: Number(item.durationSec) || 0 })); }
      catch { throw new FamilySongError('FAMILY_SEARCH_FAILED', '歌曲搜索未完成，请稍后重试。'); }
      library.addSources(list);
      return list;
    },
  };
}
