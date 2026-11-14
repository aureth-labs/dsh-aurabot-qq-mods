// 听歌报告渲染：严格按官方 me.md 的字段与单位。
// 周报 listenTime 是「日均」，不能写成总量；空版块跳过；不展示内部 ID（只把 ID 放进 H5 链接）。

import { qqH5Url } from './qq-parse.mjs'

function seconds(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** 秒 → 「X 小时 Y 分钟」；不足 1 小时只写分钟。 */
export function durationCn(value) {
  const total = seconds(value)
  if (!total) return '0 分钟'
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  if (!hours) return `${minutes} 分钟`
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

function percent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  const p = Math.round(n * 1000) / 10
  return `${p > 0 ? '+' : ''}${p}%`
}

function text(value, max = 60) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
}

function count(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function listOf(value) {
  return Array.isArray(value) ? value : []
}

function songLine(entry, { unit = '次' } = {}) {
  const name = text(entry?.songName, 60)
  const singer = text(entry?.singerName, 40)
  if (!name && !singer) return ''
  const value = count(entry?.sum)
  const tail = value ? ` · ${value} ${unit}` : ''
  const link = qqH5Url('song', entry?.songMid)
  return `${name || '未知歌曲'}${singer ? ` — ${singer}` : ''}${tail}${link ? `\n     ${link}` : ''}`
}

function singerLine(entry) {
  const name = text(entry?.singerName, 40)
  if (!name) return ''
  const value = seconds(entry?.sum)
  const tail = value ? ` · ${durationCn(value)}` : ''
  const link = qqH5Url('singer', entry?.singerMid)
  return `${name}${tail}${link ? `\n     ${link}` : ''}`
}

function topList(items, render, max = 3) {
  const list = listOf(items).map(render).filter(Boolean).slice(0, max)
  return list
}

/**
 * @param {'day'|'week'|'month'} period
 * @param {{dayData?:object,weekData?:object,monthData?:object}} data
 * @returns {{message:string, sections:number}}
 */
export function renderReport(period, data) {
  const lines = []
  let sections = 0
  const add = (title, items) => {
    const list = items.filter(Boolean)
    if (!list.length) return
    sections += 1
    lines.push(`- ${title}：`)
    list.forEach((line, i) => {
      lines.push(`  ${i + 1}. ${line}`)
    })
  }

  if (period === 'day') {
    const d = data?.dayData || {}
    lines.push('QQ 音乐 · 今日听歌报告')
    const listen = seconds(d.listenTime)
    if (listen) {
      sections += 1
      lines.push(`- 听歌时长：${durationCn(listen)}`)
    }
    const hour = Number(d.activeHour)
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
      sections += 1
      lines.push(`- 活跃时段：${hour} 点`)
    }
    add('Top 歌手（按时长）', topList(d.singerListen, singerLine))
    add('Top 歌曲（按播放次数）', topList(d.songListen, (item) => songLine(item, { unit: '次' })))
  } else if (period === 'week') {
    const w = data?.weekData || {}
    lines.push('QQ 音乐 · 本周听歌报告')
    const listen = seconds(w.listenTime)
    // 官方定义：周报 listenTime 是「日均」听歌时长，不是本周总量
    if (listen) {
      sections += 1
      lines.push(`- 本周日均听歌时长：${durationCn(listen)}`)
    }
    const float = percent(w.floatNumber)
    if (float) {
      sections += 1
      const n = Number(w.floatNumber)
      const how = n > 0 ? '上升' : n < 0 ? '下降' : '持平'
      const amount = `${Math.abs(Math.round(n * 1000) / 10)}%`
      lines.push(`- 与上周相比：${how}${n === 0 ? '' : ` ${amount}`}`)
    }
    add('Top 歌手（按时长）', topList(w.singerListen, singerLine))
    add('Top 歌曲（按播放次数）', topList(w.songListen, (item) => songLine(item, { unit: '次' })))
  } else {
    const m = data?.monthData || {}
    lines.push('QQ 音乐 · 本月听歌报告')
    add('Top 艺人（按时长）', topList(m.topSinger, singerLine))
    add('Top 歌曲（按播放次数）', topList(m.topSong, (item) => songLine(item, { unit: '次' })))

    const preferHour = Number(m.preferHour?.preferHour)
    if (Number.isInteger(preferHour) && preferHour >= 0 && preferHour <= 23) {
      sections += 1
      lines.push(`- 最爱时段：${preferHour} 点`)
    }

    const cons = m.consDays || {}
    const consDays = count(cons.conDays)
    if (consDays || count(cons.topListen)) {
      sections += 1
      const bits = []
      if (consDays) bits.push(`连续听歌 ${consDays} 天`)
      if (count(cons.topListen)) bits.push(`单日最多 ${count(cons.topListen)} 首`)
      const topSinger = text(cons.singerDay?.singerName, 40)
      if (topSinger) bits.push(`最常听 ${topSinger}`)
      lines.push(`- 连续听歌：${bits.join('；')}`)
    }

    const genreNames = listOf(m.topGenre?.genre2Count)
      .map((item) => {
        const name = text(item?.name, 30)
        return name ? `${name}${count(item?.sum) ? ` ${count(item.sum)} 次` : ''}` : ''
      })
      .filter(Boolean)
      .slice(0, 5)
    if (genreNames.length) {
      sections += 1
      lines.push(`- 偏爱流派：${genreNames.join('、')}`)
    }
    add('流派代表歌曲', topList(m.topGenre?.genreSong, (item) => songLine(item)))

    const niche = m.nicheSongs || {}
    if (count(niche.nichePercent) || count(niche.hotPercent)) {
      sections += 1
      lines.push(`- 小众 / 热门：小众 ${count(niche.nichePercent)}% / 热门 ${count(niche.hotPercent)}%`)
    }

    const fresh = m.newSongs || {}
    if (count(fresh.newSongCount) || count(fresh.lastNewSongCount)) {
      sections += 1
      const float = percent(fresh.floatNumber)
      const tail = float ? `（比上月 ${float.startsWith('-') ? '下降' : '上升'} ${float.replace(/[+-]/, '')}）` : ''
      lines.push(`- 尝鲜歌曲：${count(fresh.newSongCount)} 首${tail}`)
    }

    const cities = listOf(m.listenCityInfo)
      .map((city) => text(city?.cityName, 30))
      .filter(Boolean)
    if (cities.length) {
      sections += 1
      const shown = cities.slice(0, 5)
      lines.push(`- 听歌城市：${cities.length} 个（${shown.join('、')}${cities.length > shown.length ? '…' : ''}）`)
    }

    const months = listOf(m.topDataList).slice(0, 2)
    const monthLines = []
    for (const row of months) {
      const bits = []
      const repeat = row?.repeatSong
      if (text(repeat?.songName, 50)) {
        const link = qqH5Url('song', repeat.songMid)
        bits.push(`循环之最 ${text(repeat.songName, 50)}${count(repeat.count) ? `（${count(repeat.count)} 次）` : ''}${link ? `\n      ${link}` : ''}`)
      }
      const midnight = row?.midnightSong
      if (text(midnight?.songName, 50)) {
        const hour = Number(midnight?.hour)
        const link = qqH5Url('song', midnight.songMid)
        bits.push(`深夜单曲 ${text(midnight.songName, 50)}${Number.isInteger(hour) ? `（${hour} 点）` : ''}${link ? `\n      ${link}` : ''}`)
      }
      if (text(row?.favSongName, 50)) bits.push(`最爱歌曲 ${text(row.favSongName, 50)}`)
      if (bits.length) monthLines.push(`${bits.join('；')}`)
    }
    if (monthLines.length) {
      sections += 1
      lines.push('- 月度 Top 板块：')
      monthLines.forEach((line, i) => lines.push(`  ${i + 1}. ${line}`))
    }

    const monthDetail = listOf(m.monthDetailList).slice(-1)[0]
    if (count(monthDetail?.listenCount)) {
      sections += 1
      const when = text(monthDetail?.dataTime, 20)
      lines.push(`- 本月听歌次数：${count(monthDetail.listenCount)} 次${when ? `（${when}）` : ''}`)
    }
  }

  if (!sections) {
    return {
      message: '这次报告回包里没有可展示的版块（可能这个时间段没有听歌数据）。',
      sections: 0,
    }
  }
  lines.push('', '数据来源：QQ 音乐 /me/report；空版块已跳过，列表只显示前几条。')
  return { message: lines.join('\n'), sections }
}
