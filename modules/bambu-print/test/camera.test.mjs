// test/camera.test.mjs —— 摄像头抓帧（假 Duplex，不连真打印机）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'

import { EventEmitter } from 'node:events'

import {buildAuthPacket, parseFrameHeader, isJpeg, captureFrame, captureMjpegFrame,
  captureRtspsSnapshot, captureByPlan, detectCameraPlan, capturePlan,
  rtspsUrl, rtspsFfmpegArgs, rtspsConcatScript, RTSPS_CONCAT_PROTOCOLS,
  AUTH_PACKET_SIZE, MAX_FRAME_BYTES, RTSPS_PORT, learnCameraCert, learnPeerCert,
  verifyRtspsPeerCert, rtspsPinOf, verifyPinnedCert, fingerprintOfPem,
  rtspsPortOf, attachRtspsCertInfo } from '../lib/camera.mjs'
import { generateSelfSignedCert } from '../lib/tls-cert.mjs'

const SECRET = 'CAM-ACCESS-CODE-SECRET-3377'

/** :322 的假指纹（64 位小写 hex）与另一张证书的指纹，用于 pin 匹配/不匹配 */
const RTSPS_FP = 'aa'.repeat(32)
const OTHER_FP = 'bb'.repeat(32)
const RTSPS_PEM = '-----BEGIN CERTIFICATE-----\nMIIB-rtsps-322\n-----END CERTIFICATE-----\n'

/**
 * 假 learn（注入给 captureRtspsSnapshot / verifyRtspsPeerCert）：返回一张固定的证书。
 * 记录调用参数，用来断言「先握手核对、后 spawn」以及端口是不是 322。
 */
function fakeLearn({ ok = true, fingerprint256 = RTSPS_FP, pem = RTSPS_PEM, code = null, error = null, throws = null } = {}) {
  const calls = []
  function learn(opts) {
    calls.push(opts)
    if (throws) return Promise.reject(throws)
    if (!ok) return Promise.resolve({ ok: false, code: code || 'TLS_NO_CERT', error: error || '取不到证书' })
    return Promise.resolve({ ok: true, fingerprint256, pem, subject: 'CN=printer', notAfter: Date.now() + 86400000 })
  }
  learn.calls = calls
  return learn
}

/** 摄像头端口固定的 CA 锚点（内容无关：注入 connect 时只用它来通过「必须已固定」的闸门） */
const CAM_CA = '-----BEGIN CERTIFICATE-----\nMIIB-test-anchor\n-----END CERTIFICATE-----\n'

const JPEG_BODY = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  Buffer.alloc(200, 0x11),
  Buffer.from([0xff, 0xd9]),
])

/** 16 字节帧头：前 3 字节 LE = 长度，其余补 0 */
function frameHeader(len) {
  const head = Buffer.alloc(16)
  head[0] = len & 0xff
  head[1] = (len >> 8) & 0xff
  head[2] = (len >> 16) & 0xff
  return head
}

function fakeCameraSocket(onAuth) {
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      socket.written.push(Buffer.from(chunk))
      if (socket.written.length === 1 && onAuth) onAuth(socket)
      cb()
    },
  })
  socket.written = []
  socket.pushBack = (buf) => socket.push(Buffer.from(buf))
  return socket
}

describe('buildAuthPacket', () => {
  test('正好 80 字节且头部字段正确', () => {
    const buf = buildAuthPacket('bblp', SECRET)
    assert.equal(buf.length, AUTH_PACKET_SIZE)
    assert.equal(buf.length, 80)
    assert.equal(buf.readUInt32LE(0), 0x40)
    assert.equal(buf.readUInt32LE(4), 0x3000)
    assert.equal(buf.readUInt32LE(8), 0)
    assert.equal(buf.readUInt32LE(12), 0)
    assert.equal(buf.subarray(16, 20).toString(), 'bblp')
    assert.equal(buf.subarray(48, 48 + SECRET.length).toString(), SECRET)
  })

  test('用户名/访问码 32 字节补 0，且不越界', () => {
    const longUser = 'u'.repeat(40)
    const longCode = 'c'.repeat(40)
    const buf = buildAuthPacket(longUser, longCode)
    assert.equal(buf.length, 80)
    assert.equal(buf.subarray(16, 48).toString(), 'u'.repeat(32))
    assert.equal(buf.subarray(48, 80).toString(), 'c'.repeat(32))

    const short = buildAuthPacket('bblp', '1234')
    assert.equal(short[52], 0, '短码后面全 0')
    assert.equal(short.readUInt8(79), 0)
  })

  test('缺省用户名/访问码不抛错', () => {
    const buf = buildAuthPacket(undefined, undefined)
    assert.equal(buf.length, 80)
    assert.equal(buf.readUInt32LE(0), 0x40)
  })
})

describe('帧头与 JPEG 校验', () => {
  test('前 3 字节小端', () => {
    assert.equal(parseFrameHeader(frameHeader(0x010203)), 0x010203)
    assert.equal(parseFrameHeader(frameHeader(0)), 0)
    assert.equal(parseFrameHeader(Buffer.alloc(8)), null, '不足 16 字节返回 null')
  })

  test('isJpeg', () => {
    assert.equal(isJpeg(JPEG_BODY), true)
    assert.equal(isJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00])), false, '结尾不对')
    assert.equal(isJpeg(Buffer.from([0x00, 0x01, 0x02, 0x03])), false)
    assert.equal(isJpeg(Buffer.alloc(2)), false)
    assert.equal(isJpeg(null), false)
  })
})

