import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const XIAOAI_FULL_SONG_TASK = 'xiaoai-full-song/v1';

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// renderFullSong 由现有翻唱链提供，将已混好的完整 WAV 写入 output。
export function createXiaoaiFullSong({ voiceId, model, config, revision, renderFullSong }) {
  return async function xiaoaiFullSong(args) {
    if (args.voiceId !== voiceId) throw new Error(`不支持的本地整曲音色：${args.voiceId}`);

    const [modelSha256, configSha256] = await Promise.all([sha256File(model), sha256File(config)]);
    const params = { revision, modelSha256, configSha256 };
    const renderVersion = createHash('sha256').update(JSON.stringify(params)).digest('hex');

    if (args.describe === true) return { kind: 'describe', voiceId, renderVersion, params };
    if (args.renderVersion !== renderVersion) throw new Error('本地整曲渲染版本不匹配，请更新音色登记');

    const { refSong, vocal, inst, output, pitch, log } = args;
    await renderFullSong({ refSong, vocal, inst, output, pitch, log, model, config });
    return { kind: 'master', file: output, voiceId, renderVersion, params };
  };
}
