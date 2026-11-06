// Put the live site's server settings on Vercel, from ../.env — without any
// value being printed, pasted into a chat or committed.
//
//   npx vercel login                      (once, as you)
//   npx vercel link                       (once, from the repo root: choose the project with the API,
//                                          e.g. pragi1 / warexx-demo-frontend)
//   node frontend/tools/vercel-env.mjs --domain warexx-demo-frontend.vercel.app [--dry-run]
//   npx vercel --prod                     (or Redeploy in the dashboard: settings apply to new deployments)
//
//   --mail-only   just the mailbox (LEAD_MAIL_* / LEAD_SMTP_*): nothing else is
//                 regenerated — sessions, the admin password and the webhook login stay
//
// What it sets (Production environment), see docs/PAYMENTS.md:
//   from .env as they are   HDFC_ENV, HDFC_MERCHANT_ID, HDFC_API_KEY, HDFC_RESPONSE_KEY,
//                           HDFC_PAYMENT_PAGE_CLIENT_ID, BILLING_GST_PERCENT,
//                           and the LEAD_MAIL_* / LEAD_SMTP_* mailbox when LEAD_MAIL_BACKEND=smtp
//   made for the domain     HDFC_RETURN_URL = https://<domain>/api/payment/return
//   new for the live site   DEMO_TRIAL_SECRET, ADMIN_PASSWORD, HDFC_WEBHOOK_USERNAME, HDFC_WEBHOOK_PASSWORD
//                           (random; the admin and webhook ones are also written to
//                           lead-api/data/live-settings.local.txt — git-ignored — because you
//                           use them with /api/admin and the HDFC dashboard)
//   always on               DEMO_EMAIL_PASSWORD=1
//
// NOT set here: the databases. This computer's PostgreSQL (localhost) cannot be
// reached from Vercel. Create them in the Vercel dashboard (Storage → Neon):
// one connected as it is (POSTGRES_URL: the leads), one connected with the
// custom prefix BILLING (BILLING_DATABASE_URL: billing).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const domain = (args[args.indexOf('--domain') + 1] || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const target = args.includes('--preview') ? 'preview' : 'production'
const mailOnly = args.includes('--mail-only')
if (!domain || args.indexOf('--domain') < 0 || /^(localhost|\d)/.test(domain)) {
  console.error('Give the live site\'s domain: --domain warexx-demo-frontend.vercel.app'); process.exit(1)
}
if (!existsSync(path.join(ROOT, '.vercel', 'project.json')) && !dry) {
  console.error('Not linked to a Vercel project yet: run  npx vercel login  then  npx vercel link  from ' + ROOT); process.exit(1)
}

const env = {}
for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
}
const need = ['HDFC_ENV', 'HDFC_MERCHANT_ID', 'HDFC_API_KEY', 'HDFC_RESPONSE_KEY', 'HDFC_PAYMENT_PAGE_CLIENT_ID', 'BILLING_GST_PERCENT']
const missing = mailOnly ? [] : need.filter((k) => !env[k])
if (missing.length) { console.error('.env is missing: ' + missing.join(', ')); process.exit(1) }

const secret = (n) => randomBytes(n).toString('base64url')
const out = {}
if (!mailOnly) {
for (const k of need) out[k] = env[k]
out.HDFC_RETURN_URL = `https://${domain}/api/payment/return`
out.DEMO_TRIAL_SECRET = secret(48)
out.ADMIN_PASSWORD = secret(15)
out.ACCOUNTS_SECRET = secret(48)
out.HDFC_WEBHOOK_USERNAME = 'warexx' + randomBytes(4).toString('hex')       // letters and digits only (HDFC's rule)
out.HDFC_WEBHOOK_PASSWORD = secret(24)
out.DEMO_EMAIL_PASSWORD = '1'
out.DEMO_PUBLIC_URL = `https://${domain}/demo/`
}
const mailReady = env.LEAD_MAIL_BACKEND === 'smtp' && env.LEAD_SMTP_PASSWORD && !/your\.name@/.test(env.LEAD_SMTP_USER || '')
if (mailReady) {
  for (const k of ['LEAD_MAIL_BACKEND', 'LEAD_MAIL_FROM', 'LEAD_NOTIFY_TO', 'LEAD_SMTP_HOST', 'LEAD_SMTP_PORT', 'LEAD_SMTP_USER', 'LEAD_SMTP_PASSWORD']) {
    if (env[k]) out[k] = env[k]
  }
}

console.log(`Vercel (${target}) settings for https://${domain}:`)
for (const k of Object.keys(out)) console.log('  ' + k)
if (mailOnly && !mailReady) {
  console.error('.env has no real mailbox yet: set LEAD_MAIL_BACKEND=smtp, LEAD_MAIL_FROM, LEAD_SMTP_HOST, LEAD_SMTP_PORT, LEAD_SMTP_USER and LEAD_SMTP_PASSWORD')
  process.exit(1)
}
if (!mailReady) console.log('  (no mailbox: LEAD_MAIL_BACKEND is not smtp in .env, or its user/password are placeholders — emails will not be sent live)')
if (dry) { console.log('\n--dry-run: nothing was changed.'); process.exit(0) }

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
for (const [k, v] of Object.entries(out)) {
  spawnSync(npx, ['vercel', 'env', 'rm', k, target, '--yes'], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' })
  const r = spawnSync(npx, ['vercel', 'env', 'add', k, target], { cwd: ROOT, input: v, stdio: ['pipe', 'ignore', 'pipe'], shell: process.platform === 'win32' })
  if (r.status !== 0) { console.error(`  FAILED ${k}: ${String(r.stderr || '').split('\n').filter(Boolean).pop() || 'vercel env add failed'}`); process.exit(1) }
  console.log('  set ' + k)
}
if (mailOnly) { console.log('Done (mailbox only). Next: redeploy.'); process.exit(0) }
const keep = path.join(ROOT, 'lead-api', 'data')
mkdirSync(keep, { recursive: true })
writeFileSync(path.join(keep, 'live-settings.local.txt'),
  `Live site: https://${domain}  (written ${new Date().toISOString()})\n\n` +
  `Admin API    https://${domain}/api/admin   password: ${out.ADMIN_PASSWORD}\n\n` +
  `HDFC SmartGateway dashboard → Settings → Webhooks:\n` +
  `  Webhook URL  https://${domain}/api/payment/webhook\n  Username     ${out.HDFC_WEBHOOK_USERNAME}\n  Password     ${out.HDFC_WEBHOOK_PASSWORD}\n` +
  `HDFC return URL: ${out.HDFC_RETURN_URL}\n`)
console.log(`\nDone. The admin and webhook values are in lead-api/data/live-settings.local.txt (git-ignored).\n` +
  'Next: npx vercel --prod   (settings apply to new deployments)')
