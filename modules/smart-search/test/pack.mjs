import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'module.json'), 'utf8'));
const files = {};
async function collect(dir, prefix = '') {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.isDirectory()) await collect(join(dir, item.name), prefix + item.name + '/');
    else files[prefix + item.name] = [new Uint8Array(await readFile(join(dir, item.name))), { mtime: new Date('2000-01-01T00:00:00Z') }];
  }
}
await collect(join(root, '.build'));
const zip = zipSync(files, { level: 9 }), tag = manifest.id + '-v' + manifest.version, file = tag + '.zip';
await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist', file), zip);
// The community installer requires a SHA-256 integrity field.
const entry = { ...manifest, tag, file, path: tag + '/' + file, size: zip.length, sha256: createHash('sha256').update(zip).digest('hex') };
delete entry.build;
await writeFile(join(root, 'dist', 'release.json'), JSON.stringify(entry, null, 2) + '\n');
console.log(`${file} · ${zip.length} bytes`);
