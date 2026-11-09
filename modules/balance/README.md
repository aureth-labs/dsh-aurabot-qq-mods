# 查余额（balance）

在 QQ 里问一句就能知道 API 账户还剩多少钱。查两个来源：

- **DeepSeek 官方**：`https://api.deepseek.com/user/balance`
- **中转站**（可选，自己填地址）：one-api / new-api / OpenAI 风格账单都能认

## 用法

- 主人发 `/余额`、`/查余额`、`/balance`、`/钱包` → 直接回余额
- 或者直接问她「你还有多少钱」「余额还剩多少」→ 她用 `balance_now` 工具查（只有主人私聊 / 主人身份才会给她这个工具）
- `/余额` 后面可以不带参数；要改设置去面板这个模块的设置页

返回长这样：

```
余额：
DeepSeek 官方：¥12.34（充值 ¥10.00 + 赠金 ¥2.34）
中转站：$3.50，已用 $1.20
```

某一个来源挂了不影响另一个，没填 key 的会直接说没填。

## 配置

| 设置项 | 说明 |
|---|---|
| DeepSeek 官方 API Key | `platform.deepseek.com` 里 `sk-` 开头的 key，密码框 |
| 中转站地址 | 例如 `https://api.example.com`，不填就不查中转站 |
| 中转站 API Key | 中转站后台拿的 key，密码框 |

**不填官方 key 也能用**：会依次去这些地方找 `sk-` 开头的 key——环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY` / `DS_API_KEY`、插件配置里的 `ext.balance.deepseekKey`、`~/.dsh/.credentials.yaml` 里名字带 `DEEPSEEK` 的 `*_KEY` 条目。

## 会访问的网址

- `https://api.deepseek.com`（官方余额）
- 你自己填的中转站地址，依次试 `/user/balance`、`/api/user/self`、`/v1/dashboard/billing/subscription`

除此之外不联网，key 只发给你填的这几个地址，日志里 key 会被插件自动脱敏。

## 限制

- 超时 10 秒，查不到会说「超时了」或「连不上」，不会卡住聊天
- 中转站返回格式不认识时说「认不出返回的格式」，不会瞎猜数字
- one-api 系的 `quota` 按 `1/500000` 美元换算

## 许可

MIT。
