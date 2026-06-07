/**
 * Alarm event-code maps.
 *
 * Maps both SIA letter event codes and Ademco Contact ID numeric event codes
 * to a normalized { category, priority, description } shape used by the
 * ingest pipeline.
 *
 * priority: 1 = critical .. 5 = info
 * category: burglary | fire | holdup | panic | medical | tamper | trouble |
 *           openclose | test | supervisory | restore
 *
 * Pure data + pure functions. No DB, no side effects.
 */

export type AlarmCategory =
  | 'burglary'
  | 'fire'
  | 'holdup'
  | 'panic'
  | 'medical'
  | 'tamper'
  | 'trouble'
  | 'openclose'
  | 'test'
  | 'supervisory'
  | 'restore';

export interface MappedCode {
  category: AlarmCategory;
  priority: number;
  description: string;
}

/**
 * SIA DC-03/DC-09 letter event codes.
 * Reference: ANSI/SIA DC-03 SIA Format event code list.
 * The first letter is the code group; the second is usually A (alarm) /
 * R (restore) / B (bypass) / etc. We key on the 2-letter mnemonic.
 *
 * Restores are represented here directly (e.g. BR -> restore) AND additionally
 * any code whose qualifier is "restore" is forced to category 'restore' by the
 * normalizer. The R-prefix/suffix variants below cover the common explicit set.
 */
export const SIA_CODES: Record<string, MappedCode> = {
  // Burglary
  BA: { category: 'burglary', priority: 2, description: 'Burglary alarm' },
  BR: { category: 'restore', priority: 4, description: 'Burglary restore' },
  BB: { category: 'trouble', priority: 4, description: 'Burglary bypass' },
  BT: { category: 'trouble', priority: 3, description: 'Burglary trouble' },
  BV: { category: 'burglary', priority: 2, description: 'Burglary verified' },
  // Fire
  FA: { category: 'fire', priority: 1, description: 'Fire alarm' },
  FR: { category: 'restore', priority: 4, description: 'Fire restore' },
  FT: { category: 'trouble', priority: 2, description: 'Fire trouble' },
  FB: { category: 'trouble', priority: 4, description: 'Fire bypass' },
  KA: { category: 'fire', priority: 1, description: 'Heat alarm' },
  SA: { category: 'fire', priority: 1, description: 'Smoke alarm' },
  GA: { category: 'fire', priority: 1, description: 'Gas alarm' },
  // Hold-up / Panic
  HA: { category: 'holdup', priority: 1, description: 'Holdup alarm' },
  HR: { category: 'restore', priority: 4, description: 'Holdup restore' },
  PA: { category: 'panic', priority: 1, description: 'Panic alarm' },
  PR: { category: 'restore', priority: 4, description: 'Panic restore' },
  QA: { category: 'panic', priority: 1, description: 'Emergency alarm' },
  // Medical
  MA: { category: 'medical', priority: 1, description: 'Medical alarm' },
  MR: { category: 'restore', priority: 4, description: 'Medical restore' },
  // Tamper
  TA: { category: 'tamper', priority: 3, description: 'Tamper alarm' },
  TR: { category: 'restore', priority: 4, description: 'Tamper restore' },
  // Trouble / system
  YT: { category: 'trouble', priority: 3, description: 'System battery trouble' },
  YR: { category: 'restore', priority: 4, description: 'System battery restore' },
  AT: { category: 'trouble', priority: 3, description: 'AC power trouble' },
  AR: { category: 'restore', priority: 4, description: 'AC power restore' },
  YC: { category: 'trouble', priority: 3, description: 'Communications trouble' },
  YK: { category: 'restore', priority: 4, description: 'Communications restore' },
  // Open / Close
  OP: { category: 'openclose', priority: 5, description: 'Opening (disarm)' },
  CL: { category: 'openclose', priority: 5, description: 'Closing (arm)' },
  OR: { category: 'openclose', priority: 5, description: 'Opening after alarm' },
  CR: { category: 'openclose', priority: 5, description: 'Recent closing' },
  // Test
  RP: { category: 'test', priority: 5, description: 'Automatic test' },
  RX: { category: 'test', priority: 5, description: 'Manual test' },
  TX: { category: 'test', priority: 5, description: 'Test report' },
  // Supervisory
  US: { category: 'supervisory', priority: 3, description: 'Untyped zone supervisory' },
  ZS: { category: 'supervisory', priority: 3, description: 'Zone supervisory' },
  NF: { category: 'supervisory', priority: 3, description: 'Forced perimeter arm' },
};

