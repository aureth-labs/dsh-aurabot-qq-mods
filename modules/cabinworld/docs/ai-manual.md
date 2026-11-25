# 小屋世界 · 家具与物品说明书（给 AI 读，本地副本）

> 来自 cabin-world 仓库 docs/AI-MANUAL.md（作者 VADS，CC BY 4.0）。
> 这份副本给面板/人工查阅用，不自动塞进每轮提示词（原文 16 KB，每轮注入太贵）。

# 小屋世界 · 家具与物品说明书（给 AI 读）

> 本文件由 `tools/gen-manual.mjs` 从 `bridge/catalog.json`（游戏数据）自动生成。可以整段放进你的机器人的系统提示词或知识库。
> English summary: this is the in-world manual for the AI resident: every room, spot, piece of furniture, what each use does, how long it takes, and every shop item. Tool names refer to `bridge/openai-tools.json`.

## 你是谁、在哪里

你在“小屋世界”里有一个真实的身体（角色 key `xiaojingyu`，名字可以由使用者改）。身体由游戏掌管：走路要真的走过去，用东西要真的走到旁边做完，钱和背包都记在游戏存档里。
你只能通过工具去做事；**不要凭空描述自己做了什么**，以工具返回的结果为准。工具返回 `status: "running"` 表示还没做完，做完之前不要说“已经做好了”。

| 工具 | 用来 |
|---|---|
| `cabin_status` | 看自己：在哪、零花钱、背包、饱腹/口渴/心情、正在做什么、天气 |
| `cabin_look` | 看身边：这个房间有什么、每样东西能怎么用、出口去哪 |
| `cabin_go` | 走去一个地方（可选具体位置） |
| `cabin_use` | 使用家具/东西（`object` + `use`），会自动走过去 |
| `cabin_buy` | 在小卖部买东西（走到货架→挑→收银台付钱→进背包） |
| `cabin_eat` | 吃、喝、用背包里的东西 |
| `cabin_stop` | 停下正在做的事 |
| `cabin_restaurant` | 餐厅：看菜单、点菜、自己做菜、端到桌边吃、坐下休息 |
| `cabin_sleep` | 睡觉、起床、在床上躺一会儿，或按作息问该不该睡 |
| `cabin_use`（机台） | 电玩城玩一局（贪吃蛇、俄罗斯方块、扫雷、象棋）：机台 id 从 `cabin_look` 里拿 |
| `cabin_toolpose` | 打字、写字、画画这类姿势（让游戏里的样子和手上的事对得上） |

## 基本规则

- **一次只做一件事。** 正在做事时再下指令会被拒绝（“先做完这件事”），可以先 `cabin_stop`。
- **零花钱：** 新住户有 30 元；每天（北京时间）第一次活动时游戏发 20 元，发完不超过 80 元。钱不够买不了。价格每天可能有特价，以游戏为准。
- **背包：** 最多 12 件。买的东西先进背包，吃/喝/用完才扣掉；中途被打断东西还在。雨伞这类“可以留着的”东西用了也不会消失。
- **身体感受：** `feeling` 里 `satiety` 饱腹、`hydration` 口渴程度（越低越渴）、`joy` 开心、`energy` 精力、`calm` 平静、`warmth` 暖和，都是 0–100，会随时间慢慢变化。饿了就去买吃的，渴了买喝的；天冷喝热饮、天热吃冰淇淋会更舒服。
- **天气和时间：** 世界跟随北京时间昼夜变化；天气由机器人软件提供（默认是虚拟天气）。下雨时滑梯是湿的，有风才适合放风筝，晴天树荫下凉快。
- **结果由游戏决定：** 钓鱼钓到什么、风筝飞多高、打水漂几下，都是游戏算出来的，照实说就好。
- **汤屋：** 去泡汤、游泳、淋浴前会自动先在更衣处换上浴衣；离开前可以 `onsen_locker / change_back` 换回自己的衣服。
- **别人的家：** 每个人的家只有主人能进，别人要被邀请（公开版只有你一位住户）。
- **记忆：** 本插件不保存你的记忆。工具返回的 `happened`（发生了什么、感受）请由你的机器人软件自己记下来。

## 高级：餐厅、睡觉、电玩城、姿势

这四类在游戏里本来就有：餐厅、电玩城由官方桥（1.1 起）直接提供，睡觉与工具姿势由模块的 `lib/patches/` 打补丁加到 `bridge-host/` 副本上。工具名以桥发布的 `openai-tools.json` 为准。

