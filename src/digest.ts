// HTTP Digest auth (RFC 7616, MD5 / qop=auth) for PrusaLink, done in the
// plugin because core's http_request has no digest support. Pure — tested.

import { utf8Encode } from "./b64";

// ── MD5 (RFC 1321) over a byte array ────────────────────────────────────────

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K: number[] = [];
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

export function md5Hex(input: string): string {
  const msg = utf8Encode(input);
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // 64-bit little-endian length (inputs here are far below 2^32 bits).
  for (let i = 0; i < 4; i++) msg.push((bitLen >>> (8 * i)) & 0xff);
  for (let i = 0; i < 4; i++) msg.push(0);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < msg.length; off += 64) {
    const M: number[] = [];
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = (msg[j] | (msg[j + 1] << 8) | (msg[j + 2] << 16) | (msg[j + 3] << 24)) >>> 0;
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  let hex = "";
  for (const w of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) hex += ((w >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

// ── Digest challenge / response ─────────────────────────────────────────────

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/// Parse a `WWW-Authenticate: Digest ...` header. Null if not a Digest challenge.
export function parseDigestChallenge(header: string | undefined): DigestChallenge | null {
  if (!header || !/^\s*digest\s/i.test(header)) return null;
  const out: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header.replace(/^\s*digest\s+/i, ""))) !== null) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  }
  if (!out.realm || !out.nonce) return null;
  return { realm: out.realm, nonce: out.nonce, qop: out.qop, opaque: out.opaque, algorithm: out.algorithm };
}

/// Build the `Authorization: Digest ...` header value for one request.
export function digestAuthorization(
  ch: DigestChallenge,
  user: string,
  pass: string,
  method: string,
  uri: string,
  cnonce: string,
  nc = "00000001",
): string {
  const ha1 = md5Hex(`${user}:${ch.realm}:${pass}`);
  const ha2 = md5Hex(`${method.toUpperCase()}:${uri}`);
  const useQop = ch.qop ? ch.qop.split(",").map((s) => s.trim()).includes("auth") : false;
  const response = useQop
    ? md5Hex(`${ha1}:${ch.nonce}:${nc}:${cnonce}:auth:${ha2}`)
    : md5Hex(`${ha1}:${ch.nonce}:${ha2}`);
  const parts = [
    `username="${user}"`,
    `realm="${ch.realm}"`,
    `nonce="${ch.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (ch.algorithm) parts.push(`algorithm=${ch.algorithm}`);
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`);
  if (useQop) parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return "Digest " + parts.join(", ");
}
