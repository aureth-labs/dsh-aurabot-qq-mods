// ESC/POS 指令表（Epson 标准 + 常见国产机兼容项）。
// 说明：不同厂商会扩展或改动部分指令，表里覆盖常用标准指令；解码器遇到表外字节
// 会原样列出十六进制并标记「未识别」，不会丢失信息。
//
// params: 定长参数名，每项 1 字节；'...' 表示后面是可变长度数据。
// variable: 需要按指令规则计算长度的（位图、二维码、条码等）。
// enums: 参数取值含义，解码时显示成中文。

export const COMMANDS = [
  // ---------- 系统 ----------
  { hex: '1B 40', mnemonic: 'ESC @', name: '初始化打印机', params: [], category: '系统' },
  { hex: '1B 3F 0A', mnemonic: 'ESC ? LF', name: '取消用户自定义字符', params: [], category: '系统' },
  { hex: '1B 25', mnemonic: 'ESC %', name: '选择用户自定义字符集', params: ['n'], category: '系统', enums: { 0: '取消', 1: '启用' } },
  { hex: '1B 26', mnemonic: 'ESC &', name: '定义用户自定义字符', params: ['y', 'c1', 'c2', '...'], category: '系统', variable: 'userChars' },
  { hex: '1B 3D', mnemonic: 'ESC =', name: '选择外设', params: ['n'], category: '系统', enums: { 0: '打印机', 1: '显示设备' } },
  { hex: '1B 63 33', mnemonic: 'ESC c 3', name: '选择缺纸传感器输出信号', params: ['n'], category: '系统', note: '位掩码' },
  { hex: '1B 63 34', mnemonic: 'ESC c 4', name: '选择缺纸传感器停止打印', params: ['n'], category: '系统', note: '位掩码' },
  { hex: '1B 63 35', mnemonic: 'ESC c 5', name: '启用/禁用面板按键', params: ['n'], category: '系统', enums: { 0: '启用', 1: '禁用' } },
  { hex: '1B 75', mnemonic: 'ESC u', name: '查询外设状态', params: ['n'], category: '系统', enums: { 0: '打印机', 1: '钱箱', 2: '用户自定义' } },
  { hex: '1B 76', mnemonic: 'ESC v', name: '查询打印机状态', params: [], category: '系统' },
  { hex: '10 04', mnemonic: 'DLE EOT', name: '实时状态查询', params: ['n'], category: '系统', enums: { 1: '打印机状态', 2: '脱机状态', 3: '错误状态', 4: '纸张传感器' } },
  { hex: '10 05', mnemonic: 'DLE ENQ', name: '实时请求（恢复错误）', params: ['n'], category: '系统' },
  { hex: '10 14', mnemonic: 'DLE DC4', name: '实时钱箱脉冲', params: ['n', 'm', 't'], category: '系统', enums: { 1: '钱箱 1', 2: '钱箱 2' } },
  { hex: '1D 61', mnemonic: 'GS a', name: '自动状态回传（ASB）', params: ['n'], category: '系统', enums: { 0: '关闭', 1: '开启' } },
  { hex: '1D 72', mnemonic: 'GS r', name: '状态回传', params: ['n'], category: '系统', enums: { 1: '纸张传感器', 2: '钱箱状态' } },

  // ---------- 文本与格式 ----------
  { hex: '09', mnemonic: 'HT', name: '水平制表', params: [], category: '文本' },
  { hex: '0A', mnemonic: 'LF', name: '换行并走纸', params: [], category: '文本' },
  { hex: '0D', mnemonic: 'CR', name: '回车', params: [], category: '文本' },
  { hex: '1B 20', mnemonic: 'ESC SP', name: '字符右间距', params: ['n'], category: '文本', note: '单位 dot' },
  { hex: '1B 21', mnemonic: 'ESC !', name: '打印模式', params: ['n'], category: '文本', note: '位组合：粗体/倍高/倍宽/下划线' },
  { hex: '1B 2D', mnemonic: 'ESC -', name: '下划线', params: ['n'], category: '文本', enums: { 0: '关', 1: '1 点', 2: '2 点' } },
  { hex: '1B 33', mnemonic: 'ESC 3', name: '设置行距', params: ['n'], category: '文本', note: '单位 dot' },
  { hex: '1B 32', mnemonic: 'ESC 2', name: '恢复默认行距', params: [], category: '文本' },
  { hex: '1B 45', mnemonic: 'ESC E', name: '加粗', params: ['n'], category: '文本', enums: { 0: '关', 1: '开' } },
  { hex: '1B 47', mnemonic: 'ESC G', name: '双重打印', params: ['n'], category: '文本', enums: { 0: '关', 1: '开' } },
  { hex: '1B 4A', mnemonic: 'ESC J', name: '走纸（不换行）', params: ['n'], category: '文本', note: '单位 dot' },
  { hex: '1B 4D', mnemonic: 'ESC M', name: '选择字体', params: ['n'], category: '文本', enums: { 0: 'Font A（12×24）', 1: 'Font B（9×17）', 2: 'Font C' } },
  { hex: '1B 56', mnemonic: 'ESC V', name: '90° 旋转', params: ['n'], category: '文本', enums: { 0: '关', 1: '开' } },
  { hex: '1B 61', mnemonic: 'ESC a', name: '对齐', params: ['n'], category: '文本', enums: { 0: '左对齐', 1: '居中', 2: '右对齐' } },
  { hex: '1B 64', mnemonic: 'ESC d', name: '走纸 n 行', params: ['n'], category: '文本' },
  { hex: '1B 74', mnemonic: 'ESC t', name: '选择字符代码页', params: ['n'], category: '文本' },
  { hex: '1B 7B', mnemonic: 'ESC {', name: '倒置打印', params: ['n'], category: '文本', enums: { 0: '关', 1: '开' } },
  { hex: '1D 21', mnemonic: 'GS !', name: '字符大小', params: ['n'], category: '文本', note: '高 4 位倍高，低 4 位倍宽' },
  { hex: '1D 42', mnemonic: 'GS B', name: '反白打印', params: ['n'], category: '文本', enums: { 0: '关', 1: '开' } },
  { hex: '1D 62', mnemonic: 'GS b', name: '平滑打印', params: ['n'], category: '文本', enums: { 0: '关', 1: '开' } },

  // ---------- 位置与页面模式 ----------
  { hex: '1B 24', mnemonic: 'ESC $', name: '绝对水平位置', params: ['nL', 'nH'], category: '位置' },
  { hex: '1B 5C', mnemonic: 'ESC \\', name: '相对水平位置', params: ['nL', 'nH'], category: '位置' },
  { hex: '1B 44', mnemonic: 'ESC D', name: '设置制表位', params: ['...'], category: '位置', variable: 'tabs', note: '以 NUL 结束' },
  { hex: '1B 4C', mnemonic: 'ESC L', name: '进入页模式', params: [], category: '位置' },
  { hex: '1B 53', mnemonic: 'ESC S', name: '进入标准模式', params: [], category: '位置' },
  { hex: '1B 54', mnemonic: 'ESC T', name: '页模式打印方向', params: ['n'], category: '位置', enums: { 0: '左上起', 1: '左下起', 2: '右下起', 3: '右上起' } },
  { hex: '1B 57', mnemonic: 'ESC W', name: '页模式打印区域', params: ['xL', 'xH', 'yL', 'yH', 'dxL', 'dxH', 'dyL', 'dyH'], category: '位置' },

  // ---------- 走纸与切纸 ----------
  { hex: '1D 56 41', mnemonic: 'GS V A', name: '半切并走纸', params: ['n'], category: '切纸' },
  { hex: '1D 56 42', mnemonic: 'GS V B', name: '半切并走纸', params: ['n'], category: '切纸' },
  { hex: '1D 56', mnemonic: 'GS V', name: '切纸', params: ['m'], category: '切纸', enums: { 0: '全切', 1: '半切', 48: '全切', 49: '半切' } },
  { hex: '1B 69', mnemonic: 'ESC i', name: '半切（部分机型）', params: [], category: '切纸' },
  { hex: '1B 6D', mnemonic: 'ESC m', name: '半切（部分机型）', params: [], category: '切纸' },
  { hex: '1B 70', mnemonic: 'ESC p', name: '钱箱脉冲', params: ['m', 't1', 't2'], category: '切纸', enums: { 0: '钱箱 1', 1: '钱箱 2' } },

  // ---------- 位图 / 图形 ----------
  { hex: '1D 76 30', mnemonic: 'GS v 0', name: '打印光栅位图', params: ['m', 'xL', 'xH', 'yL', 'yH', '...'], category: '图片', variable: 'raster' },
  { hex: '1B 2A', mnemonic: 'ESC *', name: '打印点阵位图', params: ['m', 'nL', 'nH', '...'], category: '图片', variable: 'bitImage' },
  { hex: '1B 4B', mnemonic: 'ESC K', name: '8 点单密度位图', params: ['nL', 'nH', '...'], category: '图片', variable: 'bitImage8' },
  { hex: '1B 59', mnemonic: 'ESC Y', name: '8 点双密度位图', params: ['nL', 'nH', '...'], category: '图片', variable: 'bitImage8' },
  { hex: '1B 5A', mnemonic: 'ESC Z', name: '24 点双密度位图', params: ['nL', 'nH', '...'], category: '图片', variable: 'bitImage24' },
  { hex: '1D 2F', mnemonic: 'GS /', name: '打印 NV 位图', params: ['m'], category: '图片' },
  { hex: '1D 28 4C', mnemonic: 'GS ( L', name: '图形数据（位图/Logo）', params: ['pL', 'pH', 'fn', '...'], category: '图片', variable: 'fnBlock' },
  { hex: '1D 38 4C', mnemonic: 'GS 8 L', name: '图形数据（大块）', params: ['p1', 'p2', 'p3', 'p4', 'fn', '...'], category: '图片', variable: 'gs8l' },
  { hex: '1D 28 45', mnemonic: 'GS ( E', name: '用户设置命令', params: ['pL', 'pH', 'fn', '...'], category: '系统', variable: 'fnBlock' },

  // ---------- 条码 ----------
  { hex: '1D 6B', mnemonic: 'GS k', name: '打印条码', params: ['m', '...'], category: '条码', variable: 'barcode' },
  { hex: '1D 48', mnemonic: 'GS H', name: '条码文字位置', params: ['n'], category: '条码', enums: { 0: '不打印', 1: '条码上方', 2: '条码下方', 3: '上下都打印' } },
  { hex: '1D 66', mnemonic: 'GS f', name: '条码文字字体', params: ['n'], category: '条码', enums: { 0: 'Font A', 1: 'Font B' } },
  { hex: '1D 68', mnemonic: 'GS h', name: '条码高度', params: ['n'], category: '条码', note: '单位 dot' },
  { hex: '1D 77', mnemonic: 'GS w', name: '条码模块宽度', params: ['n'], category: '条码' },

  // ---------- 二维码 ----------
  { hex: '1D 28 6B', mnemonic: 'GS ( k', name: '二维码 / 二维条码', params: ['pL', 'pH', 'cn', 'fn', '...'], category: '二维码', variable: 'qr' },

  // ---------- 中文 ----------
  { hex: '1C 26', mnemonic: 'FS &', name: '进入汉字模式', params: [], category: '中文' },
  { hex: '1C 2E', mnemonic: 'FS .', name: '退出汉字模式', params: [], category: '中文' },
  { hex: '1C 21', mnemonic: 'FS !', name: '汉字字符大小', params: ['n'], category: '中文', note: '位组合：倍宽/倍高/下划线' },
  { hex: '1C 2D', mnemonic: 'FS -', name: '汉字下划线', params: ['n'], category: '中文', enums: { 0: '关', 1: '1 点', 2: '2 点' } },
  { hex: '1C 53', mnemonic: 'FS S', name: '汉字字符间距', params: ['n1', 'n2'], category: '中文', note: '部分机型' },
  { hex: '1C 57', mnemonic: 'FS W', name: '汉字倍宽倍高', params: ['n'], category: '中文', note: '部分机型' },
]

