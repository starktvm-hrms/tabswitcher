import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Absolute base: the audience page lives at /p/CODE, so asset URLs must not be relative.
  base: '/',
  server: {
    // `npm run server` runs the poll + workspace API locally on 8791.
    proxy: { '/api': 'http://127.0.0.1:8791', '/files': 'http://127.0.0.1:8791' },
  },
});
