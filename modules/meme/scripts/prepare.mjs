import {downloadArtifact} from './download-artifact.mjs';
// Shared by explicit installation and automatic first-run preparation.
import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractResourceArchive, validResource } from './resource-archive.mjs';
export async function prepare(root,{onProgress=()=>{}}={}) {
  const inventory=JSON.parse(await readFile(new URL('./resources.json',import.meta.url),'utf8'));
  const {baseKeys,packs}=JSON.parse(await readFile(new URL('./packs.json',import.meta.url),'utf8'));
  const home=join(root,'node_modules','.meme-runtime');
  const keys=new Set(baseKeys),paths=new Set(inventory.files.map(f=>f.path));
  const groups=[{repository:'MemeCrafters/meme-generator-rs',revision:`v${inventory.version}`,archiveRoot:`meme-generator-rs-${inventory.version}`,files:inventory.files}],binaries=[];
  for(const pack of packs) {
    for(const key of pack.keys){if(keys.has(key))throw Error(`扩展模板标识重复：${key}`);keys.add(key);}
    for(const f of pack.files){if(paths.has(f.path))throw Error(`扩展资源路径重复：${f.path}`);paths.add(f.path);}
    const binary=pack.binaries[`${process.platform}-${process.arch}`];if(!binary)throw Error(`扩展库不支持 ${process.platform}-${process.arch}`);
    groups.push(pack);binaries.push(binary);
  }
  const files=[...groups.flatMap(g=>g.files),...binaries];
  for(let i=0;i<groups.length;i++) {
    const group=groups[i],missing=[];
    onProgress({phase:'checking',message:'正在检查素材完整性…',completed:0,total:0});
    for(const f of group.files)if(!await validResource(home,f))missing.push(f);
    if(missing.length) {
      onProgress({phase:'assets',message:`正在下载素材包（${i+1}/${groups.length}）…`,completed:0,total:0});
      console.log(`素材包 ${i+1}/${groups.length}：补齐 ${missing.length} 个文件`);
      await extractResourceArchive(home,{...group,files:missing,onBytes:received=>onProgress({phase:'assets',message:`正在下载素材包（${i+1}/${groups.length}）…`,completed:0,total:0,received})});
    }
  }
  onProgress({phase:'components',message:'正在准备模板组件…',completed:0,total:binaries.length});
  for(let i=0;i<binaries.length;i++) {
    const f=binaries[i];
    if(!await validResource(home,f)) {
      const dest=join(home,f.path),temp=dest+'.part';await mkdir(dirname(dest),{recursive:true});
      try {
        await downloadArtifact(f,temp);
        await rename(temp,dest);
      } finally {await rm(temp,{force:true});}
    }
    onProgress({phase:'components',message:'正在准备模板组件…',completed:i+1,total:binaries.length});
  }
  onProgress({phase:'checking',message:'正在完成安装…',completed:0,total:0});
  await mkdir(home,{recursive:true});
  await writeFile(join(home,'config.toml'),'[meme]\nload_external_memes = true\n[font]\nuse_local_fonts = false\n[encoder]\ngif_max_frames = 200\n');
  const ready={version:inventory.version,baseKeys,packs:packs.map(({id,release,keys})=>({id,release,keys})),files:files.map(({path,size})=>({path,size}))};
  await writeFile(join(home,'ready.json.part'),JSON.stringify(ready));await rename(join(home,'ready.json.part'),join(home,'ready.json'));
  console.log(`基础库准备完成：${keys.size} 个模板，${files.length} 个文件`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepare(resolve(process.argv[2]||fileURLToPath(new URL('..',import.meta.url))));
