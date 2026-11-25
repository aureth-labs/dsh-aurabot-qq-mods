// GitHub 助手：私聊盯 CI 失败 / 待审 PR / 被 @；群聊 #项目 看仓库状态。
// 只读 GitHub 公开 API，token 只用于私有仓库和提高限频。不写文件到仓库以外的地方。

import { chmodSync, readFileSync, writeFileSync } from 'node:fs'

const API = 'https://api.github.com'
const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const CMD_RE = /^[#＃/／]\s*(?:项目状态|项目|仓库状态|repo|gh)(?:\s+([\s\S]+))?$/i
const BAD_RUNS = new Set(['failure', 'timed_out', 'startup_failure'])
const MAX_REPOS = 10
const MAX_SEEN = 200

const DEFAULTS = {
  token: '',
  repos: '',
  groupRepos: '',
  pollMinutes: 5,
  notifyCi: true,
  notifyReview: true,
  notifyMention: true,
  quietStart: 23,
  quietEnd: 8,
  groupDetail: 'normal',
  groupCooldown: 15,
}

const CI_WORD = {
  success: '通过',
  failure: '失败',
  cancelled: '取消',
  timed_out: '超时',
  skipped: '跳过',
  action_required: '待处理',
  neutral: '中性',
  stale: '过期',
  startup_failure: '启动失败',
  in_progress: '进行中',
  queued: '排队中',
  requested: '排队中',
  waiting: '等待中',
  pending: '等待中',
}

const DETAIL_LEVELS = ['brief', 'normal', 'detail']

const lines = (text) => String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

/** 每行一个 owner/repo，允许行尾 # 注释。 */
const repoList = (text) => lines(text)
  .map((line) => line.split('#')[0].trim())
  .filter((line) => REPO_RE.test(line))

/** 群展示列表：每行 owner/repo，或 别名=owner/repo。 */
const groupProjects = (text) => lines(text).map((line) => {
  const raw = line.split('#')[0].trim().replace('＝', '=')
  const cut = raw.indexOf('=')
  const alias = cut > 0 ? raw.slice(0, cut).trim() : ''
  const repo = (cut > 0 ? raw.slice(cut + 1) : raw).trim()
  if (!REPO_RE.test(repo)) return null
  return { alias: (alias || repo.split('/')[1] || repo).toLowerCase(), repo }
}).filter(Boolean)

const shortSha = (sha) => String(sha || '').slice(0, 7)
const oneLine = (text, max = 60) => {
  const line = String(text || '').split(/\r?\n/)[0].trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function timeText(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function agoText(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return timeText(iso)
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

const ciWord = (run) => {
  if (!run) return '无记录'
  const key = run.conclusion || run.status
  return CI_WORD[key] || key || '未知'
}

export default {
  id: 'github-assistant',
  name: 'GitHub 助手',
  version: '1.0.0',
  api: 1,
  description: '私聊盯 CI 失败、待审 PR 和被 @；群聊 #项目 看仓库状态，显示细项可调',
  settings: [
    { key: 'token', label: 'GitHub Token（填一次即可）', type: 'password', hint: '填完重载模块，会自动移到数据目录并清空这一栏，不留在配置里。也可直接设环境变量 GITHUB_TOKEN。私有仓库用 fine-grained token，只给 Contents: Read' },
    { key: 'repos', label: '私聊盯的仓库', type: 'textarea', placeholder: 'owner/repo\n每行一个，最多 10 个', hint: 'CI 失败、等你审的 PR、@ 你的 issue 会私聊提醒你' },
    { key: 'groupRepos', label: '群里能查的仓库', type: 'textarea', placeholder: 'aurabot=dsh-aurabot-qq-mods/aureth-labs\n或直接写 owner/repo', hint: '留空 = 群里不给查。等号前面是别名，群里发「#项目 别名」' },
    { key: 'pollMinutes', label: '检查间隔（分钟）', type: 'number', min: 1, max: 60, step: 1, hint: '改完要重载模块才生效' },
    { key: 'notifyCi', label: 'CI 失败提醒', type: 'switch' },
    { key: 'notifyReview', label: 'PR 待审提醒', type: 'switch', hint: '只提醒点名要你审的' },
    { key: 'notifyMention', label: '@ 提醒', type: 'switch', hint: 'issue / PR 里出现 @你' },
    { key: 'quietStart', label: '免打扰开始（点）', type: 'number', min: 0, max: 23, step: 1, hint: '和结束时间相同 = 不启用免打扰' },
    { key: 'quietEnd', label: '免打扰结束（点）', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'groupDetail', label: '群状态详细程度', type: 'select', options: [
      { value: 'brief', label: '简略：CI + 更新时间' },
      { value: 'normal', label: '一般：加最新提交、PR/Issue 数' },
      { value: 'detail', label: '详细：加最近 PR、发布版本、最近 CI' },
    ] },
    { key: 'groupCooldown', label: '群查询冷却（秒）', type: 'number', min: 0, max: 300, step: 5 },
  ],

  setup(api) {
    const settings = () => ({ ...DEFAULTS, ...(api.settings() || {}) })

    // 把默认值写进配置，设置页才会显示默认值而不是空着。
    try {
      const cur = api.settings() || {}
      if (Object.keys(DEFAULTS).some((key) => cur[key] === undefined)) {
        api.saveSettings({ ...DEFAULTS, ...cur })
        api.log.info('GitHub 助手：已把默认参数写入配置')
      }
    } catch (error) { api.log.warn(`GitHub 助手：写默认参数失败：${error.message}`) }

    const tokenFile = () => api.dataDir('token')

    /** Token 读取顺序：环境变量 GITHUB_TOKEN → 数据目录里的 token 文件。设置页只当一次性入口。 */
    function readToken() {
      const fromEnv = String(process.env.GITHUB_TOKEN || '').trim()
      if (fromEnv) return fromEnv
      try { return readFileSync(tokenFile(), 'utf8').trim() } catch (error) { return '' }
    }

    // 设置页填的 token 在加载时移到数据目录（0600）并清空，避免长期留在 config.json。
    try {
      const legacy = String((api.settings() || {}).token || '').trim()
      if (legacy) {
        writeFileSync(tokenFile(), legacy, { mode: 0o600 })
        try { chmodSync(tokenFile(), 0o600) } catch (error) { /* Windows 上不生效 */ }
        api.saveSettings({ token: '' })
        api.log.info('GitHub 助手：Token 已移到数据目录，设置页里那一栏已清空')
      }
    } catch (error) { api.log.warn(`GitHub 助手：迁移 Token 失败：${error.message}`) }

    const stateFile = () => api.dataDir('state.json')
    const loadState = () => {
      try {
        const raw = JSON.parse(readFileSync(stateFile(), 'utf8'))
        if (raw && typeof raw === 'object' && raw.repos && typeof raw.repos === 'object') return raw
      } catch (error) { /* 第一次运行或文件损坏，从空状态开始 */ }
      return { repos: {} }
    }
    const saveState = () => {
      try { writeFileSync(stateFile(), JSON.stringify(state)) } catch (error) {
        api.log.warn(`GitHub 助手：保存状态失败：${error.message}`)
      }
    }

    let state = loadState()
    let login = ''
    let polling = false
    const cooldownUntil = new Map()

    /** 调 GitHub REST。404 不当异常，交给调用方说人话。 */
    async function gh(path) {
      const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aurabot-github-assistant',
      }
      const token = readToken()
      if (token) headers.Authorization = `Bearer ${token}`
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 12_000)
      try {
        const res = await fetch(`${API}${path}`, { headers, signal: ctl.signal })
        if (res.status === 404) return { ok: false, status: 404 }
        if (!res.ok) {
          let message = ''
          try { message = String((await res.json()).message || '') } catch (error) { /* 响应可能不是 JSON */ }
          return { ok: false, status: res.status, message }
        }
        return { ok: true, status: res.status, data: await res.json() }
      } catch (error) {
        return { ok: false, status: 0, message: error.name === 'AbortError' ? '请求超时' : error.message }
      } finally { clearTimeout(timer) }
    }

    async function myLogin() {
      if (login) return login
      const res = await gh('/user')
      if (res.ok && res.data?.login) login = String(res.data.login)
      return login
    }

    const seen = (bucket, id) => {
      const list = Array.isArray(bucket) ? bucket : []
      return list.includes(id)
    }
    const remember = (bucket, id) => {
      const list = Array.isArray(bucket) ? bucket.slice(-MAX_SEEN + 1) : []
      if (!list.includes(id)) list.push(id)
      return list
    }

    function isQuiet(cfg) {
      const start = Number(cfg.quietStart)
      const end = Number(cfg.quietEnd)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false
      const hour = new Date().getHours()
      return start < end ? hour >= start && hour < end : hour >= start || hour < end
    }

    function sendOwner(text) {
      const owner = String(api.config().ownerQQ || '')
      if (!owner) { api.log.warn('GitHub 助手：配置里没有 ownerQQ，提醒发不出去'); return Promise.resolve() }
      if (api.config().dryRun) { api.log.info(`GitHub 助手：试运行，未发送：${text.split('\n')[0]}`); return Promise.resolve() }
      return api.send(`private:${owner}`, text)
    }

    /** 一轮巡检：把新出现的 CI 失败 / 待审 PR / @ 汇总成一条私聊。 */
    async function poll() {
      if (polling) return
      const cfg = settings()
      const repos = repoList(cfg.repos).slice(0, MAX_REPOS)
      if (!repos.length) return
      if (!cfg.notifyCi && !cfg.notifyReview && !cfg.notifyMention) return
      if (isQuiet(cfg)) return
      polling = true
      const items = []
      try {
        const me = (cfg.notifyReview || cfg.notifyMention) ? await myLogin() : ''
        for (const repo of repos) {
          const bucket = (state.repos[repo] ||= { seeded: false, ci: [], prs: [], mentions: [] })
          const firstRun = !bucket.seeded

          if (cfg.notifyCi) {
            const res = await gh(`/repos/${repo}/actions/runs?per_page=10`)
            const runs = res.ok && Array.isArray(res.data?.workflow_runs) ? res.data.workflow_runs : []
            for (const run of runs) {
              const id = String(run.id)
              if (seen(bucket.ci, id)) continue
              if (!firstRun && BAD_RUNS.has(String(run.conclusion || ''))) {
                items.push(`[CI 失败] ${repo} · ${oneLine(run.name, 30)} #${run.run_number}（${run.head_branch || '?'}）${agoText(run.created_at)}\n${run.html_url}`)
              }
              bucket.ci = remember(bucket.ci, id)
            }
          }

          if (cfg.notifyReview && me) {
            const res = await gh(`/repos/${repo}/pulls?state=open&per_page=50`)
            const pulls = res.ok && Array.isArray(res.data) ? res.data : []
            for (const pull of pulls) {
              const id = String(pull.id)
              if (seen(bucket.prs, id)) continue
              const asked = (pull.requested_reviewers || []).some((user) => String(user.login || '').toLowerCase() === me.toLowerCase())
              if (!firstRun && asked) {
                items.push(`[等你审] ${repo} #${pull.number} ${oneLine(pull.title, 40)}（@${pull.user?.login || '?'}）\n${pull.html_url}`)
              }
              bucket.prs = remember(bucket.prs, id)
            }
          }

          if (cfg.notifyMention && me) {
            const query = encodeURIComponent(`mentions:${me} repo:${repo} is:open`)
            const res = await gh(`/search/issues?q=${query}&sort=updated&order=desc&per_page=10`)
            const found = res.ok && Array.isArray(res.data?.items) ? res.data.items : []
            for (const item of found) {
              const id = String(item.id)
              if (seen(bucket.mentions, id)) continue
              if (!firstRun) {
                items.push(`[@ 你] ${repo} ${item.pull_request ? 'PR' : 'Issue'} #${item.number} ${oneLine(item.title, 40)}（@${item.user?.login || '?'}）\n${item.html_url}`)
              }
              bucket.mentions = remember(bucket.mentions, id)
            }
          }

          bucket.seeded = true
          state = { ...state, repos: { ...state.repos, [repo]: bucket } }
          saveState()
        }

        if (items.length) {
          const head = items.length === 1 ? 'GitHub 有新动静：' : `GitHub 有新动静（${items.length} 条）：`
          await sendOwner([head, ...items.map((line) => `· ${line}`)].join('\n'))
        }
      } catch (error) {
        api.log.warn(`GitHub 助手：巡检出错：${error.message}`)
      } finally {
        polling = false
      }
    }

    /** 拼一个仓库的状态卡片，detail 控制显示多少。 */
    async function statusText(repo, detail) {
      const level = DETAIL_LEVELS.includes(detail) ? detail : 'normal'
      const info = await gh(`/repos/${repo}`)
      if (!info.ok) {
        if (info.status === 404) return `查不到 ${repo}：仓库不存在，或 token 没有它的权限。`
        if (info.status === 403) return `GitHub 拒绝了请求（404/403 常见于 token 权限不够或限频）。稍后再试。`
        return `查 ${repo} 失败：${info.message || `HTTP ${info.status}`}`
      }
      const data = info.data || {}
      const branch = String(data.default_branch || 'main')
      const [commitRes, runsRes, pullsRes, releaseRes] = await Promise.all([
        gh(`/repos/${repo}/commits/${encodeURIComponent(branch)}`),
        gh(`/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=3`),
        level === 'brief' ? Promise.resolve({ ok: true, data: [] }) : gh(`/repos/${repo}/pulls?state=open&per_page=100`),
        level === 'detail' ? gh(`/repos/${repo}/releases/latest`) : Promise.resolve({ ok: false, data: null }),
      ])

      const runs = runsRes.ok && Array.isArray(runsRes.data?.workflow_runs) ? runsRes.data.workflow_runs : []
      const pulls = pullsRes.ok && Array.isArray(pullsRes.data) ? pullsRes.data : []
      const out = [`${data.full_name || repo}${data.private ? '（私有）' : ''}`]
      if (data.description) out.push(oneLine(data.description, 80))

      out.push(`CI: ${ciWord(runs[0])}（${branch}）`)
      if (level === 'detail' && runs.length) {
        out.push(`最近 CI: ${runs.map((run) => `${ciWord(run)} ${oneLine(run.name, 16)} ${agoText(run.created_at)}`).join(' · ')}`)
      }

      const commit = commitRes.ok ? commitRes.data : null
      if (level !== 'brief' && commit) {
        const message = oneLine(commit.commit?.message, 50)
        const author = commit.author?.login || commit.commit?.author?.name || '?'
        out.push(`最新提交: ${shortSha(commit.sha)} ${message}（${author}，${agoText(commit.commit?.author?.date)}）`)
      }

      if (level !== 'brief') {
        const openIssues = Math.max(0, Number(data.open_issues_count || 0) - pulls.length)
        out.push(`开放: PR ${pulls.length} · Issue ${openIssues} · Star ${data.stargazers_count || 0}`)
      }

      if (level === 'detail' && pulls.length) {
        out.push('待合并 PR:')
        for (const pull of pulls.slice(0, 3)) out.push(`· #${pull.number} ${oneLine(pull.title, 40)}（@${pull.user?.login || '?'}）`)
      }
      if (level === 'detail' && releaseRes.ok && releaseRes.data?.tag_name) {
        out.push(`最新发布: ${releaseRes.data.tag_name}`)
      }

      if (data.pushed_at) out.push(`更新: ${agoText(data.pushed_at)}`)
      return out.join('\n')
    }

    // ---------- 定时巡检 ----------
    const pollMinutes = Math.min(60, Math.max(1, Number(settings().pollMinutes) || DEFAULTS.pollMinutes))
    api.every(pollMinutes * 60_000, () => poll().catch((error) => api.log.warn(`GitHub 助手：定时巡检出错：${error.message}`)), 'GitHub 助手巡检')

    // ---------- 指令：#项目 ----------
    api.on('message', async (msg) => {
      if (!msg || msg.kind === 'system') return false
      const matched = String(msg.text || '').trim().match(CMD_RE)
      if (!matched) return false

      const cfg = settings()
      const inGroup = msg.kind === 'group'
      const arg = String(matched[1] || '').trim()

      if (inGroup) {
        const gid = String(msg.groupId || '')
        const groups = (api.config().allow?.groups || []).map(String)
        if (!groups.includes(gid)) {
          await api.reply(msg, '这个群不在白名单里，查不了项目状态。')
          return true
        }
        const waitMs = Math.max(0, Number(cfg.groupCooldown) || 0) * 1000
        const until = cooldownUntil.get(gid) || 0
        if (Date.now() < until) return true
        cooldownUntil.set(gid, Date.now() + waitMs)
      } else if (!api.isOwner(msg.userId)) {
        await api.reply(msg, '只有主人能查项目状态。')
        return true
      }

      const projects = inGroup
        ? groupProjects(cfg.groupRepos)
        : repoList(cfg.repos).map((repo) => ({ alias: repo.split('/')[1].toLowerCase(), repo }))

      if (!projects.length) {
        await api.reply(msg, inGroup ? '主人还没在「GitHub 助手」里配置群里能查的仓库。' : '还没配置要盯的仓库，去设置里填 owner/repo。')
        return true
      }

      let picked = null
      if (!arg) {
        if (projects.length === 1) picked = projects[0]
        else {
          await api.reply(msg, `想查哪个？\n${projects.map((p) => `· ${p.alias} → ${p.repo}`).join('\n')}\n发「#项目 别名」就行。`)
          return true
        }
      } else {
        const key = arg.toLowerCase()
        picked = projects.find((p) => p.alias === key)
          || projects.find((p) => p.repo.toLowerCase() === key)
          || projects.find((p) => p.repo.toLowerCase().endsWith(`/${key}`))
        if (!picked) {
          await api.reply(msg, `没有「${arg}」这个项目。能查的：${projects.map((p) => p.alias).join('、')}`)
          return true
        }
      }

      try {
        await api.reply(msg, await statusText(picked.repo, cfg.groupDetail))
      } catch (error) {
        api.log.warn(`GitHub 助手：查询 ${picked.repo} 出错：${error.message}`)
        await api.reply(msg, `查询 ${picked.repo} 出错：${error.message}`)
      }
      return true
    })

    return { poll }
  },
}
