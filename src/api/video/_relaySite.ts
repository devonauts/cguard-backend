import crypto from 'crypto';
import { decrypt, last4 } from '../../lib/secretBox';

/** Short stable slug for the ingest path: <name-slug>-<6 hex>. */
export function genSiteKey(name: string): string {
  const slug = String(name || 'site')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'site';
  return `${slug}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Opaque publish credential the site relay presents to the cloud ingest. */
export function genPublishToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** API shape for a relay site: drop the encrypted token, expose only masked status. */
export function serializeRelaySite(record: any): any {
  const p = record && typeof record.get === 'function' ? record.get({ plain: true }) : { ...record };
  const stored = p.publishToken;
  delete p.publishToken;
  const clear = decrypt(stored);
  p.publishTokenConfigured = !!clear;
  p.publishTokenLast4 = last4(clear);
  return p;
}
