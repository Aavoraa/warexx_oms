// The whole website on this computer, online through a Cloudflare Tunnel:
//
//     node tools/run-local.mjs            (or run_local.bat in the folder above)
//
//   * the landing page and the demo           — tools/serve-site.mjs, :8030
//   * the lead API + the leads database       — ../lead-api/server.py, :8003,
//     a SQLite file in lead-api/data/ (nothing leaves this computer)
//   * a public https address for both         — cloudflared, so a visitor
//     anywhere can open the demo link in their email while this PC is on
//
// Every free trial is emailed the demo link + login email + a temporary
// password (DEMO_EMAIL_PASSWORD=1), sent by the mailbox set in ../.env
// (Gmail: see .env.example). Ctrl+C stops everything.
//
// The quick tunnel's address (https://<random>.trycloudflare.com) changes every
// time this starts, so links in emails sent before a restart stop working. For
// a fixed address, create a named tunnel in Cloudflare and set in ../.env:
//     CLOUDFLARE_TUNNEL_TOKEN=…        DEMO_PUBLIC_URL=https://demo.your-domain.com/demo/
//
//   --no-tunnel   this computer only (links point at http://localhost:8030)
//   --build       rebuild the site first (it is built anyway when missing)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(FRONT, '..')
const SITE_PORT = +(process.env.PORT || 8030)
const API_PORT = +(process.env.LEAD_API_PORT || 8003)
const args = new Set(process.argv.slice(2))
const kids = []
let stopping = false

// ../.env: the mailbox and anything else set there (the environment wins)
const env = { ...process.env }
const envFile = path.join(ROOT, '.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && m[2] && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  }
}
env.DEMO_EMAIL_PASSWORD ??= '1'
if (env.LEAD_MAIL_BACKEND === 'smtp' && (!env.LEAD_SMTP_PASSWORD || /your\.name@/.test(env.LEAD_SMTP_USER || ''))) {
  console.error('\n.env: LEAD_MAIL_BACKEND=smtp, but LEAD_SMTP_USER / LEAD_SMTP_PASSWORD are not filled in —' +
    '\nemails would fail. Fill them in (Gmail: an App Password) or set LEAD_MAIL_BACKEND=console.\n')
  process.exit(1)
}

const say = (s) => console.log(`[local] ${s}`)
function stopAll(code = 0) {
  stopping = true
  for (const k of kids) {
    try {   // the whole tree: py.exe starts python.exe
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(k.pid), '/T', '/F'], { stdio: 'ignore' })
      else k.kill()
    } catch { /* gone */ }
  }
  process.exit(code)
}
process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))

function run(name, cmd, argv, opts = {}) {
  const k = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts })
  kids.push(k)
  const out = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) console.log(l.startsWith(`[${name}]`) ? l : `[${name}] ${l}`) }
  k.stdout.on('data', out); k.stderr.on('data', out)
  k.on('exit', (c) => { if (!stopping) { say(`${name} stopped (exit ${c}) — stopping everything`); stopAll(1) } })
  return k
}

function python() {
  for (const [cmd, pre] of [['py', ['-3']], ['python3', []], ['python', []]]) {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8' })
    if (r.status === 0 && /Python 3/.test(r.stdout + r.stderr)) return [cmd, pre]
  }
  console.error('Python 3 is needed for the lead API: https://www.python.org/downloads/'); process.exit(1)
}

function cloudflared() {
  const tries = ['cloudflared', 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe', path.join(ROOT, 'tools', 'cloudflared.exe')]
  for (const c of tries) if (spawnSync(c, ['--version'], { encoding: 'utf8' }).status === 0) return c
  return null
}

// 1. the site, built
if (args.has('--build') || !existsSync(path.join(FRONT, 'dist', 'site', 'index.html'))) {
  say('building the site…')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const s of ['build', 'build:site']) {
    if (spawnSync(npm, ['run', s], { cwd: FRONT, stdio: 'inherit', shell: true }).status !== 0) process.exit(1)
  }
}

// 2. the admin API's password: ../.env ADMIN_PASSWORD, else one kept in lead-api/data/
if (!env.ADMIN_PASSWORD) {
  const f = path.join(ROOT, 'lead-api', 'data', 'admin-password.local.txt')
  if (!existsSync(f)) {
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, 'local-' + randomBytes(12).toString('base64url'))
  }
  env.ADMIN_PASSWORD = readFileSync(f, 'utf8').trim()
}

// 2b. orders and staff accounts: the secret that signs sessions, from ../.env, else one
//     kept in lead-api/data/; an empty database starts with the sample business and
//     one Super Admin, whose one-time password goes in lead-api/data/ too
if (!env.ACCOUNTS_SECRET) {
  const f = path.join(ROOT, 'lead-api', 'data', 'accounts-secret.local.txt')
  if (!existsSync(f)) {
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, randomBytes(48).toString('base64url'))
  }
  env.ACCOUNTS_SECRET = readFileSync(f, 'utf8').trim()
}

