import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['shall-extends-protein-closely.trycloudflare.com', '.trycloudflare.com']
  }
})
