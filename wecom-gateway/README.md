# WecomGateway (relay only)

Standalone **relay** for 企业微信 · 消息推送（原群机器人）: it only forwards HTTP callbacks to LobsterAI over WebSocket. **All WeCom configuration (token, EncodingAESKey, webhook URL) is done in LobsterAI**; this service holds no bot config.

Deploy the relay on a public HTTPS server. LobsterAI connects via WebSocket and performs verification, decryption, and reply (using its own webhook URL). LobsterAI uses the official WeCom Node.js crypto library [@wecom/crypto](https://www.npmjs.com/package/@wecom/crypto) as documented in [加解密库下载与返回码 - node库](https://developer.work.weixin.qq.com/document/path/90307#node%E5%BA%93).

## LobsterAI 企业微信消息交互顺序

整体链路：**企业微信 ↔ WecomGateway 中继 ↔ LobsterAI**。中继只做转发，校验、解密、回复均由 LobsterAI 完成。

### 1. 连接建立

1. LobsterAI 在「设置 → IM → 企业微信」中配置：**WecomGateway 地址**（如 `wss://your-domain.com`）、**Token**、**EncodingAESKey**、**Webhook URL**（用于发消息）。
2. LobsterAI 主进程用上述配置连接中继：`WS /ws/{token}`，以 `token` 作为 `botId`。
3. 企业微信管理端配置「接收消息」：**回调 URL** = `https://your-domain.com/wecom/callback/{token}`，**Token** 与 **EncodingAESKey** 与 LobsterAI 中一致。

### 2. 企业微信 URL 校验（仅首次配置回调时）

1. 企业微信向中继发起 **GET** `/wecom/callback/{token}?msg_signature=...&timestamp=...&nonce=...&echostr=...`。
2. 中继将 `msg_signature`、`timestamp`、`nonce`、`echostr` 通过 WebSocket 以 `{ type: "verify", requestId, ... }` 发给该 `token` 对应的 LobsterAI 客户端。
3. LobsterAI 用本地配置的 **Token** 校验签名，用 **EncodingAESKey** 解密 `echostr`，再通过 WS 回传 `{ type: "verifyResult", requestId, echostr: 明文 }`。
4. 中继把明文 `echostr` 作为 HTTP 响应体返回给企业微信，完成校验。

### 3. 用户发消息 → LobsterAI 收消息

1. 用户在群内/单聊中发消息，企业微信服务器将加密的 XML 以 **POST** 请求推到中继：`/wecom/callback/{token}`，query 带 `msg_signature`、`timestamp`、`nonce`，body 为含 `<Encrypt>...</Encrypt>` 的 XML。
2. 中继不做解密，仅将 **body + query** 通过 WebSocket 以 `{ type: "callback", body, query }` 转发给该 `token` 对应的 LobsterAI。
3. LobsterAI 用 **Token** 校验签名、用 **EncodingAESKey** 解密 body，解析 XML 得到文本内容、发送者、会话 ID 等，转成内部 `IMMessage`，触发 Cowork/IM 逻辑并展示给用户。

### 4. LobsterAI 回复 → 企业微信

1. 用户在 LobsterAI 侧触发回复（或 Agent 自动回复），LobsterAI 主进程得到要发送的文本。
2. **方式 A（推荐）**：LobsterAI 直接使用本地配置的 **Webhook URL** 向企业微信「发送消息」接口发起 HTTP POST，将回复发到群/会话。
3. **方式 B（可选）**：LobsterAI 通过已连的 WebSocket 向中继发送 `{ type: "send", webhookUrl, text }`，由中继代为请求企业微信 Webhook（适用于 LobsterAI 无法直连企业微信的场景）。

### 顺序小结

| 步骤 | 方向 | 说明 |
|------|------|------|
| ① | LobsterAI → 中继 | 建立 WS `/ws/{token}`，后续收 `verify` / `callback` |
| ② | 企业微信 → 中继 → LobsterAI | GET 校验：中继转发 query，LobsterAI 验签+解密后回传 echostr，中继返回企业微信 |
| ③ | 企业微信 → 中继 → LobsterAI | POST 消息：中继转发 body+query，LobsterAI 验签+解密+解析，生成会话消息 |
| ④ | LobsterAI → 企业微信 | 回复：LobsterAI 用 Webhook URL 直连发消息，或经中继 `send` 代理发消息 |

## Behaviour

- **GET** `/wecom/callback/:botId` — WeCom URL verification: relay forwards query to the LobsterAI client for that `botId`; LobsterAI verifies and decrypts and returns the echostr; relay returns it to WeCom.
- **POST** `/wecom/callback/:botId` — WeCom message callback: relay forwards raw body and query to LobsterAI; LobsterAI decrypts and handles the message; replies are sent by LobsterAI directly to the WeCom webhook (no relay config needed).
- **WS** `/ws/:botId` — LobsterAI connects with its `botId` (same as token). Any `botId` is accepted; no config on the relay.

Optional: LobsterAI can send `{ type: "send", webhookUrl, text }` over WS so the relay proxies the send request (useful if LobsterAI cannot reach WeCom). Otherwise LobsterAI calls the webhook itself.

## Config (relay only)

Only server port/host. No bot credentials.

Create `config.json` (optional):

```json
{
  "port": 3000,
  "host": "0.0.0.0"
}
```

Or use env: `PORT`, `HOST`. Default: port 3000, host 0.0.0.0.

## Run locally

```bash
cd wecom-gateway
npm install
npm run build
npm start
```

## Deploy to cloud

1. Run the relay on a host with a **public IP and HTTPS** (e.g. Nginx with SSL).
2. In 企业微信 → 群机器人 → 接收消息, set:
   - **Callback URL**: `https://your-domain.com/wecom/callback/YOUR_TOKEN`
   - **Token** and **EncodingAESKey**: same as you will configure in LobsterAI (relay does not use them).
3. In **LobsterAI** IM settings (WeCom):
   - **WecomGateway address**: `wss://your-domain.com` (or `https://...`; the app normalizes to `wss://`).
   - **Token**: same as in the callback URL path.
   - **EncodingAESKey** and **Webhook URL**: set in LobsterAI; used for verification, decryption, and sending replies.

## API summary

| Endpoint | Description |
|----------|-------------|
| GET `/wecom/callback/:botId` | WeCom URL verification; relay forwards to LobsterAI and returns decrypted echostr |
| POST `/wecom/callback/:botId` | WeCom message callback; relay forwards body + query to LobsterAI |
| WS `/ws/:botId` | LobsterAI client; receives `verify` / `callback`; may send `send` with `webhookUrl` for optional proxy |

## Troubleshooting

### 企业微信「echostr 设置失败」/ URL 校验不通过

**可能原因与对应处理**：

| 现象 / 日志 | 原因 | 处理 |
|-------------|------|------|
| 网关日志：`GET verify 503, no client for botId: xxx` | 当前没有 LobsterAI 用该 botId 连上网关，或 **botId 与回调 URL 路径不一致** | ① 先打开 LobsterAI，在 IM 里开启并连接企业微信（确保网关日志里出现 `WS client connected, botId: xxx`）。② 企业微信后台「接收消息」里填的**回调 URL** 必须为 `https://你的域名/wecom/callback/你的Token`，其中 **「你的Token」** 与 LobsterAI 里配置的 **Token** 完全一致（例如 LobsterAI 用 Token `lobsteraiter1`，则 URL 为 `.../wecom/callback/lobsteraiter1`）。 |
| 网关日志：`GET verify timeout` | LobsterAI 在 15 秒内未回传解密后的 echostr | 检查 LobsterAI 里 **Token**、**EncodingAESKey** 是否与企业微信后台一致；EncodingAESKey 为 43 位。若不一致，解密会失败或超时。 |
| 网关日志：`verifyResult error from client` | LobsterAI 验签或解密失败（Token/EncodingAESKey 错误） | 在企业微信后台与 LobsterAI 中核对 **Token**、**EncodingAESKey** 完全一致（含大小写、无多余空格）。 |
| 企业微信后台提示校验失败且网关无 GET 请求日志 | 请求未到达网关（域名解析、防火墙、反向代理未转发） | 确认回调 URL 的域名解析到本网关所在服务器；若前有 Nginx，确认 `GET /wecom/callback/...` 已转发到网关端口（如 3000）。 |

**建议**：在企业微信后台点击「保存」前，先确保 LobsterAI 已连接网关（界面显示企业微信已连接），再保存；保存后查看服务器上 `wecom-gateway.log`（或控制台）中的 `[WecomGateway] GET verify ...` 日志以确认是 503、timeout 还是 verifyResult error。

**根据网关日志快速判断**（在服务器执行 `tail -50 wecom-gateway.log`）：

- 出现 `GET verify request, botId: xxx hasClient: false` 且 `knownBotIds: []` → 当时**没有任何 LobsterAI 连接**：请先在 LobsterAI 里连接企业微信，再在企业微信后台点保存。
- 出现 `GET verify request, botId: xxx hasClient: false` 且 `knownBotIds: [yyy]` → **URL 里的 botId 与 LobsterAI 使用的 Token 不一致**：企业微信「接收消息」里填的 URL 必须为 `https://域名/wecom/callback/你的Token`，其中「你的Token」与 LobsterAI 中配置的 Token 完全一致（例如 LobsterAI 用 `lobsteraiter1`，则路径为 `/wecom/callback/lobsteraiter1`）。
- 出现 `verifyResult error from client ... Invalid signature` → 企业微信后台的 **Token** 与 LobsterAI 中配置的 Token 不一致，请完全一致（含大小写、无空格）。
- 出现 `verifyResult error from client ... Decrypt failed` 或 `EncodingAESKey` 相关错误 → 企业微信后台的 **EncodingAESKey** 与 LobsterAI 中配置的不一致；EncodingAESKey 为 **43 位**，请逐字核对。
- 出现 `GET verify timeout` → LobsterAI 在 15 秒内未返回结果，多为 Token/EncodingAESKey 错误导致解密失败或未响应。

### LobsterAI 报错：`EPROTO` / `WRONG_VERSION_NUMBER` / `SSL routines`

**原因**：网关当前是**明文 HTTP/WS**（未配置 TLS），但 LobsterAI 里填的是 `https://` 或 `wss://`，客户端按 TLS 握手，服务端返回明文，导致 SSL 错误。

**处理**：

- **方案一（推荐）**：在 LobsterAI「WecomGateway 地址」中改为 **`http://` 开头**，并带上端口，例如  
  `http://9.134.80.122:3000`  
  这样会使用 `ws://` 连接，与当前明文网关一致。
- **方案二**：在服务器上为 wecom-gateway 配置 HTTPS（如用 Nginx 反向代理并配置 SSL），对外提供 `https://`，LobsterAI 再使用 `https://你的域名`（会转为 `wss://`）。

### LobsterAI 卡住 / 消息无回复 / 日志出现 "Request timed out"

**现象**：企业微信里发了消息，LobsterAI 无回复；或主进程日志里出现 `[IMGatewayManager] Error processing message: Request timed out`。

**原因**：不是整个应用卡死，而是 **IM 消息处理**在等 Cowork（Claude）会话在限定时间内完成。若 Cowork 在超时时间内没有返回（例如首轮加载 SDK、调用技能或 LLM 较慢），就会报 "Request timed out"（默认 5 分钟）。

**LobsterAI 主进程日志位置**（用于排查）：

- **macOS**: `~/Library/Logs/LobsterAI/main.log`
- **Windows**: `%USERPROFILE%\AppData\Roaming\LobsterAI\logs\main.log`
- **Linux**: `~/.config/LobsterAI/logs/main.log`

**日志中可关注**：

- `[WeCom Gateway] Verify OK` → URL 校验成功。
- `[IMGatewayManager] Using Cowork mode for message processing` → 收到消息，进入 Cowork 处理。
- `[IMCoworkHandler] 处理消息:` → 具体会话与内容。
- `[IMCoworkHandler] Waiting for Cowork response (timeout Xs)` → 开始等待回复，X 为超时秒数。
- `[IMCoworkHandler] 会话完成:` → Cowork 正常结束并回复。
- `[IMCoworkHandler] Request timed out after Xs` / `[IMGatewayManager] Error processing message: Request timed out` → 等待超时。

**建议**：若经常超时，可检查网络与 API 延迟、或是否首轮/技能执行过慢；当前默认超时为 5 分钟，一般足够首轮+简单工具调用。
