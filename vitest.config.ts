import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "apps/desktop/src/renderer") } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 20_000,
    pool: "forks"
  }
})
