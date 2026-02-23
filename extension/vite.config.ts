import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(new URL('.', import.meta.url).pathname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(new URL('.', import.meta.url).pathname, 'src/popup/index.html'),
        background: resolve(new URL('.', import.meta.url).pathname, 'src/background/index.ts'),
        content: resolve(new URL('.', import.meta.url).pathname, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'background') return 'background.js';
          if (chunk.name === 'content') return 'content.js';
          return '[name]-[hash].js';
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (info) => {
          if (info.name?.endsWith('.css')) return 'content.css';
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
    // Service workers 不支持 ES modules in Chrome, 但 popup 和 content 可以
    target: 'es2020',
  },
});
