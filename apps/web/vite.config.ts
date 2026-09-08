import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: `${appRoot}index.html`,
        recovery: `${appRoot}recovery.html`,
      },
    },
  },
})
