import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const localApi = process.env.CHANAKYA_DEV_API_URL || 'http://127.0.0.1:3001';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(localApi))
  throw new Error('CHANAKYA_DEV_API_URL must be a loopback API address.');

export default defineConfig({
  plugins: [react()],
  base: './',
  // Desktop release folders contain complete dependency trees and HTML files.
  // Only the application entry belongs in Vite's dependency scan.
  optimizeDeps: { entries: ['index.html'] },
  server: {
    port: 5173,
    watch: { ignored: ['**/release-*/**', '**/backend-runtime/**'] },
    proxy: {
      '/api': { target: localApi, changeOrigin: true },
      '/ocr': { target: localApi, changeOrigin: true },
    },
  },
});
