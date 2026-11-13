# 第三方来源

- 本模块遵循 GPL-3.0-only（见 LICENSE）。交互与参数处理参考 chinoyui/meme-plugin，原项目 GPL-3.0。
- @memecrafters/meme-generator 0.2.3 与相应平台原生包来自 MemeCrafters/meme-generator-rs，MIT，见 scripts/ENGINE-LICENSE。
- 全部模板图片、字体按上游 v0.2.3 原样分发。上游说明：表情素材来自网络，如有侵权请联系作者删除。各字体与图片权利属于各自权利人，不因引擎 MIT 或模块 GPL 而转移；商业分发前需核对具体素材许可。
- 不包含或调用 meme.pippi.top 在线服务。
- 目录图渲染使用 @resvg/resvg-wasm 2.6.2（MPL-2.0），源代码：https://github.com/yisibl/resvg-js 。依赖以未修改的独立包分发。

- 扩展库 anyliew/meme-emoji v0.0.6+build.66（提交 09838ad6eaf583696fd5d9ece7314276b7fb9102），MIT，见 scripts/EMOJI-LICENSE。源码：https://github.com/anyliew/meme-emoji 。使用其原样发布的 1.93.1 平台动态库与配套资源；素材权利说明同上。

- Memes02/meme-generator 固定提交 3749bb173d85507c72d40fd66de682bb8dde5c42，MIT，见 scripts/PYTHON-MEME-LICENSE。保留原生成代码，公共适配器按标识过滤重复项；不在运行时使用其网络服务。
- 独立 CPython 3.12.12（构建 20260211）由 python-build-standalone 提供，许可文件随解释器保留；依赖按该仓库 uv.lock 固定版本安装，许可见各依赖 dist-info。安装工具 uv 0.13.7（MIT/Apache-2.0）取自官方 PyPI wheel，仅在准备阶段使用，准备完成后删除。

- 自带“黄仁勋说”照片来自 nvidia.corporation，CC BY-SA 2.0；“黄仁勋举牌”两张合成图由用户提供。具体来源、图片许可及修改记录见 assets/README.md；这些图片的权利与代码许可证分别处理。
