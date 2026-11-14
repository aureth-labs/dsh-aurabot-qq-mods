# 下载来源与许可

首次安装会下载下列固定版本组件与素材；可选扩展由用户点击安装后才下载。完成后保存在模块数据目录，生成表情时不再下载代码。

## 版本与校验依据

| 内容 | 固定版本 / 提交 | 校验与下载源 |
|---|---|---|
| 基础引擎及平台包 | `@memecrafters/meme-generator` 0.2.3 | 官方 npm，SHA-512，见 [运行包清单](../scripts/runtime-packages.json) |
| SVG 渲染器 | `@resvg/resvg-wasm` 2.6.2 | 官方 npm，SHA-512，同上 |
| meme-emoji 动态库 | 1.93.1 | GitHub 官方发行文件，SHA-256 与大小，见 [扩展清单](../scripts/packs.json) |
| 基础素材 | 引擎 v0.2.3；meme-emoji 提交 `09838ad6eaf583696fd5d9ece7314276b7fb9102` | GitHub 整库归档，检查文件清单与大小，见 [基础清单](../scripts/resources.json)、扩展清单 |
| 可选模板源码与素材 | Memes02/meme-generator 提交 `3749bb173d85507c72d40fd66de682bb8dde5c42` | GitHub 整库归档，检查文件清单与大小，见 [可选模板清单](../scripts/python-pack.json) |
| 可选解释器 / 安装工具 | CPython 3.12.12（20260211）、uv 0.13.7 | python-build-standalone 官方发行包、官方 PyPI wheel；SHA-256 与大小，见 [平台运行包清单](../scripts/python-runtime.json) |
| 可选模板依赖 | 上述源码提交的 `uv.lock` | 固定版本，从 PyPI 安装二进制 wheel；当前未要求 pip 逐包哈希校验 |

运行包校验失败时不会安装。素材和模板源码采用固定提交与文件大小检查，不等同于逐文件加密哈希校验。下载路径、版本及预期校验值都随模块源码提交，不使用“最新版”接口。基础素材约 943 MiB，因此发布 ZIP 只含安装器和模块代码。

联网域名与 QQ 图片处理方式见 [README](../README.md#离线与隐私)。所有能力在 `module.json` 声明：联网下载、写入模块缓存、启动生成进程、保存模块设置，以及调用宿主图片/消息接口。

## 许可清单

| 内容 | 许可 / 依据 |
|---|---|
| 本模块 | GPL-3.0-only，实际上传者 `b1ghawk119`，见 [LICENSE](../LICENSE) |
| MemeCrafters 引擎 | MIT，见 [ENGINE-LICENSE](../scripts/ENGINE-LICENSE) |
| meme-emoji | MIT，见 [EMOJI-LICENSE](../scripts/EMOJI-LICENSE) |
| Memes02 模板代码 | MIT，见 [PYTHON-MEME-LICENSE](../scripts/PYTHON-MEME-LICENSE) |
| resvg WASM | MPL-2.0，见 [RESVG-LICENSE](../scripts/RESVG-LICENSE) |
| CPython / uv | 解释器随包许可；uv 为 MIT / Apache-2.0，准备结束后删除安装工具 |
| Python 依赖 | 见 [Windows 依赖版本与许可清单](PYTHON_DEPENDENCIES.md)，各 wheel 保留 `dist-info` 许可，版本由上游 `uv.lock` 固定 |
| 上游模板图片与字体 | 权利属于各自权利人；上游代码许可不覆盖全部素材，须单独判断分发许可 |
| 自带黄仁勋照片 | nvidia.corporation，CC BY-SA 2.0，见 [素材说明](../assets/README.md) |
| 自带举牌合成图 | 用户提供，未取得可覆盖所有第三方图像权利的额外授权，见素材说明 |

当前安装方式涉及运行时下载可执行组件，与市场现行规则存在冲突；分发方式和素材许可均待维护者确认。
