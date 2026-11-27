// 家人代办流水库：独立建库，不碰外挂的 flow-memory.sqlite。
// 只用 node:sqlite（两版插件的运行环境都有）。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      chatId TEXT,
      speaker TEXT,
      uid TEXT,
      text TEXT,
      at INTEGER,
      kind TEXT,
      status TEXT,
      result TEXT,
      appliedAt INTEGER,
      createdAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chatId, at);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `)

  /** 加入一条待办（重号跳过） */
  function add(row) {
    const now = Date.now()
    db.prepare(
      `INSERT OR IGNORE INTO tasks
       (id, chatId, speaker, uid, text, at, kind, status, createdAt)
       VALUES (?,?,?,?,?,?,?,'pending',?)`,
    ).run(
      String(row.id),
      String(row.chatId || ''),
      String(row.speaker || ''),
      String(row.uid || ''),
      String(row.text || ''),
      Number(row.at || now),
      String(row.kind || '闲聊'),
      now,
    )
    return db.prepare('SELECT changes() AS n').get().n > 0
  }

  /** 我还处理到哪了（按聊天） */
  function cursor(chatId) {
    const r = db.prepare('SELECT MAX(at) AS t FROM tasks WHERE chatId=?').get(String(chatId))
    return Number(r?.t || 0)
  }

  /** 列出待办 */
  function pending(limit = 20) {
    return db
      .prepare("SELECT * FROM tasks WHERE status='pending' ORDER BY at DESC LIMIT ?")
      .all(limit)
  }

  /** 标记完成 */
  function done(id, result) {
    db.prepare("UPDATE tasks SET status='done', result=?, appliedAt=? WHERE id=?").run(
      String(result || ''),
      Date.now(),
      String(id),
    )
  }

  function count() {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n)
  }

  function close() {
    try {
      db.close()
    } catch {
      /* 忽略 */
    }
  }

  return { add, cursor, pending, done, count, close, file }
}
