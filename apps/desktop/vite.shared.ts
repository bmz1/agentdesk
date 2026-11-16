import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import type { UserConfig } from "vite"

export const rendererConfig = (): UserConfig => ({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  // Router plugin must come before the React plugin.
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: resolve(__dirname, "src/renderer/routes"),
      generatedRouteTree: resolve(__dirname, "src/renderer/routeTree.gen.ts")
    }),
    react(),
    tailwindcss()
  ],
  resolve: { alias: { "@": resolve(__dirname, "src/renderer") } },
  build: { outDir: resolve(__dirname, "out/renderer"), emptyOutDir: true },
  server: { port: 5173, strictPort: true }
})
