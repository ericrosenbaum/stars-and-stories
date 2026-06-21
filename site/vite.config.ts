import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// On GitHub Project Pages the site is served from /<repo>/, so the build needs
// a matching base path. Set VITE_BASE (e.g. /stars-and-stories/) in CI; local
// dev and preview default to '/'.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
});