describe('captureFrame', () => {
  test('成功抓一帧（有锚点，发 80 字节认证包）', async () => {
    const socket = fakeCameraSocket((s) => {
      s.pushBack(frameHeader(JPEG_BODY.length))
      s.pushBack(JPEG_BODY)
    })
    const jpeg = await captureFrame({ host: '192.0.2.50', accessCode: SECRET, username: 'bblp', ca: CAM_CA, connect: () => socket })
    assert.deepEqual(jpeg, JPEG_BODY)
    assert.equal(socket.written.length, 1)
    assert.equal(socket.written[0].length, 80)
    assert.equal(socket.written[0].readUInt32LE(0), 0x40)
    assert.equal(socket.destroyed, true, '完成后应销毁 socket')
  })

  test('分片到达（头部与 payload 切开）', async () => {
    const socket = fakeCameraSocket((s) => {
      const full = Buffer.concat([frameHeader(JPEG_BODY.length), JPEG_BODY])
      s.pushBack(full.subarray(0, 5))
      setTimeout(() => s.pushBack(full.subarray(5, 17)), 5)
      setTimeout(() => s.pushBack(full.subarray(17)), 10)
    })
    const jpeg = await captureFrame({ host: 'h', accessCode: SECRET, ca: [CAM_CA], connect: () => socket })
    assert.deepEqual(jpeg, JPEG_BODY)
  })

  test('多个数据帧时取第一帧', async () => {
    const socket = fakeCameraSocket((s) => {
      s.pushBack(Buffer.concat([frameHeader(JPEG_BODY.length), JPEG_BODY]))
      s.pushBack(Buffer.concat([frameHeader(JPEG_BODY.length), JPEG_BODY]))
    })
    const jpeg = await captureFrame({ host: 'h', accessCode: SECRET, ca: [CAM_CA], connect: () => socket })
    assert.equal(jpeg.length, JPEG_BODY.length)
  })

  test('超时中止', async () => {
    const socket = fakeCameraSocket(null)
    await assert.rejects(
      () => captureFrame({ host: 'h', accessCode: SECRET, ca: [CAM_CA], timeoutMs: 50, connect: () => socket }),
      (err) => {
        assert.equal(err.code, 'TIMEOUT')
        assert.ok(!err.message.includes(SECRET))
        return true
      },
    )
    assert.equal(socket.destroyed, true)
  })

  test('单帧超过 8MB 拒绝', async () => {
    const socket = fakeCameraSocket((s) => s.pushBack(frameHeader(MAX_FRAME_BYTES + 1)))
    await assert.rejects(
      () => captureFrame({ host: 'h', accessCode: SECRET, ca: [CAM_CA], connect: () => socket }),
      (err) => {
        assert.equal(err.code, 'FRAME_TOO_LARGE')
        assert.ok(!err.message.includes(SECRET))
        return true
      },
    )
  })

  test('非 JPEG 内容拒绝', async () => {
    const notJpeg = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x03]), Buffer.alloc(50), Buffer.from([0xff, 0xd9])])
    const socket = fakeCameraSocket((s) => {
      s.pushBack(frameHeader(notJpeg.length))
      s.pushBack(notJpeg)
    })
    await assert.rejects(
      () => captureFrame({ host: 'h', accessCode: SECRET, ca: [CAM_CA], connect: () => socket }),
      (err) => err.code === 'BAD_JPEG',
    )
  })

  test('无效帧长度拒绝', async () => {
    const socket = fakeCameraSocket((s) => s.pushBack(Buffer.alloc(16)))
    await assert.rejects(
      () => captureFrame({ host: 'h', accessCode: SECRET, ca: [CAM_CA], connect: () => socket }),
      (err) => err.code === 'BAD_FRAME_HEADER',
    )
  })

  test('连接提前关闭报错', async () => {
    const socket = fakeCameraSocket((s) => setTimeout(() => s.emit('close'), 5))
    await assert.rejects(
      () => captureFrame({ host: 'h', accessCode: SECRET, ca: [CAM_CA], connect: () => socket }),
      (err) => err.code === 'CAMERA_CLOSED',
    )
  })

  test('socket 错误不泄漏访问码', async () => {
    const socket = fakeCameraSocket((s) => setTimeout(() => s.emit('error', new Error('ECONNRESET ' + SECRET)), 5))
    await assert.rejects(
      () => captureFrame({ host: 'h', accessCode: SECRET, ca: [CAM_CA], connect: () => socket }),
      (err) => !err.message.includes(SECRET),
    )
  })

  test('缺主机/访问码直接报错', async () => {
    await assert.rejects(() => captureFrame({ accessCode: SECRET, ca: [CAM_CA] }), (err) => err.code === 'BAD_INPUT')
    await assert.rejects(() => captureFrame({ host: 'h', ca: [CAM_CA] }), (err) => {
      assert.equal(err.code, 'NO_SECRET')
      return true
    })
  })
})

