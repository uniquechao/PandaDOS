import { defineConfig } from 'vite';

// root = ui，产物落根目录 public（控制面静态服务）
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
