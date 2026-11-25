/**
 * 官方机器人接入 · roost bridge
 * ============================
 * 把模块自带的 roost 整体复制到数据目录运行（不下载、不联网），扫码建机器人，
 * 开 OneBot 兼容层、把网关指过去，并提供能力兼容说明与「我们的优化」说明。
 * 写操作都在面板点按触发；
 * 唯一的例外是「自动拉起」开关打开时，延迟 8 秒后在用户已配置且 roost 没跑的情况下
 * 自动起一次进程——默认关闭，且不重载入模块就起。
 *
 * @type {import('../aurabot').AurabotModule}
 */
import { join } from 'node:path';
import * as fs from 'node:fs';
import * as roost from './lib/roost.mjs';
import * as state from './lib/state.mjs';
import { createGatewayRestore } from './lib/gateway-restore.mjs';
import { textDigest, summary, WHY_ROOST, textWhyRoost } from './lib/compat.mjs';

const ID = 'roost-bridge';

export default {
  id: ID,
  name: '官方机器人接入',
  version: '0.1.2',
  api: 1,
  description: '内置 roost 复制到数据目录运行 + 扫码建机器人 + 配 OneBot 兼容层，让大肥鱼接 QQ 官方机器人',
  category: 'tool',
  panel: 'panel.js',
  navGroup: 'platform',

  defaults: {
    botName: 'main',
    mode: 'exclusive',
    autoStart: false,
  },
  settings: [
    { key: 'botName', label: '机器人配置名', type: 'text', hint: '一般保持 main 就行' },
    { key: 'mode', label: '兼容层模式', type: 'select', options: [
      { value: 'exclusive', label: '独占（推荐）：只让大肥鱼回，roost 自己的 AI 不回' },
      { value: 'parallel', label: '并行：两边都回（可能重复）' },
      { value: 'mirror', label: '镜像：两端都收到同一份' },
    ], hint: '选独占时 roost 的 dsh-roost 插件不要再回话，否则会重复' },
    { key: 'autoStart', label: 'DSH 启动时自动拉起 roost', type: 'switch', hint: '默认关。关 DSH 时会优雅关闭 roost，所以重开 DSH 后想让机器人自己回来就打开这个开关：只有「已经配置完成 + 网关确实指向兼容层 + roost 当前没在跑」三条同时满足才延迟 8 秒起一次。不会一装模块就起进程。改完下次加载生效。' },
  ],

  setup(api) {
    const cfg = () => api.settings() || {};

    // 模块自带 roost 母本只读；运行时整体复制到模块数据目录的 roost-code 再启动。
    // 这样 roost 写 ports.json / 建 plugins 目录都落在数据目录，不会监控到模块文件夹热重载。
    const sourceDir = roost.inplaceDir(api.dir);
    const codeDir = roost.runtimeDir(api.dataDir());
    const homeDir = roost.inplaceHome(api.dataDir());

    // 恢复非敏感进度；敏感项丢了就丢了，面板会提示哪些要重填
    state.init({
      dataDir: api.dataDir(),
      installedCheck: () => roost.looksLikeRoost(codeDir),
      read: () => { try { return JSON.parse(fs.readFileSync(join(api.dataDir(), 'state.json'), 'utf8')); } catch { return null; } },
      write: (dir, obj) => {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = join(dir, 'state.json.tmp');
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
        fs.renameSync(tmp, join(dir, 'state.json'));
      },
    });
    state.set({ dir: String(homeDir), mode: String(cfg().mode || 'exclusive') });

    const log = (...a) => api.log.info('[roost-bridge]', ...a);

    /**
     * 面板密钥优先读 roost 自己的落盘配置：模块内存密钥不持久，
     * 热重载 / DSH 重启后 state 里是空的，但 roost 配置里还在。
     */
    const panelKey = () => String(roost.readPanelKey(homeDir) || state.get().accessKey || '').trim();
    /** 成功路径统一清掉上一次的报错，避免 state.json 里长期残留误导排查 */
    const clearError = () => state.set({ lastError: '' });

    /**
     * 停用/卸载后延迟恢复网关。调度逻辑在 lib/gateway-restore.mjs（可单测）：
     * 这里只负责把宿主 API 注进去——新实例创建即取消旧实例留下的待恢复任务。
     */
    const gatewayRestore = createGatewayRestore({
      state,
      setConfig: (patch) => api.setConfig(patch),
      restorePatch: roost.restoreGatewayPatch,
      log,
    });
    api.onDispose?.(gatewayRestore.schedule);

    /** 面板接口全部带 access:'panel'，复用宿主鉴权闸（1.3.0+） */
    const panelRoute = (path, handler) => api.route(path, handler, { access: 'panel' });

    /** 找 roost 面板真实地址：ports.json → 配置端口 → 默认 15207，healthz 验证 */
    const resolveApi = async () => {
      const s = state.get();
      const found = await roost.resolvePanel(s.dir);
      // 这是 WebUI 面板端口（healthz 探到的），不是 OneBot 兼容层端口——两者绝不能混。
      if (found.port) state.set({ webuiPort: found.port });
      return found;
    };

    /** 停 roost 并等它真的退出；写凭证必须在这之后，否则旧内存会把新凭证覆盖掉 */
    async function stopRoost() {
      const found = await resolveApi();
      if (!found.base) return { stopped: true, alreadyStopped: true };
      try {
        await roost.api({ base: found.base, accessKey: panelKey(), path: '/api/shutdown', method: 'POST', body: {} });
      } catch (e) {
        // 关闭接口发出后进程立刻退出，连接中断是正常现象
        if (!/fetch failed|ECONNRESET|socket hang up|aborted/i.test(e.message)) throw e;
      }
      for (let i = 0; i < 10; i++) {
        await new Promise((ok) => setTimeout(ok, 1000));
        if (!(await roost.roostAlive(homeDir))) return { stopped: true };
      }
      return { stopped: false };
    }

    /**
     * 凭证落盘 + 重启的唯一入口。顺序写死：停 roost → 确认退出 → 写盘 → 回读校验 → 启动。
     *
     * 真机 18:55 的顺序是「写盘 → 点配置兼容层」，而 roost 的 PUT /api/onebot
     * 会 saveBotConfig(rt.id, rt.cfg) 整份写回。那时进程内存还是空 AppID/AppSecret，
     * 刚写进去的凭证立刻被覆盖，日志就一直报「缺少 AppID / AppSecret」。
     * 所以这里先停进程，让内存里那份旧配置彻底消失，再写盘、再启动。
     */
    async function applyCredentials() {
      const s = state.get();
      if (!s.appId || !s.appSecret) throw new Error('没有完整凭证，先扫码或手填 AppID/AppSecret');
      const stopped = await stopRoost();
      if (!stopped.stopped) {
        throw new Error('roost 还没退出，为保护凭证没有写盘。请到 roost 面板点「关闭 roost」后再试');
      }
      const name = String(cfg().botName || 'main');
      const written = roost.writeBotConfig({ dir: homeDir, name, appId: s.appId, appSecret: s.appSecret });
      if (!roost.botConfigExists(homeDir, name)) {
        throw new Error('凭证写入后校验失败，请重新扫码');
      }
      state.mark('botWritten', true);
      const up = await doStart(false);
      state.mark('started', Boolean(up?.ok));
      if (!up?.ok) throw new Error('凭证已写入，但 roost 没起来：' + (up?.error || '看 roost 日志'));
      return { ok: true, restarted: true, file: written.file, up };
    }

    // 状态：步骤、能力矩阵、坑、我们的优化、要重填项，一次拿全
    panelRoute('/status', async () => {
      const alive = await roost.roostAlive(state.get().dir);
      // 兼容层端口每次实时读，不持久化：端口会漂移，历史 state 里的旧值（如把 WebUI 端口当兼容层）不能留。
      if (alive) {
        state.mark('started', true);
        clearError();
        try {
          const found = await resolveApi();
          const b = await roost.bridgeStatus({ base: found.base, accessKey: panelKey() });
          const realPort = Number(b?.state?.port) || 0;
          state.set({ port: realPort }); // 内存更新，不落盘（port 已移出 KEEP）
        } catch { state.set({ port: 0 }); }
      } else {
        state.set({ port: 0 });
        state.mark('started', false);
      }
      // 给面板展示「模块里的机器人 QQ」和「aurabot 配置里的机器人 QQ」是否一致。
      // 不一致时 aurabot 连上后会 get_login_info 核对失败并自己断开。
      const cur = api.config();
      const qq = String(state.get().selfUin || '').trim();
      const botQQ = String(cur.botQQ || '').trim();
      return {
        ok: true,
        steps: state.steps(),
        sourceDir,
        codeDir,
        homeDir,
        state: state.get(),
        capabilities: state.CAPABILITIES,
        caveats: state.CAVEATS,
        whyRoost: WHY_ROOST,
        manualSteps: state.MANUAL_STEPS,
        compat: summary(),
        roostAlive: alive,
        autoStart: cfg().autoStart === true,
        needRefill: state.needRefill(),
        aurabot: {
          gateway: String(cur.gateway || ''),
          botQQ,
          selfUin: qq,
          qqMatched: Boolean(qq) && botQQ === qq,
          enabled: cur.enabled === true,
          dryRun: cur.dryRun === true,
          diary: cur.diary?.enabled === true,
          qzoneSocial: cur.qzoneSocial?.enabled === true,
        },
      };
    });

    // 设置（非敏感，持久化到 aurabot settings）
    panelRoute('/settings', async (req) => {
      const b = await api.core.http.body(req);
      const patch = {};
      for (const k of ['mode', 'botName']) if (b[k] !== undefined) patch[k] = String(b[k]);
      if (b.autoStart !== undefined) patch.autoStart = Boolean(b.autoStart);
      await api.saveSettings(patch);
      state.set({ dir: String(homeDir), mode: String(patch.mode || cfg().mode || 'exclusive') });
      return { ok: true, message: '设置已保存' };
    });

    // 凭证：敏感项只进内存
    panelRoute('/credentials', async (req) => {
      const b = await api.core.http.body(req);
      const patch = {};
      for (const k of ['appId', 'appSecret', 'selfUin', 'token', 'botToken', 'accessKey']) {
        if (b[k] === undefined) continue;
        const v = String(b[k]).trim();
        // 空串一律表示「不改」：appId 是持久化字段，清空它会把已扫码拿到的号抹掉
        if (!v) continue;
        patch[k] = v;
      }
      state.set(patch);
      clearError();
      return { ok: true, message: '凭证已暂存（密钥只在本进程内存）', state: state.get() };
    });

    /**
     * 扫码建机器人：透传 roost 框架的 /api/bots/qr/start 与 /qr/poll。
     * 协议、bindKey、解密、二维码都在框架那边，模块不重实现、不碰 bindKey；
     * 成功那一刻返回的 appId/appSecret 只先暂存内存；落盘要等 /qr/finalize 先停 roost，
     * 否则旧进程内存里的空凭证会在后续面板保存时把新凭证整份覆盖掉。
     * 前提：roost 已在跑。所以前端流程是「启动 roost → 扫码」。
     */
    panelRoute('/qr/start', async () => {
      try {
        const found = await resolveApi();
        if (!found.base) throw new Error('找不到 roost 面板：先点「启动 roost」，扫码要用它的接口');
        const r = await roost.api({ base: found.base, accessKey: panelKey(), path: '/api/bots/qr/start', method: 'POST', body: {} });
        if (!r || r.ok === false || !r.taskId) throw new Error(r?.error || r?.message || '框架没返回 taskId');
        state.set({ qrTaskId: String(r.taskId) });
        return { ok: true, taskId: String(r.taskId), qrUrl: r.qrUrl || '', qrSvg: r.qrSvg || '' };
      } catch (e) { state.mark('lastError', e.message); return { ok: false, error: e.message }; }
    });

    panelRoute('/qr/poll', async (req) => {
      try {
        const b = await api.core.http.body(req);
        const taskId = String(b.taskId || state.get().qrTaskId || '').trim();
        if (!taskId) throw new Error('缺 taskId，先点「生成二维码」');
        const found = await resolveApi();
        if (!found.base) throw new Error('找不到 roost 面板：确认 roost 还在跑');
        const r = await roost.api({ base: found.base, accessKey: panelKey(), path: '/api/bots/qr/poll', method: 'POST', body: { taskId } });
        // 状态归一：认不出来按 pending（多轮询一次总好过让用户以为失败）
        const raw = String(r?.status ?? '').toLowerCase();
        const status = ['done', 'ok', 'success', '1', '2'].includes(raw) ? 'done'
          : ['expired', 'timeout', '3', '4'].includes(raw) ? 'expired'
          : ['error', 'fail', 'invalid', 'denied'].includes(raw) ? 'error' : 'pending';
        const out = { ok: status !== 'error', status, message: r?.message || '' };
        if (status === 'done') {
          const appId = String(r?.appId || '').trim();
          const appSecret = String(r?.appSecret || '').trim();
          if (!appId || !appSecret) return { ok: false, status: 'error', error: '扫码成功但没拿到完整凭证，请重新生成二维码' };
          // 凭证只在这一刻能拿到：先只暂存内存，绝不趁 roost 还活着写盘。
          // 落盘统一交给 /qr/finalize：那里会先停 roost，避免旧内存整份写回把凭证冲掉。
          state.set({ appId, appSecret, qrTaskId: '' });
          state.mark('botWritten', false);
          out.needFinalize = true;
          out.message = '扫码成功，凭证已拿到。正在关闭 roost 并写入配置…';
        }
        return out;
      } catch (e) {
        // 任务被服务端清掉后同一 taskId 会返回 400「二维码已失效」，按 expired 处理，别让用户干等
        const expired = /失效|expired|timeout|not found|400/i.test(e.message || '');
        return { ok: false, status: expired ? 'expired' : 'error', error: e.message };
      }
    });

    /**
     * 扫码成功后单独调用：停 roost → 写凭证 → 重启。
     *
     * 为什么不在 /qr/poll 里直接做：poll 是前端 2 秒轮询调的，停+写+起要十几秒，
     * 期间会收到重复 poll；拆开后前端先停轮询、再调这一步，时序干净。
     */
    panelRoute('/qr/finalize', async () => {
      try {
        await applyCredentials();
        return {
          ok: true,
          restarted: true,
          message: '凭证已写入 roost，进程已重启，机器人正在上线。下一步填机器人 QQ 号并配置兼容层。',
        };
      } catch (e) { state.mark('lastError', e.message); return { ok: false, error: e.message }; }
    });

    // 1) 就绪：把模块自带 roost 同步到数据目录运行副本（不联网）
    panelRoute('/install', async () => {
      try {
        if (await roost.roostAlive(state.get().dir)) {
          return { ok: false, error: 'roost 正在运行，先点「关闭 roost」再点就绪（避免替换正在用的代码目录）' };
        }
        const r = roost.install({ vendorDir: sourceDir, codeDir, homeDir, log });
        const deps = roost.prepareDeps({ vendorDir: codeDir, homeDir, log });
        state.mark('installed', true);
        clearError();
        return { ok: true, ...r, depsMessage: deps.message };
      } catch (e) { state.mark('lastError', e.message); return { ok: false, error: e.message }; }
    });

    // 2) 写机器人凭证（手填兜底；和扫码共用同一条安全写入路径）
    panelRoute('/create-bot', async () => {
      try {
        const s = state.get();
        if (!s.appId || !s.appSecret) throw new Error('请先在上面填 AppID 和 AppSecret 并点「保存凭证」');
        const r = await applyCredentials();
        return {
          ok: true,
          ...r,
          message: '凭证已写入并重启 roost，机器人正在上线。下一步填机器人 QQ 号并配置兼容层。',
        };
      } catch (e) { state.mark('lastError', e.message); return { ok: false, error: e.message }; }
    });

    /**
     * 真正的「拉起 + 探活」。手动按钮和自动拉起共用这一份，避免两处逻辑分叉。
     * @param {boolean} auto 自动拉起时文案不同、失败只记日志不弹 toast
     */
    async function doStartInner(auto = false) {
      try {
        const s = state.get();
        const aliveNow = await roost.roostAlive(s.dir);
        // 只在 roost 没跑时同步运行副本：跑着的时候替换代码目录等于热替换，风险大且没必要
        if (!aliveNow) roost.syncRuntime({ vendorDir: sourceDir, codeDir, log });
        if (!roost.looksLikeRoost(codeDir)) throw new Error('roost 运行副本不完整，请点一次「roost 就绪」');
        // 兼容层依赖（ws/silk）按 ROOST_HOME 找；从运行副本里取自带的那份放到 home 数据目录
        roost.prepareDeps({ vendorDir: codeDir, homeDir, log });
        // 随包 roost 保留原版自更新代码，但本模块运行时锁死 autoApply：只读检查，不自动下载安装
        roost.lockAutoApply(homeDir, log);
        // 手动启动不要求已有机器人配置：新流程是「先起 roost 面板 → 扫码建机器人」，
        // 机器人配置是扫码成功后才写的（roost 面板本身不依赖机器人配置，官方也支持 --serve 只起面板）。
        // 但自动拉起不同：那是 DSH 重启后的恢复场景，必须确实配置完成才起，
        // 所以用「roost 落盘配置存在」当判据，不看模块内存密钥（重启会清空）。
        if (auto && !roost.botConfigExists(s.dir, String(cfg().botName || 'main'))) {
          throw new Error('roost 还没有机器人配置（可能没扫过码），跳过自动拉起');
        }
        if (aliveNow) {
          const port = (await resolveApi()).port;
          state.mark('autoStartResult', 'roost 已在运行，无需拉起');
          return { ok: true, message: `roost 已经在跑了（WebUI 端口 ${port}，不用手动改）`, webuiPort: port };
        }
        roost.startRoost(codeDir, homeDir).unref?.();
        let found = null;
        for (let i = 0; i < 12; i++) {
          await new Promise((ok) => setTimeout(ok, 1000));
          found = await resolveApi();
          if (found.health) break;
        }
        if (!found?.health) {
          const msg = 'roost 进程已拉起，但面板 12 秒内没应答；去 roost 日志看报错（常见：AppID/AppSecret 错、端口全被占）';
          state.mark('lastError', msg);
          state.mark('autoStartResult', auto ? '自动拉起失败：' + msg : '');
          return { ok: false, error: msg };
        }
        state.mark('started', true);
        clearError();
        const bots = found.health.bots || [];
        const online = found.health.online || 0;
        const configured = roost.botConfigExists(s.dir, String(cfg().botName || 'main'));
        const message = !configured
          ? `roost 面板已启动（端口 ${found.port}）。现在去下面「生成二维码」，手机 QQ 扫码建机器人`
          : `roost 已启动（面板端口 ${found.port}）。机器人 ${online}/${bots.length} 在线` + (online ? '' : '；没上线去 roost 面板看日志');
        state.mark('autoStartResult', auto ? `已自动拉起（端口 ${found.port}，${online}/${bots.length} 在线）` : '');
        return { ok: true, message, webuiPort: found.port, bots };
      } catch (e) {
        state.mark('lastError', e.message);
        state.mark('autoStartResult', auto ? '自动拉起失败：' + e.message : '');
        return { ok: false, error: e.message };
      }
    }

    /**
     * 启动重入锁：healthz 起来的十几秒窗口里再点启动（或 autoStart 同时命中），
     * 不能重复 spawn 两个抢同一端口的 roost；后到的直接复用第一次的结果。
     */
    let startingPromise = null;
    async function doStart(auto = false) {
      if (startingPromise) return startingPromise;
      startingPromise = doStartInner(auto).finally(() => { startingPromise = null; });
      return startingPromise;
    }

    // 3) 启动 / 重启 roost。用户最容易卡的一步，必须有按钮。
    panelRoute('/start', () => doStart(false));

    panelRoute('/restart', async () => {
      try {
        const stopped = await stopRoost();
        if (!stopped.stopped) return { ok: false, error: 'roost 还没退出，重启已取消' };
        return await doStart(false);
      } catch (e) { state.mark('lastError', e.message); return { ok: false, error: e.message }; }
    });

    /**
     * 关闭 roost：透传框架自带的 /api/shutdown（优雅退出，会释放实例锁、写干净状态）。
     * 不在这里 kill 进程——那会留下脏的 instances.json（dsh-roost 踩过这个坑）。
     */
    panelRoute('/stop', async () => {
      try {
        const found = await resolveApi();
        if (!found.base) return { ok: true, message: 'roost 本来就没在运行', alreadyStopped: true };
        try {
          await roost.api({ base: found.base, accessKey: panelKey(), path: '/api/shutdown', method: 'POST', body: {} });
        } catch (e) {
          // 关闭接口发出后进程立刻退出，连接中断是正常现象，不当失败
          if (!/fetch failed|ECONNRESET|socket hang up|aborted/i.test(e.message)) throw e;
        }
        // 等它真的退出（最多 8 秒），确认端口不再应答
        let stopped = false;
        for (let i = 0; i < 8; i++) {
          await new Promise((ok) => setTimeout(ok, 1000));
          if (!(await roost.roostAlive(state.get().dir))) { stopped = true; break; }
        }
        state.mark('started', false);
        state.mark('autoStartResult', '');
        return {
          ok: true,
          message: stopped ? 'roost 已关闭' : '已发出关闭请求，roost 正在退出（可刷新看状态）',
          stopped,
        };
      } catch (e) { state.mark('lastError', e.message); return { ok: false, error: e.message }; }
    });

    // 诊断：一次把所有卡点查清，用户不用猜
    panelRoute('/diagnose', async () => {
      const s = state.get();
      const out = [];
      const add = (ok, label, detail) => out.push({ ok, label, detail });
      add(roost.looksLikeRoost(codeDir), 'roost 自带副本完整', codeDir);
      const rt = roost.runtimeInfo();
      add(Boolean(rt.exe), '启动 roost 的运行时', rt.exe + (rt.electronFlag
        ? '（Electron 宿主，已自动加 ELECTRON_RUN_AS_NODE=1；不需要全局 node）'
        : '（Node 运行时，走宿主自带，不需要全局 node）'));
      const found = await resolveApi();
      add(Boolean(found.health), 'roost 面板能应答', found.port ? `端口 ${found.port}` : '没找到，检查 roost 是否启动');
      if (found.health) {
        const bots = found.health.bots || [];
        add((found.health.online || 0) > 0, '机器人在线', bots.map((b) => `${b.id}:${b.state}${b.error ? '(' + b.error + ')' : ''}`).join('、') || '没有机器人');
      }
      const ready = roost.looksLikeRoost(codeDir) && Boolean(found.health) && Boolean(s.accessKey || !s.accessKeySet);
      let bridge = null;
      if (ready) {
        try {
          bridge = await roost.bridgeStatus({ base: found.base, accessKey: panelKey() });
          const st = bridge?.state || {};
          add(st.state === 'running', '兼容层运行中', `状态 ${st.state || 'unknown'}，端口 ${st.port || '—'}`);
        } catch (e) { add(false, '兼容层可读', e.message); }
      } else {
        add(false, '兼容层可读', 'roost 没起来或 accessKey 不对，先解决上面的问题');
      }
      const cur = api.config();
      add(cur.gateway === 'onebot' && /^ws:\/\/127\.0\.0\.1:\d+$/.test(cur.snowluma?.wsUrl || ''), '大肥鱼已指向兼容层', `gateway=${cur.gateway}, wsUrl=${cur.snowluma?.wsUrl || '空'}`);
      // 登录号核对：aurabot 连上后会 get_login_info，跟 config.botQQ 比，不一致自己断开。
      const curQQ = String(cur.botQQ || '').trim();
      const wantQQ = String(s.selfUin || '').trim();
      add(Boolean(wantQQ) && curQQ === wantQQ, 'aurabot 机器人 QQ 号', curQQ
        ? (curQQ === wantQQ ? curQQ : `${curQQ}（模块里是 ${wantQQ || '空'}，点「接入大肥鱼」同步）`)
        : '空（先保存机器人 QQ 号再接入）');
      add(cur.enabled === true, 'aurabot 总开关', cur.enabled ? '已开' : '关着：面板右上角打开后才会连');
      add(cur.dryRun === false, 'aurabot 试运行', cur.dryRun ? '开着：消息只截不下发，确认后关掉' : '已关');
      if (cfg().autoStart === true) {
        add(true, '自动拉起开关', state.get().autoStartResult || '已开，下次 DSH 加载时若 roost 没跑会自动起一次');
      }
      return { ok: true, checks: out, bridge };
    });

    // 4) 读兼容层状态
    panelRoute('/bridge-status', async () => {
      try {
        const found = await resolveApi();
        if (!found.base) return { ok: false, error: '找不到 roost 面板：确认 roost 已启动（点「启动 roost」）' };
        const data = await roost.bridgeStatus({ base: found.base, accessKey: panelKey() });
        const port = Number(data?.state?.port) || 0;
        if (port) state.set({ port, lastBridgePort: port });
        state.mark('depsReady', data?.state?.state !== 'missing-deps');
        if (data?.state?.state === 'missing-deps') return { ok: true, data, resolvedPort: port, warning: '兼容层报缺依赖；ws 本应随模块内置，可能这份 roost 不是本模块装的' };
        return { ok: true, data, resolvedPort: port };
      } catch (e) { return { ok: false, error: e.message }; }
    });

    // 5) 一键配置兼容层。roost 的 PUT 写盘后要 reconfigure，端口从 state 读。
    panelRoute('/configure', async () => {
      try {
        const s = state.get();
        const found = await resolveApi();
        if (!found.base) throw new Error('找不到 roost 面板，先点「启动 roost」');
        // 兼容层 PUT 会让 roost 用「当前进程内存里的 cfg」整份写回配置。
        // 如果凭证还没落盘并随重启加载进内存，这一步会把空 AppID/AppSecret 写回去。
        if (!roost.botConfigExists(homeDir, String(cfg().botName || 'main'))) {
          throw new Error('roost 配置里还没有 AppID/AppSecret：先完成扫码，等提示「凭证已写入 roost，进程已重启」再配置兼容层');
        }
        const token = s.token || roost.genToken();
        // 机器人 QQ 号官方接口拿不到，必须用户填；不能拿 Aurabot 自己的 botQQ 兜底
        // ——那可能是旧机器人号，填错会让 @ 识别和身份映射全乱。
        const selfUin = String(s.selfUin || '').trim();
        if (!/^[1-9]\d{4,11}$/.test(selfUin)) {
          throw new Error('请先填机器人 QQ 号（5–12 位数字）：扫码拿不到它，去 QQ 机器人资料里找，填到「4·配置兼容层」的输入框');
        }
        const r = await roost.configureBridge({
          base: found.base, accessKey: panelKey(),
          selfUin, token, mode: s.mode, log,
        });
        state.set({ token });
        state.mark('configured', true);
        clearError();
        let port = 0;
        try {
          const st = await roost.bridgeStatus({ base: found.base, accessKey: panelKey() });
          port = Number(st?.state?.port) || 0;
          if (port) state.set({ port, lastBridgePort: port });
        } catch (e) { log('读端口失败：' + e.message); }
        return { ok: true, ...r, port };
      } catch (e) { state.mark('lastError', e.message); return { ok: false, error: e.message }; }
    });

    // 6) 接入大肥鱼（局部深合并）
    panelRoute('/link', async () => {
      try {
        const s = state.get();
        // DSH 重启后 port（内存态）和 token（密钥）都会丢：先从 roost 实时状态和落盘配置回填
        let port = Number(s.port) || 0;
        let token = String(s.token || '').trim();
        if (!port || !token) {
          const found = await resolveApi();
          if (found.base) {
            try {
              const st = await roost.bridgeStatus({ base: found.base, accessKey: panelKey() });
              const livePort = Number(st?.state?.port) || 0;
              if (livePort) { port = livePort; state.set({ port, lastBridgePort: port }); }
            } catch {}
          }
          const disk = roost.readBridgeSettings(homeDir, String(cfg().botName || 'main'));
          if (!port && disk.port) port = disk.port;
          // roost 把实际兼容层端口只放内存，落盘 onebot.port 常是 0；用上次探到的快照兜底
          if (!port && s.lastBridgePort) port = Number(s.lastBridgePort) || 0;
          if (!token && disk.token) token = disk.token;
        }
        if (!port) throw new Error('还没拿到 OneBot 兼容层端口——先点「一键配置」开启兼容层（注意：WebUI 面板端口不是兼容层端口）');
        if (!token) throw new Error('没有兼容层 token，先点「一键配置」');
        const selfUin = String(s.selfUin || '').trim();
        if (!/^[1-9]\d{4,11}$/.test(selfUin)) {
          throw new Error('请先保存机器人 QQ 号：aurabot 会拿它核对登录号，号不对会连上后立刻断开');
        }
        // 记住接入前的旧机器人号，/unlink 退回 SnowLuma 时一并恢复。
        // 只在第一次接入时记，反复点「接入」不会被新号覆盖。
        const prev = String(s.prevBotQQ || '').trim();
        if (!prev) {
          const oldQQ = String(api.config().botQQ || '').trim();
          if (oldQQ && oldQQ !== selfUin) state.set({ prevBotQQ: oldQQ });
        }
        const curCfg = api.config();
        if (s.prevDiaryEnabled === null) state.set({ prevDiaryEnabled: curCfg.diary?.enabled !== false });
        if (s.prevQzoneSocialEnabled === null) state.set({ prevQzoneSocialEnabled: curCfg.qzoneSocial?.enabled !== false });
        const patch = roost.aurabotPatch({ port, token, selfUin });
        api.setConfig(patch);
        state.mark('linked', true);
        clearError();
        const before = api.config();
        const note = before.enabled === true
          ? (before.dryRun === true ? ' aurabot 还在试运行，消息只截不下发；确认后到「设置」关掉试运行。' : '')
          : ' aurabot 总开关还关着，到面板右上角打开后才会连。';
        return {
          ok: true,
          message: `网关已指向 roost 兼容层，aurabot 的机器人 QQ 号已同步为 ${selfUin}（你的 QQ 号 ownerQQ 没动）。空间日记 / 空间互动依赖 QQ 空间私有协议，官方这条路用不了，已暂时关闭。重启一次 DSH 生效。${note}建议先在 roost 面板「身份」页绑定常用用户的 QQ 号，记忆才能对上真号（换机器人也接得上旧记忆）。`,
          patch,
        };
      } catch (e) { state.mark('lastError', e.message); return { ok: false, error: e.message }; }
    });

    // 7) 一键恢复原网关（不是只给补丁看）
    panelRoute('/unlink', async () => {
      try {
        const s = state.get();
        api.setConfig(roost.restoreGatewayPatch({
          botQQ: s.prevBotQQ,
          diary: s.prevDiaryEnabled,
          qzoneSocial: s.prevQzoneSocialEnabled,
        }));
        state.mark('linked', false);
        clearError();
        state.set({ prevBotQQ: '', prevDiaryEnabled: null, prevQzoneSocialEnabled: null });
        return {
          ok: true,
          message: `网关已改回原来的 SnowLuma 配置${s.prevBotQQ ? `，机器人 QQ 号恢复为 ${s.prevBotQQ}` : ''}；空间日记 / 空间互动也恢复为接入前的状态。重启一次 DSH 生效。`,
        };
      } catch (e) { return { ok: false, error: e.message }; }
    });

    // 8) 兼容说明 + 我们的优化（命令和面板共用）
    panelRoute('/compat', () => ({ ok: true, text: textDigest(), why: textWhyRoost(), capabilities: state.CAPABILITIES, caveats: state.CAVEATS, whyRoost: WHY_ROOST }));

    /**
     * roost 面板各功能页的直达链接（前端做成快捷按钮，点了在浏览器新标签打开）。
     * tab 名对齐 roost web/index.html：identity=身份、groups=群组、onebot=外接、dev=开放平台。
     * 密钥拼进 URL（用户自己的本机浏览器）；不单独回显明文。
     */
    panelRoute('/panel-urls', async () => {
      const found = await resolveApi();
      if (!found.base) return { ok: false, error: '找不到 roost 面板：先点「启动 roost」' };
      const key = panelKey();
      const base = found.base + (key ? `/?key=${encodeURIComponent(key)}` : '/');
      const link = (tab, label, desc) => ({ label, desc, url: `${base}#${tab}` });
      return {
        ok: true,
        base: found.base,
        links: [
          link('identity', '身份绑定', '绑定常用用户的 QQ 号 / 群号 ↔ openid，换机器人也接得上旧记忆'),
          link('notify', '邮箱 / 自助绑定', '配置 SMTP 后群友可用 /绑定QQ + 邮箱验证码自助绑定，不用主人逐个代绑'),
          link('groups', '群组 / 认领主人', '拉群、认领主人、开群档案；主人认领也在这页'),
          link('onebot', '外接 / 检查依赖', 'OneBot 兼容层状态、ws/silk 依赖、端口与 token'),
          link('dev', '开放平台', '开发者后台相关设置（接收全量消息在 QQ 机器人后台/群设置里开）'),
        ],
      };
    });

    /**
     * 自动拉起（可选，开关默认关）。
     * 只在三条同时成立时动手：① 用户开了开关 ② 之前确实配置完成且网关指向兼容层
     * ③ roost 现在没在跑。延迟 8 秒让 DSH 各服务先起来，api.later 在模块停用时会被撤销。
     * 绝不因为「装了模块」就起进程——那是用户没预期的副作用。
     */
    api.later(8000, async () => {
      if (cfg().autoStart !== true) return;
      const s = state.get();
      if (!s.configured || !s.linked) return;
      const cur = api.config();
      if (cur.gateway !== 'onebot' || !/^ws:\/\/127\.0\.0\.1:\d+$/.test(cur.snowluma?.wsUrl || '')) {
        state.mark('autoStartResult', '未拉起：网关已不指向兼容层（可能用户手动改回过）');
        return;
      }
      if (await roost.roostAlive(s.dir)) {
        state.mark('autoStartResult', '未拉起：roost 已在运行');
        return;
      }
      log('autoStart 已开且条件满足，自动拉起 roost…');
      await doStart(true);
    });

    /**
     * 不导出 dispose()：Aurabot 热重载也会调它，直接停机/恢复网关会误伤正在运行的实例。
     * 停用/卸载恢复走上面的 api.onDispose 延迟任务；热重载时新 setup 会取消它。
     * roost 进程本身由 lib/launch.mjs 的父进程守护负责。
     */
    return { state, roost };
  },
};

