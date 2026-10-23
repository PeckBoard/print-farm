import { describe, it, expect } from "vitest";
import { md5Hex, parseDigestChallenge, digestAuthorization } from "../src/digest";

describe("md5", () => {
  it("matches RFC 1321 vectors", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890")).toBe(
      "57edf4a22be3c955ac49da2e2107b67a",
    );
  });
});

describe("digest auth", () => {
  it("parses a challenge and reproduces the RFC 2617 example response", () => {
    const ch = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    )!;
    expect(ch).toMatchObject({ realm: "testrealm@host.com", nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093" });
    const h = digestAuthorization(ch, "Mufasa", "Circle Of Life", "GET", "/dir/index.html", "0a4f113b");
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(h).toContain("qop=auth");
    expect(h).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it("ignores non-digest challenges", () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
    expect(parseDigestChallenge(undefined)).toBeNull();
  });
});
