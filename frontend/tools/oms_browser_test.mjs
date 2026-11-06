// The Order Management module, in a real (headless) browser, against a demo with
// no sign-in (npm run preview:demo):
//
//     node tools/oms_browser_test.mjs [url]      (default http://localhost:8002/)
//
// Walks an order from new to delivered through the screens, then proves the rules
// are enforced by the demo's server: stock limits, wrong-stage actions, return
// limits, surviving a worker restart, and a reload starting over.
// SHOTS=<folder> for screenshots. BROWSER=<path> to choose Edge or Chrome.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = (process.argv[2] || 'http://localhost:8002/').replace(/\/?$/, '/')
const SHOTS = process.env.SHOTS || ''
const BROWSER = process.env.BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p))
if (!BROWSER) { console.error('No Edge/Chrome found (set BROWSER)'); process.exit(2) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const ok = (cond, what, extra = '') => {
  if (cond) console.log('  ok    ' + what)
  else { failed++; console.log('  FAIL  ' + what + (extra ? '\n        ' + extra : '')) }
}

const port = 9600 + Math.floor(Math.random() * 300)
const profile = path.join(os.tmpdir(), `wx-oms-test-${port}`)
rmSync(profile, { recursive: true, force: true })
const browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => { try { browser.kill() } catch {} })

let targets
for (let i = 0; i < 120 && !targets?.length; i++) {
  try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page') } catch {}
  await sleep(250)
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const pending = new Map(), errors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text)
})
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'page error')
  return r.result?.result?.value
}
const shot = async (name) => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64'))
}
const waitFor = async (expression, ms = 15000) => {
  for (let t = 0; t < ms; t += 200) {
    try { if (await evaluate(expression)) return true } catch {}
    await sleep(200)
  }
  return false
}
// innerText carries CSS's text-transform, so section headings read in capitals
const hasText = (t) => `document.body.innerText.toLowerCase().includes(${JSON.stringify(t.toLowerCase())})`
// a button by its exact words, inside whatever selector is given
const click = (label, within = 'body') => evaluate(`(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(within)} + ' button')].filter((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled).pop()
  if (b) b.click(); return !!b })()`)
// the menu, as a person uses it: past the first-run tour, into the folder, onto the screen
const LABEL = { oms_dashboard: 'Order Dashboard', oms_orders: 'Order Inbox', oms_fulfilment: 'Fulfilment',
  oms_returns: 'Customer Returns', oms_reports: 'Order Reports' }
const menuItem = (label) => `[...document.querySelectorAll('aside button, aside a, nav button, nav a')].find((x) => x.innerText.trim() === ${JSON.stringify(label)})`
function rowsAreNewExpr() {
  return `(() => { const r = [...document.querySelectorAll('tbody tr.clickable')]; return r.length > 0 && r.every((x) => x.querySelector('.oms-status-cell').innerText.includes('New')) })()`
}
const openScreen = async (key) => {
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Skip tour')?.click()`)
  await sleep(200)
  if (!(await evaluate(`!!${menuItem(LABEL[key])}`))) await evaluate(`${menuItem('Order Management')}?.click()`)
  await waitFor(`!!${menuItem(LABEL[key])}`, 3000)
  await evaluate(`${menuItem(LABEL[key])}?.click()`)
  await sleep(300)
}
// the API as the page calls it; `wh` is the X-Essa-Warehouse header
const call = (p, body, wh) => evaluate(`fetch('/api/oms/' + ${JSON.stringify(p)}, { method: ${JSON.stringify(body ? 'POST' : 'GET')},
  headers: { 'Content-Type': 'application/json'${wh ? `, 'X-Essa-Warehouse': '${wh}'` : ''} }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ''} })
  .then(async (r) => ({ status: r.status, body: await r.json() }))`)

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: BASE })

console.log(`order management in a browser (${BASE})`)
ok(await waitFor(`!!navigator.serviceWorker.controller`), 'the demo starts with its worker in charge')
ok(await waitFor(hasText('Sample Warehouse')), 'the app opens in the sample business')
// the first-run tour opens a moment later and takes the page to the Dashboard
await waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Skip tour')`, 6000)
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Skip tour')?.click()`)

