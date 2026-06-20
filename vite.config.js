import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const CHUNK_GROUPS = [
  { name: 'firebase', test: /node_modules[\\/](@firebase|firebase)[\\/]/ },
  { name: 'motion', test: /node_modules[\\/]framer-motion[\\/]/ },
  { name: 'qr-scanner', test: /node_modules[\\/]html5-qrcode[\\/]/ },
  { name: 'qr-generator', test: /node_modules[\\/]qrcode\.react[\\/]/ },
  { name: 'sheets', test: /node_modules[\\/](read-excel-file|@json2csv)[\\/]/ },
  { name: 'icons', test: /node_modules[\\/]lucide-react[\\/]/ }
]

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const match = CHUNK_GROUPS.find(group => group.test.test(id))
          return match ? match.name : undefined
        }
      }
    }
  }
})