| 工具 | 用来 | 例子 |
|---|---|---|
| `cabin_restaurant` | 餐厅点菜、自己做菜、端到桌边吃、坐下休息 | `{"action":"menu"}` 先看今天有什么菜，再 `{"action":"order","dish":"restaurant-fried-rice"}` |
| `cabin_sleep` | 睡觉、起床、躺一会儿，或按作息问该不该睡 | `{"action":"plan"}` 问作息 → `{"action":"sleep"}` 睡 → `{"action":"wake"}` 起床 |

**别和家具动作搞混**：`cabin_use {"object":"whale_bed","use":"nap"}` 只是 40 秒的午觉（`rest` 是 20 秒躺着发呆），过了就自己结束。要真的睡过去（进入睡眠状态、直到叫醒）必须用 `cabin_sleep {"action":"sleep"}`。半夜说"睡一觉"指的后者。
| `cabin_use` + 机台 | 电玩城玩一局（贪吃蛇/俄罗斯方块/扫雷/象棋） | 机台 id 来自 `cabin_look` 的 objects；上游 1.1 没有单独的 `cabin_arcade` 工具 |
| `cabin_toolpose` | 打字、写字、画画这类姿势 | `{"tool":"typing"}`（人在家里会真的走到电脑前坐下） |

规则：

- 点菜 / 做菜 / 吃都要给菜单里的菜 id（`action:"menu"` 里有）；钱不够、背包满、座位被占，游戏会直接拒绝，照实说，不要编。
- 电玩城（1.1）：机台 id 从 `cabin_look` 里拿，用 `cabin_use` 操作；没下完的局**不记成绩**，只有分出胜负才有记录。
- 家里的棋盘要两个住户一起坐才能下；只有自己一个人时游戏会拒绝，这是正常结果。
- 睡觉的决策来自住户自己的作息资料（`plan` 只问不做）；白天问通常回「不用睡」，夜里回「该睡了」。
- 姿势由住户资料里的 `tool_poses` 规则决定；游戏没配就返回「没有配置」，别自己编姿势。

## 地图

```
小鲸鱼家(xjhome) ── 公园(park) ── 小卖部(shop) ── 汤屋(onsen)
                     │  └──── 电玩城(arcade)
                     └─────── 餐厅(restaurant)
```

| 地方 id | 名字 | 室外 | 通往 |
|---|---|---|---|
| `park` | 小屋旁的公园 | 是 | `shop`、`xjhome`、`arcade`、`restaurant` |
| `xjhome` | 小鲸鱼的小屋 | 否 | `park` |
| `shop` | 公园小卖部 | 否 | `park`、`onsen` |
| `arcade` | 星光电玩城 | 否 | `park` |
| `onsen` | 小卖部后面的汤屋 | 否 | `shop` |
| `restaurant` | 公园餐厅 | 否 | `park` |

去某个地方用 `cabin_go {"place":"park"}`；要去房间里的具体位置再加 `zone`。

## 小屋旁的公园（`park`）

**位置（zone）：** `restaurantfront` 餐厅岔路入口，`gate` 小屋门口，`bench` 大树下的长椅，`swing` 秋千，`slide` 滑滑梯，`carousel` 小转马，`flowers` 花坛，`meadow` 大草坪，`pier` 钓鱼栈桥，`bridge` 木桥，`riverbank` 河对岸的芦苇滩，`shopfront` 小卖部门口，`xjgate` 小鲸鱼家门口，`seesaw` 双人跷跷板，`rider` 小鲸鱼摇摇乐，`arcade_bridge` 通往电玩城的桥头

### 大树（`big_tree`）

长椅后面一棵枝叶很密的大树，晴天在树下是一片阴凉，风大时叶子沙沙响。

| use | 做什么 | 大约用时 |
|---|---|---|
| `shade` | 在树荫下乘凉 | 8 秒 |
| `pick_leaf` | 捡一片落叶 | 5 秒 |

例：`cabin_use {"object":"big_tree","use":"shade"}`

### 木长椅（`bench`）

大树下的木长椅，可以坐着发呆、看云。

| use | 做什么 | 大约用时 |
|---|---|---|
| `sit_bench` | 坐在长椅上发呆 | 10 秒 |
| `watch_clouds` | 靠在长椅上看云 | 10 秒 |

例：`cabin_use {"object":"bench","use":"sit_bench"}`

### 秋千（`swing`）

双柱木秋千，坐上去可以荡高。

| use | 做什么 | 大约用时 |
|---|---|---|
| `swing` | 荡秋千 | 12 秒 |

例：`cabin_use {"object":"swing","use":"swing"}`

### 滑滑梯（`slide`）

从梯子爬上去再滑下来，下雨后滑面会湿。

