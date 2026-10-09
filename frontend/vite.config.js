import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const localApi = process.env.CHANAKYA_DEV_API_URL || 'http://127.0.0.1:3001';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(localApi))
  throw new Error('CHANAKYA_DEV_API_URL must be a loopback API address.');

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: localApi, changeOrigin: true },
      '/ocr': { target: localApi, changeOrigin: true },
    },
  },
});
