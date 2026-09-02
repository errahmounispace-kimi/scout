// ULID generator (Crockford base32, 48-bit time + 80-bit randomness).
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    out = ENCODING[now % 32] + out;
    now = Math.floor(now / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ENCODING[Math.floor(Math.random() * 32)];
  }
  return out;
}

export function ulid(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}
