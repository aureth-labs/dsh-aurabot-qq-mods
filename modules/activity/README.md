# 活动记录（activity）

用 PowerShell 子进程调 Win32 取前台窗口标题与空闲秒数，按关键词表归类成「写代码 / 刷视频 / 聊天」等类别，落成 samples.jsonl 供后续统计。关键词表在 assets/activity-keywords.json，可直接改。

## 能力声明

- `filesystem`
- `process`

## 设置

- `intervalMs` 采样间隔（默认 5000ms）
- `dataDir` 快照目录（默认 activity-data）

## 许可

MIT