// OMS_STAFF_PASSWORD (with OMS_STAFF_USER): a staff session on a scratch database
if (process.env.OMS_STAFF_PASSWORD) {
  const typeInto = (selector, value) => evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)})
    i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const signInAs = async (name, password) => {
    await waitFor(`document.querySelectorAll('.login-card input').length === 2`)
    await typeInto('.login-card input:nth-of-type(1)', name)
    await evaluate(`(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      const [u, p] = document.querySelectorAll('.login-card input')
      set.call(u, ${JSON.stringify(name)}); u.dispatchEvent(new Event('input', { bubbles: true }))
      set.call(p, ${JSON.stringify(password)}); p.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(`!document.querySelector('.login-submit').disabled`, 3000)
    await evaluate(`document.querySelector('.login-submit').click()`)
  }
  const callStaff = (p, body, method) => evaluate(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method || (body ? 'POST' : 'GET'))},
    headers: { 'Content-Type': 'application/json', 'X-Wx-Staff': '1', 'X-Essa-Token': localStorage.getItem('essa_token') || '' },
    ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ''} }).then(async (r) => ({ status: r.status, body: await r.json() }))`)
  const NEW_PW = 'a-password-i-chose-7'

  console.log('the public demo, on a site with accounts switched on')
  await openScreen('oms_orders')
  ok(await waitFor(hasText('Sample orders: changes last')), 'a demo visitor gets sample orders, with no sign-in')
  ok((await callStaff('/api/oms/orders')).status === 401, 'asking the real server without an account: refused')

  console.log('signing in')
  await send('Page.navigate', { url: BASE + '?staff=1' }); await sleep(1500)
  ok(await waitFor(`!!document.querySelector('.login-wrap')`), '?staff=1 opens the login page')
  ok(await evaluate(`localStorage.getItem('essa_token') === null`), 'and drops the demo account')
  await shot('staff_login')
  await signInAs(process.env.OMS_STAFF_USER, 'not-the-right-password')
  ok(await waitFor(hasText('Wrong username or password')), 'a wrong password says so')
  await signInAs(process.env.OMS_STAFF_USER, process.env.OMS_STAFF_PASSWORD)
  ok(await waitFor(hasText('Choose your own password')), 'the one-time password must be replaced first')
  await shot('staff_forced_change')
  ok((await callStaff('/api/oms/orders')).status === 403, 'orders stay shut until it is')
  const pw = await evaluate(`[...document.querySelectorAll('input[type=password]')].length`)
  ok(pw === 3, 'with no way to dismiss it but to answer', String(pw))
  await evaluate(`(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const v = [${JSON.stringify(process.env.OMS_STAFF_PASSWORD)}, ${JSON.stringify(NEW_PW)}, ${JSON.stringify(NEW_PW)}]
    ;[...document.querySelectorAll('input[type=password]')].forEach((i, n) => { set.call(i, v[n]); i.dispatchEvent(new Event('input', { bubbles: true })) }) })()`)
  await evaluate(`[...document.querySelectorAll('form')].pop().querySelector('button[type=submit], button:not([type=button])').click()`)
  ok(await waitFor(`!document.body.innerText.includes('Choose your own password')`), 'changed, and on into the app')
  await sleep(1500)
  ok(await waitFor(`!document.body.innerText.includes('Change your password first')`, 3000), 'nothing is left showing the refusal')

  console.log('as Super Admin')
  await openScreen('oms_orders')
  ok(await waitFor(`document.querySelectorAll('tbody tr.clickable').length > 0`), 'orders from the database, with no second sign-in')
  ok(!(await evaluate(hasText('Sample orders: changes last'))), 'not sample orders')
  ok(await evaluate(hasText('orders and accounts are real')), 'the banner says what is real')
  await shot('staff_inbox')
  const list = await callStaff('/api/users')
  ok(list.status === 200 && list.body.users.some((u) => u.role === 'superadmin'), 'accounts come from the database')
  const made = await callStaff('/api/users', { username: 'wes', password: 'first-step-secret-1', role: 'user', full_name: 'Wes' })
  ok(made.status === 200, 'an account can be made')
  await callStaff('/api/users/' + made.body.id + '/permissions', { warehouses: [1], screens: { oms_orders: ['view', 'modify'], oms_fulfilment: ['view', 'modify'] } }, 'PUT')
  await evaluate(`localStorage.setItem('essa_tab', 'users')`)
  await send('Page.reload'); await sleep(1500)
  ok(await waitFor(hasText('Users & Access')), 'the Users & Access screen opens after a reload, still signed in')
  ok(await waitFor(hasText('wes')), 'and lists the real accounts')
  await shot('staff_users')
  ok(!(await evaluate(hasText('manager2'))), 'not the recorded ones')

  console.log('as a limited User')
  await evaluate(`localStorage.removeItem('essa_token'); localStorage.setItem('essa_tab', 'dashboard')`)
  await send('Page.reload'); await sleep(1200)
  await signInAs('wes', 'first-step-secret-1')
  await waitFor(hasText('Choose your own password'))
  await evaluate(`(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const v = ['first-step-secret-1', 'my-chosen-secret-22', 'my-chosen-secret-22']
    ;[...document.querySelectorAll('input[type=password]')].forEach((i, n) => { set.call(i, v[n]); i.dispatchEvent(new Event('input', { bubbles: true })) }) })()`)
  await evaluate(`[...document.querySelectorAll('form')].pop().querySelector('button[type=submit], button:not([type=button])').click()`)
  await waitFor(`!document.body.innerText.includes('Choose your own password')`)
  await sleep(1500)
  const rows = await callStaff('/api/oms/orders')
  ok(rows.status === 200 && rows.body.rows.length > 0 && rows.body.rows.every((o) => o.wh === 1), 'sees only their warehouse')
  ok((await callStaff('/api/users')).status === 403, 'cannot manage accounts')
  ok((await callStaff('/api/oms/summary')).status === 403, 'nor open what was not ticked')
  const menu = await evaluate(`document.body.innerText`)
  ok(/Order Inbox/.test(menu) && !/Customer Returns/.test(menu) && !/Order Reports/.test(menu), 'the menu shows only what was ticked', menu.slice(0, 300))
  await shot('staff_limited')

  ok(errors.length === 0, 'no uncaught errors on the page', errors.slice(0, 3).join(' | '))
  console.log(failed ? `\n${failed} FAILED` : '\nall passing')
  process.exit(failed ? 1 : 0)
}

