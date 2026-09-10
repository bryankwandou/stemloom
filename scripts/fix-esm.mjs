/**
 * Add file extensions to relative imports in a directory of compiled JS.
 *
 * TypeScript emits the specifier exactly as written, and the source writes
 * "./spectrogram" because that is what the bundler expects. Node's module
 * loader wants the extension. Rather than distort the source to suit a
 * check that runs occasionally, the fix goes here.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".tmp-check";

for (const name of readdirSync(dir)) {
  if (!name.endsWith(".js")) continue;
  const path = join(dir, name);
  const src = readFileSync(path, "utf8");
  const out = src.replace(
    /(from\s+["'])(\.\.?\/[^"']+?)(["'])/g,
    (m, a, spec, b) => (spec.endsWith(".js") ? m : a + spec + ".js" + b),
  );
  if (out !== src) {
    writeFileSync(path, out);
    console.log("rewrote imports in " + path);
  }
}
