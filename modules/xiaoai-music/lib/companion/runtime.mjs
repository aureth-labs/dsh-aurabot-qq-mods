import { createHash } from 'node:crypto';
import { askVoiceReply } from './voice-reply.mjs';
import { createDialogueSpeech, DialogueSpeechError } from './speech.mjs';
import { ProbeModelError } from '../speaker/model.mjs';
import { createFamilySession, FamilySessionError } from './session.mjs';
import { getVoiceOptions } from './settings.mjs';

export function companionFailure(error) {
  if (error instanceof DialogueSpeechError || error instanceof ProbeModelError ||
      error instanceof FamilySessionError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'FAMILY_DIALOGUE_FAILED', message: '家庭对话未完成，请重新检查文字和语音。' };
}

export async function createFamilyCompanion(api, resources, { execute,
  makeSession = createFamilySession, makeSpeech = createDialogueSpeech } = {}) {
  const speech = makeSpeech(api, { workRoot: resources.dialogueWorkRoot });
  let last = { checked: false, voiceChecked: false, phase: 'idle' };
  let session;
  let sessionPersona = '';
  let transitions = Promise.resolve();
  let cancellation = 0;
  let stateOperation = 0;
  let closed = false;
  function getPersona() {
    const text = api.core?.personas?.current?.();
    if (typeof text !== 'string' || !text.trim()) throw new Error('当前 AuraBot 人设不可用。');
    return { text };
  }
  function serialize(operation) {
    const result = transitions.then(operation);
    transitions = result.catch(() => {});
    return result;
  }
  async function synchronizeSession() {
    if (closed) throw new FamilySessionError('FAMILY_SESSION_CANCELLED');
    const persona = getPersona();
    const signature = createHash('sha256').update(persona.text).digest('hex');
    if (session && sessionPersona !== signature) {
      cancellation++;
      session.cancel();
      await session.close();
      session = undefined;
    }
    if (!session) {
      const created = await makeSession(api, resources, { persona: persona.text, execute });
      if (closed) { await created.close(); throw new FamilySessionError('FAMILY_SESSION_CANCELLED'); }
      session = created;
      sessionPersona = signature;
    }
    await session.ensure();
    return session;
  }
  const ensureSession = () => serialize(synchronizeSession);
  return {
    status: () => ({ ...last, session: session?.status() || { connected: false } }),
    getVoiceOptions: () => getVoiceOptions(api),
    ensureSession,
    cancel: () => { cancellation++; stateOperation++; return session?.cancel(); },
    close: async () => {
      closed = true;
      cancellation++;
      stateOperation++;
      const closing = session?.close();
      await serialize(async () => { await closing; });
    },
    async converse(text, options) {
      const operation = ++stateOperation;
      last = { ...last, phase: 'thinking', error: null };
      try {
        const result = await (await ensureSession()).ask(text, options);
        if (operation === stateOperation) last = { ...last, checked: true, phase: result.suppressSpeech ? 'handled' : 'answered', toolCalls: result.toolCalls };
        return result.suppressSpeech ? result : result.text;
      } catch (error) {
        if (operation === stateOperation) last = { ...last, phase: 'failed', error: companionFailure(error) };
        throw error;
      }
    },
    async ask(text) {
      const operation = ++stateOperation;
      const started = Date.now();
      last = { ...last, phase: 'thinking', error: null };
      try {
        const answer = await askVoiceReply(options => api.ask(options), getPersona().text, text);
        if (operation === stateOperation) last = { ...last, checked: true, phase: 'answered', ms: Date.now() - started };
        return answer;
      } catch (error) {
        if (operation === stateOperation) last = { ...last, checked: true, phase: 'failed', error: companionFailure(error) };
        throw error;
      }
    },
    async prepare(text, options) {
      const operation = ++stateOperation;
      const ticket = cancellation;
      last = { ...last, phase: 'synthesizing', error: null };
      try {
        const prepared = await speech.prepare(text, options);
        if (closed || ticket !== cancellation) { await prepared.cleanup(); throw new FamilySessionError('FAMILY_SESSION_CANCELLED'); }
        if (operation === stateOperation) last = { ...last, voiceChecked: true, phase: 'ready', requestedEngine: prepared.requestedEngine,
          engine: prepared.engine, fallback: prepared.fallback, conversion: prepared.conversion, duration: prepared.duration };
        return prepared;
      } catch (error) {
        if (operation === stateOperation) last = { ...last, voiceChecked: true, phase: 'failed', error: companionFailure(error) };
        throw error;
      }
    },
  };
}
