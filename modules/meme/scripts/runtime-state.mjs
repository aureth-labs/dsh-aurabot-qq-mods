import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const manifest = JSON.parse(readFileSync(new URL('./runtime-packages.json',import.meta.url),'utf8'));
export function runtimePackages(platform = `${process.platform}-${process.arch}`) {
  const native = manifest.platforms[platform];
  if (!native) throw new Error(`不支持此平台：${platform}`);
  return [...manifest.common, native];
}
export function packageReady(root, pkg) {
  const dir = join(root,'node_modules',pkg.name);
  try {
    return JSON.parse(readFileSync(join(dir,'package.json'),'utf8')).version === pkg.version && pkg.required.every(f=>statSync(join(dir,f)).size > 0);
  } catch { return false; }
}
export function hasBaseRuntime(root) {
  try {
    if (!runtimePackages().every(p=>packageReady(root,p))) return false;
    const home=join(root,'node_modules','.meme-runtime');
    const ready=JSON.parse(readFileSync(join(home,'ready.json'),'utf8'));
    const expected=JSON.parse(readFileSync(new URL('./packs.json',import.meta.url),'utf8'));
    return ready.version==='0.2.3' && ready.files?.length>0 &&
      expected.packs.every(p=>ready.packs?.some(r=>r.id===p.id && r.release===p.release)) &&
      ready.files.every(f=>existsSync(join(home,f.path)));
  } catch { return false; }
}
// Existing prepared/offline installs keep their paths. New lightweight installs use
// persistent module data, so replacing the module's code does not erase resources.
export function chooseRuntimeDir(moduleDir, cacheDir) {
  if (existsSync(join(moduleDir,'node_modules','.meme-runtime','ready.json'))) return moduleDir;
  return cacheDir;
}
