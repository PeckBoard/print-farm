// A tiny monotonic counter kept in the plugin document store. Used for stable,
// sortable host ids and activity-log keys without needing a clock (the WASM
// sandbox has no reliable wall clock; timestamps come from the ssh host-fn
// responses instead).

import { storeGet, storePut } from "./host";

const META = "_meta";

export function nextSeq(name: string): number {
  const cur = storeGet(META, name);
  const n = (typeof cur === "number" && isFinite(cur) ? cur : 0) + 1;
  storePut(META, name, n);
  return n;
}
