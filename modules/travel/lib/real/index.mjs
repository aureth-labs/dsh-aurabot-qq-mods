// 分发包的定位占位模块
// 原 real-loc 定位卡片模块带专有授权文件（license.qfl），不随分发包提供；
// 这里只保留面板需要的 3 个路由，高德/天地图 Key 仍然写进 ext.travel，供行程引擎与出门选址使用。
const tail = (k) => (k ? `…${String(k).slice(-4)}` : '')

export default {
  id: 'travel-real-stub',
  setup(api) {
    const s = () => {
      try { return api.settings() || {} } catch { return {} }
    }
    api.route('/key', (req) => {
      let value = ''
      let clear = false
      let slot = ''
      try {
        const q = api.core.http.query(req)
        value = String(q.value || q.key || '').trim()
        clear = String(q.clear || '') === '1'
        slot = String(q.slot || (String(q.tdt || '') === '1' ? 'tdt' : (String(q.backup || '') === '1' ? 'backup' : 'primary')))
      } catch {}
      if (!['primary', 'backup', 'tdt'].includes(slot)) slot = 'primary'
      const fieldOf = { primary: 'amapKey', backup: 'amapKeyBackup', tdt: 'tdtTk' }[slot]
      if (clear) api.saveSettings({ [fieldOf]: '' })
      else if (value) api.saveSettings({ [fieldOf]: value })
      const cur = s()
      return {
        ok: true,
        hasKey: !!String(cur.amapKey || '').trim(), tail: tail(cur.amapKey),
        hasBackup: !!String(cur.amapKeyBackup || '').trim(), backupTail: tail(cur.amapKeyBackup),
        hasTdt: !!String(cur.tdtTk || '').trim(), tdtTail: tail(cur.tdtTk),
        note: '分发包不含 real-loc 定位卡片模块：Key 只用于行程引擎与出门选址',
      }
    })
    api.route('/here', () => ({ ok: false, message: '分发包不含定位卡片模块；位置请用 travel_where' }))
    api.route('/places', () => ({ ok: true, places: [], note: '分发包不含内置点位' }))
    api.route('/selfcheck', () => ({ ok: false, message: '分发包不含 real-loc 定位卡片模块，无自检项' }))
    api.log.info('定位卡片模块未随分发包提供（仅保留 Key 读写路由）')
  },
}
