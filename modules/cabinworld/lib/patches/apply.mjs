#!/usr/bin/env node
// 把上游参考桥还没做的两类高级协议（睡觉、工具姿势）打到小屋世界的桥上。
// 电玩城/棋盘、餐厅从 1.1 起由官方桥自带（bridge/lib/arcade.mjs、cabin_restaurant），本补丁不再重复实现。
// 平时不用手动跑：模块重建 bridge-host 副本时会自动调一次；想单独验证可以加 --dry。
// 幂等：已经打过的锚点会跳过；上游改动导致锚点找不到时，本脚本停下来并列出手工步骤，不会半改。
//
// 用法：node lib/patches/apply.mjs [--game <游戏目录>] [--bridge <目标 bridge 目录>] [--dry] [--no-backup]
//   模块同步宿主副本时会传 --bridge <副本目录> --no-backup（副本每次重建，不需要备份）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = path.join(HERE, 'files');
const argv = process.argv.slice(2);
// 不给 --game 就不再默认某个盘符：模块调这个脚本时总带 --game（或 --bridge），手动跑也一样，
// 免得手滑打进一个早就不用的旧目录。
const at = argv.indexOf('--game');
const bt = argv.indexOf('--bridge');
const gameArg = at >= 0 ? String(argv[at + 1] || '') : String(process.env.CABIN_GAME_DIR || '');
const bridgeArg = bt >= 0 ? String(argv[bt + 1] || '') : '';
const gameDir = gameArg ? path.resolve(gameArg) : '';
const bridgeDir = bridgeArg ? path.resolve(bridgeArg) : (gameDir ? path.join(gameDir, 'bridge') : '');
const dry = argv.includes('--dry');
const noBackup = argv.includes('--no-backup');
const say = (...a) => console.log('[高级协议补丁]', ...a);

