import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the build works when served from any subpath.
  base: './',
  server: {
    proxy: {
      // In dev, vite serves the client with hot reload and the websocket
      // is proxied to `wrangler dev` (the real multiplayer server).
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
})