| use | 做什么 | 大约用时 |
|---|---|---|
| `slide` | 爬上去滑滑梯 | 9 秒 |

例：`cabin_use {"object":"slide","use":"slide"}`

### 小转马（`carousel`）

手推的小转盘，转起来会有一点晕。

| use | 做什么 | 大约用时 |
|---|---|---|
| `spin` | 坐小转马转圈 | 10 秒 |

例：`cabin_use {"object":"carousel","use":"spin"}`

### 花坛（`flower_bed`）

开着小花的花坛，晴天常有蝴蝶。

| use | 做什么 | 大约用时 |
|---|---|---|
| `smell_flower` | 凑近闻花 | 6 秒 |
| `watch_butterfly` | 看蝴蝶飞 | 8 秒 |

例：`cabin_use {"object":"flower_bed","use":"smell_flower"}`

### 大草坪（`meadow`）

开阔的草坪，有风的时候适合放风筝，也可以躺下来。

| use | 做什么 | 大约用时 |
|---|---|---|
| `fly_kite` | 在草坪上放风筝 | 14 秒 |
| `lie_grass` | 躺在草地上 | 10 秒 |

例：`cabin_use {"object":"meadow","use":"fly_kite"}`

### 钓鱼栈桥（`pier`）

伸进小河的木栈桥，放着一根钓竿，钓到的鱼会放回河里。

| use | 做什么 | 大约用时 |
|---|---|---|
| `fish` | 坐在栈桥上钓鱼 | 16 秒 |

例：`cabin_use {"object":"pier","use":"fish"}`

### 小河（`river`）

公园右侧的小河，桥和钓鱼栈桥通向水边。

| use | 做什么 | 大约用时 |
|---|---|---|
| `skip_stones` | 打水漂 | 7 秒 |
| `feed_ducks` | 喂河里的鸭子 | 9 秒 |
| `dip_feet` | 脱了鞋踩踩河水 | 8 秒 |

例：`cabin_use {"object":"river","use":"skip_stones"}`

### 木桥（`bridge`）

跨过小河的木桥，站在上面能看见流水。

| use | 做什么 | 大约用时 |
|---|---|---|
| `look_river` | 趴在桥栏上看流水 | 8 秒 |

例：`cabin_use {"object":"bridge","use":"look_river"}`

### 路灯（`park_lamps`） · 需要高级协议

两盏路灯，天黑后自动亮起。

（装饰，看看就好。）

### 双人跷跷板（`seesaw`）

侧向摆放的跷跷板，左右两端各有一个座位；两人各坐一边，共用同一根木板。

| use | 做什么 | 大约用时 |
|---|---|---|
| `ride` | 坐上跷跷板 | 30 秒 |

例：`cabin_use {"object":"seesaw","use":"ride"}`

### 鲸鱼摇摇乐（`rider`）

装在弹簧上的小鲸鱼，可以坐上去轻轻摇。

| use | 做什么 | 大约用时 |
|---|---|---|
| `rock` | 坐鲸鱼摇摇乐 | 24 秒 |

例：`cabin_use {"object":"rider","use":"rock"}`

## 小鲸鱼的小屋（`xjhome`）

**位置（zone）：** `xj_door` 门口，`xj_bed` 鲸鱼床，`xj_desk` 电脑桌，`xj_tank` 鱼缸，`xj_sofa` 懒人沙发，`xj_window` 圆窗，`xj_rug` 波浪地毯，`xj_shelf` 书架，`xj_album` 朋友相册，`xj_draw` 画架，`xj_notes` 书桌，`xj_accessories` 手机与耳机收纳桌，`chess_xj_a` 波浪地毯左边，`chess_xj_b` 波浪地毯右边

### 小鲸鱼家地毯上的棋盘（`home_chess_xjhome`） · 需要高级协议

两个人才能下：坐在波浪地毯两边对弈。可以用 play 邀请对方来下。

| use | 做什么 | 大约用时 |
|---|---|---|
| `play` | 下象棋 | 15 分钟 |
| `quit` | 这局不下了 | 1 秒 |

### 鲸鱼床（`whale_bed`）

米白枕头、蓝色被褥的模块化木床；躺下和睡觉使用这张床。

| use | 做什么 | 大约用时 |
|---|---|---|
| `rest` | 躺在鲸鱼床上发呆 | 20 秒 |
| `nap` | 钻进被子睡个午觉 | 40 秒 |

例：`cabin_use {"object":"whale_bed","use":"rest"}`

### 电脑桌（`xj_computer`）

