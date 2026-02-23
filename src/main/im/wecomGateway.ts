/**
 * WeCom (企业微信) Gateway
 * - Connects to remote WecomGateway relay (config lives only in LobsterAI).
 * - Receives "verify" / "callback" from relay; verifies and decrypts locally; replies via webhook or verifyResult.
 * - Sends messages via WS with webhookUrl so relay can proxy, or via direct webhook.
 */

import { EventEmitter } from 'events';
import { WecomConfig, WecomGatewayStatus, IMMessage } from './types';
import { verifySignature, decrypt } from './wecomCrypto';
import { extractEncryptFromBody, parseCallbackXml } from './wecomCallbackParse';
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
        console.error('[WeCom Gateway] WebSocket error:', error?.message || error);
        this.status.lastError = error?.message || String(error);
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
    try {
      if (!verifySignature(this.config.token, timestamp, nonce, msg_signature)) {
        this.ws.send(JSON.stringify({ type: 'verifyResult', requestId, error: 'Invalid signature' }));
        return;
      }
      const plain = decrypt(this.config.encodingAesKey, echostr);
      this.ws.send(JSON.stringify({ type: 'verifyResult', requestId, echostr: plain }));
    } catch (e: any) {
      this.ws.send(JSON.stringify({ type: 'verifyResult', requestId, error: e?.message || 'Decrypt failed' }));
    }
  }

  private async handleCallback(payload: { body: string; query: { msg_signature?: string; timestamp?: string; nonce?: string } }): Promise<void> {
    if (!this.config) return;
    const { body, query } = payload;
    const { msg_signature, timestamp, nonce } = query;
    if (!msg_signature || !timestamp || !nonce) return;
    try {
      if (!verifySignature(this.config.token, timestamp, nonce, msg_signature)) return;
      const encrypt = extractEncryptFromBody(body);
      if (!encrypt) return;
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

  private async sendReply(text: string): Promise<void> {
    if (!this.config?.webhookUrl) {
      console.warn('[WeCom Gateway] No webhookUrl configured, cannot send reply');
      return;
    }
    try {
      const body = JSON.stringify({ msgtype: 'text', text: { content: text } });
      const resp = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!resp.ok) {
        console.error('[WeCom Gateway] Webhook send failed:', resp.status, await resp.text());
      }
      this.status.lastOutboundAt = Date.now();
    } catch (e: any) {
      console.error('[WeCom Gateway] Webhook send error:', e?.message || e);
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

