import { stat, link, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
const exists = p => stat(p).then(s => s.isFile() && s.size > 0, e => { if (e.code === 'ENOENT') return false; throw e; });
// With uv --target, Windows wheel data lands below Lib/site-packages instead of
// beside skia.pyd, where Skia's ICU loader looks. Reuse the wheel's own data.
export async function assertSkiaData(home, platform) {
  if (!platform.startsWith('win32-')) return;
  if (!await exists(join(home, 'site-packages', 'icudtl.dat'))) throw new Error('Skia ICU 数据未就绪，请运行 scripts/prepare-python.mjs 修复');
}
export async function prepareSkiaData(home, platform) {
  if (!platform.startsWith('win32-')) return;
  const dest = join(home, 'site-packages', 'icudtl.dat');
  if (await exists(dest)) return;
  const source = join(home, 'site-packages', 'Lib', 'site-packages', 'icudtl.dat');
  if (!await exists(source)) throw new Error('已安装的 Skia 包缺少 ICU 数据，请重新准备依赖');
  try { await link(source, dest); }
  catch (e) {
    if (!['EXDEV', 'ENOSYS', 'ENOTSUP'].includes(e.code)) throw e;
    await copyFile(source, dest);
  }
  await assertSkiaData(home, platform);
}
