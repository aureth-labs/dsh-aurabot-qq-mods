import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

export const digest = (s) => createHash('sha256').update(String(s)).digest()
export const sameSecret = (value, hash) => {
  const expected = /^[a-f0-9]{64}$/.test(String(hash)) ? Buffer.from(hash, 'hex') : Buffer.alloc(32)
  return timingSafeEqual(digest(value), expected)
}
export function isLan(address) {
  const ip = String(address || '').toLowerCase().replace(/^::ffff:/, '').split('%')[0]
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  return isIP(ip) === 6 && (ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip))
}
export function networkAllowed(req, remoteAccess) {
  if (remoteAccess === true) return true
  // Never treat an Internet reverse proxy's loopback socket as a LAN phone.
  if (['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip'].some((k) => req.headers?.[k])) return false
  return isLan(req.socket?.remoteAddress)
}
export const failure = (status, code, message) => Object.assign(new Error(message), { status, code })

export function createAuth({ state, save, now = Date.now }) {
  let pairing = null
  const buckets = new Map()
  function limit(key, max, window = 60_000) {
    const t = now()
    for (const [k, b] of buckets) if (b.until <= t) buckets.delete(k)
    let b = buckets.get(key)
    if (!b) {
      if (buckets.size >= 2048) throw failure(429, 'rate_limit', '请求太频繁，稍后重试')
      buckets.set(key, b = { count: 0, until: t + window })
    }
    if (++b.count > max) throw failure(429, 'rate_limit', '请求太频繁，稍后重试')
  }
  return {
    limit,
    issue() {
      const code = randomBytes(12).toString('hex')
      pairing = { hash: digest(code).toString('hex'), expiresAt: now() + 5 * 60_000 }
      return { code, expiresAt: pairing.expiresAt }
    },
    pair(code, address, name = 'Android 手机') {
      limit('pair:global', 60); limit('pair:' + address, 10)
      if (typeof code !== 'string' || !code || code.length > 128) throw failure(400, 'invalid_code', '需要配对码字符串')
      const valid = sameSecret(code, pairing?.hash)
      if (!valid || !pairing || pairing.expiresAt <= now()) throw failure(403, 'pair_rejected', '配对码不正确、已使用或已过期，请在电脑上刷新')
      if (state.devices.length >= 100) throw failure(429, 'device_limit', '已配对设备过多，请先撤销旧设备')
      const token = randomBytes(32).toString('base64url')
      const device = { id: randomBytes(12).toString('hex'), name: String(name).slice(0, 80), tokenHash: digest(token).toString('hex'), pairedAt: now(), address: String(address || '').slice(0, 100) }
      // Consume synchronously, before any asynchronous request can reuse this code.
      pairing = null
      state.devices.push(device)
      try { save() } catch (error) { state.devices.pop(); throw error }
      return { ok: true, token }
    },
    authenticate(value) {
      const token = typeof value === 'string' && value.length <= 256 ? value : ''
      let found = null
      // Hash + constant-size timingSafeEqual for every device; don't stop at the first match.
      for (const d of state.devices) if (sameSecret(token, d.tokenHash) && token) found = d
      if (!found) throw failure(401, 'unauthorized', '请重新扫码配对')
      return found
    },
    revoke(id) {
      const previous = state.devices
      state.devices = previous.filter((d) => d.id !== id)
      try { save() } catch (error) { state.devices = previous; throw error }
    },
    clear() { pairing = null; buckets.clear() },
  }
}
