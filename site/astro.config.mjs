import { defineConfig } from 'astro/config';
import autoprefixer from 'autoprefixer';
import icon from 'astro-icon';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// Site UI locales. English lives at the root (/), every other locale under
// /<code>/ (see src/i18n/index.ts and src/pages/[lang]/). Keep in sync with
// LOCALES in src/i18n/index.ts.
const locales = ['en', 'fr', 'es', 'de', 'pt-BR', 'zh-CN', 'ja', 'ru', 'it', 'pl'];

// Custom domain: served at https://hivekeep.app/
export default defineConfig({
  site: 'https://hivekeep.app',
  base: '/',
  i18n: {
    defaultLocale: 'en',
    locales,
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    icon(),
    react(), // for @lobehub/icons (colored provider marks, SSR-only, no client JS)
    sitemap({
      // hreflang alternates in the sitemap for every localized page
      i18n: {
        defaultLocale: 'en',
        locales: Object.fromEntries(locales.map((l) => [l, l])),
      },
    }), // emits sitemap-index.xml + sitemap-0.xml under the / base
  ],
  vite: {
    // Keep prefixing our custom CSS after removing the unused Tailwind integration.
    css: { postcss: { plugins: [autoprefixer()] } },
    // @lobehub/icons ships extensionless internal ESM imports — bundle it so Vite resolves them.
    ssr: { noExternal: ['@lobehub/icons'] },
  },
});
