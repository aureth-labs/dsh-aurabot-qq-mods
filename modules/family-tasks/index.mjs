/**
 * 家人代办（family-tasks）
 *
 * 把家人私聊里托付的活收进流水库，能自己办的办了发回，办不了的叫醒主人。
 * 原来靠 Python 看守常驻扫 chatlog，现在直接用插件的 activity 钩子接消息，
 * 不用再挂脚本和计划任务。
 *
 * 只用两版纯净插件都有的接口（API_VERSION=1）：
 *   activity / send / sendFile / onebot / ask / every / dataDir / settings
 * 正式版 1.2.0+ 与测试版 1.3.0-rc.1 都验证过。
 *
 *  数据全在自己机器上，不联网、不外传。
 */

import { join } from 'node:path'
import { openStore } from './lib/store.mjs'
import { classify, isTask } from './lib/classify.mjs'
import { tryHandle } from './lib/executor.mjs'

const ID = 'family-tasks'

export default {
  id: ID,
  name: '家人代办',
  version: '0.1.0',
  api: 1,
  description: '在不改变私聊权限的情况下，把设置的家人 QQ 吩咐给大肥鱼的任务转交给主人私聊来做。主人点头后，做完向家人 QQ 反馈结果。',
  panel: 'panel.js',

  defaults: {
    enabled: true,
    autoHandle: true, // 统计类的活先自己试，办不成再叫主人
    familyQQ: '', // 一行一个家人 QQ，比如填 12345678 / 87654321
    familyNames: '', // 对应名字，可选
    ownerQQ: '', // 主人 QQ，用来叫醒
    ownerLabel: '主人', // 叫主人什么，可自定义（如 老大 / 主人 / 老板）
    notifyGapSec: 30, // 两次提醒的最小间隔
    maxNotifyPerHour: 6, // 防止刷屏
    tablePath: '', // 供统计的表格路径（xlsx），留空则自己办活不可用
    pythonPath: '', // bundled python 路径，留空自动从 node 安装推导
    debugLog: false,
  },

  setup(api) {
    const st = api.settings() || {}
    let store = null
    let family = new Set()
    let owner = ''
    let lastNotify = 0
    const notifyTimes = []

    function cfg() {
      return api.settings() || {}
    }

    function log(m) {
      if (cfg().debugLog) api.log?.info?.('[family-tasks] ' + m)
    }

    function reloadConfig() {
      const s = cfg()
      family = new Set(
        String(s.familyQQ || '')
          .split(/[\s,，、\n]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      )
      owner = String(s.ownerQQ || '').trim()
      log(
        '配置载入：家人 ' +
          family.size +
          ' 个，主人 ' +
          (owner || '(空)'),
      )
    }

    try {
      const file = join(api.dataDir(), 'tasks.sqlite')
      store = openStore(file)
      log('流水库就绪：' + file)
    } catch (e) {
      api.log?.warn?.('[family-tasks] 流水库开不了：' + e.message)
      return
    }

    reloadConfig()

    /** 叫醒主人：给主人私聊发一条 */
    function notifyOwner(tasks) {
      if (!cfg().enabled) return false
      const s = cfg()
      const gap = (Number(s.notifyGapSec) || 30) * 1000
      const now = Date.now()
      if (now - lastNotify < gap) return false
      // 一小时内的条数上限
      const maxN = Number(s.maxNotifyPerHour) || 6
      while (notifyTimes.length && now - notifyTimes[0] > 3600_000) notifyTimes.shift()
      if (notifyTimes.length >= maxN) {
        log('一小时内提醒够了，这次不吵')
        return false
      }
      if (!owner) {
        log('没填主人 QQ，叫不了')
        return false
      }

      const lines = []
      for (const t of tasks.slice(0, 5)) {
        lines.push('- ' + (t.speaker || '家人') + '：' + String(t.text || '').slice(0, 60))
        lines.push('  流水号 ' + t.id)
      }
      const msg =
        (cfg().ownerLabel || '主人') + '，看守扫到家人托付的活了：\n' +
        lines.join('\n') +
        '\n\n点头我就办，不点头就先搁着。\n' +
        '办的时候按这个走：原件一律不改，只改副本，' +
        '做完发回原号，最后把流水库里这几条标成 done。\n' +
        '只回一句「收到」不算完。'

      Promise.resolve(api.send('private:' + owner, msg))
        .then(() => {
          lastNotify = now
          notifyTimes.push(now)
          log('已叫醒主人')
        })
        .catch((e) => log('叫醒失败：' + e.message))
      return true
    }

    // ── 收消息 ──────────────────────────────────────────────
    const offActivity = api.on('activity', (ev) => {
      try {
        if (!cfg().enabled) return
        if (ev?.kind !== 'in') return // 只看收到的话
        const chatId = String(ev.chatId || '')
        if (!chatId.startsWith('private:')) return
        const uid = String(ev.userId || '')
        // 主人自己的话不算「家人托付的活」——那是正常对话，不是派活
        if (uid && uid === owner) return
        if (!family.has(uid)) return // 只管家人
        const text = String(ev.text || '').trim()
        if (!text) return

        const live = isTask(text)
        // 闲聊连库都不写，省得堆垃圾
        if (!live) return

        const at = Date.now()
        const id = chatId + ':' + at + ':' + uid.slice(-4)
        const speaker = ev.nickname || uid
        const row = { id, chatId, speaker, uid, text, at, kind: '指令' }
        const added = store.add(row)
        if (!added) return
        log('+ ' + speaker + '：' + text.slice(0, 40) + ' [活]')

        // 是活：先试着自己办，办不成再叫醒主人
        if (cfg().autoHandle !== false) {
          Promise.resolve(tryHandle(text, cfg()))
            .then((r) => {
              if (r.ok && r.result) {
                Promise.resolve(api.send(chatId, r.result))
                  .then(() => {
                    store.done(id, r.result)
                    log('自己办了 ' + text.slice(0, 24) + ' → ' + r.result.slice(0, 40))
                  })
                  .catch((e) => {
                    log('发回失败，改叫主人：' + e.message)
                    notifyOwner([row])
                  })
              } else {
                notifyOwner([row])
              }
            })
            .catch(() => notifyOwner([row]))
        } else {
          notifyOwner([row])
        }
      } catch (e) {
        log('收消息出错：' + e.message)
      }
    })

    // ── 面板路由 ─────────────────────────────────────────────
    const offRouteGet =
      api.route &&
      api.route('/get', async () => {
        const s = cfg()
        return {
          ok: true,
          enabled: s.enabled !== false,
          autoHandle: s.autoHandle !== false,
          familyQQ: s.familyQQ || '',
          familyNames: s.familyNames || '',
          ownerQQ: s.ownerQQ || '',
          ownerLabel: s.ownerLabel || '主人',
          notifyGapSec: Number(s.notifyGapSec) || 30,
          maxNotifyPerHour: Number(s.maxNotifyPerHour) || 6,
          tablePath: s.tablePath || '',
          debugLog: !!s.debugLog,
        }
      })

    const offRouteSet =
      api.route &&
      api.route('/set', async (req) => {
        let body = {}
        try {
          body = (await api.core.http.body(req)) || {}
        } catch {
          body = req || {}
        }
        const patch = body.patch || body || {}
        // 只挑认识的配置项，防止乱写
        const allowed = [
          'enabled', 'autoHandle', 'familyQQ', 'familyNames', 'ownerQQ',
          'ownerLabel', 'notifyGapSec', 'maxNotifyPerHour', 'tablePath', 'debugLog',
        ]
        const clean = {}
        for (const k of allowed) if (k in patch) clean[k] = patch[k]
        try {
          api.saveSettings(clean)
          reloadConfig()
          return { ok: true, settings: cfg() }
        } catch (e) {
          return { ok: false, message: e.message }
        }
      })

    const offRoute =
      api.route &&
      api.route('/status', async () => {
        return {
          ok: true,
          enabled: !!cfg().enabled,
          familyCount: family.size,
          owner: owner || '',
          total: store.count(),
          pending: store.pending(50),
        }
      })
    const offRouteReload =
      api.route &&
      api.route('/reload', async () => {
        reloadConfig()
        return { ok: true, familyCount: family.size, owner }
      })


    api.log?.info?.(
      '[family-tasks] 已启动：家人 ' +
        family.size +
        ' 个，主人 ' +
        (owner || '(未填)'),
    )

    return {
      dispose() {
        try {
          offActivity && offActivity()
        } catch {
          /* 忽略 */
        }
        try {
          offRoute && offRoute()
          offRouteReload && offRouteReload()
          offRouteGet && offRouteGet()
          offRouteSet && offRouteSet()
        } catch {
          /* 忽略 */
        }
        try {
          store && store.close()
        } catch {
          /* 忽略 */
        }
        log('已停下')
      },
    }
  },
}
