// Only messages deliberately authored for users may cross the chat/UI boundary.
export class UserError extends Error {}
// Translate structured engine failures, never copy their payload into chat.
export function unwrapNativeResult(result) {
  if (result.type !== 'Err') return result.field0;
  if (result.field0.type === 'TextOverLength') throw new UserError('文字太长，模板放不下，请缩短文字后重试。');
  throw new Error(`${result.field0.type}: ${JSON.stringify(result.field0.field0)}`);
}
export function publicErrorMessage(error) {
  return error instanceof UserError ? error.message : '暂时无法处理，请稍后重试；若仍失败，请联系主人。';
}
