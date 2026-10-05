import {defineConfig} from 'vite';
export default defineConfig({base: './',build: {outDir: 'dist',emptyOutDir: true,rollupOptions:{input:{main:'index.html',controllerFit:'controller-fit.html'}}}});
