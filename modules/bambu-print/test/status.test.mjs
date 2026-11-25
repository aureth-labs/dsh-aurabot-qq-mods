// test/status.test.mjs —— 状态归一化与中文格式化（纯函数）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeStatus, formatStatus, formatBrief, formatDuration, formatChoiceList } from '../lib/status.mjs'

const FILE = 'Benchy.3mf'
const PROJECT = 'Benchy'

function runningReport(extra = {}) {
  return {
    print: {
      gcode_state: 'RUNNING',
      mc_percent: '42',
      mc_remaining_time: '98',
      layer_num: '56',
      total_layer_num: '132',
      nozzle_temper: '215.4',
      nozzle_target_temper: '220',
      bed_temper: '60.1',
      bed_target_temper: '60',
      chamber_temper: '32',
      file_name: FILE,
      project_name: PROJECT,
      gcode_file: 'Metadata/plate_1.gcode',
      subtask_name: PROJECT,
      total_weight: '42.5',
      wifi_signal: '-55',
      spd_lvl: '2',
      ...extra,
    },
  }
}

describe('normalizeStatus', () => {
  test('字符串数字转 number', () => {
    const s = normalizeStatus(runningReport())
    assert.equal(s.state, 'RUNNING')
    assert.equal(s.stateText, '打印中')
    assert.equal(s.percent, 42)
    assert.equal(s.remainingMin, 98)
    assert.equal(s.layer, 56)
    assert.equal(s.totalLayers, 132)
    assert.equal(s.nozzle, 215.4)
    assert.equal(s.nozzleTarget, 220)
    assert.equal(s.bed, 60.1)
    assert.equal(s.bedTarget, 60)
    assert.equal(s.chamber, 32)
    assert.equal(s.fileName, FILE)
    assert.equal(s.projectName, PROJECT)
    assert.equal(s.gcodeFile, 'Metadata/plate_1.gcode')
    assert.equal(s.subtask, PROJECT)
    assert.equal(s.weight, 42.5)
    assert.equal(s.wifi, -55)
    assert.equal(s.speedLevel, 2)
  })

  test('空 report 返回 null', () => {
    assert.equal(normalizeStatus(null), null)
    assert.equal(normalizeStatus(undefined), null)
    assert.equal(normalizeStatus({}), null)
    assert.equal(normalizeStatus({ pushed: { version: 1 } }), null)
    assert.equal(normalizeStatus('not json'), null)
    assert.equal(normalizeStatus('{"print":{}}').state, null)
  })

  test('字符串 JSON 也接受', () => {
    const s = normalizeStatus(JSON.stringify(runningReport()))
    assert.equal(s.percent, 42)
  })

  test('缺失字段是 null 不是 0', () => {
    const s = normalizeStatus({ print: { gcode_state: 'IDLE' } })
    assert.equal(s.percent, null)
    assert.equal(s.remainingMin, null)
    assert.equal(s.layer, null)
    assert.equal(s.nozzle, null)
    assert.equal(s.bed, null)
    assert.equal(s.chamber, null)
    assert.equal(s.fileName, null)
    assert.equal(s.wifi, null)
  })

  test('增量合并：缺字段沿用上一次', () => {
    const first = normalizeStatus(runningReport())
    const raw2 = { print: { mc_percent: '55' } }
    const merged = normalizeStatus(raw2, { prev: first })
    assert.equal(merged.percent, 55)
    assert.equal(merged.state, 'RUNNING', '沿用旧 state')
    assert.equal(merged.fileName, FILE, '沿用旧文件名')
    assert.equal(merged.totalLayers, 132)
  })

  test('增量合并：prev 是原始 report', () => {
    const prevRaw = runningReport()
    const merged = normalizeStatus({ print: { layer_num: '60' } }, { prev: prevRaw })
    assert.equal(merged.layer, 60)
    assert.equal(merged.percent, 42)
  })

  test('gcode_start_time 优先算 elapsed', () => {
    const startedSec = 1_700_000_000
    const now = (startedSec + 4320) * 1000
    const s = normalizeStatus(runningReport({ gcode_start_time: String(startedSec) }), { now })
    assert.equal(s.startedAt, startedSec * 1000)
    assert.equal(s.elapsedSec, 4320)
  })

  test('observedStart 次之', () => {
    const now = 2_000_000_000_000
    const s = normalizeStatus(runningReport(), { now, observedStart: now - 600_000 })
    assert.equal(s.elapsedSec, 600)
    assert.equal(s.startedAt, now - 600_000)
  })

  test('observedStart 为 0 / 负数 / NaN 时当作没观测到，不能当 epoch', () => {
    const now = 2_000_000_000_000
    // 复现 review：PAUSE + 无 gcode_start_time + 进度 42% + 剩余 30 分钟
    // 以前 startOf() 返回 0 → 归一化把它当 Unix epoch → 显示约 20770 天
    const paused = (extra) => ({
      print: { gcode_state: 'PAUSE', mc_percent: '42', mc_remaining_time: '30', ...extra },
    })
    for (const bad of [0, -1, Number.NaN]) {
      const s = normalizeStatus(paused(), { now, observedStart: bad })
      assert.notEqual(s.startedAt, 0, 'observedStart=' + bad + ' 不能被当成 epoch')
      assert.ok(s.elapsedSec === null || s.elapsedSec < 86400 * 30, '已打印时长应当合理，实际 ' + s.elapsedSec)
    }
    // 估算仍然生效：42% 已完成、剩 30 分钟 => 已打印约 21.7 分钟
    const estimated = normalizeStatus(paused(), { now, observedStart: 0 })
    assert.ok(estimated.elapsedSec > 0 && estimated.elapsedSec < 3600, '应当按进度估算：' + estimated.elapsedSec)
    // 而合法的正数仍然照用
    const good = normalizeStatus(runningReport(), { now, observedStart: now - 600_000 })
    assert.equal(good.elapsedSec, 600)
  })

  test('无开始时间时按进度估算', () => {
    const now = 2_000_000_000_000
    const s = normalizeStatus({ print: { gcode_state: 'RUNNING', mc_percent: '50', mc_remaining_time: '60' } }, { now })
    // 50% 已完成，剩余 60 分钟 => 已打印 60 分钟
    assert.equal(s.elapsedSec, 3600)
  })

  test('估算只在 0<percent<100 且 remaining>0 时进行', () => {
    const now = 2_000_000_000_000
    const zero = normalizeStatus({ print: { gcode_state: 'RUNNING', mc_percent: '0', mc_remaining_time: '60' } }, { now })
    assert.equal(zero.elapsedSec, null)
    const full = normalizeStatus({ print: { gcode_state: 'RUNNING', mc_percent: '100', mc_remaining_time: '60' } }, { now })
    assert.equal(full.elapsedSec, null)
    const noRemain = normalizeStatus({ print: { gcode_state: 'RUNNING', mc_percent: '50', mc_remaining_time: '0' } }, { now })
    assert.equal(noRemain.elapsedSec, null)
    assert.equal(noRemain.remainingMin, null, '0 分钟剩余视为未知')
  })

  test('gcode_start_time 为 0 时忽略，退回估算', () => {
    const now = 1_000_000_000
    const s = normalizeStatus(runningReport({ gcode_start_time: '0' }), { now })
    // 42% 完成、剩余 98 分钟 => 已打印约 98*42/58 分钟 = 4258 秒
    assert.equal(s.elapsedSec, 4258)
    assert.equal(s.startedAt, now - 4258 * 1000)
  })

  test('gcode_start_time=0 且无进度时不编造 elapsed', () => {
    const s = normalizeStatus({ print: { gcode_state: 'RUNNING', gcode_start_time: '0' } }, { now: 1_000_000 })
    assert.equal(s.elapsedSec, null)
    assert.equal(s.startedAt, null)
  })

  test('hms 与 print_error 转成错误列表', () => {
    const s = normalizeStatus({
      print: {
        gcode_state: 'FAILED',
        print_error: 83951616,
        hms: [{ attr: 1792, code: 32768 }, { attr: 1793, code: 32769 }, { attr: 'x' }],
      },
    })
    assert.equal(s.stateText, '失败')
    assert.ok(s.errors.includes('0700-8000'))
    assert.ok(s.errors.includes('0701-8001'))
    assert.ok(s.errors.includes('0x05010000'), 'print_error 转大写十六进制（8 位补零）')
    assert.equal(s.errors.length, 3)
  })

  test('print_error 0 不算错误', () => {
    const s = normalizeStatus(runningReport({ print_error: '0' }))
    assert.deepEqual(s.errors, [])
  })

  test('AMS 解析（tray 数组）', () => {
    const s = normalizeStatus({
      print: {
        gcode_state: 'RUNNING',
        ams: {
          ams: [
            { id: '0', tray: [
              { id: '0', tray_type: 'PLA', tray_color: 'FF0000FF', remain: '80' },
              { id: '1', tray_type: 'PETG', tray_color: '00FF00FF', remain: '-1' },
            ] },
          ],
        },
      },
    })
    assert.equal(s.ams.length, 2)
    assert.deepEqual(s.ams[0], { id: 0, type: 'PLA', color: '#FF0000FF', remain: 80 })
    assert.equal(s.ams[1].id, 1)
    assert.equal(s.ams[1].type, 'PETG')
    assert.equal(s.ams[1].color, '#00FF00FF')
  })

  test('AMS 无托盘时用单元字段', () => {
    const s = normalizeStatus({ print: { gcode_state: 'IDLE', ams: { ams: [{ id: '0', tray_type: 'PLA', tray_color: '#FF0000', remain: '50' }] } } })
    assert.deepEqual(s.ams, [{ id: 0, type: 'PLA', color: '#FF0000', remain: 50 }])
  })

  test('AMS 颜色非法时为 null', () => {
    const s = normalizeStatus({ print: { gcode_state: 'IDLE', ams: { ams: [{ id: '0', tray_type: 'PLA', tray_color: 'zzz' }] } } })
    assert.equal(s.ams[0].color, null)
  })

  test('percent 夹在 0..100', () => {
    assert.equal(normalizeStatus({ print: { gcode_state: 'RUNNING', mc_percent: '150' } }).percent, 100)
    assert.equal(normalizeStatus({ print: { gcode_state: 'RUNNING', mc_percent: '-5' } }).percent, 0)
  })

  test('chamber_light 布尔', () => {
    assert.equal(normalizeStatus({ print: { gcode_state: 'IDLE', chamber_light: 'on' } }).light, true)
    assert.equal(normalizeStatus({ print: { gcode_state: 'IDLE', chamber_light: 'off' } }).light, false)
    assert.equal(normalizeStatus({ print: { gcode_state: 'IDLE' } }).light, null)
  })

  test('未知 state 原样保留', () => {
    const s = normalizeStatus({ print: { gcode_state: 'WEIRD' } })
    assert.equal(s.state, 'WEIRD')
    assert.equal(s.stateText, 'WEIRD')
  })

  test('全部 state 文案', () => {
    const map = {
      IDLE: '空闲', PREPARE: '准备中', RUNNING: '打印中', PAUSE: '已暂停',
      FINISH: '已完成', FAILED: '失败', SLICING: '切片中',
    }
    for (const [state, text] of Object.entries(map)) {
      assert.equal(normalizeStatus({ print: { gcode_state: state } }).stateText, text)
    }
  })
})

