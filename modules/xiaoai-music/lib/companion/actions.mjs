import { matchSavedSongSources } from '../speaker/probe.mjs';
import { FamilySongError, songFailure } from '../songs/library.mjs';

const normalize = value => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
export function createFamilyActions({ getContext, onMutation, getIntent }) {
  return async (args, { isCurrent = () => true } = {}) => {
    try {
      const context = await getContext();
      if (!isCurrent()) return { ok: false, cancelled: true };
      const { library, playlists, playback } = context;
      const entries = library.status().entries;
      const lists = playlists.status();
      if (args.action === 'catalog') return { ok: true, songs: entries, playlists: lists };
      if (args.action === 'status') return { ok: true, playback: playback.status() };
      if (!['play-song', 'play-playlist', 'shuffle-playlist', 'next', 'pause', 'resume', 'stop'].includes(args.action)) {
        return { ok: false, message: '请选择家庭播放接口支持的操作。' };
      }
      const query = String(args.query || '').trim();
      let entry, list;
      if (args.action === 'play-song') {
        entry = entries.find(item => item.id === query);
        if (!entry) {
          const exact = entries.filter(item => item.sourceId === query);
          const sources = exact.length ? [...new Set(exact.map(item => item.sourceId))] : matchSavedSongSources(entries, query);
          const matches = entries.filter(item => sources.includes(item.sourceId));
          if (matches.length !== 1) return { ok: false, message: '请先从曲库选择明确的歌曲版本，使用该成品的ID点播。' };
          entry = matches[0];
        }
      }
      if (['play-playlist', 'shuffle-playlist'].includes(args.action)) {
        const matches = lists.filter(item => !query || item.id === query || normalize(item.name) === normalize(query));
        if (matches.length !== 1) return { ok: false, message: '请先明确选择一个家庭歌单。' };
        list = matches[0];
      }
      const ticket = onMutation();
      const current = () => isCurrent() && ticket === getIntent();
      if (!current()) return { ok: false, cancelled: true };
      if (entry) await playback.entry(entry.id, { announce: true, isCurrent: current });
      else if (list) await playback.playlist(list.ids, {
        mode: args.action === 'shuffle-playlist' ? 'random' : 'sequential', announce: true, isCurrent: current,
      });
      else if (args.action === 'next') await playback.next({ isCurrent: current });
      else await playback[args.action]();
      if (entry || list || args.action === 'next') await playback.task;
      if (!current()) return { ok: false, cancelled: true };
      if (playback.error) return { ok: false, ...playback.error };
      return { ok: true, playbackHandled: true, playback: playback.status(), message: '家庭播放操作已完成。' };
    } catch (error) {
      return { ok: false, ...(error instanceof FamilySongError ? songFailure(error)
        : { code: 'FAMILY_ACTION_FAILED', message: '家庭播放操作未完成。' }) };
    }
  };
}
