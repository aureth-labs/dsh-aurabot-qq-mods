import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The directory and local templates share one WASM instance and one font buffer.
export function createSvgRenderer(require, home) {
  let ready, font;
  return async svg => {
    const { Resvg, initWasm } = require('@resvg/resvg-wasm');
    ready ||= initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'))).catch(error => { ready = null; throw error; });
    await ready;
    font ||= readFileSync(join(home, 'resources/fonts/NotoSansSC-Regular.ttf'));
    const renderer = new Resvg(svg, { font: { fontBuffers: [font], defaultFontFamily: 'Noto Sans SC', loadSystemFonts: false } });
    let image;
    try {
      image = renderer.render();
      return { buffer: Buffer.from(image.asPng()), width: image.width, height: image.height };
    } finally { image?.free(); renderer.free(); }
  };
}
