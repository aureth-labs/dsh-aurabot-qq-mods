import { askModel } from '../speaker/model.mjs';

export async function askVoiceReply(ask, persona, text) {
  return askModel(ask, {
    system: `${persona}\n\n本次请直接用角色口吻简短回答，使用自然中文，80字以内；只输出要说的话，不加角色标签、动作括号或舞台说明。不假定说话人的身份，需要身份才能回答时先简短询问。`,
    text,
    maxTokens: 220,
  });
}