/**
 * Ademco Contact ID numeric event codes (3 digits).
 * Reference: SIA DC-05 Ademco Contact ID.
 * The Contact ID qualifier (1=new event/open, 3=restore/close, 6=status)
 * is applied separately; restore handling is done by the normalizer.
 */
export const CONTACTID_CODES: Record<string, MappedCode> = {
  // 1xx Medical / fire / panic
  '100': { category: 'medical', priority: 1, description: 'Medical alarm' },
  '101': { category: 'medical', priority: 1, description: 'Personal emergency' },
  '102': { category: 'medical', priority: 1, description: 'Fail to report in' },
  '110': { category: 'fire', priority: 1, description: 'Fire alarm' },
  '111': { category: 'fire', priority: 1, description: 'Smoke alarm' },
  '112': { category: 'fire', priority: 1, description: 'Combustion alarm' },
  '113': { category: 'fire', priority: 1, description: 'Water flow alarm' },
  '114': { category: 'fire', priority: 1, description: 'Heat alarm' },
  '115': { category: 'fire', priority: 1, description: 'Pull station alarm' },
  '116': { category: 'fire', priority: 1, description: 'Duct alarm' },
  '120': { category: 'panic', priority: 1, description: 'Panic alarm' },
  '121': { category: 'holdup', priority: 1, description: 'Duress' },
  '122': { category: 'holdup', priority: 1, description: 'Silent holdup' },
  '123': { category: 'panic', priority: 1, description: 'Audible panic' },
  '129': { category: 'holdup', priority: 1, description: 'Holdup verifier' },
  // 13x Burglary
  '130': { category: 'burglary', priority: 2, description: 'Burglary' },
  '131': { category: 'burglary', priority: 2, description: 'Perimeter burglary' },
  '132': { category: 'burglary', priority: 2, description: 'Interior burglary' },
  '133': { category: 'burglary', priority: 2, description: '24-hour burglary' },
  '134': { category: 'burglary', priority: 2, description: 'Entry/exit burglary' },
  '135': { category: 'burglary', priority: 2, description: 'Day/night burglary' },
  '136': { category: 'burglary', priority: 2, description: 'Outdoor burglary' },
  '137': { category: 'tamper', priority: 3, description: 'Tamper' },
  '138': { category: 'burglary', priority: 2, description: 'Near alarm' },
  '139': { category: 'burglary', priority: 2, description: 'Intrusion verifier' },
  // 14x General alarm
  '140': { category: 'burglary', priority: 2, description: 'General alarm' },
  '143': { category: 'trouble', priority: 3, description: 'Expansion module failure' },
  '144': { category: 'tamper', priority: 3, description: 'Sensor tamper' },
  '145': { category: 'tamper', priority: 3, description: 'Expansion module tamper' },
  '150': { category: 'burglary', priority: 2, description: '24-hour non-burglary' },
  '151': { category: 'trouble', priority: 3, description: 'Gas detected' },
  '154': { category: 'trouble', priority: 3, description: 'Water leakage' },
  '158': { category: 'trouble', priority: 3, description: 'High temperature' },
  '159': { category: 'trouble', priority: 3, description: 'Low temperature' },
  // 3xx System troubles
  '300': { category: 'trouble', priority: 3, description: 'System trouble' },
  '301': { category: 'trouble', priority: 3, description: 'AC power loss' },
  '302': { category: 'trouble', priority: 3, description: 'Low system battery' },
  '305': { category: 'trouble', priority: 4, description: 'System reset' },
  '306': { category: 'trouble', priority: 4, description: 'Panel programming changed' },
  '309': { category: 'trouble', priority: 3, description: 'Battery test failure' },
  '311': { category: 'trouble', priority: 3, description: 'Battery missing/dead' },
  '320': { category: 'trouble', priority: 3, description: 'Sounder/relay trouble' },
  '321': { category: 'trouble', priority: 3, description: 'Bell trouble' },
  '333': { category: 'trouble', priority: 3, description: 'Expansion module trouble' },
  '344': { category: 'trouble', priority: 3, description: 'RF receiver jam' },
  '350': { category: 'trouble', priority: 3, description: 'Communication trouble' },
  '351': { category: 'trouble', priority: 3, description: 'Telco line fault' },
  '354': { category: 'trouble', priority: 3, description: 'Failed to communicate' },
  '370': { category: 'trouble', priority: 3, description: 'Protection loop trouble' },
  '373': { category: 'trouble', priority: 3, description: 'Fire loop trouble' },
  '380': { category: 'trouble', priority: 3, description: 'Sensor trouble' },
  '381': { category: 'supervisory', priority: 3, description: 'RF supervision loss' },
  '383': { category: 'tamper', priority: 3, description: 'Sensor tamper' },
  '384': { category: 'trouble', priority: 4, description: 'RF low battery' },
  // 4xx Open/Close & access
  '400': { category: 'openclose', priority: 5, description: 'Open/Close' },
  '401': { category: 'openclose', priority: 5, description: 'Open/Close by user' },
  '402': { category: 'openclose', priority: 5, description: 'Group Open/Close' },
  '403': { category: 'openclose', priority: 5, description: 'Automatic Open/Close' },
  '406': { category: 'openclose', priority: 4, description: 'Cancel' },
  '407': { category: 'openclose', priority: 5, description: 'Remote Open/Close' },
  '408': { category: 'openclose', priority: 5, description: 'Quick arm' },
  '409': { category: 'openclose', priority: 5, description: 'Keyswitch Open/Close' },
  '441': { category: 'openclose', priority: 5, description: 'Armed stay' },
  '459': { category: 'openclose', priority: 4, description: 'Recent close' },
  '570': { category: 'trouble', priority: 4, description: 'Zone bypass' },
  // 6xx Test / misc
  '601': { category: 'test', priority: 5, description: 'Manual test' },
  '602': { category: 'test', priority: 5, description: 'Periodic test' },
  '603': { category: 'test', priority: 5, description: 'Periodic RF test' },
  '604': { category: 'test', priority: 5, description: 'Fire test' },
  '607': { category: 'test', priority: 5, description: 'Walk test' },
  '627': { category: 'trouble', priority: 4, description: 'Panel program mode entry' },
  '628': { category: 'trouble', priority: 4, description: 'Panel program mode exit' },
};

