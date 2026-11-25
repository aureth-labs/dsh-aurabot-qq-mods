// bambu-tutk-bridge.c —— 单文件、零依赖（只用系统 API）的 TUTK 抓帧桥。
//
// 背景：open-bamboo-networking 把完整的 TUTK 客户端（IOTC 打洞/中继、DTLS-PSK、
// AV 层、H.264 分片重组）编进了 libBambuSource.so / BambuSource.dll，并导出
// Bambu_* C ABI。本程序在运行时动态加载这个库，按 Bambu Studio 的调用顺序抓样本：
//
//   Bambu_Create(url) → Bambu_Open → Bambu_StartStream(video) → Bambu_ReadSample* → Close/Destroy
//
// BambuSource 从哪来（本程序不打包它，OBN 是 AGPL-3.0）：
//   https://github.com/ClusterM/open-bamboo-networking/releases
//     obn-windows-x64.zip  → lib/v02.09.01/BambuSource.dll
//     obn-linux-x64.tar.gz → lib/libBambuSource.so
//   放到本程序同目录即可（下面会自动找）；或用 --lib / BAMBU_SOURCE_LIB 指定。
//
// 用法：
//   bambu-tutk-bridge --url-file <含 bambu:///tutk?… 的文件> --dump <输出> [--seconds N]
//                     [--lib <BambuSource 路径>] [--verbose]
//   bambu-tutk-bridge --print-lib      # 只打印自动找到的库路径（自检，不连打印机）
//   bambu-tutk-bridge --selftest       # 只验证库能加载、导出齐全
//
// 安全：URL 只从文件读，绝不从 argv 读；库自己的日志默认关掉（它会打印完整 URL）。
//
// 构建（不需要 .NET / Node / npm）。仓库里那两个预编译产物是用 zig 0.17.1
// （clang 22.1.8 / LLD 22.1.8）编的，命令见 build.sh / build.bat。
// 其它编译器（MSVC cl / MinGW gcc / 系统 cc）同样能编，只是产物不会逐字节相同。
//
// 许可：MIT。本文件不含 OBN 的实现，只在运行时调用用户自己安装的库。

/* 可移植性：-std=c11 严格模式或 musl 下，readlink / clock_gettime / setenv / usleep
 * 默认不会声明（要么报 implicit declaration，要么在 musl 上链接失败）。
 * 在包含任何头文件之前把它们打开，build.sh 的裸 cc -O2 才在各家 libc 上都编得过。 */
#if !defined(_WIN32)
#  ifndef _POSIX_C_SOURCE
#    define _POSIX_C_SOURCE 200809L
#  endif
#  ifndef _DEFAULT_SOURCE
#    define _DEFAULT_SOURCE 1
#  endif
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#  include <direct.h>
#  define LIB_HANDLE HMODULE
#  define LIB_OPEN(p) LoadLibraryA(p)
#  define LIB_SYM(h, n) ((void*)GetProcAddress((h), (n)))
#  define LIB_CLOSE(h) FreeLibrary(h)
#  define SLEEP_MS(ms) Sleep(ms)
#  define PATH_SEP '\\'
typedef void (*logger_fn)(void* ctx, int level, const wchar_t* msg);
#else
#  include <dlfcn.h>
#  include <unistd.h>
#  include <dirent.h>
#  include <sys/stat.h>
#  define LIB_HANDLE void*
#  define LIB_OPEN(p) dlopen((p), RTLD_NOW)
#  define LIB_SYM(h, n) dlsym((h), (n))
#  define LIB_CLOSE(h) dlclose((h))
#  define SLEEP_MS(ms) usleep((useconds_t)(ms) * 1000)
#  define PATH_SEP '/'
typedef void (*logger_fn)(void* ctx, int level, const char* msg);
#endif

typedef void* bambu_tunnel;
typedef int (*fn_create)(bambu_tunnel*, const char*);
typedef int (*fn_open)(bambu_tunnel);
typedef int (*fn_start_stream)(bambu_tunnel, int video);
typedef int (*fn_read_sample)(bambu_tunnel, void* sample);
typedef void (*fn_close)(bambu_tunnel);
typedef void (*fn_destroy)(bambu_tunnel);
typedef void (*fn_set_logger)(bambu_tunnel, logger_fn, void*);
typedef const char* (*fn_last_error)(void);

