/**
 * Deterministic event ids (DAN-199 design decision).
 *
 * The store dedupes on `id` (INSERT OR IGNORE), which is what makes
 * re-ingestion idempotent — but only if re-parsing the same transcript
 * record reproduces the same id. A random ULID would turn append-only
 * into append-duplicates on every replay.
 *
 * Scheme: standard ULID layout (26 chars, Crockford base32) where the
 * 48-bit time prefix comes from the event's own `ts` and the 80-bit
 * "randomness" tail is the leading 80 bits of
 * sha256(`${sessionId}\n${rawRef}\n${type}\n${discriminator}`).
 * Lexical time-ordering is preserved; identity is content-derived.
 *
 * `discriminator` disambiguates multiple same-type events sharing one
 * raw_ref (e.g. two tool_use blocks in one assistant message) — adapters
 * pass the intra-record index or native id there.
 */

import { createHash } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(timeMs: number): string {
  let t = Math.max(0, Math.floor(timeMs));
  const out = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    out[i] = CROCKFORD[t % 32]!;
    t = Math.floor(t / 32);
  }
  return out.join("");
}

/** Encode the first 80 bits of `bytes` as 16 Crockford base32 chars. */
function encode80Bits(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31]!;
      bits -= 5;
      if (out.length === 16) return out;
    }
  }
  return out;
}

export function deterministicEventId(input: {
  ts: string;
  sessionId: string;
  rawRef: string;
  type: string;
  discriminator?: string;
}): string {
  const timeMs = Date.parse(input.ts);
  if (Number.isNaN(timeMs)) {
    throw new Error(`deterministicEventId: unparseable ts: ${input.ts}`);
  }
  const digest = createHash("sha256")
    .update(
      `${input.sessionId}\n${input.rawRef}\n${input.type}\n${input.discriminator ?? ""}`,
    )
    .digest();
  return encodeTime(timeMs) + encode80Bits(digest);
}
