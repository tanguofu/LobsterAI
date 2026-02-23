/**
 * WeCom callback signature verification and message decryption.
 * See: https://developer.work.weixin.qq.com/document/path/90930
 */

import * as crypto from 'crypto';

export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  msgSignature: string
): boolean {
  const arr = [token, timestamp, nonce].sort();
  const str = arr.join('');
  const sha1 = crypto.createHash('sha1').update(str).digest('hex');
  return sha1 === msgSignature;
}

/**
 * Decrypt WeCom encrypted message (POST body or echostr).
 * AES-256-CBC; key = base64(encodingAesKey); IV = first 16 bytes of key.
 */
export function decrypt(encodingAesKey: string, encryptedBase64: string): string {
  const key = Buffer.from(encodingAesKey + '=', 'base64');
  if (key.length !== 32) {
    throw new Error('EncodingAESKey must decode to 32 bytes');
  }
  const iv = key.subarray(0, 16);
  const cipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.from(encryptedBase64, 'base64');
  const decrypted = Buffer.concat([cipher.update(encrypted), cipher.final()]);
  const msgLen = decrypted.readUInt32BE(16);
  return decrypted.subarray(20, 20 + msgLen).toString('utf8');
}
