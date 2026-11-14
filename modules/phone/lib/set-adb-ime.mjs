// lib/set-adb-ime.mjs —— 把手机的默认输入法设成 ADB Keyboard（或切回原输入法）
//
// 为什么必须这么做：
//   模型打中文是走 ADB Keyboard 的 base64 广播，而 Android 每次 `ime set` 都会重建输入连接，
//   输入框随即失焦，广播于是被静默丢弃（Broadcast completed: result=0 照样返回成功）。
//   同时软键盘弹出/收起会让输入框上下漂移，刚 dump 的坐标下一秒就失效。
//   把 ADB Keyboard 设成**常驻默认输入法**就一劳永逸：它没有软键盘 UI，
//   界面位置永远不顶、也不用来回切换，坐标和焦点都稳。
//
// 用法：
//   node lib/set-adb-ime.mjs            # 切到 ADB Keyboard（模型打字用）
//   node lib/set-adb-ime.mjs restore    # 切回百度输入法（用户自己用手机打字时）
//   node lib/set-adb-ime.mjs status     # 只看当前是哪个

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 本文件在 <modules>/phone/lib/ 下；adb 在 <modules-data>/phone/platform-tools/
// 注意 modules 与 modules-data 是**同级**的两个目录，不是父子关系（上面多爬一层就对了）
const PHONE_DATA = join(HERE, '..', '..', '..', 'modules-data', 'phone')
const ADB = join(PHONE_DATA, 'platform-tools', 'adb.exe')
const ADB_IME = 'com.android.adbkeyboard/.AdbIME'
const DEFAULT_IME = 'com.baidu.input_hihonor/com.baidu.input_honor.ImeService'

if (!existsSync(ADB)) {
  console.error(`找不到 adb：${ADB}`)
  process.exit(1)
}

const sh = (args) => execFileSync(ADB, ['shell', ...args], { encoding: 'utf8' }).trim()
const action = String(process.argv[2] || '').toLowerCase()

if (action === 'status') {
  console.log('当前默认输入法：' + sh(['settings', 'get', 'secure', 'default_input_method']))
  process.exit(0)
}

const want = action === 'restore' ? DEFAULT_IME : ADB_IME
sh(['ime', 'set', want])
console.log('已切换默认输入法：' + want)
console.log('当前：' + sh(['settings', 'get', 'secure', 'default_input_method']))
