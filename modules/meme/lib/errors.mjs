// Only messages deliberately authored for users may cross the chat/UI boundary.
export class UserError extends Error {}
export function publicErrorMessage(error) {
  return error instanceof UserError ? error.message : '暂时无法处理，请稍后重试；若仍失败，请联系主人。';
}
