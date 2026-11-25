/**
 * 停用 / 卸载后的延迟网关恢复
 * ============================
 * 从 `index.mjs` 抽出来的独立调度器，只做「什么时候写回配置」，不碰宿主 API 的具体实现，
 * 这样这段时序逻辑可以被单测覆盖（热重载取消、代际失效、linked 判据）。
 *
 * 为什么必须延迟：宿主的「热重载」和「真停用/卸载」都会走 `onDispose`，两者唯一的区别
 * 是「宽限期内会不会再 setup 一次」。所以停用后先挂一个待恢复任务，新实例创建时把它取消：
 *   - 热重载：新实例在宽限期内 setup → 取消 → 网关不动（否则改一行代码就把网关切走）
 *   - 真停用/卸载：没人取消 → 宽限期到点写回原配置
 *
 * 代际（generation）兜底：旧实例被替换后即使再被调用，也不允许安排恢复。
 *
 * 已知边界：定时器 `unref`，所以「卸载后 5 秒内直接退出 DSH 进程」不会恢复；
 * 面板里有强提示要求先手动点「一键恢复原网关」，README 也写明了这条。
 */

/** 宽限期：够热重载走完 setup，又不会让用户等太久 */
export const RESTORE_GRACE_MS = 5000;

/** 存在 globalThis 上而不是模块作用域：热重载会重新求值模块，变量会丢，任务就变成孤儿 */
const PENDING = '__roostBridgePendingGatewayRestore';
const GENERATION = '__roostBridgeSetupGeneration';

/**
 * @param {object} options
 * @param {{ get: () => object, mark: (name: string, value?: any) => any }} options.state 模块状态（lib/state.mjs）
 * @param {(patch: object) => void} options.setConfig 写宿主配置（api.setConfig）
 * @param {(input: { botQQ?: string, diary?: any, qzoneSocial?: any }) => object} options.restorePatch 生成恢复 patch
 * @param {(...args: any[]) => void} [options.log]
 * @param {number} [options.graceMs]
 * @param {object} [options.env] 存放跨实例标记的对象（默认 globalThis；测试可传一个空对象）
 */
export function createGatewayRestore({ state, setConfig, restorePatch, log = () => {}, graceMs = RESTORE_GRACE_MS, env = globalThis } = {}) {
  if (!state || typeof state.get !== 'function') throw new Error('createGatewayRestore 需要 state');
  if (typeof setConfig !== 'function') throw new Error('createGatewayRestore 需要 setConfig');
  if (typeof restorePatch !== 'function') throw new Error('createGatewayRestore 需要 restorePatch');

  // 每次 setup 都是一个新实例，代际 +1；旧实例从此无权安排恢复
  const generation = Number(env[GENERATION] || 0) + 1;
  env[GENERATION] = generation;

  function cancel() {
    const timer = env[PENDING];
    if (timer) {
      clearTimeout(timer);
      env[PENDING] = null;
    }
  }

  /** 立刻写回原网关；返回是否真的写了（没接入过就不用恢复） */
  function restoreNow() {
    const s = state.get();
    if (!s.linked) return false;
    setConfig(restorePatch({
      botQQ: s.prevBotQQ,
      diary: s.prevDiaryEnabled,
      qzoneSocial: s.prevQzoneSocialEnabled,
    }));
    state.mark('linked', false);
    return true;
  }

  /** 停用/卸载时调用；返回是否挂上了待恢复任务 */
  function schedule() {
    if (env[GENERATION] !== generation) return false; // 已被新实例顶掉
    cancel();
    const timer = setTimeout(() => {
      if (env[PENDING] !== timer) return; // 被更新的任务或取消顶掉
      env[PENDING] = null;
      if (env[GENERATION] !== generation) return; // 新实例已接管，绝不恢复
      try {
        if (restoreNow()) log('模块已停用，aurabot 网关已自动恢复为原配置');
      } catch (e) { log('停用后自动恢复网关失败：' + e.message); }
    }, graceMs);
    timer.unref?.();
    env[PENDING] = timer;
    return true;
  }

  // 新实例接管：清掉旧实例留下的待恢复任务（热重载时这一步就是「别把网关切回去」）
  cancel();

  return { generation, schedule, cancel, restoreNow };
}
