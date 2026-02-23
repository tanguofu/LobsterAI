# Adding WeCom (企业微信) Chat Bot Support

This document explains how the existing IM (Instant Messaging) integration is implemented and how to add support for **WeCom (企业微信)** as a new platform.

---

## 1. Current IM Architecture Overview

### 1.1 Data flow

```
User message (DingTalk/Feishu/Telegram/Discord)
    → Gateway receives → builds IMMessage → setMessageCallback(message, replyFn)
    → IMGatewayManager messageHandler → IMCoworkHandler / IMChatHandler
    → replyFn(response) → Gateway sends reply back to user
```

### 1.2 Key components

| Layer | Location | Responsibility |
|-------|----------|----------------|
| **Types** | `src/main/im/types.ts` | `IMPlatform`, `IMGatewayConfig`, `IMGatewayStatus`, `IMMessage`, defaults |
| **Gateway** | `src/main/im/{platform}Gateway.ts` | Start/stop, receive messages, send replies, emit events, status |
| **Manager** | `src/main/im/imGatewayManager.ts` | Holds all gateways, sets shared message callback, start/stop/test per platform |
| **Store** | `src/main/im/imStore.ts` | Load/save config and session mappings in SQLite |
| **Renderer types** | `src/renderer/types/im.ts` | Mirror of main types for React |
| **Redux** | `src/renderer/store/slices/imSlice.ts` | `config`, `status`, actions per platform |
| **UI** | `src/renderer/components/im/IMSettings.tsx` | Tabs, credentials, enable toggle, connectivity test |
| **IPC** | `src/main/main.ts` + `preload.ts` | `im:config:get/set`, `im:gateway:start/stop`, `im:gateway:test`, `im:status:get` |

### 1.3 Gateway contract (what each platform gateway must do)

Each gateway class (e.g. `TelegramGateway`, `FeishuGateway`) follows this pattern:

- **Constructor**: no config; config is passed to `start(config)`.
- **Lifecycle**: `start(config)`, `stop()`, `isConnected()`, `reconnectIfNeeded()`.
- **Status**: `getStatus()` returns a platform-specific status object (connected, startedAt, lastError, lastInboundAt, lastOutboundAt, etc.).
- **Message handling**: `setMessageCallback(cb)` where `cb(message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>`.
- **Inbound**: When a message arrives, the gateway:
  1. Builds an `IMMessage`: `platform`, `messageId`, `conversationId`, `senderId`, `content`, `chatType` ('direct' | 'group'), `timestamp`.
  2. Creates a `replyFn(text)` that sends `text` back to that conversation.
  3. Emits `'message'` with the message (optional; manager also uses the callback).
  4. Calls `onMessageCallback(message, replyFn)` so the manager can process and reply.
- **Events**: Emit `'connected'`, `'disconnected'`, `'error'`, and optionally `'message'`.
- **Optional**: `sendNotification(text)` used for scheduled-task notifications (sends to “last used” chat).

The manager wires the **same** message handler to all gateways and aggregates status; it does not care about platform-specific transport (WebSocket, HTTP callback, polling).

---

## 2. What You Need to Add for WeCom

### 2.1 WeCom (企业微信) API model

