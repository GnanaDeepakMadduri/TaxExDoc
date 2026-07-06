import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves this project from https://<user>.github.io/Tax-Extract/,
  // so built asset URLs need this subpath prefix (dev server is unaffected).
  base: '/Tax-Extract/',
  server: {
    port: 5173,
    proxy: {
      // Forward all /api/* calls to the FastAPI backend
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
