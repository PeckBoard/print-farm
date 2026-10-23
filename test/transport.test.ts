import { describe, it, expect } from "vitest";
import { curlArgs, parseCurlOutput, needsCurl, pathOf } from "../src/transport";

describe("curl transport", () => {
  it("routes only binary/file/multipart/insecure requests to curl", () => {
    expect(needsCurl({ method: "GET", url: "http://x/" })).toBe(false);
    expect(needsCurl({ method: "GET", url: "http://x/", binaryResponse: true })).toBe(true);
    expect(needsCurl({ method: "PUT", url: "http://x/", bodyFile: "/f" })).toBe(true);
    expect(needsCurl({ method: "GET", url: "https://x/", insecure: true })).toBe(true);
  });

  it("builds multipart args with a sanitised filename", () => {
    const a = curlArgs({
      method: "post",
      url: "http://h/server/files/upload",
      headers: { "X-Api-Key": "k" },
      form: { fields: { root: "gcodes" }, file: { field: "file", path: "/s/f1.gcode", filename: 'a;b"c.gcode' } },
      timeoutSecs: 300,
      insecure: true,
    });
    expect(a).toEqual([
      "-sS", "-X", "POST", "-m", "300", "-k",
      "-H", "X-Api-Key: k",
      "--form-string", "root=gcodes",
      "-F", "file=@/s/f1.gcode;filename=a_b_c.gcode",
      "--url", "http://h/server/files/upload",
    ]);
  });

  it("streams a body file and passes digest credentials", () => {
    const a = curlArgs({ method: "PUT", url: "http://h/x", bodyFile: "/s/f", digest: { user: "maker", pass: "pw" } });
    expect(a).toContain("--digest");
    expect(a[a.indexOf("-u") + 1]).toBe("maker:pw");
    expect(a[a.indexOf("--data-binary") + 1]).toBe("@/s/f");
  });

  it("parses wrapper output (text and base64)", () => {
    expect(parseCurlOutput("PFMETA 0 200 application/json\n{\"ok\":true}", false)).toEqual({
      rc: 0,
      res: { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}', contentType: "application/json" },
    });
    const b = parseCurlOutput("PFMETA 0 200 image/jpeg\n/9j/AA==\n", true);
    expect(b.res.bodyBase64).toBe("/9j/AA==");
    expect(parseCurlOutput("PFMETA 7 000 \n", false).rc).toBe(7);
  });

  it("extracts the digest uri", () => {
    expect(pathOf("http://h:80/api/v1/status?x=1")).toBe("/api/v1/status?x=1");
    expect(pathOf("http://h")).toBe("/");
  });
});
