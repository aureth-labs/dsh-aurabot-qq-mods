/* dsh-image-studio 0.5.1 default visual keywords
MIT License

Copyright (c) 2026 aa1355721445-lgtm

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
export const PHOTO_WORDS = {
  activity: [
    {"name":"在家休息","aliases":["在家","宅家","休息","放松","居家"],"scene":"卧室","outfit":"居家针织服","light":"午后暖阳","prompt":"放松慵懒的居家氛围，周围有生活感的小物件"},
    {"name":"睡前","aliases":["睡觉","晚安","熬夜"],"scene":"卧室","outfit":"居家针织服","light":"夜晚台灯","prompt":"夜深了，准备睡觉，被子和枕头有些凌乱，安静温馨"},
    {"name":"刚睡醒","aliases":["起床","早安","赖床"],"scene":"卧室","outfit":"居家针织服","light":"清晨柔光","prompt":"刚睡醒，头发有点乱，还带着困意"},
    {"name":"客厅放松","aliases":["看电视","沙发","窝沙发"],"scene":"客厅","outfit":"居家针织服","light":"午后暖阳","prompt":"窝在沙发上，悠闲自在"},
    {"name":"工作学习","aliases":["上班","工作","学习","干活","写代码"],"scene":"","outfit":"通勤休闲装","light":"","prompt":"在电脑或书桌前专注做事，桌上有电脑、笔记和一杯饮料"},
    {"name":"外出","aliases":["出门","逛街","约会","散步"],"scene":"","outfit":"复古","light":"午后暖阳","prompt":"在户外，轻松愉快，背景是街道或公园"},
    {"name":"吃东西","aliases":["吃饭","下午茶","零食","吃饭饭"],"scene":"","outfit":"","light":"","prompt":"面前摆着诱人的食物，正准备开动或吃得很满足"},
    {"name":"下雨天","aliases":["下雨","雨天"],"scene":"","outfit":"","light":"阴雨天","prompt":"窗外在下雨，玻璃上有雨痕，氛围安静"}
  ],
  emotion: [
    {"name":"开心","aliases":["高兴","愉快","笑"],"prompt":"眼睛弯成月牙，露出灿烂的笑容，神情明亮有活力"},
    {"name":"微笑","aliases":["温柔"],"prompt":"嘴角轻轻上扬的温柔微笑，眼神柔和"},
    {"name":"害羞","aliases":["脸红","不好意思"],"prompt":"脸颊泛起红晕，眼神躲闪、微微低头，嘴角含着不好意思的笑"},
    {"name":"得意","aliases":["骄傲","神气"],"prompt":"扬起下巴，眯着眼露出得意的坏笑，一副「快夸我」的神气"},
    {"name":"撒娇","aliases":["卖萌"],"prompt":"歪着头，眼睛亮晶晶地往上看，嘴角带着讨好的笑"},
    {"name":"委屈","aliases":["可怜"],"prompt":"眉头微蹙，嘴巴瘪起，眼里含着要掉不掉的泪光"},
    {"name":"生气","aliases":["气鼓鼓","不满"],"prompt":"鼓起腮帮子，眉毛竖起，气呼呼地瞪着前方"},
    {"name":"惊讶","aliases":["吃惊","震惊"],"prompt":"眼睛睁大，嘴巴微张成 O 形，眉毛高高扬起"},
    {"name":"困倦","aliases":["困","犯困","没睡醒"],"prompt":"半睁着惺忪的睡眼，打着哈欠或眼皮打架，神情迷糊"},
    {"name":"认真","aliases":["专注"],"prompt":"神情专注，目光坚定，嘴唇轻抿"},
    {"name":"平静","aliases":["放空","发呆"],"prompt":"表情放松平和，目光自然或有点出神"},
    {"name":"难过","aliases":["伤心","失落"],"prompt":"眼神低垂黯淡，嘴角下撇，带着淡淡的忧伤"},
    {"name":"无语","aliases":["无奈","白眼"],"prompt":"半眯着眼，嘴角抽动，一脸「真拿你没办法」的无奈"},
    {"name":"紧张","aliases":["慌张"],"prompt":"额角冒出细汗，眼神慌乱，嘴唇紧抿"}
  ],
  pose: [
    {"name":"站着","aliases":["站立"],"prompt":"自然地站着，重心落在一条腿上，身体略微侧转"},
    {"name":"坐着","aliases":["坐"],"prompt":"自然地坐着，身体放松，双手放在膝上或身侧"},
    {"name":"抱膝坐","aliases":["抱膝"],"prompt":"坐在地上或床上，双臂环抱膝盖，下巴搁在膝头"},
    {"name":"躺着","aliases":["躺","躺平"],"prompt":"侧身或仰面躺着，身体舒展放松"},
    {"name":"趴着","aliases":["趴"],"prompt":"趴在床上或桌上，双手托着下巴，小腿向上翘起"},
    {"name":"伸懒腰","aliases":[],"prompt":"双臂高举过头伸懒腰，身体舒展"},
    {"name":"托腮","aliases":["撑脸"],"prompt":"一只手托着脸颊，手肘撑在桌面上"},
    {"name":"挥手","aliases":["打招呼"],"prompt":"抬起一只手朝镜头挥手打招呼"},
    {"name":"回头","aliases":["回眸"],"prompt":"背对镜头，转过头回眸看向镜头"},
    {"name":"比耶","aliases":["剪刀手"],"prompt":"一只手在脸旁比出 V 字手势"},
    {"name":"抱着东西","aliases":["抱着"],"prompt":"双手把东西抱在怀里"},
    {"name":"看书","aliases":["读书"],"prompt":"低着头专注地看着手里的书"},
    {"name":"喝饮料","aliases":["喝咖啡","捧着杯子"],"prompt":"双手捧着杯子，小口喝着热饮"},
    {"name":"奔跑","aliases":["跑"],"prompt":"向前小跑，头发和衣摆随动作飘起"}
  ],
  camera: [
    {"name":"自拍","aliases":["自拍照"],"prompt":"手机自拍视角：人物一只手臂伸向镜头举着手机（手机在画面外），轻微俯拍，脸离镜头较近"},
    {"name":"特写","aliases":["大头"],"prompt":"面部特写，聚焦表情和眼神"},
    {"name":"近景","aliases":["胸像"],"prompt":"胸口以上的近景，人物占画面大部分"},
    {"name":"半身","aliases":[],"prompt":"腰部以上的半身构图"},
    {"name":"全身","aliases":[],"prompt":"全身入镜，能看清完整的姿势和服装"},
    {"name":"远景","aliases":["大场景"],"prompt":"人物在画面中较小，突出环境与氛围"},
    {"name":"俯视","aliases":["俯拍"],"prompt":"从高处向下俯拍的视角"},
    {"name":"仰视","aliases":["仰拍"],"prompt":"从低处向上仰拍的视角"},
    {"name":"第一人称","aliases":["POV","主观视角"],"prompt":"第一人称视角，观看者就在人物面前，人物与镜头有互动"}
  ],
  lighting: [
    {"name":"午后暖阳","aliases":["午后","阳光"],"prompt":"午后温暖的阳光从窗户斜照进来，有柔和的光斑，整体暖色调"},
    {"name":"清晨柔光","aliases":["清晨","早上"],"prompt":"清晨柔和的自然光，色调清新明亮"},
    {"name":"黄昏逆光","aliases":["黄昏","夕阳"],"prompt":"黄昏的橙色逆光，人物轮廓镶着一圈金边"},
    {"name":"夜晚台灯","aliases":["夜晚","晚上","台灯"],"prompt":"夜晚的室内，只有暖黄的台灯照明，周围偏暗，温馨安静"},
    {"name":"霓虹夜景","aliases":["霓虹","夜景"],"prompt":"夜晚街头的霓虹灯光，蓝紫与粉色的光影交错"},
    {"name":"阴雨天","aliases":["阴天","雨天光"],"prompt":"阴天或下雨，光线柔和偏冷，氛围安静"},
    {"name":"月光","aliases":[],"prompt":"夜晚冷蓝色的月光，静谧"}
  ]
}

export const PHOTO_ASPECTS = {square:'1:1','3:4':'3:4','4:3':'4:3','9:16':'9:16',wide:'16:9',portrait:'2:3',landscape:'3:2'}
export const WORD_LABELS = {activity:'情境',emotion:'神态',pose:'动作',camera:'镜头',lighting:'光线'}

export function situationWord(value) {
  return PHOTO_WORDS.activity.find(item=>item.name===value || item.aliases.includes(value))
}

export function photoWord(key, value, human) {
  const item=PHOTO_WORDS[key]?.find(x=>x.name===value || x.aliases.includes(value))
  if(!item)return ''
  if(human)return item.prompt
  if(key==='lighting')return item.name==='黄昏逆光'?'夕阳从背面照亮物体边缘，形成金色轮廓':item.prompt
  if(key==='camera')return ({特写:'突出物件表面和可见细节',近景:'近距离取景',远景:'远距离交代空间与景深',俯视:'从高处向下俯拍',仰视:'从低处向上仰拍',第一人称:'角色掌镜拍眼前所见'})[item.name]||''
  if(key==='activity' && ['在家休息','睡前','下雨天'].includes(item.name))return item.prompt
  return ''
}
