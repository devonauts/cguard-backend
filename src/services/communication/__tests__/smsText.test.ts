/**
 * Unit tests — smsText (central SMS sanitizer + GSM-7 segment calculator).
 *
 * Run:  NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json npx mocha -r ts-node/register \
 *         'src/services/communication/__tests__/smsText.test.ts' --exit
 */

import assert from 'assert';
import { toSmsBody, gsmSeptets } from '../smsText';

describe('Communications — smsText.toSmsBody', () => {
  // ── Emoji stripping ────────────────────────────────────────────────────────
  it('strips emoji / pictographs / variation selectors / ZWJ', () => {
    const r = toSmsBody('🚨 Alerta de pánico', 'Guardia 👮🏽‍♂️ activó el botón ⚠️');
    assert.strictEqual(r.text, 'Alerta de panico: Guardia activo el boton');
    assert.strictEqual(r.ucs2, false);
    assert.strictEqual(r.segments, 1);
  });

  it('strips flag emojis and keycaps', () => {
    const r = toSmsBody(undefined, 'Ecuador 🇪🇨 puesto 1️⃣ activo');
    assert.strictEqual(r.text, 'Ecuador puesto 1 activo');
    assert.strictEqual(r.ucs2, false);
  });

  // ── Accent folding ─────────────────────────────────────────────────────────
  it('folds non-GSM accents (á í ó ú) to plain vowels', () => {
    const r = toSmsBody(undefined, 'Notificación: el vigilante marcó su salida en Estación Única');
    assert.strictEqual(r.text, 'Notificacion: el vigilante marco su salida en Estacion Unica');
    assert.strictEqual(r.ucs2, false);
  });

  it('keeps GSM-7 Spanish characters (é ñ ü ¿ ¡)', () => {
    const r = toSmsBody(undefined, '¿Qué pasó, señor Müller? ¡Ojalá esté bien!');
    assert.strictEqual(r.text, '¿Qué paso, señor Müller? ¡Ojala esté bien!');
    assert.strictEqual(r.ucs2, false);
    assert.strictEqual(r.segments, 1);
  });

  // ── Typographic punctuation ────────────────────────────────────────────────
  it('transliterates em/en dash, middle dot, smart quotes, ellipsis and NBSP', () => {
    const r = toSmsBody(undefined, 'Turno — “Norte” · 08:00 AM – listo…');
    assert.strictEqual(r.text, 'Turno - "Norte" - 08:00 AM - listo...');
    assert.strictEqual(r.ucs2, false);
  });

  // ── Title/body joining ─────────────────────────────────────────────────────
  it("joins title and body with ': '", () => {
    assert.strictEqual(toSmsBody('Titulo', 'Cuerpo').text, 'Titulo: Cuerpo');
  });

  it('uses only the non-empty part when title or body is missing', () => {
    assert.strictEqual(toSmsBody('Solo titulo', undefined).text, 'Solo titulo');
    assert.strictEqual(toSmsBody(undefined, 'Solo cuerpo').text, 'Solo cuerpo');
    assert.strictEqual(toSmsBody('Solo titulo', '').text, 'Solo titulo');
  });

  it('returns empty/0 segments for empty input (even emoji-only input)', () => {
    assert.deepStrictEqual(toSmsBody(undefined, undefined), { text: '', segments: 0, ucs2: false });
    assert.deepStrictEqual(toSmsBody('🚨', '🔥🔥'), { text: '', segments: 0, ucs2: false });
  });

  it('collapses newlines and repeated whitespace', () => {
    assert.strictEqual(toSmsBody('Titulo', 'linea 1\n  linea   2').text, 'Titulo: linea 1 linea 2');
  });

  // ── Truncation ─────────────────────────────────────────────────────────────
  it('truncates at a word boundary within the default 155-septet budget', () => {
    const body = Array(40).fill('palabra').join(' '); // 40*8-1 = 319 septets
    const r = toSmsBody(undefined, body);
    assert.ok(r.text.endsWith('...'), 'must append ellipsis when cut');
    assert.ok(gsmSeptets(r.text) <= 155, `must fit the budget (got ${gsmSeptets(r.text)})`);
    // Word-boundary cut: everything before the '...' is whole words.
    const stem = r.text.slice(0, -3);
    assert.ok(/^(palabra )*palabra$/.test(stem), `cut mid-word: "${stem}"`);
    assert.strictEqual(r.segments, 1);
  });

  it('hard-cuts a single word longer than the budget', () => {
    const r = toSmsBody(undefined, 'a'.repeat(400), { maxChars: 20 });
    assert.ok(r.text.endsWith('...'));
    assert.ok(gsmSeptets(r.text) <= 20);
  });

  it('does not truncate text that already fits', () => {
    const r = toSmsBody('Corto', 'mensaje corto');
    assert.strictEqual(r.text, 'Corto: mensaje corto');
    assert.ok(!r.text.endsWith('...'));
  });

  // ── Segment counting (GSM-7) ───────────────────────────────────────────────
  it('counts 160 GSM septets as 1 segment and 161 as 2', () => {
    const s160 = toSmsBody(undefined, 'a'.repeat(160), { maxChars: 1000 });
    assert.strictEqual(s160.segments, 1);
    const s161 = toSmsBody(undefined, 'a'.repeat(161), { maxChars: 1000 });
    assert.strictEqual(s161.segments, 2);
    const s306 = toSmsBody(undefined, 'a'.repeat(306), { maxChars: 1000 });
    assert.strictEqual(s306.segments, 2); // 2*153
    const s307 = toSmsBody(undefined, 'a'.repeat(307), { maxChars: 1000 });
    assert.strictEqual(s307.segments, 3);
  });

  it('counts GSM extended chars (^ { } € …) as 2 septets each', () => {
    assert.strictEqual(gsmSeptets('{'), 2);
    assert.strictEqual(gsmSeptets('€uro'), 5);
    // 80 braces = 160 septets → 1 segment; 81 = 162 → 2 segments.
    assert.strictEqual(toSmsBody(undefined, '{'.repeat(80), { maxChars: 1000 }).segments, 1);
    assert.strictEqual(toSmsBody(undefined, '{'.repeat(81), { maxChars: 1000 }).segments, 2);
  });

  // ── UCS-2 leftovers (user content the sanitizer cannot fold) ──────────────
  it('reports ucs2:true and 70/67 segment math for non-GSM leftovers', () => {
    const r70 = toSmsBody(undefined, '你'.repeat(70), { maxChars: 1000 });
    assert.strictEqual(r70.ucs2, true);
    assert.strictEqual(r70.segments, 1);
    const r71 = toSmsBody(undefined, '你'.repeat(71), { maxChars: 1000 });
    assert.strictEqual(r71.ucs2, true);
    assert.strictEqual(r71.segments, 2); // ceil(71/67)
  });

  it('a single stray non-GSM char flips the whole message to UCS-2', () => {
    const r = toSmsBody(undefined, `codigo œ ${'a'.repeat(75)}`, { maxChars: 1000 });
    assert.strictEqual(r.ucs2, true);
    assert.strictEqual(r.segments, 2); // 84 UTF-16 units > 70 → ceil(84/67)
  });
});

describe('Communications — smsText.gsmSeptets', () => {
  it('counts plain GSM chars as 1 septet', () => {
    assert.strictEqual(gsmSeptets('Hola mundo'), 10);
    assert.strictEqual(gsmSeptets(''), 0);
  });

  it('counts GSM chars kept by the sanitizer (é ñ ü ¿ ¡) as 1 septet', () => {
    assert.strictEqual(gsmSeptets('é'), 1);
    assert.strictEqual(gsmSeptets('ñ'), 1);
    assert.strictEqual(gsmSeptets('¿¡'), 2);
  });
});
