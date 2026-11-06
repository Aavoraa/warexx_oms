// The interactive demo: the WAREXX app (the snapshot in ../vendor/warexx-app,
// untouched — see tools/sync-app.mjs), with sw.js standing in for the server.
// This file only starts the service worker, signs the visitor in as the demo
// account, and opens the app on a busy screen. There is no production backend
// behind it, and index.html's Content-Security-Policy keeps every request on
// this origin, where sw.js answers it.
import React from 'react'
import ReactDOM from 'react-dom/client'
import '../vendor/warexx-app/src/styles.css'
import '../vendor/warexx-app/src/design-system.css'
import '../vendor/warexx-app/src/ui/warexx.css'
import '../vendor/warexx-app/src/ui/screens.css'
import './demo.css'
import { DemoWelcome, TRIAL_ON, TrialGate, TrialWatch, checkSession, reportTour, takeTicketFromUrl, trialUser } from './trial.jsx'
import { TourHost, startTour } from './tour.jsx'
import { AccountPanel } from './account.jsx'

// The public landing page, for "Talk to us" when the visitor did not arrive from
// it. Public, build-time, never a secret (see ../.env.example).
const LANDING_URL = import.meta.env.VITE_LANDING_URL || 'https://warexx.aavoraa.com'

const START = {
  // the warehouse the demo opens inside, and the screen — the dashboard is the
  // one with the most going on (see tools/record.mjs for the ids it recorded)
  warehouse: { id: 1, name: 'Sample Warehouse A', code: 'WH-A', catalogue: 'Garments' },
  tab: 'dashboard',
}

async function ready() {
  if (!('serviceWorker' in navigator)) throw new Error('This browser cannot run the demo (no service workers).')
  await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  // The very first visit: the worker is installed but not yet in charge of this
  // page, so a request now would go to a server that does not exist. Wait for it.
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
      setTimeout(resolve, 4000)
    })
    if (!navigator.serviceWorker.controller) { location.reload(); return new Promise(() => {}) }
  }
}

// A staff session: `?staff=1` (remembered; `?staff=0` goes back to the demo). The app's
// own login page, checked by the real server, with no booked slot, tour or demo account.
// Only where a server has accounts switched on; everywhere else this is simply the demo.
async function staffSession() {
  try {
    const asked = new URLSearchParams(location.search).get('staff')
    if (asked === '1') localStorage.setItem('wx_staff', '1')
    if (asked === '0') localStorage.removeItem('wx_staff')
    if (localStorage.getItem('wx_staff') !== '1') return false
    const s = await fetch('/api/oms/health', { cache: 'no-store' }).then((r) => r.json())
    if (s.live) return true
    localStorage.removeItem('wx_staff')
  } catch { /* private mode, or no answer: the demo */ }
  return false
}

function staffStart() {
  try {
    if (localStorage.getItem('essa_token') === 'demo') localStorage.removeItem('essa_token')
    localStorage.setItem('wrx_entered', '1')
    if (!localStorage.getItem('essa_warehouse')) localStorage.setItem('essa_warehouse', JSON.stringify(START.warehouse))
  } catch { /* private mode */ }
}

function StaffBanner() {
  return (
    <div className="wxdemo-banner" role="note">
      <span className="wxdemo-dot" aria-hidden="true" />
      <span><b>Staff</b> · orders and accounts are real; the other screens still show sample data</span>
      <a href="?staff=0" target="_top">Open the public demo</a>
    </div>
  )
}

function signIn() {
  try {
    // Fresh state on every visit to the demo URL, so each visitor starts in
    // the same place; moving around afterwards is remembered as in the real app.
    const first = sessionStorage.getItem('wx_demo_started') !== '1'
    localStorage.setItem('essa_token', 'demo')
    localStorage.setItem('wrx_entered', '1')
    if (first) {
      localStorage.setItem('essa_warehouse', JSON.stringify(START.warehouse))
      localStorage.setItem('essa_tab', START.tab)
      localStorage.removeItem('essa_open_tabs')
      sessionStorage.setItem('wx_demo_started', '1')
    }
  } catch { /* private mode: the app still opens, on its own defaults */ }
}

// Back to the sample business as every visitor first sees it: nothing the demo
// was told is kept anyway (sw.js keeps no writes), so this only forgets where
// the visitor had navigated to and opens the starting screen again.
function resetDemo() {
  try {
    for (const k of ['essa_warehouse', 'essa_tab', 'essa_open_tabs']) localStorage.removeItem(k)
    sessionStorage.removeItem('wx_demo_started')
  } catch { /* private mode: a reload is still a reset */ }
  location.reload()
}

function Banner() {
  const back = (() => { try { return new URLSearchParams(location.search).get('from') } catch { return null } })()
  return (
    <div className="wxdemo-banner" role="note">
      <span className="wxdemo-dot" aria-hidden="true" />
      <span><b>Live demo</b> · sample business, explore freely — changes reset when you reload</span>
      <button type="button" className="wxdemo-reset" onClick={startTour}>Product tour</button>
      <button type="button" className="wxdemo-reset" onClick={resetDemo}>Start over</button>
      <a href={(back || LANDING_URL) + '#contact'} target="_top">Talk to us</a>
    </div>
  )
}

ready().then(async () => {
  const root = ReactDOM.createRoot(document.getElementById('root'))
  if (await staffSession()) {
    staffStart()
    const { default: App } = await import('../vendor/warexx-app/src/App.jsx')
    document.getElementById('boot')?.remove()
    document.body.classList.add('wxdemo')
    root.render(<React.StrictMode><App /><StaffBanner /></React.StrictMode>)
    return
  }
  // A booked slot (trial.jsx, VITE_DEMO_TRIAL=1): sign up or sign in first, and
  // only inside the slot's two hours. Without it the demo opens straight away.
  let open = null
  if (TRIAL_ON) {
    takeTicketFromUrl()
    open = await checkSession()
    if (open.state === 'unconfigured') open = null
    else if (open.state !== 'open') {
      document.getElementById('boot')?.remove()
      document.body.classList.add('wxtrial-gated')
      open = await new Promise((resolve) => root.render(<TrialGate initial={open} onOpen={resolve} />))
      // just signed in with the emailed password: the demo video, or the demo itself
      if (!open.subscriber) {
        await new Promise((resolve) => root.render(<DemoWelcome email={trialUser()} onTrial={resolve} />))
      }
      document.body.classList.remove('wxtrial-gated')
    }
  }
  signIn()
  // My profile → Subscription & billing: the customer's own account (account.jsx)
  window.WAREXX_ACCOUNT_PANEL = AccountPanel
  const { default: App } = await import('../vendor/warexx-app/src/App.jsx')
  document.getElementById('boot')?.remove()
  document.body.classList.add('wxdemo')
  root.render(
    <React.StrictMode>
      <App /><Banner />{open && <TrialWatch end={open.end} skew={open.skew} subscriber={open.subscriber} />}
      {/* the guided tour, the first time this demo user opens WAREXX (tour.jsx) */}
      <TourHost user={trialUser()} warehouse={START.warehouse} serverState={open?.tourState} onSave={reportTour} />
    </React.StrictMode>)
}).catch((e) => {
  const b = document.getElementById('boot')
  if (b) b.innerHTML = `<div style="text-align:center;max-width:420px;padding:24px"><b>The demo could not start</b>${String(e.message || e)}</div>`
})
