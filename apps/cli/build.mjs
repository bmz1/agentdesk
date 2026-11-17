// Bundles the CLI into one executable ESM file with no runtime dependencies.
import { chmodSync } from "node:fs"
import { build } from "esbuild"

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info"
})
chmodSync("dist/main.js", 0o755)
