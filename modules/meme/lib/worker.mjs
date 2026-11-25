import { createCaptionTemplates } from './caption-templates.mjs';
import { createSvgRenderer } from './svg-renderer.mjs';
import { UserError, unwrapNativeResult as unwrap } from './errors.mjs';
// Dedicated process: native rendering never blocks the QQ/DSH event loop.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndexSvg } from './index-image.mjs';
import { PythonBridge } from './python-bridge.mjs';
import { createRequire } from 'node:module';
const require = createRequire((process.env.MEME_RUNTIME_DIR || process.env.MEME_MODULE_DIR) + '/package.json');
const engine = require('@memecrafters/meme-generator');
const renderSvg = createSvgRenderer(require, process.env.MEME_HOME);
const localTemplates = createCaptionTemplates(process.env.MEME_MODULE_DIR, renderSvg);
const inventory = JSON.parse(readFileSync(join(process.env.MEME_HOME, 'ready.json'), 'utf8'));
const baseKeys = new Set(inventory.baseKeys || []);
const memes = engine.getMemes().sort((a, b) => Number(baseKeys.has(b.info.key)) - Number(baseKeys.has(a.info.key)));
const loadedKeys = new Set(memes.map(m => m.info.key));
for (const pack of inventory.packs || []) for (const key of pack.keys) {
  if (!loadedKeys.has(key)) throw new Error(`扩展库未完整加载：${pack.id} / ${key}`);
}
const localItems = localTemplates.items.filter(m => !loadedKeys.has(m.key));
const nativeCatalog = [...memes.map(m => ({ ...m.info, tags: [...m.info.tags] })), ...localItems];
for (const item of localItems) loadedKeys.add(item.key);
let python = null, pythonKeys = new Set(), catalog = nativeCatalog;
function attachExtension() {
  const next = new PythonBridge(process.env.MEME_MODULE_DIR, process.env.MEME_RUNTIME_DIR);
  if (!next.runtime || !next.items.length) throw new Error('扩展资源未准备完整');
  const extra = next.items.filter(m => !loadedKeys.has(m.key));
  python = next; pythonKeys = new Set(extra.map(m => m.key)); catalog = [...nativeCatalog, ...extra];
}
if (process.env.MEME_EXTENSION_ENABLED === '1') attachExtension();
const catalogResult = () => ({ version: engine.getVersion(), items: catalog, extensionEnabled: !!python, extensionCount: pythonKeys.size });
let indexCache;
async function renderIndex(disabled, columns) {
  const cacheKey = JSON.stringify({ disabled: [...new Set(disabled)].sort(), columns });
  if (indexCache?.key === cacheKey) return indexCache.data;
  const layout = buildIndexSvg(catalog, disabled, columns);
  const image = await renderSvg(layout.svg);
  const data = { base64: image.buffer.toString('base64'), mime: 'image/png', count: layout.entries.length, width: image.width, height: image.height };
  indexCache = { key: cacheKey, data };
  return data;
}

process.on('message', async ({ id, op, key, texts = [], images = [], options = {}, disabled = [], columns = 5, enabled }) => {
  try {
    let data;
    if (op === 'catalog') {
      data = catalogResult();
    } else if (op === 'extension') {
      if (enabled && !python) attachExtension();
      if (!enabled && python) { await python?.dispose(); python = null; pythonKeys = new Set(); catalog = nativeCatalog; }
      indexCache = null;
      data = catalogResult();
    } else if (op === 'index-image') {
      data = await renderIndex(disabled, columns);
    } else {
      const meme = engine.getMeme(key);
      if (!meme && !pythonKeys.has(key) && !localTemplates.has(key)) throw new UserError('模板不存在');
      const buffers = images.map(image => {
        const data = Buffer.from(image.data, 'base64');
        if (data.length > 8 * 1024 * 1024) throw new UserError('图片超过 8 MB');
        const info = unwrap(engine.Tools.ImageOperations.inspect(data));
        if (info.width * info.height > 16000000 || info.frameCount > 300) throw new UserError('图片超过 1600 万像素或 300 帧，请缩小后再试');
        return { name: image.name || '图片', data };
      });
      const result = !meme && localTemplates.has(key)
        ? await localTemplates.render(key, texts, options)
        : pythonKeys.has(key)
        ? await python.call({ op, key, texts, images, options })
        : unwrap(op === 'preview' ? meme.generatePreview(options) : meme.generate(buffers, texts, options));
      if (result.length > 20 * 1024 * 1024) throw new UserError('生成结果超过 20 MB，请缩小输入图片');
      data = { base64: result.toString('base64'), mime: result.subarray(0, 3).toString() === 'GIF' ? 'image/gif' : result[0] === 255 ? 'image/jpeg' : 'image/png' };
    }
    process.send?.({ id, data });
  } catch (error) { process.send?.({ id, error: error.message, ...(error instanceof UserError ? { publicMessage: error.message } : {}) }); }
});
process.on('disconnect', () => { python?.dispose(); process.exit(0); });
process.on('exit', () => python?.dispose());
