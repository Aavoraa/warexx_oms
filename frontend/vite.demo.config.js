import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { mobileMiddleware, writeMobile } from './tools/mobile-page.mjs'

// The interactive demo (demo/): the WAREXX app — the snapshot in
// vendor/warexx-app, see tools/sync-app.mjs — with demo/public/sw.js as its
// server, answering from the recorded sample business in ../demo-data/recorded.
// No production backend, database or API is involved, in dev or in a build.
//   npm run dev:demo        (http://localhost:8002)
//   npm run build:demo      (→ dist/demo, static files)
//   npm run preview:demo    (serves dist/demo on :8002)
// It must be served from the ROOT of its origin (e.g. https://demo.warexx.aavoraa.com/):
// the service worker has to answer /api and /pos, which only a worker at "/" can.
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
// DEMO_BASE / DEMO_OUT: set by tools/site.mjs to build the demo for /demo/ on
// the landing page's own site. Unset: the demo at the root of its own origin.
const BASE = process.env.DEMO_BASE || '/'
const OUT = process.env.DEMO_OUT ? path.resolve(process.env.DEMO_OUT) : here('./dist/demo')
const DATA = here('../demo-data/recorded')

// /m — the WAREXX phone app, see tools/mobile-page.mjs. Written into the build,
// and answered by the dev and preview servers so that /m/grn/12 and the like
// open the phone app rather than the desktop demo.
const phoneApp = () => ({
  name: 'warexx-phone-app',
  configureServer: (s) => { s.middlewares.use(mobileMiddleware()) },
  configurePreviewServer: (s) => { s.middlewares.use(mobileMiddleware()) },
  closeBundle: () => writeMobile(OUT),
})

// /data — the demo dataset (manifest.json + bodies/), kept in demo-data/ beside
// the tools that record it. sw.js reads it from /data/ on the demo's own origin.
const TYPES = { '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' }
const serveData = (req, res, next) => {
  const url = new URL(req.url, 'http://x')
  if (!url.pathname.startsWith('/data/')) return next()
  const f = path.join(DATA, decodeURIComponent(url.pathname.slice('/data/'.length)))
  if (!f.startsWith(DATA) || !existsSync(f) || !statSync(f).isFile()) { res.statusCode = 404; return res.end() }
  res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream')
  res.end(readFileSync(f))
}
const demoData = () => ({
  name: 'warexx-demo-data',
  configureServer: (s) => { s.middlewares.use(serveData) },
  configurePreviewServer: (s) => { s.middlewares.use(serveData) },
  closeBundle: () => {
    if (!existsSync(path.join(DATA, 'manifest.json'))) throw new Error('demo-data/recorded/manifest.json is missing')
    cpSync(DATA, path.join(OUT, 'data'), { recursive: true, filter: (src) => !src.endsWith('.orig') })
  },
})

export default defineConfig({
  plugins: [react(), phoneApp(), demoData()],
  base: BASE,
  root: here('./demo'),
  // landing-demo/.env* (VITE_* only — public values, see ../.env.example)
  envDir: here('..'),
  publicDir: here('./demo/public'),
  build: { outDir: OUT, emptyOutDir: true },
  // OMS_API_URL=http://127.0.0.1:8003 sends orders and accounts to the real API
  preview: { port: 8002, strictPort: true,
    ...(process.env.OMS_API_URL ? { proxy: { '/api/oms': process.env.OMS_API_URL, '/api/auth': process.env.OMS_API_URL, '/api/users': process.env.OMS_API_URL } } : {}) },
  // the recorder's browser profile and scratch databases are locked files, not
  // source, so the watcher skips them
  server: { port: 8002, strictPort: true,
    fs: { allow: [here('.'), here('../demo-data')] },
    watch: { ignored: ['**/.record-profile/**', '**/demo-build/**', '**/*.log'] } },
})
