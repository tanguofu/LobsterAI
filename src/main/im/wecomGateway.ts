/**
 * WeCom (企业微信) Gateway
 * - Connects to remote WecomGateway relay (config lives only in LobsterAI).
 * - Receives "verify" / "callback" from relay; verifies and decrypts locally; replies via webhook or verifyResult.
 * - Sends messages via WS with webhookUrl so relay can proxy, or via direct webhook.
 * - Replies are split into chunks (markdown when possible, paragraphs; tables/lists kept whole) and pushed
 *   sequentially so the user receives content in time (goal: response within 1 min).
 * @see https://developer.work.weixin.qq.com/document/path/100285 应用推送
 */

import { EventEmitter } from 'events';
import { WecomConfig, WecomGatewayStatus, IMMessage } from './types';
import { verifySignature, decrypt } from './wecomCrypto';
import { extractEncryptFromBody, parseCallbackXml } from './wecomCallbackParse';
import { splitReplyForWecom } from './wecomMessageSplitter';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocket = require('ws');

export class WecomGateway extends EventEmitter {
  private config: WecomConfig | null = null;
  private status: WecomGatewayStatus = {
    connected: false,
    startedAt: null,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    callbackUrl: null,
  };
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;
  private ws: any | null = null;

  constructor() {
    super();
  }

