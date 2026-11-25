import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, isAbsolute, win32 } from 'node:path';
import { resourcePaths, audioFileName } from '../lib/songs/storage.mjs';

const entry = (options = {}) => ({
  id: 'a'.repeat(64), source: { id: '123456', title: '小星星 Twinkle Star', artists: 'Synthetic Artist' },
  identity: { parameters: { pitch: 0 } }, ...options,
});

test('family resource paths use the requested categories without accessing the filesystem', () => {
  const base = join(tmpdir(), 'family-storage-synthetic');
  const paths = resourcePaths(base);
  assert.deepEqual(paths, {
    songRoot: join(base, 'song DB'), metadataRoot: join(base, 'song DB', '歌曲信息'),
    workRoot: join(base, 'AuraBot-Family', 'Generation-Work'),
    playlistsFile: join(base, 'AuraBot-Family', 'Playlists', '家庭歌单.json'),
    directoriesFile: join(base, 'AuraBot-Family', 'Music', 'directories.json'),
    cursorFile: join(base, 'AuraBot-Family', 'Speaker', '语音入口游标.json'),
    dialogueWorkRoot: join(base, 'AuraBot-Family', 'Dialogue-Work'),
    listenerFile: join(base, 'AuraBot-Family', 'Speaker', '常驻入口.json'),
    sessionFile: join(base, 'AuraBot-Family', 'Conversations', '家庭会话.json'),
    reminderSessionFile: join(base, 'AuraBot-Family', 'Conversations', '家庭提醒会话.json'),
    remindersFile: join(base, 'AuraBot-Family', 'Reminders', '定时提醒.json'),
    workspaceRoot: join(base, 'AuraBot-Family', 'Conversations', 'Workspace'),
  });
  assert.ok(Object.values(paths).every(isAbsolute));
  assert.throws(() => resourcePaths('relative-folder'), { message: '家庭资源位置不可用。' });
});

test('audio names retain song artist mother role and source version for inspection', () => {
  const name = audioFileName(entry());
  assert.equal(name, '小星星 Twinkle Star - Synthetic Artist - 妈妈版 [123456-aaaaaaaaaaaa].mp3');
  assert.equal(win32.basename(name), name);
  assert.equal(audioFileName(entry()), name);
});

test('Windows-invalid title characters and traversal wording cannot produce a directory path', () => {
  const name = audioFileName(entry({ source: { id: '123456', title: '../小星星?.  ', artists: '家庭 / 合唱:*\n' } }));
  assert.equal(name, '小星星 - 家庭 合唱 - 妈妈版 [123456-aaaaaaaaaaaa].mp3');
  assert.equal(win32.basename(name), name);
  assert.equal(/[<>:"/\\|?*\x00-\x1f]/.test(name), false);
});

test('long Unicode names fit a Windows component while retaining both title and artist', () => {
  const name = audioFileName(entry({ source: { id: '123456', title: '歌曲😀'.repeat(100), artists: '艺术家'.repeat(100) } }));
  assert.ok(name.length <= 220);
  assert.ok(name.includes('歌曲'));
  assert.ok(name.includes('艺术家'));
  assert.equal(Array.from(name).some(char => /^[\uD800-\uDFFF]$/.test(char)), false);
  assert.ok(name.endsWith(' [123456-aaaaaaaaaaaa].mp3'));
});

test('pitch and different version prefixes are identifiable without renaming the song', () => {
  assert.match(audioFileName(entry({ identity: { parameters: { pitch: 2 } } })), /妈妈版升2调/);
  assert.match(audioFileName(entry({ identity: { parameters: { pitch: -3 } } })), /妈妈版降3调/);
  assert.notEqual(audioFileName(entry()), audioFileName(entry({ id: 'b'.repeat(64) })));
});

test('invalid identity source and pitch inputs produce only a fixed error', () => {
  for (const value of [entry({ id: 'invalid-private-value' }), entry({ source: { id: '../invalid', title: 'Test' } }),
    entry({ identity: { parameters: { pitch: '2' } } }), entry({ identity: { parameters: { pitch: 25 } } }), null]) {
    assert.throws(() => audioFileName(value), { message: '歌曲文件信息不可用。' });
  }
});
