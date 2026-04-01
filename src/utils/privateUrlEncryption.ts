import crypto from 'crypto';
import { getConfig } from '../config';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM

function getKey() {
  const raw = getConfig().FILE_URL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('FILE_URL_ENCRYPTION_KEY not configured');
  }
  // Expect base64 encoded 32 bytes key
  return Buffer.from(raw, 'base64');
}

export function encryptPrivateUrl(privateUrl: string) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(privateUrl, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // token = iv + tag + encrypted, base64
  const token = Buffer.concat([iv, tag, encrypted]).toString('base64url');
  return token;
}

export function decryptPrivateUrl(token: string) {
  const key = getKey();
  const data = Buffer.from(token, 'base64url');
  const iv = data.slice(0, IV_LENGTH);
  const tag = data.slice(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = data.slice(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return out.toString('utf8');
}

export default {
  encryptPrivateUrl,
  decryptPrivateUrl,
};
