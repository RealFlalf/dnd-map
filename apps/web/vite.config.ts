import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    // Explicit IPv4: on Windows `localhost` may bind to [::1] only, which some setups block.
    host: '127.0.0.1',
    // Same-origin proxy: the browser talks only to Vite, so no CORS in development.
    proxy: {
      '/api': apiTarget,
      '/socket.io': { target: apiTarget, ws: true },
    },
  },
});
