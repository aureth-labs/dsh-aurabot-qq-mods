import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
const run = promisify(execFile);
const supported = new Set(['win32-x64','darwin-x64','darwin-arm64','linux-x64','linux-arm64']);
const libraries = {
  'libfontconfig.so.1':'libfontconfig1',
  'libglib-2.0.so.0':'libglib2.0-0',
  'libgomp.so.1':'libgomp1',
  'libGL.so.1':'libgl1',
  'libEGL.so.1':'libegl1',
};
// Only authored messages from this class may appear in the settings panel.
// It deliberately is not a UserError: chat must not expose host diagnostics.
const guide='https://github.com/b1ghawk119/dsh-aurabot-qq-meme-plugin/blob/main/docs/DOCKER.md';
export class EnvironmentError extends Error {
  constructor(message, detail='', help=guide) {super(message);this.detail=detail;this.help=help;if(detail)this.stack+='\n'+detail;}
}
export function environmentHelp(error) {return error instanceof EnvironmentError ? error.help : ''; }
export function environmentMessage(error, fallback) {
  return error instanceof EnvironmentError ? error.message : fallback;
}
async function libraryFinder(arch) {
  let cache='';
  for(const command of ['/sbin/ldconfig','/usr/sbin/ldconfig','ldconfig']) {
    try {cache=(await run(command,['-p'],{timeout:5000,maxBuffer:1024*1024})).stdout;break;} catch {}
  }
  const triple=arch==='arm64'?'aarch64-linux-gnu':'x86_64-linux-gnu';
  const directories=[...(process.env.LD_LIBRARY_PATH || '').split(':').filter(Boolean),
    `/lib/${triple}`,`/usr/lib/${triple}`,'/lib64','/usr/lib64','/lib','/usr/lib','/usr/local/lib'];
  return async name=>{
    const paths=directories.map(dir=>join(dir,name));
    for(const line of cache.split('\n')) {
      if(line.trim().startsWith(name+' ') && (arch==='arm64'?/AArch64/.test(line):/x86-64/.test(line))) {
        const path=line.split('=>')[1]?.trim();if(path)paths.push(path);
      }
    }
    for(const path of paths) {try {await access(path);return true;}catch{}}
    return false;
  };
}
export async function checkEnvironment({extension=false,download=false,platform=process.platform,arch=process.arch,
  glibc,hasLibrary,hasCommand,osRelease}={}) {
  if(!supported.has(`${platform}-${arch}`))throw new EnvironmentError('暂不支持这台设备，请查看支持的系统。','','https://github.com/b1ghawk119/dsh-aurabot-qq-meme-plugin/blob/main/README.md#支持的系统');
  if(platform==='linux') {
    glibc ??= process.report?.getReport().header.glibcVersionRuntime || '';
    if(!glibc)throw new EnvironmentError('当前系统不兼容，请按安装说明更换 Docker 镜像或系统。');
    const [major,minor]=glibc.split('.').map(Number);
    if(major<2 || (major===2 && minor<30))throw new EnvironmentError('当前系统版本过旧，请按安装说明升级后重试。');
    hasLibrary ??= await libraryFinder(arch);
    const required=extension?Object.keys(libraries):['libfontconfig.so.1'];
    const missing=[];
    for(const name of required)if(!await hasLibrary(name))missing.push(name);
    if(missing.length) {
      osRelease ??= await readFile('/etc/os-release','utf8').catch(()=>'');
      const debian=/^(?:ID|ID_LIKE)=["']?[^\n]*(?:debian|ubuntu)/m.test(osRelease);
      const packages=[...new Set(missing.map(name=>libraries[name]))];
      throw new EnvironmentError('缺少必要组件，请按安装说明补齐后重试。',debian
        ? `缺少系统组件：${packages.join('、')}。请让部署者在系统或 Docker 镜像中执行 apt-get update && apt-get install -y ${packages.join(' ')}，然后重试。`
        : `缺少系统组件：${missing.join('、')}。请让部署者通过系统包管理器补齐，然后重试；Docker 用户需在镜像中安装。`);
    }
  }
  // Offline/cached installations do not need download tools.
  if(download) {
    hasCommand ??= async command=>{try {await run(command,['--version'],{timeout:5000,windowsHide:true});return true;}catch{return false;}};
    const missing=[];
    for(const name of [platform==='win32'?'curl.exe':'curl','tar'])if(!await hasCommand(name))missing.push(name==='curl.exe'?'curl':name);
    if(missing.length)throw new EnvironmentError('下载工具不完整，请按安装说明补齐后重试。',`缺少工具：${missing.join('、')}`,'https://github.com/b1ghawk119/dsh-aurabot-qq-meme-plugin/blob/main/README.md#支持的系统');
  }
}
