# 构建与验证

模块源码不提交预编译程序。CI 在只读 macOS job 中从 lib/native 下的三个 Swift 源文件编译 arm64、最低 macOS 13 的窗口程序，执行 ad-hoc 签名及验证，再上传构建产物。同一次 CI 的 Linux 打包 job 校验源码指纹及每个原生文件的 sha256 后，生成 .build 发布目录。发布 job 保持独立，模块代码不会在持有写权限的发布 job 中运行。

本地 Mac 构建（开发者需 Apple Command Line Tools；普通用户安装完整市场包即可）：

```sh
npm ci --ignore-scripts
npm test
npm run build
```

`npm run build:native` 只生成 `.runtime/native`，供 CI 传递。Linux 不下载和执行外部原生程序，缺少同一源码的 Mac 产物时直接报错。

发布目录包含完整 Swift 源码、静态角色素材及原生程序；没有 Finder 脚本、图标搬运、桌面文件夹访问或额外动作试播。养成存档仍为 schema 1，升级沿用现有数据。