- **Receiving messages**: WeCom uses a **callback URL**. Your app must expose an HTTP endpoint that WeCom servers can POST to (receiving messages and events). So the WeCom gateway, unlike Feishu (WebSocket) or Telegram (polling), will be **callback-based**: you run an HTTP server (or register a route on an existing one) that receives and decrypts callbacks, then builds `IMMessage` and calls the shared callback.
- **Sending messages**: Two options:
  1. **自建应用 API** — “发送应用消息” with `access_token` (corpId + secret). See [发送应用消息](https://developer.work.weixin.qq.com/document/path/90236).
  2. **Group webhook (群机器人)** — A **webhook URL** configured per group. You **POST** to this URL to push messages into that WeCom group. No `access_token` needed. Format: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_WEBHOOK_KEY`. Supports `text` and `markdown`. Rate limit: e.g. 20 messages per minute per robot.
- **Auth**: Get `access_token` via [获取access_token](https://developer.work.weixin.qq.com/document/path/91039) (corpId + secret for 自建应用).
- **Callback**: Configure the **callback URL** in the WeCom admin console. For a desktop app, it must be **publicly reachable** (e.g. ngrok or a deployed endpoint). See [接收消息](https://developer.work.weixin.qq.com/document/path/100719), [接收事件](https://developer.work.weixin.qq.com/document/path/101027), [加解密方案](https://developer.work.weixin.qq.com/document/path/101033).

You can implement either:
- **自建应用**: 接收消息/事件 via 回调, 发送应用消息; or  
- **智能机器人**: 接收消息/接收事件/被动回复/主动回复 as per [智能机器人](https://developer.work.weixin.qq.com/document/path/101039).

**Group pusher webhook**: In addition, the app should support a configurable **group webhook URL** (群机器人 webhook). The user adds a “群机器人” in the WeCom group, copies the webhook URL, and configures it in the app. The gateway then uses this URL to **push** messages to that group (e.g. `sendNotification`, or replying when the conversation is that group). This is the same pattern as DingTalk’s session webhook: one URL per conversation for sending.

### 2.2 Two URLs to configure (summary)

| Purpose | Who configures | Where | Used by app |
|--------|----------------|--------|-------------|
| **Callback URL** | User sets in **WeCom admin** (receive messages/events). Must be publicly reachable (e.g. ngrok). | WeCom 应用/机器人 后台 → 接收消息 → 回调 URL | App’s HTTP server receives POSTs from WeCom. |
| **Group webhook URL** | User copies from **WeCom group** (群机器人) and pastes into **LobsterAI Settings**. | 群聊 → 添加群机器人 → 新建 → 复制地址. Format: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...` | App **POSTs** to this URL to push messages into the group (replies, notifications). |

Both can be used: callback for receiving + 自建应用 API for sending, and/or group webhook for pushing to a specific group. At least one of (callback+API) or (group webhook) is needed for a useful integration.

The integration steps below are the same; only the API calls and callback payload shapes differ.

---

## 3. Step-by-Step Implementation Checklist

### 3.1 Types (`src/main/im/types.ts`)

- Add `'wecom'` to `IMPlatform`:  
  `export type IMPlatform = 'dingtalk' | 'feishu' | 'telegram' | 'discord' | 'wecom';`
- Add `WecomConfig` with:
  - `enabled`, `debug`
  - For 自建应用 / callback: `corpId`, `agentSecret` or `corpSecret`, `agentId`, optional `token` / `encodingAesKey` for callback verification/decryption
  - **`groupWebhookUrl`** (optional): the **group robot webhook URL** used to **push** messages to a WeCom group. Format: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`. When set, use it for group replies and for `sendNotification(text)` so scheduled tasks or notifications go to that group.
- Add `WecomGatewayStatus` (e.g. `connected`, `startedAt`, `lastError`, `lastInboundAt`, `lastOutboundAt`; optionally `callbackUrl` if you show it in UI).
- Add `WecomConfig` and `WecomGatewayStatus` to `IMGatewayConfig` and `IMGatewayStatus`.
- Add `DEFAULT_WECOM_CONFIG` and `DEFAULT_WECOM_STATUS` and include them in `DEFAULT_IM_CONFIG` and `DEFAULT_IM_STATUS`.

### 3.2 Renderer types (`src/renderer/types/im.ts`)

- Mirror the same: `IMPlatform` including `'wecom'`, `WecomConfig`, `WecomGatewayStatus`, `IMGatewayConfig` / `IMGatewayStatus` and defaults.

### 3.3 WeCom gateway (`src/main/im/wecomGateway.ts`)

- Implement the gateway contract:
  - `start(config: WecomConfig)`:  
    - Obtain and cache `access_token` (and refresh when needed).  
    - Start an **HTTP server** (or register a path on a shared server) that listens for WeCom callback POSTs.  
    - On GET (URL verification): respond with WeCom’s verification logic (echostr etc.).  
    - On POST: decrypt/decode body, parse message or event; ignore non-message events if desired; build `IMMessage`; create `replyFn` that calls 发送应用消息 (or 被动回复 if you reply in the same HTTP response); call `onMessageCallback(message, replyFn)`; respond to WeCom as required (e.g. 200 + empty or passive reply).
  - `stop()`: stop the HTTP server, clear token cache.
  - `getStatus()`, `isConnected()`, `reconnectIfNeeded()`.
  - `setMessageCallback(cb)`.
  - Emit `'connected'` / `'disconnected'` / `'error'` and optionally `'message'`.
  - Optional: `sendNotification(text)`: if `groupWebhookUrl` is set, POST the text to that webhook (group pusher); otherwise use 发送应用消息 to last conversation if available.
- **Callback URL**: Document that the user must set a **public** URL in WeCom admin (e.g. `https://your-ngrok.io/wecom/callback`). The app can bind the server to `0.0.0.0` and a chosen port, but the public URL must be configured externally (ngrok/deploy).
- **Group webhook URL**: In Settings, the user can optionally set **Group webhook URL** (群机器人 webhook). Get it from the WeCom group: 群聊 → 添加群机器人 → 新建 → 复制地址. Use this URL to push messages to the group (reply in group context, or `sendNotification`). Request body: `{ "msgtype": "text", "text": { "content": "..." } }` or `"markdown"`; POST to the webhook URL.

### 3.4 IMStore (`src/main/im/imStore.ts`)

- In `getConfig()` / `setConfig()`: read/write `wecom` config (and merge with `DEFAULT_WECOM_CONFIG`).
- Add `getWecomConfig()` / `setWecomConfig()` (same pattern as telegram/discord).
- In `migrateDefaults()`: add `'wecom'` to the platforms list if you store per-platform config.
- In `isConfigured()`: consider WeCom configured when e.g. corpId and secret are set, **or** when `groupWebhookUrl` is set (group-pusher-only mode).

### 3.5 IMGatewayManager (`src/main/im/imGatewayManager.ts`)

- Instantiate `WecomGateway` in the constructor.
- In `setupGatewayEventForwarding()`: forward `wecom` gateway events to `statusChange` and `message`.
- In `setupMessageHandlers()`: call `wecomGateway.setMessageCallback(messageHandler)`.
- In `startGateway()` / `stopGateway()`: add `platform === 'wecom'` and call `wecomGateway.start(config.wecom)` / `wecomGateway.stop()`.
- In `startAllEnabled()` / `stopAll()`: include WeCom (start if enabled and credentials present; stop with others).
- In `getStatus()`: add `wecom: this.wecomGateway.getStatus()`.
- In `isConnected()`, `sendNotification()`, `getMissingCredentials()`, `runAuthProbe()`, `getStartedAtMs()`, `getLastInboundAt()`, `getLastOutboundAt()`, `getLastError()`: add a branch for `platform === 'wecom'`.
- In `buildMergedConfig()`: add `wecom: { ...current.wecom, ...(configOverride.wecom || {}) }`.
- For `runAuthProbe('wecom')`: use WeCom’s get access_token API (or a minimal API that requires token) to verify corpId/secret.
- Optionally add a connectivity check hint for WeCom (e.g. “请确保回调 URL 已配置且可从外网访问”).

### 3.6 Main process IPC (`src/main/main.ts`)

- No change to IPC channel names; they already use `IMPlatform`. Ensure `IMPlatform` includes `'wecom'` so that `im:gateway:start`, `im:gateway:stop`, `im:gateway:test` accept `'wecom'`.

### 3.7 Preload / electron.d.ts

- Type `startGateway` (and related) so that the platform argument can be `'wecom'` (should follow from `IMPlatform` if preload uses the same type or a union that includes wecom).

### 3.8 Redux slice (`src/renderer/store/slices/imSlice.ts`)

- Add `setWecomConfig` reducer (partial update to `state.config.wecom`).
- Export `setWecomConfig` in the actions list.
- Ensure `DEFAULT_IM_CONFIG` / `DEFAULT_IM_STATUS` in renderer types include wecom (so initial state has `config.wecom` and `status.wecom`).

### 3.9 IM Settings UI (`src/renderer/components/im/IMSettings.tsx`)

- Add WeCom to `platformMeta`: e.g. `wecom: { label: '企业微信', logo: 'wecom.png' }` (add logo asset if needed).
- In `platforms` (or visible list): include `'wecom'` (e.g. in `getVisibleIMPlatforms` for Chinese, or always).
- Add WeCom credential inputs: corpId, secret, agentId (for 自建应用/callback), and **Group webhook URL** (群机器人 webhook, for pushing messages to a WeCom group). Optional: callback URL display-only hint.
- In `toggleGateway` / `canStart` / `isPlatformEnabled` / `getPlatformConnected` / `getPlatformStarting`: handle `platform === 'wecom'` and use `setWecomConfig`, `config.wecom`, `status.wecom`.
- **canStart('wecom')**: allow start if either (corpId + secret) or `groupWebhookUrl` is set, so that “group pusher only” is valid.
- Optional: show a short note that the callback URL must be publicly reachable and configured in WeCom admin; and that the group webhook is obtained from the group’s 群机器人.

### 3.10 Region filter (`src/renderer/utils/regionFilter.ts`)

- Add `'wecom'` to `CHINA_IM_PLATFORMS` so it appears for Chinese UI:  
  `export const CHINA_IM_PLATFORMS = ['dingtalk', 'feishu', 'wecom'] as const;`

### 3.11 IM module export (`src/main/im/index.ts`)

- Export `WecomGateway` and any WeCom-related types if needed.

### 3.12 i18n (`src/renderer/services/i18n.ts`)

- Add any WeCom-specific connectivity check strings (e.g. `imConnectivityCheckTitle_wecom_callback_url`, `imConnectivityCheckSuggestion_wecom_callback_url`) if you add such checks.

### 3.13 Connectivity check codes (`src/main/im/types.ts`)

- If you add WeCom-specific checks, extend `IMConnectivityCheckCode` (e.g. `'wecom_callback_url'`) and use them in `imGatewayManager.testGateway()` for platform `wecom`.

---

## 4. WeCom Callback and Sending (Implementation Notes)

- **Callback server**: Create an HTTP server (e.g. `http.createServer`) in the main process, listen on a port (and optionally bind to `0.0.0.0`). One route (e.g. `/wecom`) handles GET (verification) and POST (messages/events). Implement WeCom’s decryption/verification as per [加解密方案](https://developer.work.weixin.qq.com/document/path/101033).
- **Sending (two paths)**:
  1. **自建应用**: When `replyFn(text)` is called and you have `access_token`, call the “发送应用消息” API, targeting the conversation (single-user or group) that sent the message. Map `IMMessage.conversationId` / `senderId` to WeCom’s `touser` / `chatid` etc.
  2. **Group webhook (群机器人)**: If the conversation is a group and `config.groupWebhookUrl` is set (or the incoming callback identifies the same group), send by **POST** to that URL:  
     `POST groupWebhookUrl` with body `{ "msgtype": "text", "text": { "content": "..." } }`.  
     For markdown: `{ "msgtype": "markdown", "markdown": { "content": "..." } }`.  
     Use the group webhook for `sendNotification(text)` when configured, so scheduled tasks push to the WeCom group.
- **Token**: Fetch and cache `access_token` in the gateway when corpId/secret are set; refresh before expiry (e.g. 7000 seconds). Use the token only for 发送应用消息. Group webhook does not use token.

---

## 5. Summary

| Step | File(s) | Change |
|------|---------|--------|
| 1 | `src/main/im/types.ts` | Add `wecom` to `IMPlatform`; add `WecomConfig`, `WecomGatewayStatus`, defaults; add to aggregate config/status types. |
| 2 | `src/renderer/types/im.ts` | Mirror WeCom types and `IMPlatform`. |
| 3 | `src/main/im/wecomGateway.ts` | New file: HTTP callback server + send API, full gateway contract. |
| 4 | `src/main/im/imStore.ts` | get/set wecom config; migrate; isConfigured. |
| 5 | `src/main/im/imGatewayManager.ts` | Wire WeCom gateway: events, message callback, start/stop/test, status, auth probe, all platform switches. |
| 6 | `src/main/im/index.ts` | Export WecomGateway. |
| 7 | `src/renderer/store/slices/imSlice.ts` | setWecomConfig; default config/status. |
| 8 | `src/renderer/components/im/IMSettings.tsx` | WeCom tab, credentials, toggle, connectivity. |
| 9 | `src/renderer/utils/regionFilter.ts` | Add wecom to CHINA_IM_PLATFORMS. |
| 10 | i18n / preload / electron.d.ts | WeCom labels and types. |

After these steps, the app will support WeCom as another IM platform: user configures corpId/secret/agentId and a public callback URL, enables WeCom in Settings, and the agent can receive and reply to WeCom messages through the same Cowork/Chat handler as other platforms.