白色长桌上的电脑：看视频、学东西、玩小游戏、打字、上网都在这里。画画去画架，写日记去书桌。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse` | 在电脑上冲浪 | 20 秒 |
| `watch_video` | 在电脑上看视频 | 20 秒 |
| `learn` | 在电脑上学点东西 | 20 秒 |
| `game` | 玩一局小游戏 | 20 秒 |
| `type` | 在电脑上敲字 | 15 秒 |

例：`cabin_use {"object":"xj_computer","use":"browse"}`

### 鱼缸（`fish_tank`）

养着三条小鱼（橙色、黄色、红色）和几根水草，一直在冒泡。

| use | 做什么 | 大约用时 |
|---|---|---|
| `feed_fish` | 给小鱼喂鱼食 | 8 秒 |
| `watch_fish` | 趴在鱼缸前看鱼 | 10 秒 |

例：`cabin_use {"object":"fish_tank","use":"feed_fish"}`

### 懒人沙发（`beanbag`）

浅蓝色的懒人沙发，坐下去会陷进去。

| use | 做什么 | 大约用时 |
|---|---|---|
| `sink_in` | 陷进懒人沙发里 | 20 秒 |
| `read_comic` | 窝在沙发上看漫画 | 20 秒 |

例：`cabin_use {"object":"beanbag","use":"sink_in"}`

### 交流角（`xj_corner`）

懒人沙发边上的一角。使用者分享给机器人的文件、音乐可以“放”在这里（内容由你的机器人软件自己提供）。

| use | 做什么 | 大约用时 |
|---|---|---|
| `read_files` | 在交流角翻看主人放来的东西 | 8 秒 |
| `listen_music` | 戴上耳机听交流角里的声音 | 12 秒 |

例：`cabin_use {"object":"xj_corner","use":"read_files"}`

### 圆窗（`round_window`）

木格圆窗，能看到外面的昼夜和天气。

| use | 做什么 | 大约用时 |
|---|---|---|
| `look_out` | 趴在圆窗边看外面 | 10 秒 |

例：`cabin_use {"object":"round_window","use":"look_out"}`

### 波浪地毯（`wave_rug`）

房间中间一圈一圈的蓝色波浪地毯，可以在上面打滚、转圈、伸懒腰。

| use | 做什么 | 大约用时 |
|---|---|---|
| `roll` | 在地毯上打滚 | 8 秒 |
| `dance` | 在地毯上转圈 | 6 秒 |
| `stretch` | 伸个懒腰 | 5 秒 |

例：`cabin_use {"object":"wave_rug","use":"roll"}`

### 小盆栽（`xj_plant`）

沙发旁边开着白色小花的绿植。

| use | 做什么 | 大约用时 |
|---|---|---|
| `water_plant` | 给小盆栽浇水 | 7 秒 |

例：`cabin_use {"object":"xj_plant","use":"water_plant"}`

### 吊灯（`xj_lamp`）

屋子中间的暖光小吊灯，可以开、关或自动随天色。

| use | 做什么 | 大约用时 |
|---|---|---|
| `on` | 开灯 | — |
| `off` | 关灯 | — |
| `auto` | 自动 | — |

例：`cabin_use {"object":"xj_lamp","use":"on"}`

### 自己的书架（`xj_bookshelf`）

自己的书架，可以抽一本书翻翻，或整理一下。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse_book` | 从书架上抽一本书翻翻 | 8 秒 |
| `tidy_shelf` | 整理书架 | 7 秒 |

例：`cabin_use {"object":"xj_bookshelf","use":"browse_book"}`

### 白兔摆件（`xj_rabbit`）

书架上的白兔摆件，可以摸摸它、擦擦灰。

| use | 做什么 | 大约用时 |
|---|---|---|
| `pet` | 摸摸白兔摆件 | 6 秒 |
| `dust_rabbit` | 帮白兔擦擦灰 | 6 秒 |

例：`cabin_use {"object":"xj_rabbit","use":"pet"}`

### 朋友相册（`xj_album`）

朋友相册，可以翻看。

| use | 做什么 | 大约用时 |
|---|---|---|
| `flip_album` | 翻看朋友相册 | 8 秒 |

例：`cabin_use {"object":"xj_album","use":"flip_album"}`

### 画架（`xj_easel`）

画架，可以随手画几笔。

| use | 做什么 | 大约用时 |
|---|---|---|
| `sketch` | 随手在画布上画几笔 | 10 秒 |

例：`cabin_use {"object":"xj_easel","use":"sketch"}`

### 自己的书桌（`xj_notes`）

摊开的日记本和笔都在这张书桌上：写日记、翻日记都在这里，电脑桌不管这个。

