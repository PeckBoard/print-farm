#!/usr/bin/env node
// A tiny fake Moonraker for manual / browser checks of the Print Farm page.
//
//   node test/fixtures/fake-moonraker.js [port]
//
// Serves a printer that is mid-print (progress advances each status call),
// honours pause / resume / cancel / start, accepts multipart uploads, lists one
// webcam and serves test/fixtures/snapshot.jpg as its snapshot.
const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.argv[2] || 7125);
const jpeg = fs.readFileSync(path.join(__dirname, "snapshot.jpg"));
const st = { state: "printing", filename: "benchy_0.2mm_PLA.gcode", progress: 0.37, duration: 1820, layer: 46, total: 120, files: [] };

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let body = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      const p = u.pathname;
      console.log(req.method, req.url);
      if (p === "/printer/objects/query") {
        if (st.state === "printing") {
          st.progress = Math.min(0.999, st.progress + 0.002);
          st.duration += 2;
          st.layer = Math.max(1, Math.round(st.progress * st.total));
        }
        const printing = st.state === "printing" || st.state === "paused";
        return json(res, 200, {
          result: {
            status: {
              print_stats: { state: st.state, filename: printing || st.state === "complete" ? st.filename : "", print_duration: st.duration, message: "", info: { current_layer: printing ? st.layer : null, total_layer: printing ? st.total : null } },
              virtual_sdcard: { progress: printing ? st.progress : 0 },
              display_status: { progress: st.progress },
              extruder: { temperature: printing ? 214.6 + Math.random() : 31.2, target: printing ? 215 : 0 },
              heater_bed: { temperature: printing ? 59.8 + Math.random() * 0.4 : 27.5, target: printing ? 60 : 0 },
            },
          },
        });
      }
      if (p === "/server/info") return json(res, 200, { result: { moonraker_version: "v0.9.3-fake", klippy_state: "ready" } });
      if (p === "/server/webcams/list") {
        return json(res, 200, { result: { webcams: [{ name: "cam", enabled: true, snapshot_url: `http://127.0.0.1:${port}/webcam/?action=snapshot` }] } });
      }
      if (p === "/webcam/") {
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.length });
        return res.end(jpeg);
      }
      if (p === "/printer/print/pause") st.state = "paused";
      else if (p === "/printer/print/resume") st.state = "printing";
      else if (p === "/printer/print/cancel") st.state = "cancelled";
      else if (p === "/printer/print/start") {
        st.state = "printing";
        st.filename = u.searchParams.get("filename") || st.filename;
        st.progress = 0.001;
        st.duration = 0;
      } else if (p === "/server/files/upload") {
        const m = /filename="([^"]+)"/.exec(Buffer.concat(body).toString("latin1"));
        st.files.push(m ? m[1] : "upload.gcode");
        return json(res, 201, { result: { item: { path: m ? m[1] : "upload.gcode", root: "gcodes" }, action: "create_file" } });
      } else return json(res, 404, { error: { message: "not found: " + p } });
      return json(res, 200, { result: "ok" });
    });
  })
  .listen(port, "127.0.0.1", () => console.log("fake moonraker on", port));
