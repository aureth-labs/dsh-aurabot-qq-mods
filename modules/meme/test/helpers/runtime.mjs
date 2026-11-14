import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { runtimePackages } from '../../scripts/runtime-state.mjs';
export async function seedRuntimeMetadata(root) {
  for (const p of runtimePackages()) {
    const dir=join(root,'node_modules',p.name);await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'package.json'),JSON.stringify({version:p.version}));
    for(const file of p.required){await mkdir(dirname(join(dir,file)),{recursive:true});await writeFile(join(dir,file),'fixture');}
  }
  const home=join(root,'node_modules','.meme-runtime');await mkdir(home,{recursive:true});await writeFile(join(home,'fixture.bin'),'x');
  const expected=JSON.parse(await readFile(new URL('../../scripts/packs.json',import.meta.url),'utf8'));
  await writeFile(join(home,'ready.json'),JSON.stringify({version:'0.2.3',files:[{path:'fixture.bin',size:1}],packs:expected.packs.map(p=>({id:p.id,release:p.release,keys:p.keys}))}));
}