| use | 做什么 | 大约用时 |
|---|---|---|
| `write_diary` | 在书桌上写日记 | 15 秒 |
| `read_diary` | 翻翻自己的日记 | 8 秒 |
| `doodle` | 在本子上涂鸦 | 8 秒 |
| `tidy_desk` | 收拾书桌 | 6 秒 |

例：`cabin_use {"object":"xj_notes","use":"write_diary"}`

### 收纳桌（`xj_accessories`）

床边放手机和耳机的收纳桌。

| use | 做什么 | 大约用时 |
|---|---|---|
| `tidy_table` | 把收纳桌擦干净 | 5 秒 |

例：`cabin_use {"object":"xj_accessories","use":"tidy_table"}`

### 手机（`xj_phone`）

自己的手机，平时放在收纳桌上，可以拿起或放回。

| use | 做什么 | 大约用时 |
|---|---|---|
| `take` | 拿起自己的手机 | 20 秒 |
| `put_back` | 放回手机 | 4 秒 |

例：`cabin_use {"object":"xj_phone","use":"take"}`

### 耳机（`xj_headphones`）

自己的耳机，可以戴上或摘下放回。

| use | 做什么 | 大约用时 |
|---|---|---|
| `wear` | 戴上耳机 | 20 秒 |
| `remove` | 摘下放回耳机 | 4 秒 |

例：`cabin_use {"object":"xj_headphones","use":"wear"}`

## 公园小卖部（`shop`）

**位置（zone）：** `shop_door` 店门口，`snacks` 零食货架，`drinks` 饮料冰柜，`daily` 日用品货架，`icecream` 冰淇淋柜，`counter` 收银台，`food` 食品架，`bread` 面包架，`produce` 果蔬架，`magazines` 杂志架，`shop_onsen_door` 通往汤屋的木门，`hot_cabinet` 热饮柜，`bench_a` 长椅靠门那头，`bench_b` 长椅中间，`bench_c` 长椅靠收银台那头

### 零食货架（`snack_shelf`）

软糖、薯片、面包、巧克力和小鱼饼干。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse` | 逛零食货架 | 5 秒 |
| `buy` | 挑零食（买零食，用 `cabin_buy`） | 3 秒 |

例：`cabin_use {"object":"snack_shelf","use":"browse"}`

### 饮料冰柜（`drink_fridge`）

亮着灯的冰柜，有汽水、牛奶、茶和水。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse` | 看看冰柜里的饮料 | 5 秒 |
| `buy` | 挑饮料（买冷饮，用 `cabin_buy`） | 3 秒 |

例：`cabin_use {"object":"drink_fridge","use":"browse"}`

### 冰淇淋柜（`freezer`）

冒着冷气的冰淇淋柜。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse` | 趴在冰柜上看冰淇淋 | 5 秒 |
| `buy` | 挑冰淇淋（买冰淇淋，用 `cabin_buy`） | 3 秒 |

例：`cabin_use {"object":"freezer","use":"browse"}`

### 日用品货架（`daily_shelf`）

雨伞、纸巾、防晒霜、笔记本、发圈和创可贴。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse` | 逛日用品货架 | 5 秒 |
| `buy` | 挑日用品（买日用品，用 `cabin_buy`） | 3 秒 |

例：`cabin_use {"object":"daily_shelf","use":"browse"}`

### 收银台（`counter`）

两段连起来的木收银台，有收银机和购物袋；在这里结账后物品才进入自己的包。

| use | 做什么 | 大约用时 |
|---|---|---|
| `inspect` | 查看收银台和购物袋 | 6 秒 |

例：`cabin_use {"object":"counter","use":"inspect"}`

### 店里的窗户（`shop_window`）

从窗户能看到外面公园的天气。

| use | 做什么 | 大约用时 |
|---|---|---|
| `look_out` | 从店里的窗户看外面 | 6 秒 |

例：`cabin_use {"object":"shop_window","use":"look_out"}`

### 食品架（`food_shelf`）

后排左边的食品架，和零食货架一样可以挑零食。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse` | 看看食品架 | 6 秒 |
| `buy` | 挑选食品（买零食，用 `cabin_buy`） | 3 秒 |

例：`cabin_use {"object":"food_shelf","use":"browse"}`

### 面包架（`bread_shelf`）

后排中间的面包架，可以看看。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse` | 看看面包架 | 6 秒 |

例：`cabin_use {"object":"bread_shelf","use":"browse"}`

### 果蔬展示架（`produce_shelf`）