enum { BAMBU_SUCCESS = 0, BAMBU_STREAM_END = 1, BAMBU_WOULD_BLOCK = 2, BAMBU_BUFFER_LIMIT = 3 };

/* Bambu_Sample: itrack, size, flags, buffer, decode_time(100ns) */
typedef struct {
    int itrack;
    int size;
    int flags;
    const unsigned char* buffer;
    unsigned long long decode_time;
} bambu_sample;

static int g_verbose = 0;

#if defined(_WIN32)
static void on_log(void* ctx, int level, const wchar_t* msg)
{
    (void)ctx;
    if (g_verbose && level <= 2 && msg) {
        char buf[1024];
        WideCharToMultiByte(CP_UTF8, 0, msg, -1, buf, sizeof(buf), NULL, NULL);
        fprintf(stderr, "lib: %s\n", buf);
    }
}
#else
static void on_log(void* ctx, int level, const char* msg)
{
    (void)ctx;
    if (g_verbose && level <= 2 && msg) fprintf(stderr, "lib: %s\n", msg);
}
#endif

static const char* lib_name(void)
{
#if defined(_WIN32)
    return "BambuSource.dll";
#else
    return "libBambuSource.so";
#endif
}

static int file_exists(const char* p)
{
    FILE* f;
    if (!p || !*p) return 0;
    f = fopen(p, "rb");
    if (!f) return 0;
    fclose(f);
    return 1;
}

static void join_path(char* out, size_t cap, const char* dir, const char* name)
{
    size_t n;
    if (!dir || !*dir) { snprintf(out, cap, "%s", name); return; }
    snprintf(out, cap, "%s%c%s", dir, PATH_SEP, name);
    n = strlen(out);
    if (n + 1 < cap) { out[n] = 0; }
}

/** 本程序所在目录（末尾不带分隔符）。 */
static void exe_dir(char* out, size_t cap)
{
    out[0] = 0;
#if defined(_WIN32)
    {
        char buf[2048];
        DWORD n = GetModuleFileNameA(NULL, buf, (DWORD)sizeof(buf));
        char* slash;
        if (n == 0 || n >= sizeof(buf)) return;
        buf[n] = 0;
        slash = strrchr(buf, '\\');
        if (!slash) slash = strrchr(buf, '/');
        if (slash) *slash = 0;
        snprintf(out, cap, "%s", buf);
    }
#else
    {
        char buf[2048];
        ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
        char* slash;
        if (n <= 0) return;
        buf[n] = 0;
        slash = strrchr(buf, '/');
        if (slash) *slash = 0;
        snprintf(out, cap, "%s", buf);
    }
#endif
}

