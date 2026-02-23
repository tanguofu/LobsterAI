/**
 * WecomGateway relay (config-free): only forwards WeCom HTTP callbacks to LobsterAI over WebSocket.
 * All WeCom config (token, encodingAesKey, webhookUrl) lives in LobsterAI.
 *
 * - GET  /wecom/callback/:botId — forward verify params to WS client, return decrypted echostr from client
 * - POST /wecom/callback/:botId — forward raw body + query to WS client, return 200
 * - WS   /ws/:botId — LobsterAI client (any botId accepted)
 * - Client may send { type: "send", webhookUrl, text } to proxy send (optional; LobsterAI can also call webhook directly)
 */

import express, { Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { loadConfig } from './config';
import { randomUUID } from 'crypto';

const config = loadConfig();

// botId -> Set<WebSocket>
const wsClients = new Map<string, Set<import('ws').WebSocket>>();
// requestId -> { resolve, reject, timeout }
const pendingVerify = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }>();

const VERIFY_TIMEOUT_MS = 15000;

function getWsClients(botId: string): Set<import('ws').WebSocket> {
  let set = wsClients.get(botId);
  if (!set) {
    set = new Set();
    wsClients.set(botId, set);
  }
  return set;
}

function sendToFirstClient(botId: string, payload: object): boolean {
  const clients = wsClients.get(botId);
  if (!clients) return false;
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(msg);
      return true;
    }
  }
  return false;
}

function broadcastToClients(botId: string, payload: object): void {
  const clients = wsClients.get(botId);
  if (!clients) return;
  const msg = JSON.stringify(payload);
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

const app = express();
app.use(express.text({ type: '*/*' }));

// GET /wecom/callback/:botId — WeCom URL verification: forward to LobsterAI, wait for decrypted echostr
app.get('/wecom/callback/:botId', (req: Request, res: Response) => {
  const botId = req.params.botId;
  const { msg_signature, timestamp, nonce, echostr } = req.query as Record<string, string>;
  console.log('[WecomGateway] GET verify request, botId:', botId, 'hasClient:', !!wsClients.get(botId)?.size);
  if (!msg_signature || !timestamp || !nonce || !echostr) {
    console.log('[WecomGateway] GET verify missing params');
    res.status(400).send('Missing msg_signature, timestamp, nonce or echostr');
    return;
  }
  const requestId = randomUUID();
  const promise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingVerify.delete(requestId)) {
        console.log('[WecomGateway] GET verify timeout, requestId:', requestId);
        reject(new Error('Verify timeout'));
      }
    }, VERIFY_TIMEOUT_MS);
    pendingVerify.set(requestId, { resolve, reject, timeout });
  });
  const sent = sendToFirstClient(botId, {
    type: 'verify',
    requestId,
    msg_signature,
    timestamp,
    nonce,
    echostr,
  });
  if (!sent) {
    const entry = pendingVerify.get(requestId);
    if (entry) {
      clearTimeout(entry.timeout);
      pendingVerify.delete(requestId);
    }
    console.log('[WecomGateway] GET verify 503, no client for botId:', botId, 'knownBotIds:', Array.from(wsClients.keys()));
    res.status(503).send('No LobsterAI client connected for this botId');
    return;
  }
  promise
    .then((plainEchostr) => {
      console.log('[WecomGateway] GET verify OK, requestId:', requestId);
      res.type('text/plain').send(plainEchostr);
    })
    .catch((e) => {
      console.log('[WecomGateway] GET verify failed, requestId:', requestId, 'error:', e?.message);
      res.status(500).send(e?.message || 'Verify failed');
    });
});

// POST /wecom/callback/:botId — WeCom message callback: forward raw body + query, return 200 immediately
app.post('/wecom/callback/:botId', (req: Request, res: Response) => {
  const botId = req.params.botId;
  const rawBody = typeof req.body === 'string' ? req.body : (req.body && (req.body as any).toString?.()) || '';
  const query = req.query as Record<string, string>;
  broadcastToClients(botId, {
    type: 'callback',
    body: rawBody,
    query: {
      msg_signature: query.msg_signature,
      timestamp: query.timestamp,
      nonce: query.nonce,
    },
  });
  res.status(200).send('');
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '', `http://${request.headers.host}`);
  if (url.pathname.startsWith('/ws/')) {
    const botId = url.pathname.slice(4).replace(/\/$/, '');
    if (!botId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, botId);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: import('ws').WebSocket, _req: import('http').IncomingMessage, botId: string) => {
  const clients = getWsClients(botId);
  clients.add(ws);
  console.log('[WecomGateway] WS client connected, botId:', botId, 'total:', clients.size);

  ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const rawStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    let payload: { type?: string; requestId?: string; echostr?: string; webhookUrl?: string; text?: string; conversationId?: string };
    try {
      payload = JSON.parse(rawStr);
    } catch {
      return;
    }
    if (payload.type === 'verifyResult' && payload.requestId) {
      const entry = pendingVerify.get(payload.requestId);
      const err = (payload as { error?: string }).error;
      if (entry) {
        clearTimeout(entry.timeout);
        pendingVerify.delete(payload.requestId);
        if (err) {
          console.log('[WecomGateway] verifyResult error from client, requestId:', payload.requestId, 'error:', err);
          entry.reject(new Error(err));
        } else if (payload.echostr != null) {
          console.log('[WecomGateway] verifyResult OK, requestId:', payload.requestId);
          entry.resolve(payload.echostr);
        } else {
          console.log('[WecomGateway] verifyResult missing echostr, requestId:', payload.requestId);
          entry.reject(new Error('Missing echostr in verifyResult'));
        }
      } else {
        console.log('[WecomGateway] verifyResult unknown requestId:', payload.requestId);
      }
      return;
    }
    if (payload.type === 'send' && payload.webhookUrl && payload.text) {
      const body = JSON.stringify({
        msgtype: 'text',
        text: { content: payload.text },
      });
      fetch(payload.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch((e) => console.error('[WecomGateway] Webhook proxy error:', e));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (clients.size === 0) wsClients.delete(botId);
  });
});

const port = config.port;
const host = config.host;
server.listen(port, host, () => {
  console.log(`WecomGateway (relay-only) listening on http://${host}:${port}`);
  console.log('  GET  /wecom/callback/:botId — WeCom URL verification (forward to LobsterAI)');
  console.log('  POST /wecom/callback/:botId — WeCom message callback (forward to LobsterAI)');
  console.log('  WS   /ws/:botId — LobsterAI client; no config required on gateway.');
});
