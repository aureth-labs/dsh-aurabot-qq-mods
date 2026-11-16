import test from 'node:test'
import assert from 'node:assert/strict'
import { checkCommand } from '../lib/commands.mjs'
import { parseDimension } from '../lib/dimension.mjs'

const guestCommands = ['gamemode', 'tp', 'back', 'spawn', 'list', 'time query', 'home']
const blocked = ['stop', 'ban', 'op', 'deop', 'whitelist', 'kick', 'kill @a']
const run = (command, opts = {}) => checkCommand(command, { player: 'Steve', guestCommands, blocked, ...opts })

test('普通玩家只能切旁观/生存，且自动补自己', () => {
  const r = run('gamemode spectator')
  assert.equal(r.ok, true)
  assert.equal(r.command, 'gamemode spectator Steve')
  assert.equal(run('gamemode creative').ok, false)
  assert.equal(run('gamemode survival Alex').ok, false)
})

test('普通玩家 tp 只能传自己，坐标有范围校验', () => {
  const r = run('tp 100 64 200')
  assert.equal(r.ok, true)
  assert.equal(r.command, 'tp Steve 100 64 200')
  assert.equal(run('tp 100 500 200').ok, false)
  assert.equal(run('tp Alex').ok, false)
})

test('back 返回回退标记', () => {
  const r = run('back')
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'back')
  assert.equal(run('back Alex').ok, false)
})

test('禁止名单对管理员也生效', () => {
  assert.equal(run('stop', { admin: true }).ok, false)
  assert.equal(run('gamemode creative', { admin: true }).ok, true)
})

test('维度识别不会把坐标冒号当维度', () => {
  const aliases = ['下界=minecraft:the_nether', '末地=minecraft:the_end']
  assert.equal(parseDimension('15792:69 -12480', aliases), '')
  assert.equal(parseDimension('去下界 100 64 200', aliases), 'minecraft:the_nether')
  assert.equal(parseDimension('minecraft:the_end 1 2 3', aliases), 'minecraft:the_end')
})

test('home 走 execute as，家名是玩家自己时去掉', () => {
  const r = run('home')
  assert.equal(r.ok, true)
  assert.equal(r.command, 'execute as Steve run home')
  assert.equal(r.kind, 'home')
  assert.equal(run('home 二号').command, 'execute as Steve run home 二号')
  assert.equal(run('home Steve').command, 'execute as Steve run home')
  assert.equal(run('home a b').ok, false)
  assert.equal(run('home', { guestCommands: [] }).ok, false)
  assert.equal(run('home', { admin: true }).ok, true)
})

test('xaero 模组维度编码能还原成完整 id', () => {
  assert.equal(
    parseDimension('xaero-waypoint:娜迦庭院:娜:115504:7:-90384:10:false:0:Internal-dim%twilightforest$twilight-forest-waypoints', []),
    'twilightforest:twilight_forest'
  )
})
