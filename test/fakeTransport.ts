// A scripted Transport for driver tests: routes "METHOD url-substring" to a
// canned response (or a thrown error) and records every request.

import { Transport, HttpReq, HttpRes } from "../src/transport";

export type Canned = Partial<HttpRes> | Error | ((req: HttpReq) => Partial<HttpRes>);

export class FakeTransport implements Transport {
  calls: HttpReq[] = [];
  constructor(private routes: Array<[string, Canned]>) {}

  request(req: HttpReq): HttpRes {
    this.calls.push(req);
    for (const [key, canned] of this.routes) {
      const [method, frag] = key.split(" ");
      if (method !== req.method.toUpperCase() || !req.url.includes(frag)) continue;
      if (canned instanceof Error) throw canned;
      const r = typeof canned === "function" ? canned(req) : canned;
      return { status: 200, headers: {}, body: "", ...r };
    }
    return { status: 404, headers: {}, body: "" };
  }
}

export const json = (v: unknown, status = 200): Partial<HttpRes> => ({ status, body: JSON.stringify(v) });