describe('formatDuration', () => {
  test('各量级', () => {
    assert.equal(formatDuration(0), '0 分钟')
    assert.equal(formatDuration(null), '0 分钟')
    assert.equal(formatDuration(-10), '0 分钟')
    assert.equal(formatDuration(30), '0 分钟')
    assert.equal(formatDuration(60), '1 分钟')
    assert.equal(formatDuration(1380), '23 分钟')
    assert.equal(formatDuration(3600), '1 小时')
    assert.equal(formatDuration(7500), '2 小时 5 分钟')
    assert.equal(formatDuration(86400), '1 天')
    assert.equal(formatDuration(97200), '1 天 3 小时')
  })
})

describe('formatStatus', () => {
  const now = new Date(2024, 4, 20, 16, 20, 0).getTime()

  test('完整运行中多行输出', () => {
    const startedAt = now - 4320 * 1000
    const s = normalizeStatus(runningReport({ gcode_start_time: String(Math.floor(startedAt / 1000)) }), { now })
    const text = formatStatus(s, { printerName: 'A1', now })
    const lines = text.split('\n')
    assert.equal(lines[0], '🖨️ A1 · 打印中（42%）')
    assert.equal(lines[1], '第 56/132 层')
    assert.match(text, /已打印 1 小时 12 分钟 · 剩余 1 小时 38 分钟/)
    assert.match(text, /预计 17:58 完成/, 'now + 剩余 98 分钟')
    assert.match(text, /喷嘴 215\/220℃ · 热床 60\/60℃ · 仓温 32℃/)
    assert.match(text, /文件：Benchy\.3mf/)
  })

  test('脱敏时不出现真实文件名/项目名', () => {
    const s = normalizeStatus(runningReport())
    const text = formatStatus(s, { printerName: 'A1', redactName: true, redactProject: true })
    assert.match(text, /文件：已脱敏/)
    assert.ok(!text.includes(FILE), '不得出现真实文件名')
    assert.ok(!text.includes(PROJECT), '不得出现真实项目名')
    assert.ok(!text.includes('plate_1'), '不得出现 gcode 路径')
    assert.match(text, /打印中（42%）/, '进度仍显示')
  })

  test('只 redactProject 也隐藏文件行', () => {
    const s = normalizeStatus(runningReport())
    const text = formatStatus(s, { redactProject: true })
    assert.match(text, /文件：已脱敏/)
    assert.ok(!text.includes(FILE))
  })

  test('stale 时首行加提示', () => {
    const s = normalizeStatus(runningReport())
    const text = formatStatus(s, { printerName: 'A1', stale: true })
    assert.match(text.split('\n')[0], /数据可能过期/)
  })

  test('IDLE 显示空闲与温度，不显示剩余时间', () => {
    const s = normalizeStatus({ print: { gcode_state: 'IDLE', nozzle_temper: '24.5', bed_temper: '23.1' } })
    const text = formatStatus(s, { printerName: 'A1' })
    assert.equal(text.split('\n')[0], '🖨️ A1 · 空闲')
    assert.match(text, /喷嘴 25℃/)
    assert.ok(!text.includes('剩余'))
    assert.ok(!text.includes('预计'))
    assert.ok(!text.includes('%'))
  })

  test('没有进度/时间时不编造', () => {
    const s = normalizeStatus({ print: { gcode_state: 'RUNNING' } })
    const text = formatStatus(s, { printerName: 'A1', now })
    assert.ok(!/\d+%/.test(text), '不应出现进度百分比')
    assert.ok(!text.includes('预计'))
    assert.match(text, /剩余时间未知/)
  })

  test('错误显示 ⚠️ 行', () => {
    const s = normalizeStatus({ print: { gcode_state: 'FAILED', hms: [{ attr: 1792, code: 32768 }] } })
    const text = formatStatus(s, { printerName: 'A1' })
    assert.match(text, /⚠️ 错误：0700-8000/)
  })

  test('空状态不抛错', () => {
    assert.equal(formatStatus(null), '暂无打印机状态')
    assert.equal(formatStatus(undefined), '暂无打印机状态')
  })

  test('脱敏且无文件名时不编造文件行', () => {
    const s = normalizeStatus({ print: { gcode_state: 'RUNNING', mc_percent: '10' } })
    const text = formatStatus(s, { redactName: true })
    assert.ok(!text.includes('文件'), '没有文件就不该出现文件行')
    assert.ok(!text.includes('Benchy'))
    assert.match(text, /打印中/)
  })

  test('群聊脱敏输出不含任何真实名字（全字段审查）', () => {
    const s = normalizeStatus(runningReport({ subtask_name: 'SecretProject', gcode_file: 'Metadata/SecretProject.gcode' }))
    const text = formatStatus(s, { printerName: 'A1', redactName: true, redactProject: true })
    for (const needle of [FILE, PROJECT, 'SecretProject', 'plate_1', 'gcode']) {
      assert.ok(!text.includes(needle), '不得出现 ' + needle)
    }
  })
})

