/**
 * At-rest encryption for message bodies + previews. AES-256-GCM with a key
 * derived from MESSAGE_ENC_KEY (falls back to APP_SECRET). Stored as
 * `enc1:<base64(iv|tag|ciphertext)>`. Legacy plaintext rows (no prefix) are
 * returned as-is, so this is safe to roll out without a data migration.
 */
import crypto from 'crypto';

const PREFIX = 'enc1:';
const KEY: Buffer = crypto
  .createHash('sha256')
  .update(String(process.env.MESSAGE_ENC_KEY || process.env.APP_SECRET || 'cguard-message-key-change-me'))
  .digest();

/** Encrypt a plaintext string for storage. Returns the original on any failure. */
export function encryptBody(text: string | null | undefined): string {
  const s = text == null ? '' : String(text);
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
  } catch {
    return s;
  }
}

/** Decrypt a stored value. Legacy plaintext (no prefix) is returned unchanged. */
export function decryptBody(stored: string | null | undefined): string {
  if (!stored || typeof stored !== 'string') return '';
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
