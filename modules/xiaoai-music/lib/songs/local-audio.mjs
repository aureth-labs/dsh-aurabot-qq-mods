import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { extname } from 'node:path';

// Only the existing validated song ID is accepted; callers never supply paths.
export function createLocalAudioHandler({ library, isLocalRequest }) {
  return async (req, res) => {
    const fail = (status, headers = {}) => { res.writeHead(status, { 'Cache-Control': 'no-store', ...headers }); res.end(); };
    if (!isLocalRequest(req) || !['GET', 'HEAD'].includes(req.method)) return fail(403);
    let id;
    try { id = new URL(req.url, 'http://localhost').searchParams.get('id'); } catch { return fail(400); }
    if (!/^[a-f0-9]{64}$/.test(id || '')) return fail(400);
    let file;
    try {
      const entry = await library.get(id);
      file = await open(entry.absoluteFile, 'r');
      const info = await file.stat();
      if (!info.isFile() || !info.size) { await file.close(); return fail(404); }
      const size = info.size;
      let start = 0, end = size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { await file.close(); return fail(416, { 'Content-Range': `bytes */${size}` }); }
        if (!match[1]) {
          const length = Number(match[2]);
          if (!Number.isSafeInteger(length) || length <= 0) { await file.close(); return fail(416, { 'Content-Range': `bytes */${size}` }); }
          start = Math.max(0, size - length);
        } else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(Number(match[2]), end);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
          await file.close(); return fail(416, { 'Content-Range': `bytes */${size}` });
        }
        status = 206;
      }
      const headers = { 'Content-Type': ({ '.wav': 'audio/wav', '.ogg': 'audio/ogg' })[extname(entry.absoluteFile).toLowerCase()] || 'audio/mpeg', 'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') { await file.close(); res.end(); return; }
      const stream = file.createReadStream({ start, end, autoClose: true });
      file = undefined;
      try { await pipeline(stream, res); } catch { /* client disconnected or file became unreadable */ }
    } catch {
      await file?.close().catch(() => {});
      if (!res.headersSent) fail(404);
      else res.destroy();
    }
  };
}
