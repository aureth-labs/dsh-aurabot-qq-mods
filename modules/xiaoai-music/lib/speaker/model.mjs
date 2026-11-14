export const MODEL_TOKEN_BUDGET = 120;
export const MODEL_TEST_QUESTION = '一加一等于几？请只回答一句。';

const messages = {
  MODEL_EMPTY_RESPONSE: '模型返回了空文字。',
  MODEL_AUTH: '模型服务认证未通过，请检查当前模型账号。',
  MODEL_QUOTA: '模型服务额度不足或请求受限。',
  MODEL_NETWORK: '模型服务网络请求失败或超时。',
  MODEL_CONFIG: '当前默认模型或模型服务不可用。',
  MODEL_OPTIONS: '模型服务不接受当前请求参数。',
  MODEL_REQUEST: '模型请求未完成。',
};

export function modelFailureMessage(code) { return messages[code] || '测试模型未完成回答。'; }

export class ProbeModelError extends Error {
  constructor(code) {
    super(modelFailureMessage(code));
    this.code = code;
  }
}

function classify(error) {
  // Inspect upstream errors only in memory. Never preserve/echo their body,
  // credential-bearing URLs, local paths, headers or arbitrary error codes.
  const value = String(error?.code || '') + ' ' + String(error?.message || '');
  if (/401|403|unauth|authentication|api.?key|凭据|密钥/i.test(value)) return 'MODEL_AUTH';
  if (/429|quota|credit|余额|额度|限流/i.test(value)) return 'MODEL_QUOTA';
  if (/fetch failed|ECONN|ENOTFOUND|ETIMED|timeout|network|连接|网络|超时/i.test(value)) return 'MODEL_NETWORK';
  if (/默认模型|llm 服务|default model|unknown model|not found|provider/i.test(value)) return 'MODEL_CONFIG';
  if (/400|invalid|unsupported|不支持/i.test(value)) return 'MODEL_OPTIONS';
  return 'MODEL_REQUEST';
}

export async function askModel(ask, options) {
  let answer;
  try {
    answer = await ask(options);
  } catch (error) {
    throw new ProbeModelError(classify(error));
  }
  if (typeof answer !== 'string' || !answer.trim()) throw new ProbeModelError('MODEL_EMPTY_RESPONSE');
  return answer.trim();
}

export async function askProbeModel(ask, text = MODEL_TEST_QUESTION, maxTokens = MODEL_TOKEN_BUDGET) {
  return '家庭模块回答：' + await askModel(ask, {
    system: '这是小爱音响接入模块的隔离单轮入口测试。简短用中文回答，不调用工具，不保存任何记忆，不假定说话人身份。',
    text, maxTokens,
  });
}