// OMS_LIVE_OPEN=1: the real API on this computer, no sign-in (reads only)
if (process.env.OMS_LIVE_OPEN) {
  console.log('the real API, as Super Admin on this computer')
  for (const [key, words] of [['oms_dashboard', 'Where orders are now'], ['oms_orders', 'Every customer order'],
    ['oms_fulfilment', 'To allocate'], ['oms_returns', 'RMA-'], ['oms_reports', 'Best sellers']]) {
    await openScreen(key)
    ok(await waitFor(hasText(words)), `${key} opens with no password`)
    ok(!(await evaluate(hasText('Sign in to orders'))) && !(await evaluate(hasText('Sample orders: changes last'))), `${key}: real data, not sample`)
    await shot('open_' + key)
  }
  ok(errors.length === 0, 'no uncaught errors on the page', errors.slice(0, 3).join(' | '))
  console.log(failed ? `\n${failed} FAILED` : '\nall passing')
  process.exit(failed ? 1 : 0)
}

// OMS_LIVE_PASSWORD: the site has the real API behind it (a scratch database, please)
const LIVE = process.env.OMS_LIVE_PASSWORD || ''
if (LIVE) {
  const typeInto = (selector, value) => evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)})
    i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  console.log('the real API')
  await openScreen('oms_orders')
  ok(await waitFor(hasText('Sign in to orders')), 'the order screens ask for their password')
  ok(!(await evaluate(hasText('Sample orders: changes last'))), 'and do not say they are sample orders')
  ok((await evaluate(`fetch('/api/oms/orders').then((r) => r.status)`)) === 403, 'no data without signing in')
  await shot('live_signin')
  await typeInto('.oms-signin input', 'wrong-password')
  await evaluate(`document.querySelector('.oms-signin button').click()`)
  ok(await waitFor(hasText('That password is not right'), 5000), 'a wrong password says so, and stays in the app', (await evaluate('document.body.innerText')).slice(-400))
  await shot('live_wrong')
  ok(await evaluate(hasText('Sample Warehouse')), 'not signed out of the app')
  await typeInto('.oms-signin input', LIVE)
  await evaluate(`document.querySelector('.oms-signin button').click()`)
  ok(await waitFor(`document.querySelectorAll('tbody tr.clickable').length > 0`), 'signed in: the orders come from the database')
  await shot('live_inbox')
  await evaluate(`[...document.querySelectorAll('.oms-tab')].find((b) => b.innerText.startsWith('New')).click()`)
  await waitFor(rowsAreNewExpr())
  const no = await evaluate(`document.querySelector('tbody tr.clickable td').innerText.trim()`)
  await evaluate(`document.querySelector('tbody tr.clickable').click()`)
  await waitFor(`[...document.querySelectorAll('.wx-drawer button')].some((b) => b.innerText.trim() === 'Confirm order')`)
  ok(await click('Confirm order', '.wx-drawer'), `${no}: confirmed through the screen`)
  ok(await waitFor(`[...document.querySelectorAll('.wx-drawer button')].some((b) => b.innerText.trim() === 'Allocate stock')`), 'it moves on to the next step')
  await send('Page.reload'); await sleep(1500)
  await openScreen('oms_orders')
  ok(await waitFor(`document.querySelectorAll('tbody tr.clickable').length > 0`), 'after a reload, the tab is still signed in')
  const status = await evaluate(`[...document.querySelectorAll('tbody tr.clickable')].find((r) => r.innerText.includes(${JSON.stringify(no)}))?.querySelector('.oms-status-cell').innerText`)
  ok(/confirmed/i.test(status || ''), `the change survived the reload, unlike the sample data (${status})`)
  ok(errors.length === 0, 'no uncaught errors on the page', errors.slice(0, 3).join(' | '))
  console.log(failed ? `\n${failed} FAILED` : '\nall passing')
  process.exit(failed ? 1 : 0)
}

