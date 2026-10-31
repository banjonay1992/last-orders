import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "../shared/limits";

/** URL-safe random string built from `bytes` bytes of cryptographic randomness. */
export function randomId(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A short code people can read off a pub TV and type on a phone. */
export function randomRoomCode(): string {
  const alphabet = ROOM_CODE_ALPHABET;
  // Rejection sampling keeps every letter equally likely.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < ROOM_CODE_LENGTH) {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < ROOM_CODE_LENGTH) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}
