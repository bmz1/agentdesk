import { resolve } from "node:path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import { rendererConfig } from "./vite.shared"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(import.meta.dirname, "src/main/index.ts") } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" }
      }
    }
  },
  renderer: rendererConfig()
})
