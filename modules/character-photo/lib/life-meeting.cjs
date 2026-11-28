'use strict'
const MEETING_IDLE_MS=60*60*1000

function readMeetingTurn(message,audience,atDoor){
 const line=String(message||'').trim()
 if(!line)return 'empty'
 if(audience==='group')return 'group'
 if(/["'“”‘’「」『』]|(?:他|她|别人|朋友)(?:刚才)?说|转述|台词|引用|画一?张|生成.{0,5}(?:照片|合影)/.test(line))return 'quote'
 if(/[?？]|(?:吗|么|好不好|行不行)[。！!]*$|如果|假如|要是|想象|假装|比方|梦见/.test(line))return 'uncertain'
 if(/没有|还没|并没|没(?:有)?(?:坐|见|来|到|回|上车|走|分开|离开|碰面)|没能|未曾|从未|并非|并不|别(?:坐|来|走|见面|碰面|说)|不(?:要|是|想|会|能|坐|见|回|上车|在你)/.test(line))return 'negative'
 if(/昨天|前天|上周|上个月|上次|去年|那时|那天|当时|刚才|从前|曾经|以前|记得|想起/.test(line))return 'past'
 if(/(?:说好|约好).{0,14}(?:忙完|下班后).{0,7}(?:见|碰面)/.test(line))return 'wait'
 if(/明天|改天|下次|周末|等会|一会儿|打算|准备|想见|希望|待会|想坐|要不要|(?:会|要)(?:坐|见面|碰面)|(?:见面|碰面|面对面).{0,5}(?:吧|怎么样)|(?:一|等我)(?:回家|上车|到家|回去).{0,8}(?:就|再)|(?:回家|到家|上车)(?:后|以后)再/.test(line))return 'plan'
 if(/回到(?:手机|QQ|线上)|(?:回家|上车|先走|回去|分开|到家).{0,18}(?:手机聊|QQ聊|线上聊|晚点聊)|(?:不在一起|离开你身边)了/i.test(line))return 'leave'
 if(/(?:我|我们|咱们).{0,10}(?:见到你了|看见你了.{0,8}旁边|(?:来到|就在)你(?:身边|面前)|坐(?:在|到)?你(?:的)?(?:身边|旁边|对面))|(?:我们|咱们|我俩)(?:现在|已经|终于|真的|刚刚|刚)?(?:线下|真实|真正)?(?:见面了|碰面了)|(?:我们|咱们|我俩)(?:(?:现在|此刻|正|已经)(?:就|是|在)?面对面|面对面坐着)/.test(line))return 'enter'
 if(/^(?:现在)?我们(?:已经)?在一起了[。！!啦]*$/.test(line))return atDoor?'enter':'ambiguous'
 if(/我(?:已经|刚刚|刚)?到(?:你家)?(?:门口|楼下|店里|咖啡馆)了?/.test(line))return 'arrived'
 return 'unchanged'
}

if(typeof module==='object'&&module.exports)module.exports={MEETING_IDLE_MS,readMeetingTurn}
