@echo off
rem build.bat —— 在 Windows 上编译 TUTK 抓帧桥（单文件 C，只依赖系统 API，不需要 .NET）。
rem
rem 仓库里带的 bambu-tutk-bridge.exe 用 zig 0.17.1（clang 22.1.8 / LLD 22.1.8）生成：
rem   zig cc -O2 -o bambu-tutk-bridge.exe bambu-tutk-bridge.c
rem 同一份源码用 zig 重编，代码段逐字节相同，整文件只差 PE 时间戳 / PDB 签名那 20 字节。
rem
rem 没有 zig 也行：MSVC 的 cl（在「x64 Native Tools Command Prompt」里跑）或 MinGW 的 gcc
rem 都能编译出功能等价的产物。
setlocal
cd /d "%~dp0"

if not "%ZIG%"=="" (
  echo using zig: %ZIG%
  "%ZIG%" cc -O2 -o bambu-tutk-bridge.exe bambu-tutk-bridge.c
  goto done
)

where zig >nul 2>nul
if %ERRORLEVEL%==0 (
  echo using zig from PATH
  zig cc -O2 -o bambu-tutk-bridge.exe bambu-tutk-bridge.c
  goto done
)

where cl >nul 2>nul
if %ERRORLEVEL%==0 (
  cl /nologo /O2 bambu-tutk-bridge.c /Fe:bambu-tutk-bridge.exe
  goto done
)
where gcc >nul 2>nul
if %ERRORLEVEL%==0 (
  gcc -O2 -o bambu-tutk-bridge.exe bambu-tutk-bridge.c
  goto done
)
echo 找不到 C 编译器：请装 zig、Visual Studio Build Tools（cl）或 MinGW（gcc）。
exit /b 1
:done
echo built: %CD%\bambu-tutk-bridge.exe