const UNKNOWN_CODE: MappedCode = {
  category: 'trouble',
  priority: 3,
  description: 'Unknown event',
};

/**
 * Restore detection across formats.
 * - SIA: qualifier === 'restore' OR the 2-letter code itself is a restore
 *   (ends in R or maps to category 'restore').
 * - Contact ID: qualifier '3' (restore/close).
 */
function isRestoreQualifier(qualifier?: string): boolean {
  if (!qualifier) return false;
  const q = qualifier.toLowerCase();
  return q === 'restore' || q === 'r' || q === '3';
}

/**
 * Map a SIA letter code (e.g. "BA") + optional qualifier to a MappedCode.
 * If the qualifier marks a restore, the category is forced to 'restore'.
 */
export function mapSiaCode(code: string, qualifier?: string): MappedCode {
  const key = (code || '').trim().toUpperCase().slice(0, 2);
  const base = SIA_CODES[key] || { ...UNKNOWN_CODE, description: `SIA ${key || '??'}` };
  if (isRestoreQualifier(qualifier) && base.category !== 'restore') {
    return { category: 'restore', priority: 4, description: `${base.description} restore` };
  }
  return base;
}

/**
 * Map a Contact ID numeric code (e.g. "130") + qualifier ('1'|'3'|'6') to a
 * MappedCode. Qualifier '3' (restore/close) forces category 'restore' for
 * alarm-type events; open/close & test stay in their own category.
 */
export function mapContactIdCode(code: string, qualifier?: string): MappedCode {
  const key = (code || '').trim().padStart(3, '0').slice(-3);
  const base = CONTACTID_CODES[key] || { ...UNKNOWN_CODE, description: `CID ${key}` };
  if (
    isRestoreQualifier(qualifier) &&
    base.category !== 'restore' &&
    base.category !== 'openclose' &&
    base.category !== 'test'
  ) {
    return { category: 'restore', priority: 4, description: `${base.description} restore` };
  }
  return base;
}

/**
 * Generic dispatcher used by the normalizer.
 * format: 'sia' | 'contactid' | 'surgard' | 'webhook' | 'manual'
 * For surgard/webhook we try Contact-ID-numeric first, else SIA letter.
 */
export function mapCode(format: string, eventCode: string, qualifier?: string): MappedCode {
  const fmt = (format || '').toLowerCase();
  const code = (eventCode || '').trim();
  if (fmt === 'sia') return mapSiaCode(code, qualifier);
  if (fmt === 'contactid') return mapContactIdCode(code, qualifier);
  // surgard / webhook / manual / unknown: numeric -> CID, alpha -> SIA
  if (/^\d{3,4}$/.test(code)) return mapContactIdCode(code, qualifier);
  if (/^[A-Za-z]{2}$/.test(code)) return mapSiaCode(code, qualifier);
  return { ...UNKNOWN_CODE, description: code ? `Event ${code}` : 'Unknown event' };
}

export default {
  SIA_CODES,
  CONTACTID_CODES,
  mapSiaCode,
  mapContactIdCode,
  mapCode,
};
