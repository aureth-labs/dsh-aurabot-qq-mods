// 高级消息的接入口：睡觉、工具姿势。
// 电玩城/棋盘/餐厅上游 1.1 已经自带（bridge/lib/arcade.mjs 和 cabin_restaurant），这里不再重复实现。
// 桥本身不发明任何结果：每条路都以游戏回来的帧为准，游戏拒绝就照实说拒绝。

import fs from 'node:fs';
import path from 'node:path';
import { createSleep } from './sleep.mjs';

/**
 * 等一帧符合条件的回包（先挂监听再发送，避免回得太快错过）。
 * 游戏回的一部分帧没有 id（body.toolPose 等），不能挂进 CabinHost.pending，只能用 host.on('frame') 自己匹配。
 */
function awaitFrame(host, match, timeoutMs = 4000, { send = null } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return; done = true;
      clearTimeout(timer); host.off('frame', onFrame); host.off('disconnected', onLost);
      fn(v);
    };
    const onFrame = f => { let hit = false; try { hit = match(f) === true; } catch { hit = false; } if (hit) finish(resolve, f); };
    const onLost = () => finish(reject, Error('游戏断开了，结果没有回来'));
    const timer = setTimeout(() => finish(reject, Error('游戏 ' + Math.round(timeoutMs / 1000) + ' 秒没有回话')), timeoutMs);
    timer.unref?.();
    host.on('frame', onFrame); host.once('disconnected', onLost);
    if (send) { try { host.send(send); } catch (error) { finish(reject, error); } }
  });
}

/**
 * 工具姿势：body.tool → body.toolPose。游戏按住户资料挑姿势，桥不改住户数据；
 * 游戏答不上来就照实说没有配。
 * @returns {Promise<{name:string, location:string, visual:object, configured:boolean}>}
 */
async function resolveToolPose(host, actor, { tool, location = '' } = {}, timeoutMs = 4000) {
  const name = String(tool || '').trim();
  if (!name) throw Object.assign(Error('要给一个工具名，例如 typing、drawing、reading'), { status: 400 });
  const where = String(location || '');
  const frame = await awaitFrame(host, f => f.type === 'body.toolPose' && f.actor === actor && f.name === name, timeoutMs,
    { send: { type: 'body.tool', actor, name, location: where } });
  const visual = frame && frame.visual && typeof frame.visual === 'object' ? frame.visual : {};
  return { name, location: where, visual, configured: Object.keys(visual).length > 0 };
}

function notReady(what) {
  return Object.assign(Error('游戏还没连上，' + what + '要等小屋世界开着'), { status: 503 });
}

export function createAdvanced({ host, resident, catalog, dataDir, log = () => {} }) {
  const key = resident.key;
  const sleep = createSleep({ host, resident, log });

  const caps = { connected: false, at: 0 };
  const tools = { sleep: false, toolpose: false };

  function attach(frame = {}) {
    caps.connected = true;
    caps.at = Date.now();
    for (const k of ['actions', 'economy', 'walk', 'residents', 'sleepProfiles', 'toolPoses', 'game']) {
      if (frame[k] !== undefined) caps[k] = frame[k];
    }
    tools.sleep = Boolean(caps.sleepProfiles && Object.keys(caps.sleepProfiles).length);
    tools.toolpose = Boolean(caps.toolPoses && Object.keys(caps.toolPoses).length);
    try {
      const file = path.join(dataDir, 'advanced-caps.json');
      fs.writeFileSync(file, JSON.stringify({ at: caps.at, tools, caps }, null, 2) + '\n', { mode: 0o600 });
    } catch (error) { log('能力位没写下来：' + error.message); }
    log('高级协议就绪：睡觉=' + tools.sleep + ' 姿势=' + tools.toolpose);
    return { ...tools };
  }

  function detach() {
    caps.connected = false;
  }

  function status() {
    return { connected: caps.connected, tools: { ...tools }, at: caps.at };
  }

  // ---- 工具姿势 -----------------------------------------------------------------------
  async function toolpose(args = {}) {
    if (!host.connected) throw notReady('换姿势');
    const got = await resolveToolPose(host, key, { tool: args.tool || args.name, location: args.location || '' });
    if (!got.configured) {
      return {
        ok: false, status: 'done', label: '换姿势',
        result: { ok: false, outcome: '这位住户没有配置「' + got.name + '」的姿势（residents.json 的 tool_poses 里没有匹配规则）', happened: [] },
      };
    }
    resident.pose = { name: got.name, ...got.visual };
    // 打字/写字这类姿势在游戏里有真实的身体表现：电脑前坐下、屏幕切成 typing。
    // 只有人在家里（电脑在家）才发，免得她为了一个姿势横穿整个公园。
    if (/^(typing|type|writing|write|working|work)$/i.test(got.name) && resident.space === 'xjhome') {
      try {
        host.send({ type: 'body.do', actor: key, part: 'computer', method: 'use', args: ['typing', 'pose-' + Date.now().toString(36)], at: Date.now() });
      } catch { /* 断线就算了，姿势本身已经拿到 */ }
    }
    resident.publish();
    const label = got.visual.label || ('摆出' + got.name + '的姿势');
    return { ok: true, status: 'done', label, result: { ok: true, happened: [label], pose: got.visual } };
  }

  // ---- 睡觉 ---------------------------------------------------------------------------
  async function sleepTool(args = {}) {
    if (!host.connected) throw notReady('睡觉');
    const action = String(args.action || 'state').trim();
    if (action === 'plan') {
      const got = await sleep.plan();
      const word = { sleep: '该睡了', defer: '该睡了但正忙，等一等', rest: '已经躺着但还没盖被子，可以继续睡', wake: '该起床了', idle: '不用睡' }[got.decision] || got.decision;
      return { ok: true, status: 'done', label: '按作息看', result: { ok: true, decision: got.decision, happened: ['按作息：' + word + '（' + (got.facts.night ? '夜里' : '白天') + '）'], facts: got.facts, bed: sleep.describe({ bed: got.bed }).bed } };
    }
    if (action === 'state') {
      const snap = await sleep.state();
      const d = sleep.describe(snap);
      return { ok: true, status: 'done', label: '看床上状态', result: { ok: true, happened: [d.bed.text ? '床上：' + d.bed.text : '不在床上'], bed: d.bed, items: d.items, computer: d.computer } };
    }
    if (['sleep', 'wake', 'rest', 'sit', 'cover', 'leave'].includes(action)) {
      if (action === 'sleep') {
        const home = (catalog.spaces || []).find(s => s.id === 'xjhome') || {};
        const space = (catalog.spaces || []).find(s => s.id === resident.space) || null;
        if (space && home.id && space.id !== 'xjhome') await resident.walkTo(home.scene || 'world-xjhome');
      }
      const out = await sleep.doAction(action);
      resident.asleep = Boolean(out.result && out.result.bed && out.result.bed.asleep);
      resident.publish();
      return out;
    }
    throw Object.assign(Error('睡觉能做：plan、sleep、wake、rest、sit、cover、leave、state'), { status: 400 });
  }

  return { attach, detach, status, toolpose, sleep: sleepTool, sleepEngine: sleep };
}