describe('P1-4：无锚点必须 fail-closed', () => {
  test('无 ca 时直接 CAMERA_UNPINNED，且完全不建连接', async () => {
    let connectCalls = 0
    const socket = fakeCameraSocket((s) => {
      s.pushBack(frameHeader(JPEG_BODY.length))
      s.pushBack(JPEG_BODY)
    })
    await assert.rejects(
      () => captureMjpegFrame({
        host: 'h',
        accessCode: SECRET,
        connect: () => {
          connectCalls++
          return socket
        },
      }),
      (err) => {
        assert.equal(err.code, 'CAMERA_UNPINNED')
        assert.equal(err.message, '摄像头证书没固定，为安全起见不会发送访问码')
        assert.ok(!err.message.includes(SECRET), '错误文本不得含访问码')
        return true
      },
    )
    assert.equal(connectCalls, 0, '没有锚点时不允许建立连接')
    assert.equal(socket.written.length, 0, '更不能发 80 字节认证包')
  })

  test('空 ca 数组 / 空字符串同样拒绝（不是「传了 ca 就算固定」）', async () => {
    let connectCalls = 0
    const connect = () => {
      connectCalls++
      return fakeCameraSocket(null)
    }
    await assert.rejects(
      () => captureMjpegFrame({ host: 'h', accessCode: SECRET, ca: [], connect }),
      (err) => err.code === 'CAMERA_UNPINNED',
    )
    await assert.rejects(
      () => captureMjpegFrame({ host: 'h', accessCode: SECRET, ca: '', connect }),
      (err) => err.code === 'CAMERA_UNPINNED',
    )
    assert.equal(connectCalls, 0)
  })

  test('captureFrame（无 model）同样拒绝；未知型号也不会回退到 RTSPS', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    let connectCalls = 0
    await assert.rejects(
      () => captureFrame({ host: 'h', accessCode: SECRET, connect: () => { connectCalls++; return fakeCameraSocket(null) } }),
      (err) => err.code === 'CAMERA_UNPINNED',
    )
    assert.equal(connectCalls, 0)

    await assert.rejects(
      () => captureFrame({ host: 'h', accessCode: SECRET, model: 'Mystery', spawn: spawnImpl }),
      (err) => err.code === 'CAMERA_UNPINNED',
    )
    assert.equal(spawnImpl.calls.length, 0, '证书没固定时不能改用 RTSPS 再送一次访问码')
    assert.equal(connectCalls, 0)
  })

  test('allowUnpinnedForTest 是显式的测试口子（默认关闭）', async () => {
    const socket = fakeCameraSocket((s) => {
      s.pushBack(frameHeader(JPEG_BODY.length))
      s.pushBack(JPEG_BODY)
    })
    const jpeg = await captureMjpegFrame({ host: 'h', accessCode: SECRET, allowUnpinnedForTest: true, connect: () => socket })
    assert.deepEqual(jpeg, JPEG_BODY)
    assert.equal(socket.written[0].length, 80)
  })
})

describe('detectCameraPlan', () => {
  test('MJPEG 型号', () => {
    for (const model of ['A1', 'a1', 'A1 mini', 'A1-Mini', 'P1P', 'p1s', 'Bambu Lab A1']) {
      assert.equal(detectCameraPlan(model), 'mjpeg', model)
    }
  })

  test('RTSPS 型号', () => {
    for (const model of ['X1', 'X1C', 'X1 Carbon', 'X1E', 'H2', 'H2D', 'P2S', 'X2D', 'x1-carbon']) {
      assert.equal(detectCameraPlan(model), 'rtsps', model)
    }
  })

  test('未知型号与空值', () => {
    assert.equal(detectCameraPlan(''), 'unknown')
    assert.equal(detectCameraPlan(undefined), 'unknown')
    assert.equal(detectCameraPlan(null), 'unknown')
    assert.equal(detectCameraPlan('WeirdModel'), 'unknown')
  })

  test('capturePlan 是别名', () => {
    assert.equal(capturePlan, detectCameraPlan)
    assert.equal(capturePlan('X1C'), 'rtsps')
  })
})

describe('P2-2：RTSPS 凭据不进 argv', () => {
  test('URL 形状', () => {
    assert.equal(rtspsUrl({ host: '192.0.2.9', accessCode: '12345678' }), 'rtsps://bblp:12345678@192.0.2.9:322/streaming/live/1')
  })

  test('访问码特殊字符做百分号编码', () => {
    const url = rtspsUrl({ host: 'h', accessCode: 'p@ss:w/rd' })
    assert.ok(!url.includes('p@ss:w/rd'))
    assert.equal(url, 'rtsps://bblp:p%40ss%3Aw%2Frd@h:322/streaming/live/1')
  })

  test('ffmpeg 参数只取一帧 mjpeg，且 argv 里没有访问码', () => {
    const args = rtspsFfmpegArgs({ host: 'h', accessCode: SECRET })
    assert.ok(args.includes('-frames:v'))
    assert.equal(args[args.indexOf('-frames:v') + 1], '1')
    assert.equal(args[args.indexOf('-f') + 1], 'concat')
    assert.equal(args[args.indexOf('-vcodec') + 1], 'mjpeg')
    assert.equal(args[args.indexOf('-i') + 1], 'pipe:0')
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], RTSPS_CONCAT_PROTOCOLS)
    assert.ok(!JSON.stringify(args).includes(SECRET), 'argv 不得包含访问码')
    assert.ok(!JSON.stringify(args).includes('rtsps://'), 'argv 不得包含带凭据的 URL')
  })

  test('concat 脚本包含 URL 与 tcp 选项，且单引号被正确转义', () => {
    const script = rtspsConcatScript({ host: 'h', accessCode: "co'de" })
    assert.ok(script.includes('option rtsp_transport tcp'), '脚本里要把内层 rtsp 设成 tcp')
    // encodeURIComponent 不转义单引号，所以这里必须由 concat 的引号转义兜住
    assert.equal(script.split('\n')[0], "file 'rtsps://bblp:co'\\''de@h:322/streaming/live/1'")
    assert.equal(script.split('\n').filter(Boolean).length, 2)
    // concat 的字符串转义规则只有一个：单引号写成 '\''
    const quoted = rtspsConcatScript({ host: "h'x", accessCode: 'x' })
    assert.equal(quoted.split('\n')[0], "file 'rtsps://bblp:x@h'\\''x:322/streaming/live/1'")
  })
})

