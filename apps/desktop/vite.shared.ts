import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import type { Plugin, UserConfig } from "vite"

// The React Refresh preamble is an inline <script>; allow inline scripts only on the dev server.
const devInlineScripts = (): Plugin => ({
  name: "agentdesk:dev-csp",
  apply: "serve",
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
})

export const rendererConfig = (): UserConfig => ({
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  // Router plugin must come before the React plugin.
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: resolve(import.meta.dirname, "src/renderer/routes"),
      generatedRouteTree: resolve(import.meta.dirname, "src/renderer/routeTree.gen.ts")
    }),
    react(),
    tailwindcss(),
    devInlineScripts()
  ],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer") } },
  build: { outDir: resolve(import.meta.dirname, "out/renderer"), emptyOutDir: true },
  server: { port: 5173, strictPort: true }
})
