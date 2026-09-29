import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [vue()],
  root,
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8601',
        changeOrigin: true
      }
    }
  }
})
