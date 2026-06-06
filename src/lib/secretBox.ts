/**
 * Small symmetric encryption helper for secrets stored in the DB (e.g. Stripe
 * secret keys in platformSettings). AES-256-GCM with a key derived from
 * SETTINGS_ENC_KEY (or AUTH_JWT_SECRET as a fallback) via SHA-256.
 *
 * Format of an encrypted string: "enc:v1:<ivB64>:<tagB64>:<cipherB64>".
 * encrypt()/decrypt() are best-effort and reversible; decrypt() returns the
 * input unchanged if it isn't in our envelope (so plaintext/legacy values and
 * already-masked values pass through safely).
 */
import crypto from 'crypto';

const PREFIX = 'enc:v1:';

function key(): Buffer {
  const material =
    process.env.SETTINGS_ENC_KEY ||
    process.env.AUTH_JWT_SECRET ||
    'cguard-insecure-fallback-key';
  return crypto.createHash('sha256').update(String(material)).digest(); // 32 bytes
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encrypt(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return plain ?? null;
  if (isEncrypted(plain)) return plain; // already encrypted
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  } catch (e: any) {
    console.warn('secretBox.encrypt failed, storing plaintext:', e?.message || e);
    return String(plain);
  }
}

export function decrypt(value: string | null | undefined): string | null {
  if (value == null || value === '') return value ?? null;
  if (!isEncrypted(value)) return value; // plaintext/legacy — return as-is
  try {
    const body = value.slice(PREFIX.length);
    const [ivB64, tagB64, dataB64] = body.split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch (e: any) {
    console.warn('secretBox.decrypt failed:', e?.message || e);
    return null;
  }
}

/** Last 4 chars of a secret (for masked display). */
export function last4(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value);
  return s.length <= 4 ? s : s.slice(-4);
}
