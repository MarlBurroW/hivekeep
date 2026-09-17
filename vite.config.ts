import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/client',
  resolve: {
    dedupe: ['react', 'react-dom', 'react-dom/client'],
    alias: {
      '@/server': path.resolve(__dirname, 'src/server'),
      '@/client': path.resolve(__dirname, 'src/client'),
      '@/shared': path.resolve(__dirname, 'src/shared'),
      // Force all React imports to the root node_modules (avoid site/ copy)
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom'],
  },
  server: {
    host: true,
    port: 5173,
    warmup: {
      clientFiles: [
        './pages/chat/ChatPage.tsx',
        './pages/settings/SettingsPage.tsx',
        './pages/login/LoginPage.tsx',
        './components/mini-app/MiniAppViewer.tsx',
        './components/chat/ChatPanel.tsx',
      ],
    },
    watch: {
      usePolling: true,
      interval: 1000,
    },
    fs: {
      allow: [path.resolve(__dirname)],
    },
    proxy: {
      // Terminal WebSocket (must be declared before the generic /api rule)
      '/api/terminal/ws': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
      '/api/sse': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // SSE: disable proxy response buffering so events stream through immediately
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache'
            proxyRes.headers['x-accel-buffering'] = 'no'
          })
        },
      },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // HIVEKEEP_BUILD_OUTDIR lets the self-updater build into a staging dir
    // (e.g. dist/client.staging) instead of the live dist/client, so a failed
    // build never wipes what the running server is serving. Normal builds
    // (CI, `bun run build`) leave it unset and target dist/client as before.
    outDir: path.resolve(__dirname, process.env.HIVEKEEP_BUILD_OUTDIR || 'dist/client'),
    emptyOutDir: true,
    // Let Rollup split the graph: hand-grouping dependencies pulled the editor
    // and shared helpers into the login page's preload chain.
  },
})
