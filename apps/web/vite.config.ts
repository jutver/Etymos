import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_PAGES } from './src/seo/pages.ts'
import { APP_SHELL, pageFile, robotsTxt, sitemapXml, withAppHead, withNotFoundHead, withPageHead } from './src/seo/build.ts'
import { notFoundBody, pageBody, withRootContent } from './src/seo/prerender.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Search-engine output from src/seo/pages.ts: the home page's tags in
 * index.html, a copy of it per public page with that page's own title and
 * description, plus sitemap.xml and robots.txt. */
function seo(): Plugin {
  let outDir = 'dist'
  const home = PUBLIC_PAGES.find((p) => p.path === '/')!
  return {
    name: 'etymos-seo',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    transformIndexHtml(html) {
      return withPageHead(html, home)
    },
    writeBundle() {
      // The built index.html (home's head, empty #root) is the template for
      // every page, so read it before the home page's own copy overwrites it.
      const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')
      for (const page of PUBLIC_PAGES) {
        const file = path.join(outDir, pageFile(page))
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, withRootContent(withPageHead(html, page), pageBody(page)))
      }
      fs.writeFileSync(path.join(outDir, APP_SHELL), withAppHead(html))
      // Vercel answers any path no file or rewrite claims with this, as a 404.
      fs.writeFileSync(path.join(outDir, '404.html'), withRootContent(withNotFoundHead(html), notFoundBody()))
      fs.writeFileSync(path.join(outDir, 'sitemap.xml'), sitemapXml(new Date().toISOString().slice(0, 10)))
      fs.writeFileSync(path.join(outDir, 'robots.txt'), robotsTxt())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  envDir: path.resolve(__dirname, '../..'),
  plugins: [react(), tailwindcss(), seo()],
  server: {
    port: 5173,
    strictPort: true,
  },
})
