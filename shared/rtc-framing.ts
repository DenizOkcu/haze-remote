/** Text-only framing over an ordered, reliable RTC channel. No cryptography here.
 * Each wire is framed (including small wires), so arbitrary JSON cannot collide
 * with a framing marker. Limits count UTF-8 bytes, not JS characters.
 */
export const RTC_FRAME_LIMIT = 64 * 1024;
export const RTC_WIRE_LIMIT = 12 * 1024 * 1024;
const CHUNK = 8000; // worst-case JSON escaping is six bytes per code unit
const bytes = (s: string) => new TextEncoder().encode(s).length;
export function encodeFrames(wire: string): string[] {
  if (typeof wire !== 'string' || bytes(wire) > RTC_WIRE_LIMIT) throw new Error('RTC wire too large');
  const chunks: string[] = [];
  for (let start = 0; start < wire.length;) {
    let end = Math.min(start + CHUNK, wire.length);
    if (end < wire.length && /[\uD800-\uDBFF]/.test(wire[end - 1]) && /[\uDC00-\uDFFF]/.test(wire[end])) end--;
    chunks.push(wire.slice(start, end)); start = end;
  }
  if (!chunks.length) chunks.push('');
  return chunks.map((data, index) => JSON.stringify({ rtc: 1, index, count: chunks.length, data }));
}
export class Framer {
  private parts: string[] = [];
  private count = 0;
  private size = 0;
  reset() { this.parts = []; this.count = 0; this.size = 0; }
  push(frame: string): string | undefined {
    try {
      if (typeof frame !== 'string' || bytes(frame) > RTC_FRAME_LIMIT) throw new Error('Invalid RTC frame');
      const v = JSON.parse(frame);
      if (!v || Object.keys(v).sort().join(',') !== 'count,data,index,rtc' || v.rtc !== 1 ||
          !Number.isInteger(v.index) || !Number.isInteger(v.count) || v.count < 1 || v.count > Math.ceil(RTC_WIRE_LIMIT / (CHUNK - 1)) ||
          v.index !== this.parts.length || v.index >= v.count || typeof v.data !== 'string' || v.data.length > CHUNK ||
          (this.count && this.count !== v.count)) throw new Error('Invalid RTC assembly');
      this.count = v.count;
      this.size += bytes(v.data);
      if (this.size > RTC_WIRE_LIMIT) throw new Error('RTC assembly too large');
      this.parts.push(v.data);
      if (this.parts.length !== this.count) return undefined;
      const wire = this.parts.join('');
      this.reset();
      return wire;
    } catch (error) { this.reset(); throw error; }
  }
}
