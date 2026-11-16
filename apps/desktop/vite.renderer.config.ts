import { defineConfig } from "vite"
import { rendererConfig } from "./vite.shared"

/** Browser-only renderer (no Electron) for fast iteration and Playwright tests. */
export default defineConfig(rendererConfig())
