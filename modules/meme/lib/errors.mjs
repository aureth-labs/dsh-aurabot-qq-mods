// Only messages deliberately authored for users may cross the chat/UI boundary.
export class UserError extends Error {}
export function userErrorForCode(code) {
  const messages = {
    TextOverLength: '文字太长，模板放不下，请缩短文字后重试。',
    ImageDecodeError: '无法读取这张图片，请换一张图片后重试。',
    OpenImageFailed: '无法读取这张图片，请换一张图片后重试。',
    ArgModelMismatch: '参数不合适，请查看模板详情并调整后重试。',
    OutputTooLarge: '生成结果超过 20 MB，请缩小输入图片。',
  };
  return Object.hasOwn(messages, code) ? new UserError(messages[code]) : undefined;
}
// Translate structured engine failures, never copy their payload into chat.
export function unwrapNativeResult(result) {
  if (result.type !== 'Err') return result.field0;
  const known = userErrorForCode(result.field0.type);
  if (known) throw known;
  throw new Error(`${result.field0.type}: ${JSON.stringify(result.field0.field0)}`);
}
export function publicErrorMessage(error) {
  return error instanceof UserError ? error.message : '暂时无法处理，请稍后重试；若仍失败，请联系主人。';
}
