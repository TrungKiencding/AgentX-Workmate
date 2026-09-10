import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Deployed at the root of its own host (Vercel / Netlify / a Pages project with
// a custom domain). `base` stays absolute because the vendored fonts are public
// assets referenced from CSS as `/fonts/…`, and Vite does not rewrite those for
// a relative base. Moving the page under a sub-path means changing `base` here
// AND the two preload hrefs in index.html.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: { outDir: 'dist', assetsInlineLimit: 2048 }
})