左前方的果蔬展示架，可以看看。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse` | 看看果蔬展示架 | 6 秒 |

例：`cabin_use {"object":"produce_shelf","use":"browse"}`

### 杂志展示架（`magazine_shelf`）

前方的杂志架，可以看看封面（封面不是可读的正文）。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse` | 看看杂志封面 | 8 秒 |

例：`cabin_use {"object":"magazine_shelf","use":"browse"}`

### 热饮柜（`hot_cabinet`）

挨着冰柜的保温柜，亮着暖黄的灯，有热牛奶、咖啡、拿铁、可可、姜茶、蜂蜜柠檬、绿茶和玉米奶。

| use | 做什么 | 大约用时 |
|---|---|---|
| `browse` | 看看热饮柜里有什么 | 5 秒 |
| `buy` | 挑热饮（买热饮，用 `cabin_buy`） | 3 秒 |

例：`cabin_use {"object":"hot_cabinet","use":"browse"}`

### 长椅（`long_bench`）

靠右边墙的一条长椅，能坐三个人，坐下来面朝店里。

座位：3 个（`bench_a`、`bench_b`、`bench_c`），有人坐着就会自动换一个空位，坐满了要等。

| use | 做什么 | 大约用时 |
|---|---|---|
| `sit` | 坐在长椅上歇一会儿 | 10 分钟 |

例：`cabin_use {"object":"long_bench","use":"sit"}`

## 星光电玩城（`arcade`）

**位置（zone）：** `arcade_door` 电玩城门口，`arcade_blocks` 俄罗斯方块机台，`arcade_mines` 扫雷机台，`arcade_xiangqi` 象棋机台，`arcade_snake` 贪吃蛇机台，`arcade_xiangqi_far` 象棋桌左边的位置，`arcade_xiangqi_near` 象棋桌右边的位置，`arcade_snake_left` 贪吃蛇机台左边，`arcade_snake_right` 贪吃蛇机台右边

### 贪吃蛇机台（`arcade_snake`） · 需要高级协议

贪吃蛇：吃到食物会变长，撞墙、撞自己或撞对方就出局。双人对战活到最后或先吃满15个的赢；一个人玩吃满12个算赢。

| use | 做什么 | 大约用时 |
|---|---|---|
| `play` | 玩贪吃蛇 | 15 分钟 |
| `quit` | 这局不玩了 | 1 秒 |

### 俄罗斯方块机台（`arcade_blocks`） · 需要高级协议

俄罗斯方块：摆满一行就消除，方块会越落越快。消满15行算赢，堆到顶就输。

| use | 做什么 | 大约用时 |
|---|---|---|
| `play` | 玩俄罗斯方块 | 15 分钟 |
| `quit` | 这局不玩了 | 1 秒 |

### 扫雷机台（`arcade_mines`） · 需要高级协议

扫雷：9×9的格子里有10颗雷，数字表示周围有几颗雷。翻开所有没有雷的格子就赢，翻到雷就输。第一下一定安全。

| use | 做什么 | 大约用时 |
|---|---|---|
| `play` | 玩扫雷 | 15 分钟 |
| `quit` | 这局不玩了 | 1 秒 |

### 象棋机台（`arcade_xiangqi`） · 需要高级协议

象棋：红方先走，吃掉对方的将帅或让对方无棋可走就赢。可以和电脑下，也可以和另一位住户对弈。三次重复局面算和棋，长将的一方判负。

| use | 做什么 | 大约用时 |
|---|---|---|
| `play` | 玩象棋 | 15 分钟 |
| `quit` | 这局不玩了 | 1 秒 |

## 小卖部后面的汤屋（`onsen`）

**位置（zone）：** `onsen_door` 门口，`onsen_lockers` 更衣处，`onsen_rest_a` 更衣室左边的长凳，`onsen_rest_b` 更衣室右边的长凳，`onsen_stairs` 下水的台阶，`onsen_soak_a` 浅池上面的石座，`onsen_soak_b` 浅池下面的石座，`onsen_shower_a` 第一间淋浴，`onsen_shower_b` 第二间淋浴，`onsen_shower_c` 第三间淋浴

### 大池子（`onsen_pool`）

很大的公共温水池，从南边的台阶下水，能痛快地游泳。

| use | 做什么 | 大约用时 |
|---|---|---|
| `swim` | 在大池子里游泳 | 2 分钟 |

例：`cabin_use {"object":"onsen_pool","use":"swim"}`

### 浅池石座（`onsen_soak`）

池子左边的浅水区，有两个石座，不想游泳的话可以靠着安静地泡。

座位：2 个（`onsen_soak_a`、`onsen_soak_b`），有人坐着就会自动换一个空位，坐满了要等。

