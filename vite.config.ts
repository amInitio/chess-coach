import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// './' keeps all asset paths relative, so the app works under https://<user>.github.io/<repo>/
export default defineConfig({ base: './', plugins: [react()] });
