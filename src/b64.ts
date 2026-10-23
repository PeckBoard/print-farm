// Pure-JS base64 + UTF-8 codecs. The Extism js-pdk (QuickJS) runtime does not
// reliably provide btoa/atob/TextEncoder, and those are latin1-only anyway, so
// we encode/decode bytes ourselves. Pure — safe under vitest. Used to marshal
// remote file content to/from the ssh host functions (which speak base64).

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] & 0xff;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] & 0xff : 0;
    const b2 = has2 ? bytes[i + 2] & 0xff : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += has1 ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += has2 ? B64[b2 & 63] : "=";
  }
  return out;
}

export function base64ToBytes(b64: string): number[] {
  const s = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const c0 = B64.indexOf(s[i]);
    const c1 = B64.indexOf(s[i + 1]);
    if (c0 < 0 || c1 < 0) break;
    const c2 = s[i + 2] === "=" || s[i + 2] === undefined ? -1 : B64.indexOf(s[i + 2]);
    const c3 = s[i + 3] === "=" || s[i + 3] === undefined ? -1 : B64.indexOf(s[i + 3]);
    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
    if (c2 >= 0 && c3 >= 0) bytes.push(((c2 & 3) << 6) | c3);
  }
  return bytes;
}

export function utf8Encode(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return bytes;
}

export function utf8Decode(bytes: number[]): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc0 && b < 0xe0) {
      const b1 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b & 0x1f) << 6) | b1);
    } else if (b >= 0xe0 && b < 0xf0) {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b & 0x0f) << 12) | (b1 << 6) | b2);
    } else {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      const b3 = bytes[i++] & 0x3f;
      let cp = ((b & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

export function utf8ToBase64(str: string): string {
  return bytesToBase64(utf8Encode(str));
}

export function base64ToUtf8(b64: string): string {
  return utf8Decode(base64ToBytes(b64));
}
