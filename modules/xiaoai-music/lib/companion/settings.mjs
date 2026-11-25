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
  return {
    options: [{ id: '', label: '跟随 AuraBot「表达」' }, ...models],
    dialogue: { configured: baseReady && (!selectedDialogue || hasModel(selectedDialogue)),
      label: selectedDialogue && hasModel(selectedDialogue) ? selectedDialogue : 'AuraBot表达模块的当前声音', engine },
    singing: { configured: hasModel(selectedSinging), label: hasModel(selectedSinging) ? selectedSinging : '尚未选择翻唱音色' },
    guide: { dialogue: { tab: 'voice', label: '表达 → 语音' }, singing: { tab: 'song', label: '表达 → 翻唱' } },
  };
}
