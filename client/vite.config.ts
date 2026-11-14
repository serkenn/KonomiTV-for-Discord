import { defineConfig } from 'vite';

export default defineConfig({
    // Discord のプロキシ配下でも動くように相対パスで出力する
    base: './',
    build: { outDir: 'dist', target: 'es2022', sourcemap: false },
    server: {
        proxy: { '/api': { target: 'http://127.0.0.1:7100', ws: true } },
    },
});
