/**
 * Parse WeCom callback XML (decrypted body) into a simple message object.
 * Uses regex to avoid adding an XML dependency in the main process.
 */

export interface WecomCallbackMessage {
  msgId: string;
  conversationId: string;
  senderId: string;
  content: string;
  chatType: 'group' | 'direct';
  timestamp: number;
}

function extractTag(xml: string, tagName: string): string {
  const re = new RegExp(`<${tagName}>(?:<!\\[CDATA\\[([^\\]]+)\\]\\]>|([^<]+))</${tagName}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return (m[1] ?? m[2] ?? '').trim();
}

export function parseCallbackXml(xml: string): WecomCallbackMessage | null {
  const msgType = extractTag(xml, 'MsgType');
  if (msgType !== 'text') return null;
  const content = extractTag(xml, 'Content');
  if (!content) return null;
  const fromUserName = extractTag(xml, 'FromUserName');
  const msgId = extractTag(xml, 'MsgId');
  const chatId = extractTag(xml, 'ChatId');
  const createTimeStr = extractTag(xml, 'CreateTime');
  const createTime = parseInt(createTimeStr, 10) * 1000 || Date.now();
  return {
    msgId: msgId || '',
    conversationId: chatId || fromUserName,
    senderId: fromUserName,
    content,
    chatType: chatId ? 'group' : 'direct',
    timestamp: createTime,
  };
}

/**
 * Extract <Encrypt>...</Encrypt> or <Encrypt><![CDATA[...]]></Encrypt> from callback body.
 */
export function extractEncryptFromBody(body: string): string | null {
  const m = body.match(/<Encrypt><!\[CDATA\[([^\]]+)\]\]><\/Encrypt>/i) ?? body.match(/<Encrypt>([^<]+)<\/Encrypt>/i);
  return m ? m[1].trim() : null;
}
