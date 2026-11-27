// 本地整曲音色登记：小爱模块自己的配置，默认空列表。
//
// 登记文件放在模块数据目录（api.dataDir()）下的「本地整曲音色.json」，
// 数组格式：[{ "id": "宵宫", "label": "宵宫", "renderVersion": "..." }]。
// id 用于面板下拉（选项 id 为 local:<id>）与任务标记路由；
// label 是面板显示名；renderVersion 由真实权重、模型配置、混音配置和
// 渲染实现版本确定（由本地钩子按同一约定计算并核对，不匹配即失败）。
// 未登记的用户继续走原有小爱 RVC（Applio）流程。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCAL_VOICE_PREFIX = 'local:';
export const LOCAL_VOICE_FILE = '本地整曲音色.json';

export function singingVoiceLabel(name, local = false) {
  if (!local) return name === 'bb_mother_v1' ? '妈妈' : name;
  return name + (name === '妈妈' ? '（本地混音）' : '（本地整曲）');
}

const VOICE_ID = /^[^\s\\/:<>"|?*\x00-\x1f]{1,48}$/;

export function localVoicesFile(api) {
  const base = typeof api.dataDir === 'function' ? api.dataDir() : '';
  if (typeof base !== 'string' || !base) return '';
  return join(base, LOCAL_VOICE_FILE);
}

export function validLocalVoiceId(id) {
  return typeof id === 'string' && VOICE_ID.test(id.trim());
}

/**
 * 读取本地整曲音色登记。
 * 文件缺失按空列表处理；单条格式无效跳过并提示；整个文件读不了时
 * entries 为空并带 error，调用方按「已登记音色不可用」给出明确错误。
 * @returns {{file: string, entries: {id: string, label: string, renderVersion: string}[], error: string}}
 */
export function readLocalSongVoices(api) {
  const file = localVoicesFile(api);
  if (!file || !existsSync(file)) return { file, entries: [], error: '' };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { file, entries: [], error: '登记文件不是有效 JSON（' + (error?.message || '') + '）' };
  }
  if (!Array.isArray(raw)) return { file, entries: [], error: '登记文件应为数组：[{ "id", "label", "renderVersion" }]' };
  const entries = [];
  let skipped = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') { skipped++; continue; }
    const id = String(item.id ?? '').trim();
    const label = String(item.label ?? '').trim();
    const renderVersion = String(item.renderVersion ?? '').trim();
    if (!validLocalVoiceId(id) || !label || !renderVersion) { skipped++; continue; }
    entries.push({ id, label, renderVersion });
  }
  return {
    file,
    entries,
    error: skipped ? `有 ${skipped} 条登记格式无效（需要 id / label / renderVersion），已跳过` : '',
  };
}
