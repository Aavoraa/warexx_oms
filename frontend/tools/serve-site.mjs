// Serve dist/site the way landing-demo/vercel.json does, to try the one-domain
// site locally:
//
//     npm run build:site && npm run preview:site     → http://localhost:8030/
//
// /demo/* and /m/* fall back to their index.html; /api/leads is forwarded to
// the lead API (python ../lead-api/server.py, LEAD_API_URL, default :8003).
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'site')
const PORT = +(process.env.PORT || 8030)
const leadApi = new URL(process.env.LEAD_API_URL || 'http://127.0.0.1:8003')
const CSP = "connect-src 'self'; form-action 'self'; base-uri 'self'"
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf', '.jpg': 'image/jpeg' }

if (!existsSync(path.join(SITE, 'index.html'))) { console.error('dist/site is missing — npm run build:site'); process.exit(1) }

createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (/^\/api\/(oms\/|auth\/|users(\/|$))/.test(url.pathname) || ['/api/leads', '/api/trial', '/api/admin', '/api/subscribe', '/api/payment/return', '/api/payment/webhook'].includes(url.pathname)) {
    const fwd = httpRequest({ hostname: leadApi.hostname, port: leadApi.port, path: url.pathname + url.search,
      method: req.method, headers: { ...req.headers, host: leadApi.host, 'x-forwarded-host': req.headers.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
    fwd.on('error', () => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"detail":"lead API not running"}') })
    return req.pipe(fwd)
  }
  if (url.pathname === '/api/geo') {
    // the visitor's country for the landing page's prices (api/geo.py on Vercel):
    // through a Cloudflare Tunnel (tools/run-local.mjs) Cloudflare adds it
    const c = String((process.env.LEAD_TRUST_CF === '1' && req.headers['cf-ipcountry']) || '').toUpperCase()
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' })
    return res.end(JSON.stringify({ country: /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : '' }))
  }
  let rel = decodeURIComponent(url.pathname)
  let file = path.join(SITE, rel)
  if (!file.startsWith(SITE)) { res.writeHead(400); return res.end() }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html')
  if (!existsSync(file)) {
    // a missing bundle file is a 404, never the page: HTML answered for a .css
    // or .js is what leaves a stale tab unstyled after a redeploy
    if (/^\/demo(\/|$)/.test(rel) && !rel.startsWith('/demo/assets/')) file = path.join(SITE, 'demo', 'index.html')
    else if (/^\/m(\/|$)/.test(rel)) file = path.join(SITE, 'm', 'index.html')
    else { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found') }
  }
  const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }
  if (/^\/(demo|m)(\/|$)/.test(rel)) headers['Content-Security-Policy'] = CSP
  if (rel === '/sw.js') headers['Service-Worker-Allowed'] = '/'
  res.writeHead(200, headers)
  res.end(readFileSync(file))
}).listen(PORT, process.env.SITE_HOST || undefined, () => console.log(`[site] http://localhost:${PORT}/  (demo at /demo/, lead form → ${leadApi.href}api/leads)`))