console.log('the screens')
for (const [key, words] of [['oms_dashboard', 'Where orders are now'], ['oms_orders', 'Every customer order'],
  ['oms_fulfilment', 'To allocate'], ['oms_returns', 'RMA-'], ['oms_reports', 'Best sellers']]) {
  await openScreen(key)
  ok(await waitFor(hasText(words)), `${key} renders ("${words}")`, (await evaluate('document.body.innerText')).slice(0, 200))
  await shot(key)
}

console.log('the rules, at the server')
await send('Page.reload'); await sleep(800)
await waitFor(`!!navigator.serviceWorker.controller`)
const list = (await call('orders')).body
ok(list.rows.length === 57 && list.counts.all === 57, `central sees all sample orders (${list.rows.length})`)
const whA = (await call('orders', null, '1')).body
ok(whA.rows.length > 0 && whA.rows.length < 57 && whA.rows.every((o) => o.wh === 1), `a warehouse sees only its own (${whA.rows.length})`)
ok((await call(`orders/${list.rows.find((o) => o.wh === 2).id}`, null, '1')).status === 404, "another warehouse's order is not found from here")
const inv = list.rows.find((o) => o.status === 'new')
ok((await call(`orders/${inv.id}/action`, { action: 'ship', courier: 'Sample Express' })).status === 409, 'a new order cannot jump to shipped')
ok((await call(`orders/${inv.id}/action`, { action: 'cancel' })).status === 422, 'a cancellation needs a reason')

// more than the shelf holds → backorder; free the stock → allocates
const stockBefore = (await call('products?wh=1')).body
const roomy = stockBefore.find((p) => p.available >= 5)
const huge = (await call('orders', { wh: 1, customer: { name: 'Test' }, lines: [{ product_id: roomy.id, qty: roomy.available + 1 }] })).body
await call(`orders/${huge.id}/action`, { action: 'confirm' })
const short = (await call(`orders/${huge.id}/action`, { action: 'allocate' })).body
ok(short.status === 'backorder' && /Not enough stock/.test(short.message), 'asking for more than is free: backorder, and it says why')
const fits = (await call('orders', { wh: 1, customer: { name: 'Test' }, lines: [{ product_id: roomy.id, qty: 2 }] })).body
await call(`orders/${fits.id}/action`, { action: 'confirm' })
ok((await call(`orders/${fits.id}/action`, { action: 'allocate' })).body.status === 'allocated', 'an order that fits: allocated')
const freeAfter = (await call('products?wh=1')).body.find((p) => p.id === roomy.id)
ok(freeAfter.available === roomy.available - 2 && freeAfter.stock === roomy.stock, 'allocating reserves stock without taking it off the shelf')
await call(`orders/${fits.id}/action`, { action: 'cancel', reason: 'test' })
ok((await call('products?wh=1')).body.find((p) => p.id === roomy.id).available === roomy.available, 'cancelling frees what it reserved')
await call(`orders/${fits.id}/action`, { action: 'confirm' })
ok((await call(`orders/${fits.id}`)).body.status === 'cancelled', 'a cancelled order stays cancelled')

// through to the doorstep: shipping takes it off the shelf
const walk = (await call('orders', { wh: 1, customer: { name: 'Test' }, payment: 'COD', lines: [{ product_id: roomy.id, qty: 2 }] })).body
for (const action of ['confirm', 'allocate', 'pick', 'pack']) await call(`orders/${walk.id}/action`, { action })
ok((await call(`orders/${walk.id}/action`, { action: 'ship' })).status === 422, 'shipping needs a courier')
const shipped = (await call(`orders/${walk.id}/action`, { action: 'ship', courier: 'Sample Express' })).body
ok(shipped.status === 'shipped' && /^AWB/.test(shipped.awb), 'shipped, with a tracking number')
ok((await call('products?wh=1')).body.find((p) => p.id === roomy.id).stock === roomy.stock - 2, 'shipping takes it off the shelf')
ok((await call('returns', { order_id: walk.id, reason: 'Wrong size', lines: [{ product_id: roomy.id, qty: 1 }] })).status === 409, 'an undelivered order cannot be returned')
await call(`orders/${walk.id}/action`, { action: 'deliver' })

