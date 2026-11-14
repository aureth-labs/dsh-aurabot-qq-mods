# 第三方声明

本模块自研代码为 MIT（见 `LICENSE`）。下面是随模块一起分发的第三方文件，
它们在 `lib/vendor/` 下，**原样未改**（仅按浏览器 ES module 路径分发）。

## three.js r160 —— 3D 渲染库（MIT）

- 仓库：<https://github.com/mrdoob/three.js>
- 版本：**r160**（`three.module.js` 内 `const REVISION = '160'`）
- 许可：MIT（Copyright © 2010-2023 Three.js Authors；文件头保留 `@license` / `SPDX-License-Identifier: MIT`）
- 取件地址：<https://unpkg.com/three@0.160.0/>

| 随模块分发的文件 | 来源（npm 包 `three@0.160.0`） | 大小 | 说明 |
|---|---|---|---|
| `lib/vendor/three.module.js` | `build/three.module.js` | 1.27 MB | 3D 引擎主体，**原样未改** |
| `lib/vendor/OrbitControls.js` | `examples/jsm/controls/OrbitControls.js` | 29.8 KB | 相机轨道控制，**原样未改**（examples 官方示例代码，与 three.js 同许可） |
| `lib/vendor/RoundedBoxGeometry.js` | `examples/jsm/geometries/RoundedBoxGeometry.js` | 4.6 KB | 圆角盒几何体，**原样未改**（同上） |

核对方式（可复现，2026-11-06 实测三个文件与 npm 包同名文件 **sha256 完全一致**）：

```bash
sha256 three.module.js          76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495
sha256 OrbitControls.js         5a44a9e86a2a0fb11933eed69bc2cd33c76a496854c1aed6ed776efa87d7b064
sha256 RoundedBoxGeometry.js    d20aeaf7077c459a8d952d215738d7b44fba028440bb862d84b622a34f0c80bb
```

`three.module.js` 只在 `lib/index3d.html` 的 importmap（`"three": ".../vendor/three.module.js"`）
与三处 `import()` 里被引用；页面代码是本模块自研的。

### MIT 许可原文（three.js）

```text
The MIT License

Copyright © 2010-2023 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 动作素材（.webm，不随本仓库分发）

106 个动作视频（约 52 MB）**不在模块包里**，运行时从素材仓按需下载：
<https://github.com/RookieApe-tao/room3d-assets/releases/tag/v1>。
素材是与「大肥鱼」形象配套的自有素材，不随模块仓库分发，下载地址可在面板
`roomAssetUrl` 换成自建镜像。
