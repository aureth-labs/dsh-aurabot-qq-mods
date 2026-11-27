import { LOCAL_VOICE_PREFIX, readLocalSongVoices, singingVoiceLabel } from '../songs/local-voices.mjs';

export function getVoiceOptions(api) {
  const config = api.config() || {};
  const voice = config.voice || {};
  let models = [];
  try {
    const available = api.use?.('song')?.status?.().voices;
    if (Array.isArray(available)) models = [...new Set(available.map(item => item?.id)
      .filter(id => typeof id === 'string' && id.trim() && !/[\\/\x00-\x1f]/.test(id)))].map(id => ({ id, label: id }));
  } catch {}
  const hasModel = id => models.some(item => item.id === id);
  const engine = ['auto', 'edge', 'windows', 'cosyvoice', 'gptsovits', 'http'].includes(voice.engine) ? voice.engine : '';
  const baseReady = voice.enabled !== false && Boolean(engine) && (engine === 'edge' ? Boolean(String(voice.voice || '').trim())
    : engine === 'auto' || engine === 'windows' || engine === 'http' ? (engine !== 'http' || String(voice.http?.urlTemplate || '').includes('{text}'))
    : Boolean(String(voice[engine]?.url || '').trim()));
  const selectedDialogue = String(voice.songVoice || '');
  const selectedSinging = String(config.song?.voice || '');
  // 已登记的本地整曲音色只进入翻唱音色下拉（local:<id>），不进入对话或 TTS 音色选项。
  const localVoices = readLocalSongVoices(api);
  const localOptions = localVoices.entries.map(item => ({ id: LOCAL_VOICE_PREFIX + item.id, label: singingVoiceLabel(item.label, true) }));
  const options = [...models.map(item => ({ ...item, label: singingVoiceLabel(item.label) })), ...localOptions];
  const singingId = String(api.settings?.()?.motherVoice || selectedSinging);
  const singingOption = options.find(item => item.id === singingId);
  return {
    options: [{ id: '', label: '跟随 AuraBot「表达」' }, ...options],
    localVoices,
    dialogue: { configured: baseReady && (!selectedDialogue || hasModel(selectedDialogue)),
      label: selectedDialogue && hasModel(selectedDialogue) ? selectedDialogue : 'AuraBot表达模块的当前声音', engine },
    singing: { id: singingId, configured: Boolean(singingOption),
      label: singingOption?.label || (singingId ? singingVoiceLabel(singingId) + '（不可用）' : '尚未选择翻唱音色') },
    guide: { dialogue: { tab: 'voice', label: '表达 → 语音' }, singing: { tab: 'song', label: '表达 → 翻唱' } },
  };
}
