import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the app from /<repository>/; the deploy workflow sets VITE_BASE. Local and server builds stay at '/'.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  // Every build is a new version: the service worker notices it and offers the update.
  define: { __APP_BUILD__: JSON.stringify(new Date().toISOString()) },
  plugins: [
    react(),
    VitePWA({
      // Never swap code under the user mid-tour: a new version waits for an explicit "update".
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'SiteFlow',
        short_name: 'SiteFlow',
        description: 'תיעוד עבודות להשלמה בסיורי שטח',
        lang: 'he',
        dir: 'rtl',
        display: 'standalone',
        start_url: base,
        scope: base,
        background_color: '#f4f6f9',
        theme_color: '#0F2340',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: `${base}index.html`,
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { proxy: { '/api': 'http://localhost:8787' } },
  preview: { proxy: { '/api': 'http://localhost:8787' } },
});