/** 假 spawn：可脚本化输出 stdout / stderr / 退出码；记录 argv 与 stdin 收到的脚本 */
function fakeSpawn({ stdout = Buffer.alloc(0), stderr = '', code = 0, throwError = null, emitError = null, hang = false } = {}) {
  const calls = []
  function spawnImpl(bin, args, options) {
    const record = { bin, args, options, child: null }
    calls.push(record)
    if (throwError) throw throwError
    const child = new EventEmitter()
    child.killed = false
    child.kill = (sig) => { child.killed = true; child.killedWith = sig; return true }
    const out = new EventEmitter()
    const err = new EventEmitter()
    const stdin = new EventEmitter()
    stdin.written = []
    stdin.end = (chunk) => {
      if (chunk != null) stdin.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      stdin.ended = true
      return stdin
    }
    child.stdout = out
    child.stderr = err
    child.stdin = stdin
    child.writtenStdin = () => Buffer.concat(stdin.written).toString('utf8')
    record.child = child
    if (emitError) {
      setImmediate(() => child.emit('error', emitError))
      return child
    }
    if (hang) return child
    setImmediate(() => {
      if (stderr) err.emit('data', Buffer.from(stderr))
      if (stdout.length) out.emit('data', stdout)
      child.emit('close', code)
    })
    return child
  }
  spawnImpl.calls = calls
  return spawnImpl
}

/** :322 已 pin 的调用参数（假 learn 回一张固定证书，指纹与 pin 一致） */
function pinnedRtsps(extra = {}) {
  return { fingerprint: RTSPS_FP, learn: fakeLearn(), ...extra }
}

describe('captureRtspsSnapshot', () => {
  test('用注入 spawn 截一帧，访问码只走 stdin', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const shot = await captureRtspsSnapshot({ host: '192.0.2.9', accessCode: SECRET, spawn: spawnImpl, ...pinnedRtsps() })
    assert.deepEqual(shot.jpeg, JPEG_BODY)
    const call = spawnImpl.calls[0]
    assert.equal(call.bin, 'ffmpeg')
    assert.ok(!JSON.stringify(call.args).includes(SECRET), 'argv 不得包含访问码')
    assert.ok(!call.args.some((a) => String(a).startsWith('rtsps://')), 'argv 不得包含带凭据的 URL')
    assert.equal(call.args[call.args.indexOf('-i') + 1], 'pipe:0')
    assert.equal(call.options.stdio[0], 'pipe', 'stdin 必须是管道')
    const script = call.child.writtenStdin()
    assert.match(script, /^file 'rtsps:\/\/bblp:/, 'stdin 里才是带凭据的 URL')
    assert.ok(script.includes(SECRET))
  })

  test('ffmpeg 不存在（ENOENT）给出清晰中文错误', async () => {
    const err = new Error('spawn ffmpeg ENOENT')
    err.code = 'ENOENT'
    const spawnImpl = fakeSpawn({ emitError: err })
    await assert.rejects(
      () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: spawnImpl, ...pinnedRtsps() }),
      (e) => {
        assert.equal(e.code, 'NO_FFMPEG')
        assert.match(e.message, /ffmpeg/)
        assert.match(e.message, /X1 系列需要本机 ffmpeg/)
        assert.ok(!e.message.includes(SECRET), '错误里不得出现访问码')
        return true
      },
    )
  })

  test('spawn 同步抛 ENOENT 也报 NO_FFMPEG', async () => {
    const err = new Error('ENOENT')
    err.code = 'ENOENT'
    await assert.rejects(
      () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: fakeSpawn({ throwError: err }), ...pinnedRtsps() }),
      (e) => e.code === 'NO_FFMPEG' && !e.message.includes(SECRET),
    )
  })

  test('非零退出码带清洗后的 stderr', async () => {
    const spawnImpl = fakeSpawn({ code: 1, stderr: 'Connection refused for ' + SECRET })
    await assert.rejects(
      () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: spawnImpl, ...pinnedRtsps() }),
      (e) => {
        assert.equal(e.code, 'FFMPEG_FAILED')
        assert.match(e.message, /退出码 1/)
        assert.ok(!e.message.includes(SECRET), 'stderr 里的访问码必须被清洗')
        assert.match(e.message, /••••/)
        return true
      },
    )
  })

  test('空输出与非 JPEG 输出', async () => {
    await assert.rejects(
      () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: fakeSpawn({ stdout: Buffer.alloc(0) }), ...pinnedRtsps() }),
      (e) => e.code === 'EMPTY_FRAME',
    )
    await assert.rejects(
      () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: fakeSpawn({ stdout: Buffer.from('not jpeg') }), ...pinnedRtsps() }),
      (e) => e.code === 'BAD_JPEG',
    )
  })

  test('超过 8MB 拒绝并 kill', async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(MAX_FRAME_BYTES)])
    const spawnImpl = fakeSpawn({ stdout: big })
    await assert.rejects(
      () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: spawnImpl, ...pinnedRtsps() }),
      (e) => e.code === 'FRAME_TOO_LARGE' && !e.message.includes(SECRET),
    )
  })

  test('超时中止并 kill', async () => {
    const spawnImpl = fakeSpawn({ hang: true })
    await assert.rejects(
      () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, timeoutMs: 40, spawn: spawnImpl, ...pinnedRtsps() }),
      (e) => e.code === 'TIMEOUT' && !e.message.includes(SECRET),
    )
  })

  test('缺 host/accessCode', async () => {
    await assert.rejects(() => captureRtspsSnapshot({ accessCode: SECRET, spawn: fakeSpawn() }), (e) => e.code === 'BAD_INPUT')
    await assert.rejects(() => captureRtspsSnapshot({ host: 'h', spawn: fakeSpawn() }), (e) => e.code === 'NO_SECRET')
  })

  test('自定义 ffmpegPath 传入 spawn', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    await captureRtspsSnapshot({ host: 'h', accessCode: SECRET, ffmpegPath: '/opt/bin/ffmpeg', spawn: spawnImpl, ...pinnedRtsps() })
    assert.equal(spawnImpl.calls[0].bin, '/opt/bin/ffmpeg')
  })
})

