// 打包入口：把 index.mjs 连同 mathjax-full 一起塞进 .build/index.mjs。
// mathjax-full 是 CommonJS，esbuild 会包一层，banner 里补一个真的 require 给它用。
import { build } from 'esbuild'

await build({
  entryPoints: ['index.mjs'],
  outfile: '.build/index.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  legalComments: 'none',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
})

console.log('latex：已打包到 .build/index.mjs')