describe('formatBrief', () => {
  test('单行摘要', () => {
    const s = normalizeStatus(runningReport())
    const line = formatBrief(s, { printerName: 'A1' })
    assert.equal(line, '🖨️ A1 · 打印中 · 42% · 剩余 1小时38分钟')
    assert.ok(!line.includes('\n'))
  })

  test('IDLE 不带进度', () => {
    const s = normalizeStatus({ print: { gcode_state: 'IDLE' } })
    assert.equal(formatBrief(s, { printerName: 'A1' }), '🖨️ A1 · 空闲')
  })

  test('错误与 stale 标记', () => {
    const s = normalizeStatus({ print: { gcode_state: 'FAILED', hms: [{ attr: 1, code: 2 }] } })
    const line = formatBrief(s, { printerName: 'A1', stale: true })
    assert.match(line, /有错误/)
    assert.match(line, /数据可能过期/)
  })

  test('空状态不抛错', () => {
    assert.equal(formatBrief(null), '暂无打印机状态')
  })
})

describe('formatChoiceList', () => {
  test('编号列表，序列号打码', () => {
    const text = formatChoiceList([
      { name: 'A1', model: 'A1', serial: '01S00A123456789' },
      { name: 'X1C', model: 'X1 Carbon', serial: '01S00B987654321', label: '公司' },
    ])
    const lines = text.split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^1\. A1/)
    assert.match(lines[1], /^2\. X1C/)
    assert.ok(!text.includes('01S00A123456789'), '不得出现完整序列号')
    assert.match(lines[0], /01S0\*\*\*\*6789/)
    assert.match(lines[1], /绑定：公司/)
  })

  test('空列表与兜底名', () => {
    assert.equal(formatChoiceList([]), '没有可用的打印机。')
    assert.equal(formatChoiceList(null), '没有可用的打印机。')
    const one = formatChoiceList([{ serial: 'SHORT' }])
    assert.match(one, /1\. 未命名打印机/)
  })

  test('短序列号只留前两位', () => {
    const text = formatChoiceList([{ name: 'A', serial: 'ABCD1234' }])
    assert.equal(text, '1. A · 序列号 AB****')
  })
})
