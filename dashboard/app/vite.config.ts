import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // src/lib/carbon.ts reuses the CLI's EcoLogits port, so the dev server must read above dashboard/app.
  server: {
    // Every interface, the same default the served dashboard uses, so a phone on this network can open the dev build.
    host: true,
    fs: {
      allow: [path.resolve(import.meta.dirname, "../..")],
    },
  },
  // Tersio serves on an ephemeral 127.0.0.1 port and exports a file:// snapshot: one self-contained html, no /assets.
  build: {
    outDir: path.resolve(import.meta.dirname, "../dist"),
    emptyOutDir: true,
    assetsInlineLimit: 100 * 1024 * 1024,
    chunkSizeWarningLimit: 1024,
  },
})
