const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIMESTAMP = 0xffffffffffff;

let lastTimestamp = -1;
let lastRandom = new Uint8Array(10);

function encode(value: bigint, length: number): string {
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

function incrementRandom(bytes: Uint8Array): void {
  if (bytes.every((byte: number): boolean => byte === 0xff)) {
    throw new Error("ULID random component overflowed within one millisecond");
  }

  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const current = bytes[index];
    if (current === undefined) {
      throw new Error(`ULID randomness byte ${index} is unavailable`);
    }
    if (current < 0xff) {
      bytes[index] = current + 1;
      return;
    }
    bytes[index] = 0;
  }
}

function randomValue(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

export function ulid(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error(`ULID timestamp must be a non-negative safe integer, got ${String(now)}`);
  }
  if (now > MAX_TIMESTAMP) {
    throw new Error(`ULID timestamp exceeds 48-bit maximum: ${now}`);
  }

  if (now <= lastTimestamp) {
    incrementRandom(lastRandom);
    now = lastTimestamp;
  } else {
    lastTimestamp = now;
    lastRandom = crypto.getRandomValues(new Uint8Array(10));
  }

  return encode(BigInt(now), 10) + encode(randomValue(lastRandom), 16);
}

export function isUlid(s: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(s);
}
