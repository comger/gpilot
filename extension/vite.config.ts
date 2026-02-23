import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = process.env.VITE_BUILD_TARGET || 'popup';

export default defineConfig({
  plugins: [target === 'popup' ? react() : []],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: target === 'popup',
    lib: target === 'popup' ? false : {
      entry: resolve(__dirname, target === 'content' ? 'src/content/index.ts' : 'src/background/index.ts'),
      formats: [target === 'content' ? 'iife' : 'es'],
      name: target === 'content' ? 'GpilotContent' : 'GpilotBackground',
      fileName: () => (target === 'content' ? 'content.js' : 'background.js'),
    },
    rollupOptions: target === 'popup' ? {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (info) => {
          if (info.name === 'index.css' || info.name === 'popup.css') return 'popup.css';
          return 'assets/[name]-[hash][extname]';
        },
      }
    } : {
      output: {
        assetFileNames: (info) => {
          if (info.name === 'index.css' || info.name === 'style.css' || info.name === 'content.css') return 'content.css';
          return 'assets/[name]-[hash][extname]';
        }
      }
    },
    target: 'es2020',
  },
});
