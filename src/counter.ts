// A tiny monotonic counter kept in the plugin document store. Used for stable,
// sortable host ids and activity-log keys without needing a clock (the WASM
// sandbox has no reliable wall clock; timestamps come from the ssh host-fn
// responses instead).

import { storeGet, storePut, storePutIfAbsent } from "./host";

const META = "_meta";
const CLAIMS = "_seq_claims";

/// Calls run on up to `concurrency` instances at once, so a plain
/// read-increment-write could hand two callers the same id. Each number is
/// claimed with an atomic put-if-absent; a lost race moves on to the next.
export function nextSeq(name: string): number {
  const cur = storeGet(META, name);
  let n = (typeof cur === "number" && isFinite(cur) ? cur : 0) + 1;
  for (let tries = 0; !storePutIfAbsent(CLAIMS, `${name}-${n}`, 1); tries++) {
    if (tries > 1000) throw new Error(`could not allocate a ${name} id`);
    n++;
  }
  const now = storeGet(META, name);
  if (!(typeof now === "number" && now >= n)) storePut(META, name, n);
  return n;
}