describe('captureFrame 按 model 自动选路', () => {
  test('X1 型号走 RTSPS（注入 spawn），argv 不带访问码', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const jpeg = await captureFrame({ host: 'h', accessCode: SECRET, model: 'X1 Carbon', spawn: spawnImpl, ...pinnedRtsps() })
    assert.deepEqual(jpeg, JPEG_BODY)
    assert.equal(spawnImpl.calls.length, 1)
    assert.ok(!JSON.stringify(spawnImpl.calls[0].args).includes(SECRET))
  })

  test('A1 型号走 MJPEG（注入 connect + 锚点）', async () => {
    const socket = fakeCameraSocket((s) => {
      s.pushBack(frameHeader(JPEG_BODY.length))
      s.pushBack(JPEG_BODY)
    })
    const jpeg = await captureFrame({ host: 'h', accessCode: SECRET, model: 'A1 mini', ca: [CAM_CA], connect: () => socket })
    assert.deepEqual(jpeg, JPEG_BODY)
    assert.equal(socket.written[0].length, 80, '应发 80 字节认证包')
  })

  test('无 model 保持 MJPEG 行为（需锚点）', async () => {
    const socket = fakeCameraSocket((s) => {
      s.pushBack(frameHeader(JPEG_BODY.length))
      s.pushBack(JPEG_BODY)
    })
    const jpeg = await captureFrame({ host: 'h', accessCode: SECRET, ca: [CAM_CA], connect: () => socket })
    assert.deepEqual(jpeg, JPEG_BODY)
  })

  test('未知型号 MJPEG 失败后回落 RTSPS', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const socket = fakeCameraSocket((s) => s.emit('close'))
    const jpeg = await captureFrame({ host: 'h', accessCode: SECRET, model: 'Mystery', ca: [CAM_CA], connect: () => socket, spawn: spawnImpl, fingerprint: RTSPS_FP, learn: fakeLearn() })
    assert.deepEqual(jpeg, JPEG_BODY)
    assert.equal(spawnImpl.calls.length, 1)
  })

  test('未知型号两条都失败时报 CAMERA_UNSUPPORTED 且不含秘密', async () => {
    const err = new Error('ENOENT')
    err.code = 'ENOENT'
    const socket = fakeCameraSocket((s) => s.emit('close'))
    await assert.rejects(
      () => captureFrame({ host: 'h', accessCode: SECRET, model: 'Mystery', ca: [CAM_CA], connect: () => socket, spawn: fakeSpawn({ emitError: err }), fingerprint: RTSPS_FP, learn: fakeLearn() }),
      (e) => {
        assert.equal(e.code, 'CAMERA_UNSUPPORTED')
        assert.ok(!e.message.includes(SECRET))
        return true
      },
    )
  })
})

describe('captureByPlan', () => {
  test('返回用了哪条路径', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const rtsps = await captureByPlan({ host: 'h', accessCode: SECRET, model: 'P2S', spawn: spawnImpl, ...pinnedRtsps() })
    assert.equal(rtsps.plan, 'rtsps')
    assert.deepEqual(rtsps.jpeg, JPEG_BODY)

    const socket = fakeCameraSocket((s) => {
      s.pushBack(frameHeader(JPEG_BODY.length))
      s.pushBack(JPEG_BODY)
    })
    const mjpeg = await captureByPlan({ host: 'h', accessCode: SECRET, model: 'P1S', ca: [CAM_CA], connect: () => socket })
    assert.equal(mjpeg.plan, 'mjpeg')
    assert.deepEqual(mjpeg.jpeg, JPEG_BODY)
  })

  test('未知型号无锚点：直接 CAMERA_UNPINNED，不回退', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    await assert.rejects(
      () => captureByPlan({ host: 'h', accessCode: SECRET, model: 'Mystery', spawn: spawnImpl }),
      (e) => e.code === 'CAMERA_UNPINNED',
    )
    assert.equal(spawnImpl.calls.length, 0)
  })
})

test('learnCameraCert：拿到证书就返回，拿不到给明确错误码', async () => {
  const { Duplex } = await import('node:stream')
  const make = (cert) => {
    const socket = new Duplex({ read() {}, write(c, e, cb) { cb() } })
    socket.getPeerCertificate = () => cert
    setImmediate(() => socket.emit('secureConnect'))
    return socket
  }
  const ok = await learnCameraCert({ host: '192.168.1.50', connect: () => make({ raw: Buffer.from([0x30, 0x00]), fingerprint256: 'AB:CD', subject: { CN: 'cam' } }) })
  assert.equal(ok.ok, true)
  assert.equal(ok.fingerprint256, 'abcd')

  const missing = await learnCameraCert({ host: '192.168.1.50', connect: () => make(null) })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'TLS_NO_CERT')

  const boom = await learnCameraCert({ host: '192.168.1.50', connect: () => { throw new Error('连不上') } })
  assert.equal(boom.ok, false)
  assert.match(String(boom.error), /连不上/)
})