  getStatus(): WecomGatewayStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.status.connected;
  }

  reconnectIfNeeded(): void {
    if (!this.config) return;
    if (!this.isConnected()) {
      void this.start(this.config);
    }
  }

  setMessageCallback(
    callback: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>
  ): void {
    this.onMessageCallback = callback;
  }

  async start(config: WecomConfig): Promise<void> {
    if (!config.enabled) {
      console.log('[WeCom Gateway] WeCom is disabled in config');
      return;
    }

    this.config = config;

    if (!config.gatewayUrl || !config.token) {
      throw new Error('WeCom requires gatewayUrl and token to be configured');
    }

    const baseUrl = config.gatewayUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/+$/, '');
    const wsUrl = `${baseUrl}/ws/${encodeURIComponent(config.token)}`;

    console.log('[WeCom Gateway] Connecting to remote gateway via WebSocket:', wsUrl);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      let settled = false;

      ws.on('open', () => {
        this.status = {
          connected: true,
          startedAt: Date.now(),
          lastError: null,
          lastInboundAt: null,
          lastOutboundAt: null,
          callbackUrl: this.status.callbackUrl ?? null,
        };
        console.log('[WeCom Gateway] WebSocket connected');
        this.emit('connected');
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('message', async (data: any) => {
        try {
          const text = typeof data === 'string' ? data : data.toString('utf8');
          const payload = JSON.parse(text);

          if (payload.type === 'verify') {
            this.handleVerify(payload);
            return;
          }
          if (payload.type === 'callback') {
            await this.handleCallback(payload);
            return;
          }
          if (payload.type === 'message') {
            const message: IMMessage = {
              platform: 'wecom',
              messageId: payload.messageId || '',
              conversationId: payload.conversationId || '',
              senderId: payload.senderId || '',
              senderName: payload.senderName || undefined,
              content: payload.content || '',
              chatType: payload.chatType === 'group' ? 'group' : 'direct',
              timestamp: payload.timestamp || Date.now(),
            };
            this.status.lastInboundAt = Date.now();
            const replyFn = async (replyText: string): Promise<void> => {
              await this.sendViaWebSocket(replyText, message.conversationId);
            };
            if (this.onMessageCallback) {
              await this.onMessageCallback(message, replyFn);
            }
            this.emit('message', message);
          }
        } catch (error: any) {
          console.error('[WeCom Gateway] Failed to handle WS message:', error?.message || error);
          this.status.lastError = error?.message || String(error);
          this.emit('error', error);
        }
      });

      ws.on('error', (error: any) => {
        const msg = error?.message || String(error);
        console.error('[WeCom Gateway] WebSocket error:', msg);
        const isSslMismatch =
          /EPROTO|WRONG_VERSION_NUMBER|SSL/i.test(msg) ||
          (msg.includes('100000f7') && msg.includes('SSL'));
        this.status.lastError = isSslMismatch
          ? `${msg}（若网关未配置 HTTPS，请将「WecomGateway 地址」改为 http:// 开头，例如 http://服务器:3000）`
          : msg;
        this.emit('error', error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      ws.on('close', () => {
        console.log('[WeCom Gateway] WebSocket closed');
        this.status.connected = false;
        this.emit('disconnected');
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.status.connected) {
      return;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    this.status = {
      connected: false,
      startedAt: null,
      lastError: null,
      lastInboundAt: this.status.lastInboundAt,
      lastOutboundAt: this.status.lastOutboundAt,
      callbackUrl: this.status.callbackUrl ?? null,
    };

    this.emit('disconnected');
  }

  /**
   * Send notification via WebSocket to remote gateway.
   * Remote WecomGateway 服务负责根据 token 调用企业微信 webhook。
   */
  async sendNotification(text: string): Promise<void> {
    await this.sendViaWebSocket(text);
  }

  private handleVerify(payload: { requestId: string; msg_signature: string; timestamp: string; nonce: string; echostr: string }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.config) return;
    const { requestId, msg_signature, timestamp, nonce, echostr } = payload;
    console.log('[WeCom Gateway] Verify request received, requestId:', requestId);
    try {
      if (!verifySignature(this.config.token, timestamp, nonce, msg_signature, echostr)) {
        console.warn('[WeCom Gateway] Verify failed: Invalid signature (token/timestamp/nonce/echostr mismatch)');
        this.ws.send(JSON.stringify({ type: 'verifyResult', requestId, error: 'Invalid signature' }));
        return;
      }
      const plain = decrypt(this.config.encodingAesKey, echostr);
      console.log('[WeCom Gateway] Verify OK: signature valid, echostr decrypted');
      this.ws.send(JSON.stringify({ type: 'verifyResult', requestId, echostr: plain }));
    } catch (e: any) {
      console.error('[WeCom Gateway] Verify failed: decrypt error:', e?.message || e);
      this.ws.send(JSON.stringify({ type: 'verifyResult', requestId, error: e?.message || 'Decrypt failed' }));
    }
  }

  private async handleCallback(payload: { body: string; query: { msg_signature?: string; timestamp?: string; nonce?: string } }): Promise<void> {
    if (!this.config) return;
    const { body, query } = payload;
    const { msg_signature, timestamp, nonce } = query;
    if (!msg_signature || !timestamp || !nonce) return;
    try {
      const encrypt = extractEncryptFromBody(body);
      if (!encrypt) return;
      if (!verifySignature(this.config.token, timestamp, nonce, msg_signature, encrypt)) return;
      const xmlPlain = decrypt(this.config.encodingAesKey, encrypt);
      const msg = parseCallbackXml(xmlPlain);
      if (!msg) return;
      this.status.lastInboundAt = Date.now();
      const message: IMMessage = {
        platform: 'wecom',
        messageId: msg.msgId,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        senderName: undefined,
        content: msg.content,
        chatType: msg.chatType,
        timestamp: msg.timestamp,
      };
      const replyFn = async (replyText: string): Promise<void> => {
        await this.sendReply(replyText);
      };
      if (this.onMessageCallback) {
        await this.onMessageCallback(message, replyFn);
      }
      this.emit('message', message);
    } catch (e: any) {
      console.error('[WeCom Gateway] Callback handle error:', e?.message || e);
    }
  }

  /**
   * Send reply via WeCom webhook (应用推送).
   * Uses markdown_v2 when content contains tables (per API 100285); else markdown; else text.
   * markdown_v2: content 必填，最长 4096 字节 UTF-8；不支持字体颜色、@群成员；低版本客户端显示纯文本。
   * 注：chatid/visible_to_user 为「应用发送消息到群聊」接口参数，webhook 推送不需要。
   */
  private async sendReply(text: string): Promise<void> {
    if (!this.config?.webhookUrl) {
      console.warn('[WeCom Gateway] No webhookUrl configured, cannot send reply');
      return;
    }
    const MARKDOWN_V2_MAX_BYTES = 4096;
    const chunks = splitReplyForWecom(text);
    if (chunks.length === 0) return;
    for (let i = 0; i < chunks.length; i++) {
      try {
        const { content, useMarkdown, useMarkdownV2 } = chunks[i];
        let body: string;
        if (useMarkdownV2) {
          const contentBytes = Buffer.byteLength(content, 'utf8');
          let safeContent: string;
          if (contentBytes <= MARKDOWN_V2_MAX_BYTES) {
            safeContent = content;
          } else {
            const buf = Buffer.from(content, 'utf8');
            let end = MARKDOWN_V2_MAX_BYTES;
            while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
            safeContent = buf.subarray(0, end).toString('utf8');
          }
          body = JSON.stringify({ msgtype: 'markdown_v2', markdown_v2: { content: safeContent } });
        } else if (useMarkdown) {
          body = JSON.stringify({ msgtype: 'markdown', markdown: { content } });
        } else {
          body = JSON.stringify({ msgtype: 'text', text: { content } });
        }
        let resp = await fetch(this.config.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (!resp.ok) {
          const errText = await resp.text();
          if (useMarkdownV2 && resp.status >= 400) {
            await new Promise((r) => setTimeout(r, 200));
            const fallbackResp = await fetch(this.config.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
            });
            if (!fallbackResp.ok) {
              console.error('[WeCom Gateway] Webhook send failed (markdown fallback):', fallbackResp.status, await fallbackResp.text());
            }
          } else {
            console.error('[WeCom Gateway] Webhook send failed:', resp.status, errText);
          }
        }
        this.status.lastOutboundAt = Date.now();
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch (e: any) {
        console.error('[WeCom Gateway] Webhook send error:', e?.message || e);
      }
    }
  }

  private async sendViaWebSocket(text: string, conversationId?: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WeCom WebSocket is not connected');
    }
    if (!this.config) {
      throw new Error('WeCom config is not set');
    }
    const payload: Record<string, unknown> = {
      type: 'send',
      conversationId: conversationId || null,
      text,
    };
    if (this.config.webhookUrl) {
      payload.webhookUrl = this.config.webhookUrl;
    }
    this.ws.send(JSON.stringify(payload));
    this.status.lastOutboundAt = Date.now();
  }
}

