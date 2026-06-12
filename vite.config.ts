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
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // React core - rarely changes
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          // UI framework
          'vendor-ui': ['radix-ui', 'lucide-react', 'class-variance-authority', 'clsx', 'tailwind-merge', 'sonner', 'cmdk'],
          // Markdown rendering (heavy)
          // react-markdown core; remark-math (pulls katex), rehype-katex & rehype-highlight are lazy-loaded on demand
'vendor-markdown': ['react-markdown', 'remark-gfm'],
          // CodeMirror editor (heavy, used only in specific views)
          'vendor-codemirror': ['@uiw/react-codemirror', '@codemirror/lang-markdown', '@codemirror/language-data', '@codemirror/view'],
          // Forms
          'vendor-forms': ['react-hook-form', '@hookform/resolvers', 'zod'],
          // i18n
          'vendor-i18n': ['i18next', 'react-i18next'],
          // DnD
          'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
        },
      },
    },
  },
})