test('camera：学习阶段用 learnOnly 连接，不校验也不发访问码', async () => {
  const seen = []
  const connect = (opts) => {
    seen.push(opts)
    const socket = new Duplex({ read() {}, write (c, e, cb) { cb() } })
    setImmediate(() => socket.emit('secureConnect'))
    socket.getPeerCertificate = () => ({ raw: Buffer.from([0x30, 0x00]), fingerprint256: 'EE:FF' })
    return socket
  }
  const learned = await learnCameraCert({ host: '192.168.1.50', port: 6000, timeoutMs: 200, connect })
  assert.equal(learned.ok, true, 'learnOnly 不因为没有锚点而被 fail-closed 拦住')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].rejectUnauthorized, false, '学习阶段不校验')
  assert.equal(seen[0].learnOnly, true)
})

describe('RTSPS TLS：spawn 前必须核对 :322 对端证书', () => {
  test('指纹不匹配 → RTSPS_CERT_MISMATCH，且 ffmpeg 一次都没启动', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const learn = fakeLearn({ fingerprint256: OTHER_FP })
    await assert.rejects(
      () => captureRtspsSnapshot({ host: '192.0.2.9', accessCode: SECRET, spawn: spawnImpl, fingerprint: RTSPS_FP, learn }),
      (e) => {
        assert.equal(e.code, 'RTSPS_CERT_MISMATCH')
        assert.ok(!e.message.includes(SECRET), '错误文本不得含访问码')
        assert.equal(e.fingerprint256, OTHER_FP, '拒绝时也带实测指纹，方便排查/重新落盘')
        return true
      },
    )
    assert.equal(spawnImpl.calls.length, 0, '关键：指纹不一致时绝不能启动 ffmpeg（否则访问码已经交出去了）')
    assert.equal(learn.calls.length, 1, '做过一次握手核对')
  })

  test('指纹匹配 → 正常 spawn、返回 JPEG 并带实测指纹', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const learn = fakeLearn({ fingerprint256: RTSPS_FP })
    const shot = await captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: spawnImpl, fingerprint: RTSPS_FP, learn })
    assert.deepEqual(shot.jpeg, JPEG_BODY)
    assert.equal(shot.fingerprint256, RTSPS_FP, '返回里带实测指纹，供上层 TOFU 落盘')
    assert.equal(shot.pem, RTSPS_PEM)
    assert.equal(shot.port, RTSPS_PORT)
    assert.equal(shot.verified, true)
    assert.equal(shot.learned, false)
    assert.equal(spawnImpl.calls.length, 1)
    // 仍然保持 P2-2 的保证：argv 干净、凭据只走 stdin
    const call = spawnImpl.calls[0]
    assert.ok(!JSON.stringify(call.args).includes(SECRET))
    assert.ok(!call.args.some((a) => String(a).startsWith('rtsps://')))
    assert.ok(call.child.writtenStdin().includes(SECRET))
  })

  test('先握手核对、后 spawn（顺序断言）', async () => {
    const order = []
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const inner = spawnImpl
    const recordingSpawn = (bin, args, options) => {
      order.push('spawn')
      return inner(bin, args, options)
    }
    const learn = (opts) => {
      order.push('learn')
      assert.equal(opts.port, RTSPS_PORT, '核对的是 :322，不是 :6000')
      return Promise.resolve({ ok: true, fingerprint256: RTSPS_FP, pem: RTSPS_PEM })
    }
    await captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: recordingSpawn, fingerprint: RTSPS_FP, learn })
    assert.deepEqual(order, ['learn', 'spawn'])
  })

  test('未 pin 且未显式放行 → RTSPS_UNPINNED，ffmpeg 0 次，但带回实测指纹供固定', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const learn = fakeLearn({ fingerprint256: OTHER_FP })
    await assert.rejects(
      () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: spawnImpl, learn }),
      (e) => {
        assert.equal(e.code, 'RTSPS_UNPINNED')
        assert.ok(!e.message.includes(SECRET))
        assert.equal(e.fingerprint256, OTHER_FP, '拒绝时带实测指纹，用户确认一次就能 pin')
        return true
      },
    )
    assert.equal(spawnImpl.calls.length, 0)
    assert.equal(learn.calls.length, 1, '只握手取指纹，不发访问码')
  })

  test('allowUnpinnedRtsps 是显式的 TOFU 学习口子（默认关闭）', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const learn = fakeLearn({ fingerprint256: OTHER_FP })
    const shot = await captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: spawnImpl, learn, allowUnpinnedRtsps: true })
    assert.deepEqual(shot.jpeg, JPEG_BODY)
    assert.equal(shot.fingerprint256, OTHER_FP, '学习模式把实测指纹交回上层落盘')
    assert.equal(shot.verified, false)
    assert.equal(shot.learned, true)
    assert.equal(spawnImpl.calls.length, 1)
  })

  test('握手失败（连接失败 / 超时 / 无证书）→ 拒绝且 ffmpeg 0 次', async () => {
    const cases = [
      { learn: fakeLearn({ ok: false, code: 'CONNECT_FAILED', error: 'connect ECONNREFUSED' }), expect: 'CONNECT_FAILED' },
      { learn: fakeLearn({ ok: false, code: 'TIMEOUT', error: '读取证书超时' }), expect: 'TIMEOUT' },
      { learn: fakeLearn({ ok: false, code: 'TLS_NO_CERT', error: '摄像头没有出示 TLS 证书' }), expect: 'RTSPS_CERT_UNVERIFIED' },
      { learn: fakeLearn({ throws: Object.assign(new Error('boom'), { code: 'ECONNRESET' }) }), expect: 'ECONNRESET' },
    ]
    for (const { learn, expect } of cases) {
      const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
      await assert.rejects(
        () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: spawnImpl, fingerprint: RTSPS_FP, learn }),
        (e) => {
          assert.equal(e.code, expect)
          assert.ok(!e.message.includes(SECRET))
          return true
        },
      )
      assert.equal(spawnImpl.calls.length, 0, '握手失败时 ffmpeg 绝不能启动')
    }
  })

  test('真实 learnPeerCert + 注入 connect：:322 取到证书后按端口核对', async () => {
    const { Duplex } = await import('node:stream')
    const seen = []
    const connect = (opts) => {
      seen.push(opts)
      const socket = new Duplex({ read() {}, write(c, e, cb) { cb() } })
      setImmediate(() => socket.emit('secureConnect'))
      socket.getPeerCertificate = () => ({ raw: Buffer.from([0x30, 0x00]), fingerprint256: RTSPS_FP })
      return socket
    }
    const verdict = await verifyRtspsPeerCert({ host: '192.0.2.9', port: RTSPS_PORT, fingerprint: RTSPS_FP, connect })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.verified, true)
    assert.equal(verdict.fingerprint256, RTSPS_FP)
    assert.equal(seen[0].port, 322, '握手用的是 :322')

    // 换成另一张证书就必须拒绝
    const mismatch = await verifyRtspsPeerCert({ host: '192.0.2.9', port: RTSPS_PORT, fingerprint: OTHER_FP, connect })
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.code, 'RTSPS_CERT_MISMATCH')
  })

  test(':6000 的 ca 锚点不会被当成 :322 的 pin（两端口证书不同）', async () => {
    const port6000 = generateSelfSignedCert({ commonName: 'port6000' })
    const actual322 = generateSelfSignedCert({ commonName: 'port322' })
    const learn = fakeLearn({ fingerprint256: fingerprintOfPem(actual322.certPem), pem: actual322.certPem })
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    // 只给了 :6000 的锚点 → 仍然算「:322 没 pin」，默认拒绝而不是误报 mismatch
    await assert.rejects(
      () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: spawnImpl, ca: port6000.certPem, learn }),
      (e) => e.code === 'RTSPS_UNPINNED' && !e.message.includes(SECRET),
    )
    assert.equal(spawnImpl.calls.length, 0)
    assert.equal(learn.calls.length, 1, '握手只为取回实测指纹，不发访问码')

    // 反过来：真把 :6000 的锚点硬当成 rtspsCa 用，会如实报 mismatch（不是静默放行）
    await assert.rejects(
      () => captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: spawnImpl, rtspsCa: port6000.certPem, learn }),
      (e) => e.code === 'RTSPS_CERT_MISMATCH',
    )
    assert.equal(spawnImpl.calls.length, 0)
  })

  test('opts.rtspsCa 也可以用有效 PEM 当 pin（按证书指纹比对）', async () => {
    const cert = generateSelfSignedCert({ commonName: 'rtsps322' })
    const learn = fakeLearn({ fingerprint256: cert.fingerprint256, pem: cert.certPem })
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const shot = await captureRtspsSnapshot({ host: 'h', accessCode: SECRET, spawn: spawnImpl, rtspsCa: [cert.certPem], learn })
    assert.equal(shot.verified, true)
    assert.equal(shot.fingerprint256, cert.fingerprint256)
    assert.equal(spawnImpl.calls.length, 1)
  })
})

