// Assemble the lightweight installer module; native runtimes and template data
// are deliberately prepared on first use, not hidden inside the release ZIP.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
export async function buildRelease(source=root) {
  const manifest=JSON.parse(await readFile(join(source,'module.json'),'utf8'));
  const pkg=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
  if(manifest.version!==pkg.version)throw Error('module.json 与 package.json 版本不一致');
  const out=resolve(source,manifest.build.out);
  if(dirname(out)!==resolve(source))throw Error('构建目录必须是模块内的一级目录');
  await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
  for(const name of ['index.mjs','panel.js','module.json','package.json','README.md','LICENSE','THIRD-PARTY-NOTICES.md','lib','scripts','assets','docs']) {
    await cp(join(source,name),join(out,name),{recursive:true});
  }
  await writeFile(join(out,'RELEASE.md'),'这是轻量安装器包。首次运行会自动下载固定版本的运行组件和素材，默认不安装 Python 扩展。\n运行时获取可执行依赖的分发方式仍需模块市场维护者审核，不代表已上架。\n');
  return out;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log('构建完成：'+await buildRelease());
