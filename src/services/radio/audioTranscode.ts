/**
 * Audio transcode helpers for the RoIP/SIP bridge.
 *
 * App PTT wire format (lib/radioVoice): 16 kHz mono G.711 µ-law, 1 byte/sample.
 * SIP/RTP PCMU: 8 kHz mono G.711 µ-law, 1 byte/sample.
 * So both directions are µ-law; only an 8k↔16k resample is needed.
 *
 * These are pure functions (no I/O) so they can be unit-tested without a gateway.
 */

/** µ-law byte → PCM16 sample. Standard G.711 decode. */
export function muLawByteToPcm16(uVal: number): number {
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/** PCM16 sample → µ-law byte. Standard G.711 encode. */
export function pcm16ToMuLawByte(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) { /* find exp */ }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode a µ-law buffer to Int16 PCM. */
export function decodeMuLaw(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = muLawByteToPcm16(buf[i]);
  return out;
}

/** Encode Int16 PCM to a µ-law buffer. */
export function encodeMuLaw(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm16ToMuLawByte(pcm[i]);
  return out;
}

/** Linear resample of Int16 PCM (same approach as radioVoice.resampleF32). */
export function resamplePcm16(input: Int16Array, inRate: number, outRate: number): Int16Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    out[i] = Math.round(input[i0] * (1 - frac) + input[i1] * frac);
  }
  return out;
}

/** App µ-law @16k  →  RTP PCMU µ-law @8k. */
export function appMuLawToRtpMuLaw(appBuf: Buffer): Buffer {
  return encodeMuLaw(resamplePcm16(decodeMuLaw(appBuf), 16000, 8000));
}

/** RTP PCMU µ-law @8k  →  PCM16 @8k (feed to radioVoice.broadcastPcm with inRate=8000). */
export function rtpMuLawToPcm16(rtpBuf: Buffer): Int16Array {
  return decodeMuLaw(rtpBuf);
}