// DLE EOT n 返回 1 字节；每一位的含义按查询类型不同。
export const STATUS_BITS = {
  1: {
    0: '固定位',
    1: '钱箱接口有信号',
    2: '固定位',
    3: '脱机',
    4: '固定位',
    5: '等待恢复联机',
    6: '错误',
    7: '固定位',
  },
  2: {
    3: '机盖打开',
    5: '按键进纸中',
    6: '错误（卡纸等）',
  },
  3: {
    2: '自动切刀错误',
    3: '不可恢复错误',
    5: '可恢复错误',
    6: '缺纸',
  },
  4: {
    2: '纸将尽传感器：有纸',
    3: '纸将尽传感器：将尽',
    5: '缺纸传感器：有纸',
    6: '缺纸传感器：缺纸',
  },
}

export const STATUS_LABELS = {
  1: '打印机状态',
  2: '脱机状态',
  3: '错误状态',
  4: '纸张传感器',
}

// ESC v 返回 1 字节的通用状态位
export const PRINTER_STATUS_BITS = {
  0: '固定位 0',
  1: '固定位 1',
  2: '钱箱接口有信号',
  3: '脱机',
  4: '固定位 0',
  5: '等待恢复联机',
  6: '错误',
  7: '固定位 0',
}

// GS a 自动状态回传（ASB）4 字节
export const ASB_BITS = [
  {
    label: '打印机信息',
    bits: {
      0: '钱箱接口有信号',
      1: '联机',
      2: '固定位 1',
      3: '固定位 1',
      4: '固定位 0',
      5: '固定位 0',
      6: '固定位 0',
      7: '固定位 0',
    },
  },
  {
    label: '脱机原因',
    bits: {
      2: '机盖打开',
      3: '按键进纸中',
      5: '等待恢复联机',
      6: '错误',
    },
  },
  {
    label: '错误原因',
    bits: {
      2: '自动切刀错误',
      3: '不可恢复错误',
      5: '可恢复错误',
      6: '缺纸',
    },
  },
  {
    label: '纸张传感器',
    bits: {
      2: '纸将尽：有纸',
      3: '纸将尽：将尽',
      5: '缺纸传感器：有纸',
      6: '缺纸传感器：缺纸',
    },
  },
]
