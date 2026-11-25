import { build } from 'esbuild';
import { readFile, writeFile, mkdir, rm, cp, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
export async function buildRelease() {
  const root = fileURLToPath(new URL('..', import.meta.url)), out = join(root, '.build');
  const manifest = JSON.parse(await readFile(join(root, 'module.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) throw Error('版本不一致');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  await build({ entryPoints: [join(root, 'index.mjs')], outfile: join(out, 'index.mjs'), bundle: true,
    platform: 'node', target: 'node22', format: 'esm', minify: false, legalComments: 'inline' });
  for (const name of ['module.json', 'panel.js', 'README.md', 'LICENSE', 'docs']) await cp(join(root, name), join(out, name), { recursive: true });
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const notices = [];
  for (const [path, item] of Object.entries(lock.packages)) {
    if (!path || item.dev) continue;
    const dir = join(root, path), files = await readdir(dir);
    const license = files.find(x => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(x));
    if (!license) throw Error('缺少依赖许可证：' + path);
    const meta = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    notices.push(`${meta.name} ${meta.version} (${meta.license})\n${await readFile(join(dir, license), 'utf8')}`);
  }
  await writeFile(join(out, 'THIRD-PARTY-LICENSES.txt'), notices.join('\n\n' + '='.repeat(72) + '\n\n'));
  const imported = (await import(new URL('../.build/index.mjs?' + Date.now(), import.meta.url))).default;
  if (imported.version !== manifest.version || imported.id !== manifest.id) throw Error('构建入口信息不一致');
  console.log('已构建独立模块：' + out);
  return out;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildRelease();