// returns
ok((await call('returns', { order_id: walk.id, reason: 'Wrong size', lines: [{ product_id: roomy.id, qty: 3 }] })).status === 422, 'cannot return more than was delivered')
const rma = (await call('returns', { order_id: walk.id, reason: 'Wrong size', lines: [{ product_id: roomy.id, qty: 2 }] })).body
ok(rma.status === 'requested' && rma.value === roomy.price * 2, 'a return is valued at what was paid')
ok((await call('returns', { order_id: walk.id, reason: 'Wrong size', lines: [{ product_id: roomy.id, qty: 1 }] })).status === 422, 'what is already being returned cannot be returned twice')
ok((await call(`returns/${rma.id}/action`, { action: 'refund' })).status === 409, 'no refund before the goods are back')
await call(`returns/${rma.id}/action`, { action: 'approve' })
await call(`returns/${rma.id}/action`, { action: 'receive', condition: 'good' })
ok((await call('products?wh=1')).body.find((p) => p.id === roomy.id).stock === roomy.stock, 'goods received in good condition go back on the shelf')
ok((await call(`returns/${rma.id}/action`, { action: 'refund' })).body.refund_amount === roomy.price * 2, 'refund recorded for the full value')

console.log('the state outlives the worker, not a reload')
const marker = (await call('orders', { wh: 1, customer: { name: 'Keep Me' }, lines: [{ product_id: roomy.id, qty: 1 }] })).body
await evaluate(`navigator.serviceWorker.ready.then(() => true)`)
const stopped = await send('ServiceWorker.enable').then(() => send('ServiceWorker.stopAllWorkers'))
await sleep(800)
ok(!stopped.error, 'the worker was stopped', JSON.stringify(stopped.error || ''))
ok((await call(`orders/${marker.id}`)).body.customer?.name === 'Keep Me', 'an order saved before the worker stopped is still there after')
await send('ServiceWorker.disable')
await send('Page.reload'); await sleep(1000)
await waitFor(`!!navigator.serviceWorker.controller`)
ok((await call(`orders/${marker.id}`)).status === 404, 'a reload starts the orders over')
ok((await call('orders')).body.rows.length === 57, 'back to the 57 sample orders')

console.log('through the screens')
await openScreen('oms_orders')
ok(await waitFor(hasText('SO-10')), 'the inbox lists orders')
await evaluate(`[...document.querySelectorAll('.oms-tab')].find((b) => b.innerText.startsWith('New')).click()`)
ok(await waitFor(rowsAreNewExpr()), 'filtering by status narrows the list')
await evaluate(`document.querySelector('tbody tr.clickable').click()`)
ok(await waitFor(hasText('Timeline')), 'an order opens, with its timeline')
await shot('order_drawer')
ok(await click('Confirm order', '.wx-drawer'), 'the next step is offered')
ok(await waitFor(`[...document.querySelectorAll('.wx-drawer button')].some((b) => b.innerText.trim() === 'Allocate stock')`), 'confirming moves it on, and offers the next step')
await evaluate(`document.querySelector('.wx-drawer button[aria-label="Close"]').click()`)
await click('New order')
ok(await waitFor(`document.querySelectorAll('.oms-line select option').length > 1`), 'a new order inside a warehouse offers its products')
await shot('new_order')
await evaluate(`document.querySelector('.fin-modal button[aria-label="Close"]').click()`)
await click('Central')
await sleep(500)
await openScreen('oms_orders')
ok(await waitFor(`document.querySelectorAll('tbody tr.clickable').length === 57`), 'Central lists every warehouse\'s orders')
await click('New order')
ok(await waitFor(`[...document.querySelectorAll('.oms-line select option')].some((o) => o.textContent === 'Choose a warehouse first')`), 'a new order at Central asks for the warehouse first')
await shot('new_order_central')

ok(errors.length === 0, 'no uncaught errors on the page', errors.slice(0, 3).join(' | '))
console.log(failed ? `\n${failed} FAILED` : '\nall passing')
process.exit(failed ? 1 : 0)