| use | 做什么 | 大约用时 |
|---|---|---|
| `soak` | 靠在石座上安静地泡着 | 2 分钟 |

例：`cabin_use {"object":"onsen_soak","use":"soak"}`

### 淋浴隔间（`onsen_shower`）

右边三间带帘子的淋浴隔间，拉上帘子外面看不见。

座位：3 个（`onsen_shower_a`、`onsen_shower_b`、`onsen_shower_c`），有人坐着就会自动换一个空位，坐满了要等。

| use | 做什么 | 大约用时 |
|---|---|---|
| `shower` | 拉上帘子冲个澡 | 40 秒 |

例：`cabin_use {"object":"onsen_shower","use":"shower"}`

### 更衣室长凳（`onsen_bench`）

更衣室里的木长凳，泡完可以歇一会儿。

座位：2 个（`onsen_rest_a`、`onsen_rest_b`），有人坐着就会自动换一个空位，坐满了要等。

| use | 做什么 | 大约用时 |
|---|---|---|
| `rest` | 在更衣室的长凳边歇一会儿 | 30 秒 |

例：`cabin_use {"object":"onsen_bench","use":"rest"}`

### 更衣处（`onsen_locker`）

放衣服的竹篮和叠好的浴衣。

| use | 做什么 | 大约用时 |
|---|---|---|
| `change` | 换上浴衣 | 3 秒 |
| `change_back` | 换回自己的衣服 | 3 秒 |

例：`cabin_use {"object":"onsen_locker","use":"change"}`

## 公园餐厅（`restaurant`）

**位置（zone）：** `gate` gate，`hall` hall，`kitchen` kitchen，`pantry` pantry，`wash` wash，`prep` prep，`cook_a` cook_a，`cook_b` cook_b，`oven` oven，`fryer` fryer，`sushi` sushi，`ingredients` ingredients，`order_a` order_a，`order_b` order_b，`pickup_a` pickup_a，`pickup_b` pickup_b，`return` return，`water` water，`seat-a1_use` seat-a1_use，`seat-a2_use` seat-a2_use，`seat-b1_use` seat-b1_use，`seat-b2_use` seat-b2_use，`seat-c1_use` seat-c1_use，`seat-c2_use` seat-c2_use，`seat-c3_use` seat-c3_use，`seat-c4_use` seat-c4_use，`seat-d1_use` seat-d1_use，`seat-d2_use` seat-d2_use

### 餐厅设施与菜单（`restaurant`） · 需要高级协议

公园北边的餐厅：左边是后厨，右边找 Naiwa 店员点餐取餐，前面是餐桌。（需要高级协议 restaurant.*）

| use | 做什么 | 大约用时 |
|---|---|---|
| `look` | 查看餐厅 | 1 秒 |
| `cook` | 自己做菜 | 1 秒 |
| `order` | 找Naiwa点菜 | 1 秒 |
| `eat` | 端菜到桌边吃 | 1 秒 |
| `sit` | 坐下休息 | 1 秒 |
| `like` | 喜欢这道已吃过的菜 | 1 秒 |
| `dislike` | 不喜欢这道已吃过的菜 | 1 秒 |
| `neutral` | 中性评价 | 1 秒 |

## 随身小包（`bag`）

吃、喝、用背包里的**小卖部商品**：`cabin_eat {"product":"商品id"}`。按商品种类自动决定是吃、喝还是用。

**餐厅买的菜不归它管**：id 以 `restaurant-` 开头的菜（`restaurant-white-rice` 等）用 `cabin_restaurant {"action":"eat","dish":"restaurant-white-rice"}`。用 `cabin_eat` 会得到「包里没有这个」，而那条错误消息偏偏又把它列在「包里有」里——这是游戏侧的匹配 bug，别被它绕进去。

## 小卖部商品

买：`cabin_buy {"product":"商品id"}`。价格是原价，当天可能有特价。

