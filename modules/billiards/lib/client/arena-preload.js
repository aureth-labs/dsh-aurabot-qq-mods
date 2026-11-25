// 桌面台球（arena）窗口的桥：鼠标命中翻转 + 退出 + 一次性取球面动画地址。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('arenaBridge', {
  // 只有指针落在球桌上时才让窗口吃鼠标，其余地方点穿过去（桌面照常可用）
  setHit: (hit) => ipcRenderer.send('arena:hit', Boolean(hit)),
  exit: () => ipcRenderer.send('arena:exit'),
  ballAnims: () => ipcRenderer.sendSync('billiards:anims') || [],
})
