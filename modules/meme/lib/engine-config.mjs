import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CONFIG = '[meme]\nload_external_memes = true\n[font]\nuse_local_fonts = true\n[encoder]\ngif_max_frames = 200\n';

// In the native engine, "local fonts" means MEME_HOME/resources/fonts.
// System fonts are still its fallback, not what this switch enables.
export function withBundledFonts(config) {
  const lines = config.split('\n');
  const start = lines.findIndex(line => /^\s*\[font\]\s*(?:#.*)?$/.test(line));
  if (start < 0) return config.trimEnd() + '\n[font]\nuse_local_fonts = true\n';
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const setting = lines.findIndex((line, i) => i > start && i < end && /^\s*use_local_fonts\s*=/.test(line));
  if (setting < 0) lines.splice(start + 1, 0, 'use_local_fonts = true');
  else lines[setting] = lines[setting].replace(/(use_local_fonts\s*=\s*)false\b/, '$1true');
  return lines.join('\n');
}

export function ensureEngineConfig(home) {
  const file = join(home, 'config.toml');
  let before = '';
  try { before = readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const next = before ? withBundledFonts(before) : DEFAULT_CONFIG;
  if (next === before) return false;
  const temp = file + `.${process.pid}.tmp`;
  try { writeFileSync(temp, next); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
  return true;
}
