import { assertSkiaData } from './python-data.mjs';
import { chooseRuntimeDir } from './runtime-state.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename, join } from 'node:path';
const args=process.argv.slice(2), positional=[];let withExtension=false,runtimeArg;
for(let i=0;i<args.length;i++) {
  if(args[i]==='--with-extension')withExtension=true;
  else if(args[i]==='--runtime-dir'){runtimeArg=args[++i];if(!runtimeArg)throw Error('--runtime-dir 需要目录');}
  else positional.push(args[i]);
}
const root=resolve(positional[0]||'.'),output=resolve(positional[1]||'../meme-offline.tar.gz');
const runtime=runtimeArg?resolve(runtimeArg):chooseRuntimeDir(root,join(dirname(dirname(root)),'modules-data',basename(root),'runtime'));
if (!existsSync(join(runtime, 'node_modules/.meme-runtime/ready.json'))) throw new Error('请先等待表情库自动准备完成');
const ready = JSON.parse(readFileSync(join(runtime, 'node_modules/.meme-runtime/ready.json'), 'utf8'));
const expected = JSON.parse(readFileSync(new URL('./packs.json', import.meta.url), 'utf8'));
for (const pack of expected.packs) {
  const installed = ready.packs?.find(p => p.id === pack.id && p.release === pack.release);
  if (!installed || pack.keys.some(key => !installed.keys.includes(key))) throw new Error('基础库资源尚未准备完整');
}
for (const file of ready.files) if (!existsSync(join(runtime, 'node_modules/.meme-runtime', file.path))) throw new Error(`缺少资源：${file.path}`);
if (withExtension) {
  const pythonHome=join(runtime,'node_modules/.meme-python');
  if (!existsSync(join(pythonHome,'ready.json'))) throw new Error('请先安装扩展库');
  await assertSkiaData(pythonHome, JSON.parse(readFileSync(join(pythonHome,'ready.json'), 'utf8')).platform);
}
let stage,packageRoot=root;
try {
  if(runtime!==root) {
    // Merge code and persistent resources without copying a second large library.
    stage=mkdtempSync(join(tmpdir(),'meme-pack-'));packageRoot=join(stage,basename(root));
    cpSync(root,packageRoot,{recursive:true,filter:p=>!['node_modules','.git','.aurabot-cache'].includes(basename(p))});
    symlinkSync(join(runtime,'node_modules'),join(packageRoot,'node_modules'),process.platform==='win32'?'junction':'dir');
  }
  execFileSync('tar', ['-czf', output, ...(stage?['-h']:[]), ...(!withExtension ? ['--exclude=.meme-python'] : []), '--exclude=.aurabot-cache', '--exclude=.git', '--exclude=test', '-C', dirname(packageRoot), basename(packageRoot)], { stdio: 'inherit' });
} finally {if(stage)rmSync(stage,{recursive:true,force:true});}
console.log(output);
