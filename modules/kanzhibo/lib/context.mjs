// lib/context.mjs —— 运行期共享可变状态：cdp / port / viewport；
// index 还会把 badge*/gift*/say*/quietUntil 等运行态挂到同一 ctx 上。
export function createContext() {
  return { cdp: null, port: 0, viewport: null }
}
