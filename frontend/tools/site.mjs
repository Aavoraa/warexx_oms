// The landing page and the interactive demo as ONE site, on one domain:
//
//     /              the landing page
//     /demo/         the interactive demo ("Book a demo" opens it)
//     /api/leads     the landing forms' email endpoint (api/leads.py on Vercel)
//     /sw.js /data/ /m/   the demo's stand-in server, its dataset, its phone app
//
//     npm run build:site        → dist/site/  (what landing-demo/vercel.json deploys)
//
// Why the demo's server files sit at the root: the WAREXX app calls /api/... and
// /pos/... from the root of the domain, and only a service worker at /sw.js may
// answer those. The worker answers everything under /api except /api/leads, so
// the landing forms still reach the real endpoint — and nothing of the demo does.
//
// For a demo on a domain of its own later (demo.warexx.aavoraa.com), deploy
// build:demo separately and set VITE_DEMO_URL; see ../README.md.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as buildLanding } from './landing.mjs'
import { DEMO_CSP } from './mobile-page.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.resolve(HERE, '..')
const SITE = path.join(FRONTEND, 'dist', 'site')
const TMP = path.join(FRONTEND, 'dist', '.site-demo')

// 1. the landing page, at the root
const cfg = buildLanding(SITE)
if (/^https?:\/\//i.test(cfg.demoAppUrl)) {
  console.warn(`[site] note: VITE_DEMO_URL is ${cfg.demoAppUrl}, so "Book a demo" opens that address,`
    + ' not the /demo/ built into this site.')
}

// 2. the demo, built for /demo/
rmSync(TMP, { recursive: true, force: true })
const vite = path.join(FRONTEND, 'node_modules', 'vite', 'bin', 'vite.js')
const r = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.demo.config.js'], {
  cwd: FRONTEND, stdio: 'inherit', env: { ...process.env, DEMO_BASE: '/demo/', DEMO_OUT: TMP,
    // the demo on this site: its sign-up for a booked slot (demo/trial.jsx) talks
    // to this site's /api/trial, and its links back go to this site's landing page
    VITE_DEMO_TRIAL: process.env.VITE_DEMO_TRIAL ?? '1',
    VITE_LANDING_URL: process.env.VITE_LANDING_URL ?? '/' },
})
if (r.status !== 0) process.exit(r.status || 1)

// 3. put it together: the page and its bundle under /demo/, the worker, the
//    dataset and the phone app at the root
const DEMO = path.join(SITE, 'demo')
mkdirSync(DEMO, { recursive: true })
renameSync(path.join(TMP, 'index.html'), path.join(DEMO, 'index.html'))
renameSync(path.join(TMP, 'assets'), path.join(DEMO, 'assets'))
for (const name of readdirSync(TMP)) {
  if (name === '_headers' || name === '_redirects') continue        // the site's own, below
  if (name.startsWith('favicon')) cpSync(path.join(TMP, name), path.join(DEMO, name))
  cpSync(path.join(TMP, name), path.join(SITE, name), { recursive: true })
}
rmSync(TMP, { recursive: true, force: true })

// 4. headers and fallbacks for Netlify / Cloudflare Pages (vercel.json has the same)
writeFileSync(path.join(SITE, '_headers'), [
  '/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin',
  '/index.html', '  Cache-Control: no-cache',
  '/demo/*', `  Content-Security-Policy: ${DEMO_CSP}`, '  X-Robots-Tag: noindex',
  '/m/*', `  Content-Security-Policy: ${DEMO_CSP}`, '  X-Robots-Tag: noindex',
  '/demo/assets/*', '  Cache-Control: public, max-age=0, must-revalidate',
  '/sw.js', '  Cache-Control: no-cache', '  Service-Worker-Allowed: /',
  '/data/*', '  Cache-Control: no-cache',
].join('\n') + '\n')
writeFileSync(path.join(SITE, '_redirects'), [
  '/demo     /demo/index.html  200',
  '/m        /m/index.html     200',
  '/m/*      /m/index.html     200',
  `/app      ${cfg.appUrl}  302`,
].join('\n') + '\n')

const need = ['index.html', 'demo/index.html', 'sw.js', 'data/manifest.json', 'm/index.html']
const missing = need.filter((f) => !existsSync(path.join(SITE, f)))
if (missing.length) { console.error('[site] missing:', missing.join(', ')); process.exit(1) }
console.log('[site] built dist/site — / landing page, /demo/ interactive demo, /api/leads lead form')
