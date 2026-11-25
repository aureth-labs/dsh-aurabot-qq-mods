import { recordKey } from './cursor.mjs';
import { parseProbeCommand } from './probe.mjs';
import { describeWakeMatch } from './wake.mjs';

// Only explicit local reads return text. Never persist cloud records or include them in status.
export function recognitionRows(records, wakeConfig, observations = new Map()) {
  return [...records].sort((a, b) => b.time - a.time).slice(0, 10).map(record => {
    const action = parseProbeCommand(record.query, { sessionRouting: true, wakeConfig });
    const match = describeWakeMatch(record.query.replace(/[\s，。！？、,.!?：:]/g, ''), wakeConfig);
    return { time: record.time, text: record.query.slice(0, 1000), matched: Boolean(action),
      heardPinyin: match.heardPinyin, targetPinyin: match.targetPinyin,
      action: action?.action || '', outcome: observations.get(recordKey(record)) || '无本轮处理记录；不能据此判断此前是否注入。' };
  });
}