// 3. the public address
let publicUrl = ''
if (!args.has('--no-tunnel')) {
  const cf = cloudflared()
  if (!cf) {
    console.error('\ncloudflared is not installed. Install it once with:\n    winget install --id Cloudflare.cloudflared\n' +
      'then run this again (or use --no-tunnel to run on this computer only).')
    process.exit(1)
  }
  if (env.CLOUDFLARE_TUNNEL_TOKEN) {
    if (!env.DEMO_PUBLIC_URL) { console.error('CLOUDFLARE_TUNNEL_TOKEN is set: set DEMO_PUBLIC_URL in .env to its address + /demo/'); process.exit(1) }
    run('tunnel', cf, ['tunnel', '--no-autoupdate', 'run', '--token', env.CLOUDFLARE_TUNNEL_TOKEN])
    publicUrl = env.DEMO_PUBLIC_URL.replace(/\/demo\/?$/, '').replace(/\/$/, '')
  } else {
    say('opening a Cloudflare quick tunnel…')
    publicUrl = await new Promise((resolve) => {
      const k = spawn(cf, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${SITE_PORT}`],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      kids.push(k)
      const timer = setTimeout(() => { console.error('the tunnel did not start within 60 s'); stopAll(1) }, 60000)
      const look = (b) => {
        const m = String(b).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
        if (m) { clearTimeout(timer); resolve(m[0]) }
      }
      k.stdout.on('data', look); k.stderr.on('data', look)
      k.on('exit', (c) => { if (!stopping) { say(`tunnel stopped (exit ${c}) — stopping everything`); stopAll(1) } })
    })
    env.DEMO_PUBLIC_URL = publicUrl + '/demo/'
  }
  env.LEAD_TRUST_CF = '1'
}

// this computer only: nobody else can reach the site, so the app's Super Admin goes
// straight into the orders. Online (a tunnel), the order password stays.
if (args.has('--no-tunnel')) {
  env.SITE_HOST ??= '127.0.0.1'
  env.OMS_OPEN_LOCAL ??= '1'
}

// 4. the lead API (and its database), then the site in front of it
const [py, pre] = python()
{
  const r = spawnSync(py, [...pre, path.join(ROOT, 'lead-api', 'oms_load.py'), '--sample', '--if-empty'],
    { env: { ...env, PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8' })
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1) }
  say(r.stdout.trim())
  const u = spawnSync(py, [...pre, path.join(ROOT, 'lead-api', 'accounts_admin.py'), '--username', 'owner', '--full-name', 'Owner', '--if-none',
    '--password-file', path.join(ROOT, 'lead-api', 'data', 'superadmin-password.local.txt')],
    { env: { ...env, PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8' })
  if (u.status !== 0) { console.error(u.stderr || u.stdout); process.exit(1) }
  say(u.stdout.trim())
}
run('lead api', py, [...pre, path.join(ROOT, 'lead-api', 'server.py')],
  { env: { ...env, LEAD_API_PORT: String(API_PORT), PYTHONIOENCODING: 'utf-8' } })
run('site', process.execPath, [path.join(FRONT, 'tools', 'serve-site.mjs')],
  { env: { ...env, PORT: String(SITE_PORT), LEAD_API_URL: `http://127.0.0.1:${API_PORT}` } })

// where the leads are kept (store.py's order), without the password
function dbNote() {
  const url = ['LEADS_DATABASE_URL', 'POSTGRES_URL', 'DATABASE_URL'].map((k) => (env[k] || '').trim())
    .find((v) => /^postgres(ql)?:\/\//.test(v))
  if (!url) return 'lead-api\\data\\leads.db (SQLite, this computer only)'
  try { const u = new URL(url); return `PostgreSQL ${u.hostname}:${u.port || 5432}${u.pathname}` } catch { return 'PostgreSQL' }
}

setTimeout(() => {
  const base = publicUrl || `http://localhost:${SITE_PORT}`
  const mail = (env.LEAD_MAIL_BACKEND || 'console') === 'smtp'
    ? `sent from ${env.LEAD_SMTP_USER || '(LEAD_SMTP_USER not set)'}`
    : 'NOT sent — saved in lead-api\\outbox (set LEAD_MAIL_BACKEND=smtp in .env)'
  console.log(`
  ──────────────────────────────────────────────────────────────
   WAREXX website, running on this computer
     Website   ${base}/
     Demo      ${base}/demo/
     On this PC: http://localhost:${SITE_PORT}/
     Staff     ${base}/demo/?staff=1   first password: lead-api\\data\\superadmin-password.local.txt
     Orders    Order Management; ${args.has('--no-tunnel') ? 'no sign-in needed on this computer' : 'staff sign in'}
     Emails    ${mail}
     Database  ${dbNote()}
   Keep this window open; Ctrl+C stops everything.
  ──────────────────────────────────────────────────────────────`)
}, 2500)
