import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Allow Railway preview to serve on custom domain/host
  preview: {
    host: true,
    allowedHosts: true, // or provide an array of allowed hosts
  },
  // Optional: match dev behavior to accept external hosts
  server: {
    host: true,
    allowedHosts: true,
  },
})
