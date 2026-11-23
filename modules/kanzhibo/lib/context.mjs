// lib/context.mjs —— 运行期可变状态收口（逐步迁移）。
// 目前只放 cdp；后续 port/viewport/badge*/say* 等也迁进来，供各领域模块共享同一份状态。
export function createContext() {
  return { cdp: null, port: 0, viewport: null }
}
