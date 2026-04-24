import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://axon-5zf.pages.dev',
  base: '/learn',
  trailingSlash: 'never',
  outDir: '../landing/learn',
  integrations: [
    mdx(),
    sitemap(),
  ],
  markdown: {
    shikiConfig: {
      theme: 'github-dark-dimmed',
      wrap: false,
    },
  },
  build: {
    format: 'directory',
    assets: '_astro',
  },
  vite: {
    build: {
      emptyOutDir: true,
    },
  },
});