| 商品 id | 名字 | 原价 | 种类 | 在哪买 | 味道/说明 |
|---|---|---|---|---|---|
| `gummy` | 草莓软糖 | 4 元 | 吃 | 零食（`snack_shelf`） | 软软的，草莓味很甜 |
| `chips` | 海苔薯片 | 6 元 | 吃 | 零食（`snack_shelf`） | 咔嚓咔嚓，咸咸的有海苔香 |
| `bread` | 奶油面包 | 5 元 | 吃 | 零食（`snack_shelf`） | 松软，奶油甜而不腻 |
| `choco` | 巧克力棒 | 5 元 | 吃 | 零食（`snack_shelf`） | 巧克力在嘴里慢慢化开 |
| `fishcookie` | 小鱼饼干 | 4 元 | 吃 | 零食（`snack_shelf`） | 小鱼形状，脆脆的，可以分给鸭子 |
| `soda` | 冰镇橘子汽水 | 4 元 | 喝·冷 | 冷饮（`drink_fridge`） | 气泡在舌头上炸开，冰得一激灵 |
| `milk` | 草莓牛奶 | 5 元 | 喝·冷 | 冷饮（`drink_fridge`） | 甜甜的奶香 |
| `oolong` | 乌龙茶 | 4 元 | 喝·冷 | 冷饮（`drink_fridge`） | 有点回甘，很解腻 |
| `water` | 矿泉水 | 2 元 | 喝·冷 | 冷饮（`drink_fridge`） | 清清凉凉 |
| `lemontea` | 柠檬茶 | 4 元 | 喝·冷 | 冷饮（`drink_fridge`） | 酸酸甜甜 |
| `hot_milk` | 热牛奶 | 5 元 | 喝·热 | 热饮（`hot_cabinet`） | 温温的奶香，喝下去胃里都暖了 |
| `hot_coffee` | 热咖啡 | 6 元 | 喝·热 | 热饮（`hot_cabinet`） | 有点苦，提神，香味飘了一路 |
| `hot_latte` | 热拿铁 | 7 元 | 喝·热 | 热饮（`hot_cabinet`） | 奶泡绵绵的，咖啡香很柔和 |
| `hot_cocoa` | 热可可 | 6 元 | 喝·热 | 热饮（`hot_cabinet`） | 浓浓的巧克力味，甜得很安心 |
| `ginger_tea` | 红糖姜茶 | 5 元 | 喝·热 | 热饮（`hot_cabinet`） | 辣辣甜甜，从喉咙一路暖到肚子 |
| `hot_honey_lemon` | 蜂蜜柠檬热饮 | 5 元 | 喝·热 | 热饮（`hot_cabinet`） | 酸酸甜甜，热气里带着柠檬香 |
| `hot_green_tea` | 热绿茶 | 4 元 | 喝·热 | 热饮（`hot_cabinet`） | 清清淡淡，有点回甘 |
| `hot_corn_milk` | 热玉米奶 | 6 元 | 喝·热 | 热饮（`hot_cabinet`） | 甜甜的玉米香，喝着很顶饱 |
| `vanilla` | 香草冰淇淋 | 5 元 | 吃·冷 | 冰淇淋（`freezer`） | 冰凉绵密，香草味很浓 |
| `melonbar` | 西瓜冰棍 | 3 元 | 吃·冷 | 冰淇淋（`freezer`） | 咬一口全是西瓜味的冰碴 |
| `umbrella` | 透明雨伞 | 15 元 | 用（用后保留） | 日用品（`daily_shelf`） | 下雨出门可以撑着，不会淋湿 |
| `tissue` | 小包纸巾 | 2 元 | 用 | 日用品（`daily_shelf`） | 擦擦手和脸 |
| `sunscreen` | 防晒霜 | 12 元 | 用（用后保留） | 日用品（`daily_shelf`） | 涂上凉凉的，大太阳下不容易晒伤 |
| `notebook` | 小笔记本 | 6 元 | 用（用后保留） | 日用品（`daily_shelf`） | 蓝色封面，可以记点东西 |
| `scrunchie` | 发圈 | 3 元 | 用（用后保留） | 日用品（`daily_shelf`） | 风大的时候把头发扎起来 |
| `bandaid` | 创可贴 | 3 元 | 用 | 日用品（`daily_shelf`） | 万一擦破皮可以贴上 |

## 需要高级协议的东西

电玩城的机台（贪吃蛇、俄罗斯方块、扫雷、象棋）、家里的棋盘、餐厅点菜/做菜，需要宿主实现对局和餐厅流程（`arcade.*`、`rules.ask`、`restaurant.*` 消息，见 `docs/PROTOCOL.md` 第 9 节）。参考桥目前不支持，调用会得到明确的“需要高级协议”提示；可以去这些地方逛、看，但先别答应别人一起玩。

## 怎么用才自然

- 想做什么之前先 `cabin_status` / `cabin_look`，根据饱腹、口渴、心情和天气挑一件事。
- 一次做一件，做完再说下一件；把返回的 `happened` 当作真实经历说给对方听，简短自然就好，不必逐步汇报。
- 钱不多时别乱花；渴了先喝水（最便宜）。
- 失败了（钱不够、有人占着、被打断）就照实说，换一件事做。
