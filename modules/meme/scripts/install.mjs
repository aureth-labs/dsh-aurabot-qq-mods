import { checkEnvironment } from '../lib/environment.mjs';
import { hasBaseRuntime } from './runtime-state.mjs';
import { cachedExtension } from '../lib/extension.mjs';
import { prepareDependencies } from './prepare-runtime.mjs';
import { cp, mkdir, access, rename, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepare } from './prepare.mjs';
import { preparePython } from './prepare-python.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const withExtension = process.argv.includes('--with-extension');
const target = resolve(process.argv.slice(2).find(x => x !== '--with-extension') || join(homedir(), '.dsh', 'plugins-data', 'aurabot', 'modules', 'meme'));
if (await access(target).then(() => true, () => false)) throw new Error(`目标已存在：${target}。安装器不会覆盖现有模块。`);
await checkEnvironment({extension:withExtension,download:!hasBaseRuntime(root) || (withExtension && !cachedExtension(root))});
const stage = join(dirname(target), '_meme-install');
await mkdir(stage, { recursive: true });
for (const name of ['index.mjs', 'module.json', 'package.json', 'panel.js', 'lib', 'assets', 'docs', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'scripts']) await cp(join(root, name), join(stage, name), { recursive: true });
await prepareDependencies(stage,{sourceRoot:root});
const assets = join('node_modules', '.meme-runtime');
if (await access(join(root, assets, 'ready.json')).then(() => true, () => false)) await cp(join(root, assets), join(stage, assets), { recursive: true });
await prepare(stage);
if (withExtension) {
const pythonAssets = join('node_modules', '.meme-python');
if (await readFile(join(root, pythonAssets, 'ready.json'), 'utf8').then(text => JSON.parse(text).platform === `${process.platform}-${process.arch}`, () => false)) await cp(join(root, pythonAssets), join(stage, pythonAssets), { recursive: true });
await preparePython(stage);
}
await rename(stage, target);
console.log(`已安装：${target}。AuraBot 会在几秒内自动加载，无需重启。发送“#表情帮助”开始使用。`);
