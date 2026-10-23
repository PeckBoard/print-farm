// Hook + tool dispatch. Parses the `{ hook, payload }` envelope and routes each
// call to its handler. The wasm export functions live in `index.ts`.

import { skip, allow, cancel, errMsg } from "./verdict";
import { serveHttp, serveAuthed } from "./http";
import { TOOLS } from "./tools";

export function dispatch(hook: string, payload: any): string {
  switch (hook) {
    case "mcp.tool.invoke":
      return handleInvoke(payload);
    case "http.request.before":
      return serveHttp(payload);
    case "http.request.authed":
      return serveAuthed(payload);
    default:
      return skip();
  }
}

function handleInvoke(payload: any): string {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return cancel("malformed invoke payload: not an object");
  }
  const tool: string = typeof payload.tool === "string" ? payload.tool : "";
  const fn = TOOLS[tool];
  if (!fn) return cancel(`print-farm does not provide tool '${tool}'`);
  try {
    return allow(fn(payload.arguments ?? {}));
  } catch (e) {
    // A handler error is a normal tool result (the agent sees the message).
    return allow({ error: errMsg(e) });
  }
}
