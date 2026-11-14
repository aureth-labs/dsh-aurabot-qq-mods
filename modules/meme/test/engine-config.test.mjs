import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureEngineConfig, withBundledFonts } from '../lib/engine-config.mjs';

test('新安装启用随包字体，重复检查不重写配置', () => {
  const home = mkdtempSync(join(tmpdir(), 'meme-font-'));
  try {
    assert.equal(ensureEngineConfig(home), true);
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    assert.match(config, /\[font\]\nuse_local_fonts = true/);
    assert.match(config, /load_external_memes = true/);
    assert.equal(ensureEngineConfig(home), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('已有离线缓存只迁移字体开关，保留其他设置和注释', () => {
  const home = mkdtempSync(join(tmpdir(), 'meme-font-'));
  const config = '[font]\nuse_local_fonts = false # bundled\ndefault_font_families = ["Noto Sans SC"]\n[encoder]\ngif_max_frames = 150\n';
  try {
    writeFileSync(join(home, 'config.toml'), config);
    assert.equal(ensureEngineConfig(home), true);
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), config.replace('false', 'true'));
    assert.equal(ensureEngineConfig(home), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('缺失字体项时补齐，其他分组同名项不受影响', () => {
  assert.equal(withBundledFonts('[font]\n[other]\nuse_local_fonts = false\n'), '[font]\nuse_local_fonts = true\n[other]\nuse_local_fonts = false\n');
  assert.match(withBundledFonts('[meme]\nload_external_memes = true\n'), /\[font\]\nuse_local_fonts = true\n$/);
});
