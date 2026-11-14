import { isDirectDshCall } from './dsh-source.mjs';
import { refreshFamilyToolBindings } from './tool-refresh.mjs';

export const PLAYBACK_ACTIONS = ['catalog', 'status', 'play-song', 'play-playlist', 'shuffle-playlist', 'next', 'pause', 'resume', 'stop'];
export const REMINDER_PROPERTIES = {
  action: { type: 'string', enum: ['create', 'list', 'cancel', 'preview'] },
  text: { type: 'string', maxLength: 500, description: '提醒提示词；到时由AuraBot按当前人设组织话语，不要求逐字朗读。' },
  id: { type: 'string', description: '取消时填写list返回的提醒ID。' },
  schedule: { type: 'object', properties: {
    frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'once'] },
    time: { type: 'string', description: '北京时间HH:mm，24小时制。', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
    date: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'once必填：北京时间YYYY-MM-DD，与time组成尚未到时的一次提醒。' },
    weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, uniqueItems: true,
      description: 'weekly必填：1周一至7周日，可多选。' },
    monthDay: { type: 'integer', minimum: 1, maximum: 31, description: 'monthly必填；月份没有该日期则跳过。' },
  }, required: ['frequency', 'time'], additionalProperties: false },
};
export const PLAYBACK_PROPERTIES = {
  action: { type: 'string', enum: PLAYBACK_ACTIONS },
  query: { type: 'string', maxLength: 160, description: '歌曲/歌单名称或catalog返回的ID，不确定版本先查catalog。' },
};

export function registerFamilyTools(api, { execute, remind, available = () => true }) {
  const build = ({ chat, level, sessionId }) => {
    if (!['private', 'group'].includes(chat?.kind) || level === 'chat') return [];
    const owner = exec => api.core.hub?.turnHasOwner?.(sessionId) === true || isDirectDshCall(exec, sessionId);
    const make = (name, description, properties, run) => api.defineTool({ name, description, properties, required: ['action'],
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      execute: async (args, exec) => {
        if (!available()) return { ok: false, code: 'FAMILY_MODULE_UNAVAILABLE', message: '家庭模块正在更新或关闭，请稍后重试。' };
        if (!owner(exec)) return { ok: false, code: 'FAMILY_OWNER_REQUIRED', message: '只有主人能调用家庭接口。' };
        const isCurrent = () => available() && owner(exec) && !exec?.signal?.aborted;
        if (!isCurrent()) return { ok: false, cancelled: true };
        return run(args, { isCurrent });
      },
    });
    return [
      make('xiaoai_music', '家庭小爱音箱接口：查看曲库/歌单、播放状态，点播已保存歌曲或歌单、随机一轮、下一首、暂停、继续、停止。仅主人可调用；不会把歌曲发到QQ。', PLAYBACK_PROPERTIES, execute),
      make('xiaoai_reminder', '家庭定时提醒：create设置每日/每周/每月周期，或once一次提醒的date日期、time北京时间和提示词；到时AuraBot按当前人设生成话语，在独立“小爱音响接入 · 提醒”会话留记录并投送小爱音箱。list查看，cancel取消，preview只生成文字预览不播报。播报需等音箱空闲；不向QQ发送提醒。', REMINDER_PROPERTIES, remind),
    ];
  };
  api.tool(build);
  api.onDispose?.(refreshFamilyToolBindings(api, build));
  api.rule(() => '家庭音箱用xiaoai_music：先catalog确认曲库和歌单，再点播或控制。主人设置一次或日/周/月提醒时用xiaoai_reminder；time为北京时间HH:mm，周用weekdays(1周一到7周日)，月用monthDay；一次用frequency=once和date(YYYY-MM-DD)，执行后结束。提醒文字是给AuraBot的提示词，不能把创建成功说成已播报；以工具结果为准。');
}