/** 在 plugin 目录（如 ~/.config/BambuStudio/plugins）里找最高版本子目录下的库。 */
static int best_in_plugin_dir(const char* root, char* out, size_t cap)
{
    char best[256];
    best[0] = 0;
#if defined(_WIN32)
    {
        char pattern[2048];
        WIN32_FIND_DATAA fd;
        HANDLE h;
        join_path(pattern, sizeof(pattern), root, "*");
        h = FindFirstFileA(pattern, &fd);
        if (h == INVALID_HANDLE_VALUE) return 0;
        do {
            if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
            if (fd.cFileName[0] != 'v') continue;
            {
                char candidate[2048];
                join_path(candidate, sizeof(candidate), root, fd.cFileName);
                join_path(candidate, sizeof(candidate), candidate, lib_name());
                if (file_exists(candidate) && strcmp(fd.cFileName, best) > 0) snprintf(best, sizeof(best), "%s", fd.cFileName);
            }
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
#else
    {
        DIR* d = opendir(root);
        struct dirent* e;
        if (!d) return 0;
        while ((e = readdir(d)) != NULL) {
            char candidate[2048];
            if (e->d_name[0] != 'v') continue;
            join_path(candidate, sizeof(candidate), root, e->d_name);
            join_path(candidate, sizeof(candidate), candidate, lib_name());
            if (file_exists(candidate) && strcmp(e->d_name, best) > 0) snprintf(best, sizeof(best), "%s", e->d_name);
        }
        closedir(d);
    }
#endif
    if (!best[0]) return 0;
    join_path(out, cap, root, best);
    join_path(out, cap, out, lib_name());
    return file_exists(out);
}

/** 找到 BambuSource：--lib → 环境变量 → 本程序同目录 → 切片器插件目录 → 系统搜索路径。 */
static int resolve_lib(const char* explicit_path, char* out, size_t cap, char* tried, size_t tried_cap)
{
    char dir[2048];
    char cand[2048];
    const char* env;
    int i;

    if (tried && tried_cap) tried[0] = 0;

    if (explicit_path && *explicit_path) {
        if (file_exists(explicit_path)) { snprintf(out, cap, "%s", explicit_path); return 1; }
        if (tried) { snprintf(cand, sizeof(cand), "--lib 指定的文件不存在：%s", explicit_path); snprintf(tried, tried_cap, "%s", cand); }
        return 0;
    }

    env = getenv("BAMBU_SOURCE_LIB");
    if (env && *env && file_exists(env)) { snprintf(out, cap, "%s", env); return 1; }
    if (env && *env && tried) { snprintf(cand, sizeof(cand), "BAMBU_SOURCE_LIB 指向的文件不存在：%s\n", env); snprintf(tried, tried_cap, "%s", cand); }

    exe_dir(dir, sizeof(dir));
    if (dir[0]) {
        join_path(cand, sizeof(cand), dir, lib_name());
        if (file_exists(cand)) { snprintf(out, cap, "%s", cand); return 1; }
        if (tried) {
            size_t used = strlen(tried);
            snprintf(tried + used, tried_cap - used, "%s\n", cand);
        }
    }

    {
        const char* roots[8];
        int n = 0;
#if defined(_WIN32)
        const char* appdata = getenv("APPDATA");
        const char* localappdata = getenv("LOCALAPPDATA");
        const char* programdata = getenv("ProgramData");
        static char p1[2048], p2[2048], p3[2048], p4[2048], p5[2048], p6[2048];
        if (appdata) {
            snprintf(p1, sizeof(p1), "%s\\BambuStudio\\plugins", appdata); roots[n++] = p1;
            snprintf(p2, sizeof(p2), "%s\\OrcaSlicer\\plugins", appdata); roots[n++] = p2;
        }
        if (localappdata) {
            snprintf(p3, sizeof(p3), "%s\\BambuStudio\\plugins", localappdata); roots[n++] = p3;
            snprintf(p4, sizeof(p4), "%s\\Programs\\BambuStudio\\plugins", localappdata); roots[n++] = p4;
        }
        if (programdata) { snprintf(p5, sizeof(p5), "%s\\BambuStudio\\plugins", programdata); roots[n++] = p5; }
        snprintf(p6, sizeof(p6), "C:\\Program Files\\Bambu Studio\\plugins"); roots[n++] = p6;
#else
        const char* home = getenv("HOME");
        const char* xdg = getenv("XDG_CONFIG_HOME");
        static char p1[2048], p2[2048], p3[2048], p4[2048];
        if (xdg) { snprintf(p1, sizeof(p1), "%s/BambuStudio/plugins", xdg); roots[n++] = p1; }
        if (home) {
            snprintf(p2, sizeof(p2), "%s/.config/BambuStudio/plugins", home); roots[n++] = p2;
            snprintf(p3, sizeof(p3), "%s/.config/OrcaSlicer/plugins", home); roots[n++] = p3;
        }
        snprintf(p4, sizeof(p4), "/usr/lib/bambu-studio/plugins"); roots[n++] = p4;
#endif
        for (i = 0; i < n; i++) {
            if (!roots[i] || !roots[i][0]) continue;
            if (best_in_plugin_dir(roots[i], cand, sizeof(cand))) { snprintf(out, cap, "%s", cand); return 1; }
        }
    }

    snprintf(cand, sizeof(cand), "%s", lib_name());
    if (file_exists(cand)) { snprintf(out, cap, "%s", cand); return 1; }
    return 0;
}

static char* read_first_line(const char* path)
{
    FILE* f = fopen(path, "rb");
    if (!f) return NULL;
    char* line = (char*)calloc(1, 4096);
    if (!line) { fclose(f); return NULL; }
    size_t n = fread(line, 1, 4095, f);
    fclose(f);
    line[n] = 0;
    char* nl = strpbrk(line, "\r\n");
    if (nl) *nl = 0;
    return line;
}

static long long now_ms(void)
{
#if defined(_WIN32)
    return (long long)GetTickCount64();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
#endif
}

static void usage(void)
{
    fprintf(stderr,
        "usage: bambu-tutk-bridge --url-file PATH --dump PATH [--seconds N] [--lib PATH] [--verbose]\n"
        "       bambu-tutk-bridge --print-lib | --selftest\n"
        "\n"
        "BambuSource 从哪来：https://github.com/ClusterM/open-bamboo-networking/releases\n"
        "  Windows: obn-windows-x64.zip  -> lib/v02.09.01/BambuSource.dll\n"
        "  Linux:   obn-linux-x64.tar.gz -> lib/libBambuSource.so\n"
        "放到本程序同目录即可；或 --lib / BAMBU_SOURCE_LIB 指定。\n");
}

int main(int argc, char** argv)
{
    const char* url_file = NULL;
    const char* dump_file = NULL;
    const char* lib_arg = NULL;
    int seconds = 8;
    int print_lib = 0;
    int selftest = 0;
    int i;
    char lib_path[2048];
    char tried[4096];

    for (i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--url-file") && i + 1 < argc) url_file = argv[++i];
        else if (!strcmp(argv[i], "--dump") && i + 1 < argc) dump_file = argv[++i];
        else if ((!strcmp(argv[i], "--lib") || !strcmp(argv[i], "--bambu-source")) && i + 1 < argc) lib_arg = argv[++i];
        else if (!strcmp(argv[i], "--seconds") && i + 1 < argc) seconds = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--verbose")) g_verbose = 1;
        else if (!strcmp(argv[i], "--print-lib")) print_lib = 1;
        else if (!strcmp(argv[i], "--selftest")) selftest = 1;
        else if (!strcmp(argv[i], "--help") || !strcmp(argv[i], "-h")) { usage(); return 0; }
    }
    if (seconds < 2) seconds = 2;
    if (seconds > 60) seconds = 60;

    /* 库自己的日志会打印完整 bambu:/// URL（含 passwd），默认关掉；--verbose 才开。
       OBN 同时认 OBN_BAMBUSOURCE_* 与 BAMBUSOURCE_* 两套变量名，两套都设。 */
    {
        const char* level = g_verbose ? "info" : "off";
        const char* stderr_flag = g_verbose ? "1" : "0";
#if defined(_WIN32)
        _putenv_s("BAMBUSOURCE_LOG_LEVEL", level);
        _putenv_s("BAMBUSOURCE_LOG_STDERR", stderr_flag);
        _putenv_s("OBN_BAMBUSOURCE_LOG_LEVEL", level);
        _putenv_s("OBN_BAMBUSOURCE_LOG_STDERR", stderr_flag);
#else
        setenv("BAMBUSOURCE_LOG_LEVEL", level, 1);
        setenv("BAMBUSOURCE_LOG_STDERR", stderr_flag, 1);
        setenv("OBN_BAMBUSOURCE_LOG_LEVEL", level, 1);
        setenv("OBN_BAMBUSOURCE_LOG_STDERR", stderr_flag, 1);
#endif
    }

    lib_path[0] = 0;
    if (!resolve_lib(lib_arg, lib_path, sizeof(lib_path), tried, sizeof(tried))) {
        fprintf(stderr,
            "找不到 BambuSource（%s）。\n"
            "下载：https://github.com/ClusterM/open-bamboo-networking/releases\n"
            "  Windows: obn-windows-x64.zip  -> lib/v02.09.01/BambuSource.dll\n"
            "  Linux:   obn-linux-x64.tar.gz -> lib/libBambuSource.so\n"
            "放到本程序同目录，或用 --lib / BAMBU_SOURCE_LIB 指定。\n",
            lib_name());
        if (tried[0]) fprintf(stderr, "已尝试：\n%s", tried);
        return 3;
    }

    if (print_lib) {
        printf("%s\n", lib_path);
        return 0;
    }

    LIB_HANDLE lib = LIB_OPEN(lib_path);
    if (!lib) {
        fprintf(stderr, "加载失败：%s\n（Windows 上请确认是 x64 的 BambuSource.dll）\n", lib_path);
        return 3;
    }

    fn_create p_create = (fn_create)LIB_SYM(lib, "Bambu_Create");
    fn_open p_open = (fn_open)LIB_SYM(lib, "Bambu_Open");
    fn_start_stream p_start = (fn_start_stream)LIB_SYM(lib, "Bambu_StartStream");
    fn_read_sample p_read = (fn_read_sample)LIB_SYM(lib, "Bambu_ReadSample");
    fn_close p_close = (fn_close)LIB_SYM(lib, "Bambu_Close");
    fn_destroy p_destroy = (fn_destroy)LIB_SYM(lib, "Bambu_Destroy");
    fn_set_logger p_logger = (fn_set_logger)LIB_SYM(lib, "Bambu_SetLogger");
    fn_last_error p_err = (fn_last_error)LIB_SYM(lib, "Bambu_GetLastErrorMsg");

    if (!p_create || !p_open || !p_start || !p_read || !p_close || !p_destroy) {
        fprintf(stderr, "BambuSource 缺少必要导出（Create/Open/StartStream/ReadSample/Close/Destroy）：%s\n", lib_path);
        LIB_CLOSE(lib);
        return 3;
    }

    if (selftest) {
        printf("selftest ok: %s（Bambu_Create/Open/StartStream/ReadSample 都在）\n", lib_path);
        LIB_CLOSE(lib);
        return 0;
    }

    if (!url_file || !dump_file) { usage(); LIB_CLOSE(lib); return 2; }

    char* url = read_first_line(url_file);
    if (!url) { fprintf(stderr, "读不到 URL 文件\n"); LIB_CLOSE(lib); return 2; }
    if (strncmp(url, "bambu:///", 9) != 0) {
        fprintf(stderr, "URL 不是 bambu:/// 开头\n");
        free(url); LIB_CLOSE(lib); return 2;
    }

    bambu_tunnel tunnel = NULL;
    int rc = p_create(&tunnel, url);
    if (rc != 0 || !tunnel) {
        fprintf(stderr, "Bambu_Create 失败 rc=%d%s%s\n", rc, p_err ? " " : "", p_err && p_err() ? p_err() : "");
        free(url); LIB_CLOSE(lib); return 4;
    }
    if (p_logger) p_logger(tunnel, on_log, NULL);

    {
        long long deadline = now_ms() + 20000;
        do { rc = p_open(tunnel); if (rc == BAMBU_WOULD_BLOCK) SLEEP_MS(100); } while (rc == BAMBU_WOULD_BLOCK && now_ms() < deadline);
        if (rc < 0) {
            fprintf(stderr, "Bambu_Open 失败 rc=%d%s%s\n", rc, p_err ? " " : "", p_err && p_err() ? p_err() : "");
            p_destroy(tunnel); free(url); LIB_CLOSE(lib); return 5;
        }
    }

    {
        long long deadline = now_ms() + 20000;
        do { rc = p_start(tunnel, 1); if (rc == BAMBU_WOULD_BLOCK) SLEEP_MS(100); } while (rc == BAMBU_WOULD_BLOCK && now_ms() < deadline);
        if (rc < 0) {
            fprintf(stderr, "Bambu_StartStream 失败 rc=%d（打印机没开云画面 / ttcode 已过期 / 账号没有云画面权限）\n", rc);
            p_close(tunnel); p_destroy(tunnel); free(url); LIB_CLOSE(lib); return 6;
        }
    }

    FILE* out = fopen(dump_file, "wb");
    if (!out) {
        fprintf(stderr, "写不了 dump 文件\n");
        p_close(tunnel); p_destroy(tunnel); free(url); LIB_CLOSE(lib); return 7;
    }

    {
        long long got = 0;
        long long limit = 64LL * 1024 * 1024;
        long long deadline = now_ms() + (long long)seconds * 1000;
        bambu_sample sample;
        while (now_ms() < deadline && got < limit) {
            memset(&sample, 0, sizeof(sample));
            rc = p_read(tunnel, &sample);
            if (rc == BAMBU_SUCCESS) {
                if (sample.buffer && sample.size > 0) {
                    fwrite(sample.buffer, 1, (size_t)sample.size, out);
                    got += sample.size;
                }
            } else if (rc == BAMBU_WOULD_BLOCK || rc == BAMBU_BUFFER_LIMIT) {
                fflush(out);
                SLEEP_MS(15);
            } else {
                break;
            }
        }
        fflush(out);
        fclose(out);
        p_close(tunnel);
        p_destroy(tunnel);
        free(url);
        LIB_CLOSE(lib);
        if (got <= 0) {
            fprintf(stderr, "没有拿到画面样本（打印机可能没开云画面，或 ttcode 过期）\n");
            return 8;
        }
    }
    return 0;
}
