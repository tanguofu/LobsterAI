/**
 * WeCom callback signature verification and message decryption
 * using the official Node.js library @wecom/crypto.
 *
 * Official docs:
 * - 加解密库下载与返回码 (Node 库): https://developer.work.weixin.qq.com/document/path/90307#node%E5%BA%93
 * - 加解密方案说明: https://developer.work.weixin.qq.com/document/path/91144
 * - 回调和回复的加解密方案: https://developer.work.weixin.qq.com/document/path/101033
 *
 * Install: npm install @wecom/crypto  (or yarn add @wecom/crypto)
 *
 * GET URL 校验：msg_signature = SHA1(sort(token, timestamp, nonce, echostr))，需包含 echostr。
 * POST 回调：msg_signature = SHA1(sort(token, timestamp, nonce, encrypt))，包含加密消息体。
 */

import { getSignature, decrypt as wecomDecrypt } from '@wecom/crypto';

/**
 * Verify WeCom request signature.
 * For GET verify: ciphered = echostr; for POST callback: ciphered = encrypted body (or <Encrypt> value).
 */
export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  msgSignature: string,
  ciphered: string
): boolean {
  const expected = getSignature(token, timestamp, nonce, ciphered);
  const received = (msgSignature ?? '').trim();
  return expected.toLowerCase() === received.toLowerCase();
}

/**
 * Decrypt WeCom encrypted payload (echostr or POST body).
 * Returns the plain message (echostr string or XML).
 */
export function decrypt(encodingAesKey: string, encryptedBase64: string): string {
  const { message } = wecomDecrypt(encodingAesKey, encryptedBase64);
  return message;
}