describe('RTSPS pin 纯函数', () => {
  test('rtspsPinOf：fingerprint / tlsFingerprint / expectedFingerprint / ca 都认', () => {
    assert.equal(rtspsPinOf({}).pinned, false)
    assert.equal(rtspsPinOf({ ca: [] }).pinned, false)
    assert.equal(rtspsPinOf({ fingerprint: 'AA:BB' }).fingerprint, 'aabb')
    assert.equal(rtspsPinOf({ tlsFingerprint: 'CC:DD' }).fingerprint, 'ccdd')
    assert.equal(rtspsPinOf({ expectedFingerprint: 'EE:FF' }).fingerprint, 'eeff')
    assert.equal(rtspsPinOf({ fingerprint: 'AA:BB', rtspsCa: ['x'] }).viaCa, false, '显式指纹优先')
    assert.equal(rtspsPinOf({ rtspsFingerprint: '11:22' }).fingerprint, '1122')
    assert.equal(rtspsPinOf({ ca: [CAM_CA] }).pinned, false, ':6000 的 ca 不算 :322 的 pin')
    assert.equal(rtspsPinOf({ rtspsCa: [CAM_CA] }).pinned, true, 'rtspsCa 才是 :322 的锚点')
  })

  test('verifyPinnedCert：一致 / 不一致 / 无 pin / 实测为空', () => {
    assert.equal(verifyPinnedCert({ pinned: true, fingerprint: 'aabb' }, { fingerprint256: 'aabb' }).ok, true)
    assert.equal(verifyPinnedCert({ pinned: true, fingerprint: 'aabb' }, { fingerprint256: 'aacc' }).code, 'RTSPS_CERT_MISMATCH')
    assert.equal(verifyPinnedCert({ pinned: false, fingerprint: '' }, { fingerprint256: 'aabb' }).code, 'RTSPS_CERT_UNPINNED')
    assert.equal(verifyPinnedCert({ pinned: true, fingerprint: 'aabb' }, { fingerprint256: '' }).code, 'RTSPS_CERT_UNVERIFIED')
  })

  test('fingerprintOfPem：无效 PEM 返回空串，不抛', () => {
    assert.equal(fingerprintOfPem('not a pem'), '')
    assert.equal(fingerprintOfPem(''), '')
    const cert = generateSelfSignedCert({ commonName: 'x' })
    assert.equal(fingerprintOfPem(cert.certPem), cert.fingerprint256)
  })
})

