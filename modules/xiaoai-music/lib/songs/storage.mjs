import { isAbsolute, join } from 'node:path';

export function resourcePaths(base) {
  if (typeof base !== 'string' || !isAbsolute(base)) throw new Error('家庭资源位置不可用。');
  const songRoot = join(base, 'song DB');
  const familyRoot = join(base, 'AuraBot-Family');
  return {
    songRoot,
    metadataRoot: join(songRoot, '歌曲信息'),
    workRoot: join(familyRoot, 'Generation-Work'),
    playlistsFile: join(familyRoot, 'Playlists', '家庭歌单.json'),
    directoriesFile: join(familyRoot, 'Music', 'directories.json'),
    cursorFile: join(familyRoot, 'Speaker', '语音入口游标.json'),
    dialogueWorkRoot: join(familyRoot, 'Dialogue-Work'),
    listenerFile: join(familyRoot, 'Speaker', '常驻入口.json'),
    sessionFile: join(familyRoot, 'Conversations', '家庭会话.json'),
    reminderSessionFile: join(familyRoot, 'Conversations', '家庭提醒会话.json'),
    remindersFile: join(familyRoot, 'Reminders', '定时提醒.json'),
    workspaceRoot: join(familyRoot, 'Conversations', 'Workspace'),
  };
}

const clean = value => value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
  .replace(/\s+/gu, ' ').replace(/^[. ]+|[. ]+$/g, '');
const fit = (value, length) => value.slice(0, length).replace(/[\uD800-\uDBFF]$/, '').replace(/[. ]+$/, '');

export function audioFileName(entry) {
  const sourceId = String(entry?.source?.id || '');
  const pitch = entry?.identity?.parameters?.pitch ?? 0;
  if (typeof entry?.id !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.id) ||
      typeof entry?.source?.title !== 'string' || !entry.source.title.trim() ||
      !/^[a-z0-9_-]{1,48}$/i.test(sourceId) || !Number.isInteger(pitch) || pitch < -24 || pitch > 24) {
    throw new Error('歌曲文件信息不可用。');
  }
  const title = clean(entry.source.title) || '未命名歌曲';
  const artists = clean(String(entry.source.artists || '')) || '未知歌手';
  const shift = pitch > 0 ? `升${pitch}调` : pitch < 0 ? `降${-pitch}调` : '';
  const version = entry.identity?.voice?.role === 'original' ? '原曲' :
    entry.voiceName ? `翻唱 ${fit(clean(String(entry.voiceName)), 40)}` : '妈妈版';
  const suffix = ` - ${version}${shift} [${sourceId}-${entry.id.slice(0, 12).toLowerCase()}].mp3`;
  const room = 220 - suffix.length - 3;
  const artistPart = fit(artists, Math.min(60, Math.floor(room / 3)));
  const titlePart = fit(title, room - artistPart.length);
  return `${titlePart} - ${artistPart}${suffix}`;
}