if (!bridgeDir) {
  say('要给 --game <游戏目录>（默认打 <游戏目录>/bridge），或 --bridge <目标 bridge 目录>');
  process.exit(1);
}
if (!fs.existsSync(path.join(bridgeDir, 'bridge.mjs'))) {
  say('找不到 ' + path.join(bridgeDir, 'bridge.mjs') + '：先用一键安装把游戏装上，或用 --game 指到游戏目录');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
function backup(file) {
  if (noBackup) return '';
  if (!fs.existsSync(file)) return '';
  const to = file + '.bak-' + stamp;
  fs.copyFileSync(file, to);
  return to;
}
function read(p) { return fs.readFileSync(p, 'utf8'); }

// ---- 锚点：每一处都带一个只属于本补丁的标记，已经存在就跳过 ----------------------------------

const BRIDGE_PATCHES = [
  { marker: "lib/advanced/index.mjs", mode: 'after',
    anchor: "import { Resident } from './lib/resident.mjs';",
    insert: "\nimport { createAdvanced } from './lib/advanced/index.mjs';" },
  { marker: 'const advanced = createAdvanced({', mode: 'after',
    anchor: '  resident = new Resident({ host, key: cfg.resident, who: cfg.who, name: cfg.displayName, catalog, weather });',
    insert: "\n  const advanced = createAdvanced({ host, resident, catalog, dataDir: cfg.dataDir, log });\n  resident.advanced = advanced;   // catalog 里 bridge:\"advanced\" 的对象在 use() 里转交到这里" },
  { marker: 'advanced.attach(caps);', mode: 'after',
    anchor: "    pushEvent({ type: 'game', connected: true });",
    insert: '\n    advanced.attach(caps);' },
  { marker: 'advanced.detach(); pushEvent', mode: 'replace',
    anchor: "log('游戏断开（关闭窗口不会关闭桥，重新打开游戏会自动连回）'); pushEvent({ type: 'game', connected: false });",
    insert: "log('游戏断开（关闭窗口不会关闭桥，重新打开游戏会自动连回）'); advanced.detach(); pushEvent({ type: 'game', connected: false });" },
  { marker: 'cabin_sleep: a => advanced.sleep(a)', mode: 'after',
    anchor: "    cabin_stop: a => select(a).stop(a.reason||'自己决定或用户要求结束',a.action||'stop'),",
    insert: "\n    // 高级协议（上游 1.1 还没做的两件）：睡觉、工具姿势\n    cabin_sleep: a => advanced.sleep(a),\n    cabin_toolpose: a => advanced.toolpose(a)," },
  { marker: 'advanced: advanced.status()', mode: 'replace',
    anchor: "      if (url.pathname === '/v1/health') return send(200, { ok: true, game: host.connected, resident: cfg.resident });",
    insert: "      if (url.pathname === '/v1/health') return send(200, { ok: true, game: host.connected, resident: cfg.resident, advanced: advanced.status() });" },
  { marker: 'clearInterval(timer); advanced.detach();', mode: 'replace',
    anchor: 'const close = async () => { clearInterval(timer);',
    insert: 'const close = async () => { clearInterval(timer); advanced.detach();' },
];

const RESIDENT_PATCHES = [
  { marker: 'this.asleep = false; this.pose = null;', mode: 'after',
    anchor: "    this.effect = null; this.outfit = ''; this.items = { phone: 'dock', headphones: 'dock' }; this.lamps = 'auto';",
    insert: "\n    this.asleep = false; this.pose = null;   // 睡觉与工具姿势由 lib/advanced 驱动" },
  { marker: 'sleeping: this.asleep === true', mode: 'replace',
    anchor: "      label: this.task?.label || e?.label || '', sleeping: false, items: this.items, lamps: this.lamps,",
    insert: "      label: this.task?.label || e?.label || '', sleeping: this.asleep === true, items: this.items, lamps: this.lamps," },
];

function patchFile(file, patches) {
  let text = read(file);
  const report = [];
  for (const p of patches) {
    if (text.includes(p.marker)) { report.push(['skip', p.marker]); continue; }
    if (!text.includes(p.anchor)) { report.push(['missing', p.anchor]); continue; }
    text = p.mode === 'replace' ? text.replace(p.anchor, p.insert) : text.replace(p.anchor, p.anchor + p.insert);
    report.push(['added', p.marker]);
  }
  return { text, report };
}

function ensureTools() {
  const target = path.join(bridgeDir, 'openai-tools.json');
  const ours = JSON.parse(read(path.join(FILES, 'openai-tools.json')));
  const want = ['cabin_toolpose', 'cabin_sleep'];
  let up;
  try { up = JSON.parse(read(target)); } catch { up = { tools: [] }; }
  const have = new Set((up.tools || []).map(t => t && t.function && t.function.name));
  const add = (ours.tools || []).filter(t => want.includes(t.function.name) && !have.has(t.function.name));
  if (!add.length) return ['skip', 'openai-tools.json 已经有这两个工具'];
  up.tools = (up.tools || []).concat(add);
  // dry 连备份都不该留：backup() 会往 bridge/ 里写 .bak 文件。
  if (dry) return ['added', 'openai-tools.json +' + add.length + '（dry，未写入）'];
  backup(target);
  fs.writeFileSync(target, JSON.stringify(up, null, 2) + '\n');
  return ['added', 'openai-tools.json +' + add.length];
}

// ---- 执行 ---------------------------------------------------------------------------------
const problems = [];
const report = [];
// 先把所有改动算出来，全部检查通过才落盘。
// 原来是边算边写：锚点能匹配的先写进文件，写完之后才在下面判 problems 然后 exit(2)——
// 手动对 bridge/ 跑一次（README 教的用法），官方桥就留下半套补丁。
const pending = [];

const srcDir = path.join(FILES, 'lib', 'advanced');
const dstDir = path.join(bridgeDir, 'lib', 'advanced');
for (const name of fs.readdirSync(srcDir)) {
  const from = path.join(srcDir, name), to = path.join(dstDir, name);
  const same = fs.existsSync(to) && read(to) === read(from);
  if (same) { report.push(['skip', 'lib/advanced/' + name]); continue; }
  pending.push({ kind: 'copy', from, to });
  report.push(['added', 'lib/advanced/' + name]);
}

for (const [file, patches] of [['bridge.mjs', BRIDGE_PATCHES], [path.join('lib', 'resident.mjs'), RESIDENT_PATCHES]]) {
  const full = path.join(bridgeDir, file);
  if (!fs.existsSync(full)) { problems.push('缺文件：' + full); continue; }
  const { text, report: rows } = patchFile(full, patches);
  for (const [kind, what] of rows) {
    if (kind === 'missing') problems.push(file + ' 里找不到锚点：' + JSON.stringify(what).slice(0, 120));
    else report.push([kind, file + ' ← ' + what]);
  }
  if (rows.some(r => r[0] === 'added')) pending.push({ kind: 'write', full, text });
}

if (problems.length) {
  say('上游代码变了，这些地方要靠手工补：');
  for (const p of problems) say('  ! ' + p);
  say('对照 lib/patches/files/ 与厂方源码的差异手动合并，然后重跑。');
  say('（这一轮没有写入任何文件。）');
  process.exit(2);
}

// 先算 ensureTools，让 --dry 的报告顺序和实际写入顺序一致。
report.push(ensureTools());

if (!dry) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const item of pending) {
    if (item.kind === 'copy') { fs.copyFileSync(item.from, item.to); continue; }
    backup(item.full);
    fs.writeFileSync(item.full, item.text);
  }
}

for (const [kind, what] of report) say((kind === 'added' ? '＋ ' : '＝ ') + what);

if (!dry) {
  const checks = ['bridge.mjs', path.join('lib', 'resident.mjs')];
  if (fs.existsSync(dstDir)) for (const f of fs.readdirSync(dstDir)) checks.push(path.join('lib', 'advanced', f));
  for (const file of checks) {
    try { execFileSync(process.execPath, ['--check', path.join(bridgeDir, file)], { stdio: 'pipe' }); }
    catch (error) { say('语法检查没过：' + file); console.error(String(error.stderr || error.message)); process.exit(3); }
  }
}

say('打好了。平时不用手动跑这个脚本：模块启动/重启桥时会自动重建 bridge-host 副本并打补丁。');
say('验证：curl http://127.0.0.1:18790/v1/health 里 advanced.tools 的 sleep、toolpose 应为 true（游戏端提供能力位时）。');