describe('rtspsPortOf：别把 MJPEG 的 :6000 当成 RTSPS 端口', () => {
  test('默认 322', () => {
    assert.equal(rtspsPortOf({}), RTSPS_PORT)
    assert.equal(RTSPS_PORT, 322)
  })

  test('上层传进来的 :6000 被忽略', () => {
    assert.equal(rtspsPortOf({ port: 6000 }), 322)
    assert.equal(rtspsPortOf({ port: 6000, rtspsPort: 0 }), 322)
    assert.equal(rtspsPortOf({ port: 6000, rtspsPort: -1 }), 322)
    assert.equal(rtspsPortOf({ port: 6000, rtspsPort: null }), 322)
  })

  test('rtspsPort 显式指定优先；非 6000 的 port 也当转发端口用', () => {
    assert.equal(rtspsPortOf({ rtspsPort: 4322 }), 4322)
    assert.equal(rtspsPortOf({ rtspsPort: 4322, port: 6000 }), 4322)
    assert.equal(rtspsPortOf({ port: 4322 }), 4322)
  })

  test('非法端口回落到 322', () => {
    assert.equal(rtspsPortOf({ port: 0 }), 322)
    assert.equal(rtspsPortOf({ port: 'abc' }), 322)
    assert.equal(rtspsPortOf({ port: 70000 }), 322)
    assert.equal(rtspsPortOf({ rtspsPort: 3.5 }), 322)
  })

  test('captureRtspsSnapshot 用 322 的 URL 和 322 的握手（即使 opts.port=6000）', async () => {
    const spawnImpl = fakeSpawn({ stdout: JPEG_BODY })
    const learn = fakeLearn()
    const shot = await captureRtspsSnapshot({ host: 'h', accessCode: SECRET, port: 6000, spawn: spawnImpl, fingerprint: RTSPS_FP, learn })
    assert.equal(learn.calls[0].port, 322, '握手必须打 :322')
    assert.equal(shot.port, 322)
    assert.ok(spawnImpl.calls[0].child.writtenStdin().includes(':322/streaming/live/1'), 'URL 也要是 :322')
  })
})

describe('attachRtspsCertInfo：元数据不破坏 Buffer 语义', () => {
  test('仍是 Buffer，深比较/JSON 不受不可枚举属性影响', () => {
    const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9])
    const stamped = attachRtspsCertInfo(Buffer.from(plain), { fingerprint256: 'AA:BB', pem: 'x', verified: true })
    assert.equal(Buffer.isBuffer(stamped), true)
    assert.deepEqual(stamped, plain, '深比较只看可枚举属性')
    assert.equal(JSON.stringify([stamped]), JSON.stringify([plain]))
    assert.equal(stamped.fingerprint256, 'aabb')
    assert.equal(stamped.verified, true)
    const { jpeg, fingerprint256 } = stamped
    assert.deepEqual(jpeg, plain)
    assert.equal(fingerprint256, 'aabb')
  })
})

describe('learnPeerCert：端口通用', () => {
  test('port=322 的握手按 :322 连，不写死 6000', async () => {
    const { Duplex } = await import('node:stream')
    const seen = []
    const connect = (opts) => {
      seen.push(opts)
      const socket = new Duplex({ read() {}, write(c, e, cb) { cb() } })
      setImmediate(() => socket.emit('secureConnect'))
      socket.getPeerCertificate = () => ({ raw: Buffer.from([0x30, 0x00]), fingerprint256: 'AB:CD' })
      return socket
    }
    const learned = await learnPeerCert({ host: '192.0.2.9', port: 322, timeoutMs: 200, connect })
    assert.equal(learned.ok, true)
    assert.equal(learned.fingerprint256, 'abcd')
    assert.equal(seen[0].port, 322)

    // learnCameraCert 是同一个实现，显式传 322 也一样
    const alias = await learnCameraCert({ host: '192.0.2.9', port: 322, timeoutMs: 200, connect })
    assert.equal(alias.ok, true)
    assert.equal(seen[1].port, 322)
  })

  test('learnPeerCert 不发任何应用数据（只握手取证书）', async () => {
    const { Duplex } = await import('node:stream')
    const socket = new Duplex({ read() {}, write(c, e, cb) { socket.written.push(Buffer.from(c)); cb() } })
    socket.written = []
    socket.getPeerCertificate = () => ({ raw: Buffer.from([0x30, 0x00]), fingerprint256: 'AB:CD' })
    setImmediate(() => socket.emit('secureConnect'))
    await learnPeerCert({ host: 'h', port: 322, timeoutMs: 200, connect: () => socket })
    assert.equal(socket.written.length, 0, '学习阶段不能写任何字节（更没有访问码）')
  })
})

