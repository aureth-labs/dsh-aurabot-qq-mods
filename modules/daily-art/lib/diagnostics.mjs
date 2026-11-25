// 只记录排障需要的字段。请求 URL、查询参数、代理地址和响应正文都可能含凭据。
export function requestAudit({ log, operation, stage, host, proxyUrl, authenticated, fallback }) {
  const started = Date.now()
  return (level, outcome, response, error) => {
    if (!log) return
    const record = {
      operation, stage, host,
      network: proxyUrl ? 'proxy' : 'direct',
      auth: authenticated ? 'api-key' : fallback ? 'public-fallback' : 'public',
      outcome, elapsedMs: Date.now() - started,
    }
    if (response) {
      record.status = response.status
      const rayId = response.headers.get('cf-ray')
      const contentType = response.headers.get('content-type')?.split(';')[0].trim()
      const retryAfter = response.headers.get('retry-after')
      if (/^[a-f0-9]{8,32}(?:-[a-z0-9]{3,6})?$/i.test(rayId || '')) record.cfRay = rayId
      if (/^[\w.+-]{1,40}\/[\w.+-]{1,40}$/.test(contentType || '')) record.contentType = contentType
      if (response.headers.get('cf-mitigated') === 'challenge') record.cfMitigated = 'challenge'
      if (/^\d{1,8}$/.test(retryAfter || '')) record.retryAfterSeconds = Number(retryAfter)
    }
    const code = error?.cause?.code || error?.code || (error?.name === 'AbortError' ? 'ABORT_ERR' : '')
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,48}$/.test(code)) record.errorCode = code
    const label = host === 'yande.re' || host === 'files.yande.re' ? 'Yande.re' : 'Konachan'
    log[level](`[${label}] ${JSON.stringify(record)}`)
  }
}
