import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const TITLE = '小爱音响接入 · 对话';
const PRESET = 'aurabot-social';
const TOOL = 'xiaoai_music';
const ACTIONS = ['catalog', 'status', 'play-song', 'play-playlist', 'shuffle-playlist', 'next', 'pause', 'resume', 'stop'];
const MUTATIONS = new Set(ACTIONS.filter(action => !['catalog', 'status'].includes(action)));
// The controller owns live agents beyond a module hot reload. Keep their empty
// inherited-tool mask and native transport until the agent itself is disposed.
const fenceKey = Symbol.for('aurabot.xiaoai-music.session-fences');
const fences = globalThis[fenceKey] ||= new WeakMap();
const messages = {
  FAMILY_SESSION_UNAVAILABLE: 'DSH家庭会话服务暂不可用。',
  FAMILY_SESSION_STORAGE: '家庭会话记录不可读写，未另开会话。',
  FAMILY_SESSION_RESOLVE: '原家庭会话暂时无法恢复，未另开会话。',
  FAMILY_SESSION_SCOPE: '家庭会话的人设或工具隔离检查未通过。',
  FAMILY_SESSION_MODEL: '家庭会话的模型选择未完成。',
  FAMILY_SESSION_REQUEST: 'DSH家庭会话本轮未完成。',
  FAMILY_SESSION_EMPTY: '家庭会话没有返回可播报的文字。',
  FAMILY_SESSION_CANCELLED: '本次家庭请求已取消。',
  FAMILY_SESSION_TIMEOUT: '家庭会话等待超时，本轮已取消。',
  FAMILY_SESSION_TOOL: '家庭工具未完成操作。',
};
export class FamilySessionError extends Error {
  constructor(code) { super(messages[code] || messages.FAMILY_SESSION_REQUEST); this.code = code; }
}
const key = id => String(id || '').replace(/^session-/, '');
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,180}$/.test(id);
const fixed = (error, fallback) => error instanceof FamilySessionError ? error : new FamilySessionError(fallback);
const textOf = message => (Array.isArray(message?.content) ? message.content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();

export async function createFamilySession(api, resources, { persona, execute, timeoutMs = 180000, title = TITLE, requireNativeTools = true }) {
  if (typeof title !== 'string' || !title.trim()) throw new FamilySessionError('FAMILY_SESSION_SCOPE');
  title = title.trim();
  let sessionId = '';
  let agent;
  let controller;
  let initializing;
  let createdMapping;
  let offs = [];
  let closed = false;
  let generation = 0;
  let queue = Promise.resolve();
  let pending;
  let activeTurn = null;
  const turns = new Map();
  let lastError = null;
  let fence;
  const owner = {};

  const setError = error => { lastError = { code: error.code, message: error.message }; return error; };
  const valid = request => !closed && request.ticket === generation && !request.cancelled && request.isCurrent();
  function settle(request, error, value) {
    if (!request || request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(value);
  }
  function stopCurrent(error = new FamilySessionError('FAMILY_SESSION_CANCELLED')) {
    if (activeTurn !== null && turns.has(activeTurn)) turns.get(activeTurn).cancelled = true;
    if (pending) { pending.cancelled = true; settle(pending, error); }
    agent?.cancel({ kind: 'user' });
  }
  function event(_session, value) {
    if (closed || key(_session?.id) !== key(sessionId) || !value) return;
    const data = value.data || {};
    if (value.type === 'turn/start') {
      activeTurn = data.turn;
      turns.set(data.turn, { manual: false, cancelled: false, request: null });
    } else if (value.type === 'user/message') {
      const turn = turns.get(activeTurn);
      if (!turn) return;
      if (pending && data.id === pending.messageId) {
        pending.turn = activeTurn;
        turn.request = pending;
      } else if (!turn.request && data.source?.kind === 'user') turn.manual = true;
    } else if (value.type === 'assistant/message') {
      const request = turns.get(data.turn)?.request;
      if (request && !data.interrupted) request.text = textOf(data.message);
    } else if (value.type === 'turn/end') {
      const turn = turns.get(data.turn);
      const request = turn?.request;
      if (request && !request.settled) {
        if (turn.cancelled || !valid(request)) settle(request, new FamilySessionError('FAMILY_SESSION_CANCELLED'));
        else if (data.reason?.kind !== 'completed') settle(request, new FamilySessionError('FAMILY_SESSION_REQUEST'));
        else if (!request.text && !request.suppressSpeech) settle(request, new FamilySessionError('FAMILY_SESSION_EMPTY'));
        else settle(request, null, { text: request.text, suppressSpeech: request.suppressSpeech, toolCalls: request.toolCalls });
      }
      turns.delete(data.turn);
      if (activeTurn === data.turn) activeTurn = null;
    }
  }
  const tool = {
    name: TOOL,
    description: '小爱音响接入中枢：查看妈妈曲库和播放状态，播放指定妈妈歌曲或歌单、随机一轮、下一首、暂停、继续或停止。只操作家庭模块；同名版本不明时先询问。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ACTIONS }, query: { type: 'string', maxLength: 160, description: '歌曲或歌单名称，或catalog返回的成品ID；多个版本时使用明确的成品ID，不要猜。' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const turn = turns.get(activeTurn);
      const request = turn?.request;
      const isCurrent = () => !closed && key(exec?.agent?.id) === key(sessionId) && !exec?.signal?.aborted &&
        Boolean(turn) && !turn.cancelled && (request ? valid(request) : turn.manual);
      if (!isCurrent()) return { ok: false, code: 'FAMILY_SESSION_CANCELLED', message: messages.FAMILY_SESSION_CANCELLED };
      if (!ACTIONS.includes(args?.action) || (args.query !== undefined && typeof args.query !== 'string')) {
        return { ok: false, code: 'FAMILY_SESSION_TOOL', message: messages.FAMILY_SESSION_TOOL };
      }
      if (request?.readOnly && MUTATIONS.has(args.action)) {
        return { ok: false, code: 'FAMILY_SESSION_READ_ONLY', message: '本轮为只读检查，未执行播放或控制。' };
      }
      try {
        const result = await execute(args, { isCurrent, signal: exec.signal });
        if (!isCurrent()) return { ok: false, code: 'FAMILY_SESSION_CANCELLED', message: messages.FAMILY_SESSION_CANCELLED };
        if (request && result?.ok === true && !result.cancelled && !result.needsSelection) request.toolCalls++;
        if (request && MUTATIONS.has(args.action) && result?.ok === true && !result.cancelled && !result.needsSelection) {
          request.suppressSpeech = true;
        }
        return JSON.parse(JSON.stringify(result ?? { ok: false, message: messages.FAMILY_SESSION_TOOL }));
      } catch (error) {
        const failure = fixed(error, 'FAMILY_SESSION_TOOL');
        return { ok: false, code: failure.code, message: failure.message };
      }
    },
  };
  function verifyTools() {
    const names = agent.ctx.tools.schemas(agent).map(item => item.name).sort();
    if (names.length !== 1 || names[0] !== TOOL) throw new FamilySessionError('FAMILY_SESSION_SCOPE');
    if (requireNativeTools && typeof agent.ctx.tools.presentAs !== 'function') {
      const schemas = agent.ctx.tools.selectExecutor(agent).describe([tool]).schemas;
      if (schemas.length !== 1 || schemas[0].name !== TOOL) throw new FamilySessionError('FAMILY_SESSION_SCOPE');
    }
  }
  async function applyModel() {
    try {
      const { defaultModel, pickReasoningEffort } = api.lib('core/llm.js');
      const config = api.config();
      const target = defaultModel(api.dsh, config);
      if (!target?.provider || !target?.model) throw new Error();
      const effort = await pickReasoningEffort(api.dsh, target.provider, target.model, config.model?.reasoningEffort);
      const selection = { provider: target.provider, model: target.model, ...(effort ? { reasoningEffort: effort } : {}) };
      if (typeof agent.model?.select === 'function') await agent.model.select(selection);
      else if (typeof controller.agents?.selectForNextRequest === 'function') await controller.agents.selectForNextRequest(agent, selection);
      else throw new Error();
    } catch { throw new FamilySessionError('FAMILY_SESSION_MODEL'); }
  }
  function mount() {
    try {
      const ctx = agent.ctx;
      fence = fences.get(agent);
      if (fence?.owner) throw new Error();
      if (!fence) {
        const nativeOff = ctx.tools.presentAs?.('native');
        let maskOff;
        try {
          maskOff = ctx.tools.restrict({ allow: [] });
          fence = { owner: null };
          const ownFence = fence;
          ctx.tools.guard(exec => ownFence.owner && exec.name === TOOL ? undefined : '家庭会话仅开放当前家庭模块的工具。');
          fences.set(agent, fence);
        } catch { maskOff?.(); nativeOff?.(); throw new Error(); }
      }
      offs.push(ctx.systemPrompt.variable('aurabot_persona', () => persona + '\n\n家庭语音入口：简短中文回复，80字以内，只输出要说的话。歌曲及播放控制通过xiaoai_music执行，必须以工具结果为准；身份不明确时不假定身份。'));
      offs.push(ctx.systemPrompt.variable('aurabot_rules_social', () => ''));
      offs.push(ctx.tools.register(tool));
      offs.push(ctx.on('session/event', event));
      verifyTools();
      fence.owner = owner;
    } catch {
      for (const off of offs.splice(0).reverse()) { try { off(); } catch {} }
      if (fence?.owner === owner) fence.owner = null;
      throw new FamilySessionError('FAMILY_SESSION_SCOPE');
    }
  }
  async function mapping() {
    try {
      const value = JSON.parse(await readFile(resources.sessionFile, 'utf8'));
      if (value?.schema !== 1 || !safeId(value.sessionId) || !safeId(value.workspaceId) || value.preset !== PRESET) throw new Error();
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new FamilySessionError('FAMILY_SESSION_STORAGE');
    }
  }
  async function save(value) {
    const temporary = resources.sessionFile + '.tmp-' + randomUUID();
    try {
      await mkdir(dirname(resources.sessionFile), { recursive: true });
      await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, resources.sessionFile);
    } catch { throw new FamilySessionError('FAMILY_SESSION_STORAGE'); }
    finally { try { await unlink(temporary); } catch {} }
  }
  async function ensure() {
    if (closed) throw new FamilySessionError('FAMILY_SESSION_CANCELLED');
    if (agent && offs.length) return { sessionId, title };
    if (!initializing) initializing = (async () => {
      try {
        const dsh = api.dsh;
        controller = dsh?.get?.('sessionController');
        const registry = dsh?.workspaceRegistry || dsh?.get?.('workspaceRegistry');
        if (!controller?.create || !controller?.resolveAgent || !registry?.list || !registry?.create) throw new FamilySessionError('FAMILY_SESSION_UNAVAILABLE');
        const saved = await mapping();
        if (saved) sessionId = saved.sessionId;
        const normalize = path => resolve(path).replace(/[\\/]+$/, '').toLowerCase();
        if (saved) {
          const own = registry.list().find(item => item.id === saved.workspaceId &&
            normalize(item.path) === normalize(resources.workspaceRoot) && Array.isArray(item.sessionIds) &&
            item.sessionIds.some(id => key(id) === key(sessionId)));
          if (!own) throw new FamilySessionError('FAMILY_SESSION_RESOLVE');
        } else if (sessionId) {
          if (!createdMapping) throw new FamilySessionError('FAMILY_SESSION_STORAGE');
          await save(createdMapping);
        }
        if (!sessionId) {
          await mkdir(resources.workspaceRoot, { recursive: true });
          let workspace = registry.list().find(item => normalize(item.path) === normalize(resources.workspaceRoot));
          if (!workspace) workspace = await registry.create(resources.workspaceRoot, '小爱音响接入 · 小爱');
          const created = await controller.create({ workspaceId: workspace.id, agentPreset: PRESET });
          if (!safeId(created?.sessionId)) throw new FamilySessionError('FAMILY_SESSION_UNAVAILABLE');
          sessionId = created.sessionId;
          createdMapping = { schema: 1, sessionId, workspaceId: workspace.id, preset: PRESET, title };
          await save(createdMapping);
        }
        if ((registry.archivedSessionIds || []).some(id => key(id) === key(sessionId))) throw new FamilySessionError('FAMILY_SESSION_RESOLVE');
        const found = await controller.resolveAgent(sessionId);
        if (!found?.agent || key(found.agent.id) !== key(sessionId) ||
            !['followup', 'cancel', 'whenIdle'].every(name => typeof found.agent[name] === 'function')) {
          throw new FamilySessionError('FAMILY_SESSION_RESOLVE');
        }
        agent = found.agent;
        if (closed) throw new FamilySessionError('FAMILY_SESSION_CANCELLED');
        await controller.rename({ sessionId, title });
        if (saved && saved.title !== title) await save({ ...saved, title });
        await applyModel();
        if (closed) throw new FamilySessionError('FAMILY_SESSION_CANCELLED');
        mount();
        lastError = null;
        return { sessionId, title };
      } catch (error) { throw setError(fixed(error, sessionId ? 'FAMILY_SESSION_RESOLVE' : 'FAMILY_SESSION_UNAVAILABLE')); }
    })();
    try { return await initializing; } finally { initializing = null; }
  }
  return {
    ensure,
    status: () => ({ sessionId: sessionId || null, title, busy: Boolean(pending && !pending.settled),
      toolNames: offs.length ? [TOOL] : [], error: lastError }),
    ask(text, { isCurrent = () => true, readOnly = false } = {}) {
      const clean = String(text || '').trim();
      const ticket = ++generation;
      stopCurrent();
      const operation = queue.then(async () => {
        const request = { ticket, isCurrent, readOnly: readOnly === true, messageId: randomUUID(), turn: null, text: '', toolCalls: 0,
          suppressSpeech: false, settled: false, cancelled: false };
        try {
          if (!clean || !valid(request)) throw new FamilySessionError('FAMILY_SESSION_CANCELLED');
          await ensure();
          await agent.whenIdle();
          if (!valid(request)) throw new FamilySessionError('FAMILY_SESSION_CANCELLED');
          verifyTools();
          await applyModel();
          if (!valid(request)) throw new FamilySessionError('FAMILY_SESSION_CANCELLED');
          pending = request;
          const result = new Promise((resolveResult, rejectResult) => { request.resolve = resolveResult; request.reject = rejectResult; });
          request.timer = setTimeout(() => {
            if (pending === request) stopCurrent(new FamilySessionError('FAMILY_SESSION_TIMEOUT'));
          }, timeoutMs);
          request.timer.unref?.();
          try {
            Promise.resolve(agent.followup({ id: request.messageId, role: 'user', content: [{ type: 'text', text: clean }], source: { kind: 'xiaoai-music' } }))
              .catch(() => settle(request, new FamilySessionError('FAMILY_SESSION_REQUEST')));
          } catch { settle(request, new FamilySessionError('FAMILY_SESSION_REQUEST')); }
          const response = await result;
          await agent.whenIdle();
          if (!valid(request)) throw new FamilySessionError('FAMILY_SESSION_CANCELLED');
          const sessions = api.dsh.sessions || api.dsh.get?.('sessions');
          if (!sessions?.flush || await sessions.flush(agent.session) === false) throw new FamilySessionError('FAMILY_SESSION_STORAGE');
          lastError = null;
          return response;
        } catch (error) {
          const failure = fixed(error, 'FAMILY_SESSION_REQUEST');
          if (failure.code !== 'FAMILY_SESSION_CANCELLED') setError(failure);
          throw failure;
        } finally {
          if (pending === request) {
            clearTimeout(request.timer);
            if (!request.settled) settle(request, new FamilySessionError('FAMILY_SESSION_CANCELLED'));
            try { await agent?.whenIdle?.(); } catch {}
            pending = null;
          }
        }
      });
      queue = operation.catch(() => {});
      return operation;
    },
    cancel() { generation++; stopCurrent(); },
    async close() {
      if (closed) return;
      closed = true;
      generation++;
      stopCurrent();
      try { await initializing; } catch {}
      try { await agent?.whenIdle?.(); } catch {}
      await queue;
      for (const off of offs.splice(0).reverse()) { try { off(); } catch {} }
      if (fence?.owner === owner) fence.owner = null;
      turns.clear();
      activeTurn = null;
    },
  };
}
