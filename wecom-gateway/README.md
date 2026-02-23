# WecomGateway (relay only)

Standalone **relay** for 企业微信 · 消息推送（原群机器人）: it only forwards HTTP callbacks to LobsterAI over WebSocket. **All WeCom configuration (token, EncodingAESKey, webhook URL) is done in LobsterAI**; this service holds no bot config.

Deploy the relay on a public HTTPS server. LobsterAI connects via WebSocket and performs verification, decryption, and reply (using its own webhook URL).

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
