/* WAREXX static demo — the "server".
 *
 * The demo is the real WAREXX app with no backend behind it. This service
 * worker answers every request the app makes to /api, /pos and /m from answers
 * recorded off a real server running a sample business (tools/record.mjs wrote
 * data/manifest.json and data/bodies/*). Nothing is sent anywhere; nothing is
 * stored. Writes are acknowledged so the screens behave, and the recorded data
 * comes back on the next read — the demo resets itself on every reload.
 */
const VERSION = 'wx-demo-v4'
const DATA = new URL('./data/', self.registration.scope).href

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

let manifestP = null
const manifest = () => (manifestP ||= fetch(DATA + 'manifest.json', { cache: 'no-cache' })
  // no recording yet (or one being written): an empty one, so the app still opens
  .then((r) => (r.ok ? r.json() : { entries: [] })).catch(() => ({ entries: [] }))
  .then((m) => {
    // index: exact key, then path without query, then a path "shape" with the
    // numbers taken out — so /api/documents/7 still finds a document when only
    // /api/documents/3 was recorded.
    const exact = new Map(), byPath = new Map(), byShape = new Map()
    for (const e of m.entries) {
      exact.set(e.key, e)
      push(byPath, `${e.method} ${e.wh} ${e.path}`, e)
      push(byPath, `${e.method} * ${e.path}`, e)
      push(byShape, `${e.method} ${e.wh} ${shape(e.path)}`, e)
      push(byShape, `${e.method} * ${shape(e.path)}`, e)
    }
    return { meta: m.meta || {}, exact, byPath, byShape }
  }))
const push = (map, k, v) => { const a = map.get(k); a ? a.push(v) : map.set(k, [v]) }
const shape = (p) => p.replace(/\/\d+(?=\/|$)/g, '/:n').replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/:h')

// The two real endpoints on a site that serves the landing page and the demo
// together (npm run build:site): /api/leads (the landing forms; sends an email)
// and /api/trial (the demo's sign-up / sign-in for a booked slot), plus /api/geo
// (the landing page's visitor country, for prices in their currency). None is
// part of the recording, and nothing of the demo's data goes to any of them.
// /api/admin is the leads admin page (/admin) — it must never get demo answers.
// /api/subscribe and /api/payment/* are the real subscription and HDFC
// SmartGateway endpoints: HDFC sends the customer back to /api/payment/return,
// and on a browser that has opened the demo this worker sees that request first.
const REAL = new Set(['/api/leads', '/api/trial', '/api/geo', '/api/admin', '/api/subscribe'])
const ours = (url) => url.origin === self.location.origin && !REAL.has(url.pathname) &&
  !url.pathname.startsWith('/api/payment/') &&
  (url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname.startsWith('/pos'))

// The phone app (/m) is real files — the WAREXX phone page, copied in at build
// (tools/mobile-page.mjs) — not a recording. Its screens have addresses of their
// own (/m/grn/12, /m/purchase-orders), which are all that one page.
const isMobilePage = (url) => url.origin === self.location.origin &&
  (url.pathname === '/m' || url.pathname.startsWith('/m/')) && !/\.[a-z0-9]+$/i.test(url.pathname)

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // a page load re-reads the recording, so newly recorded data shows on reload
  // without waiting for this worker to be replaced
  if (event.request.mode === 'navigate' && url.origin === self.location.origin
      && !url.pathname.startsWith('/pos')) {
    manifestP = null
    omsLiveP = null
    event.waitUntil?.(omsReset())         // a reload starts the sample orders over too
  }
  if (event.request.mode === 'navigate' && isMobilePage(url)) {
    event.respondWith(fetch('/m/index.html', { cache: 'no-cache' }))
    return
  }
  if (!ours(url)) return                      // the app's own files: straight through
  event.respondWith(answer(event.request, url))
})

// ---- Ask WAREXX (tools/record_mobile.py recorded its answers) ----
// A question is a POST whose meaning is in its body, so it is looked up by a key
// made from the body: the words (normalised as the recorder normalised them) and
// the previous answer's intent — "only in warehouse b" means something different
// after "low stock" than after "pending GRNs" — or, for a tap, the intent itself.
// Spoken words wander ("show me the low stock items please"), so a close-enough
// recorded question answers too. One that is not close to anything recorded is
// told so, with questions that are — never answered with something else.
const CMD = '/api/assist/command'
const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, '')
  .replace(/[^a-z0-9\- ]+/g, ' ').split(/\s+/).filter(Boolean).join(' ')
  .replace(/^(?:(?:hey|ok|okay) )?warexx /, '').replace(/^please /, '').replace(/ please$/, '')
  .replace(/^show me /, 'show ')
const canon = (i) => {
  const f = Object.entries(i.filters || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`).sort().join(';')
  return `${i.intent}|${f}|${i.all ? 1 : 0}`
}
// Filler that carries no meaning in a question about the business: "which
// products are low in stock" asks what "show low stock items" asks.
const STOP = new Set(['the', 'a', 'an', 'me', 'my', 'all', 'please', 'show', 'is', 'are', 'what', 'whats', 'do', 'we', 'have',
  'which', 'in', 'of', 'any', 'there', 'items', 'list', 'currently'])
const words = (t) => new Set(t.split(' ').filter((w) => !STOP.has(w)))
const dice = (a, b) => {
  if (!a.size || !b.size) return 0
  let n = 0; for (const w of a) if (b.has(w)) n++
  return (2 * n) / (a.size + b.size)
}
let askIndexFor = null, askIndex = null
function askKeys(m) {
  if (askIndexFor !== m) {
    askIndexFor = m; askIndex = new Map()
    for (const k of m.exact.keys()) {
      const mm = k.match(/^POST (\S+) \/api\/assist\/command#T:([^:]+):(.*)$/)
      if (!mm) continue
      const key = `${mm[1]} ${mm[2]}`
      if (!askIndex.has(key)) askIndex.set(key, [])
      askIndex.get(key).push({ text: mm[3], words: words(mm[3]), key: k })
    }
  }
  return askIndex
}
async function assistAnswer(m, req, wh) {
  let body = {}
  try { body = await req.clone().json() } catch { /* empty */ }
  const W = wh === '-' ? '1' : wh
  const get = (k) => m.exact.get(`POST ${W} ${CMD}#${k}`)
  let hit = null
  if (body.intent && body.intent.intent) {
    hit = get('I:' + canon(body.intent))
  } else {
    const t = norm(body.text)
    const prev = (body.context && body.context.intent && body.context.intent.intent) || '-'
    // "open the second one" / "receive the first one" point INTO the last answer,
    // whose rows travel in the request (context.items) — so they are answered
    // from those rows, exactly as the server answers them, not from a recording
    // made after some other list.
    const ORD = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4, last: -1 }
    const pm = t.match(/^(open|show|select|view|pick|take|receive)(?: me)?(?: the)? (first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)(?: one)?$/)
      || t.match(/^(open|show|receive) (?:it|that|this)$/)
    const rows = (body.context && Array.isArray(body.context.items)) ? body.context.items : []
    if (pm && rows.length) {
      let i = pm[2] ? ORD[pm[2]] : 0
      if (i < 0) i = rows.length - 1
      const it = rows[i]
      const card = (kind, line, extra) => json({ ok: kind === 'open', kind, title: 'Open', line, text: body.text || '',
        items: [], metrics: [], actions: [], total: 0, intent: { intent: 'PICK', filters: {} }, context: body.context, ...extra })
      if (!it) return card('empty', `The last answer had ${rows.length} row${rows.length === 1 ? '' : 's'}.`)
      if (pm[1] === 'receive' && it.kind === 'transfer') {
        const r = get('I:' + canon({ intent: 'RECEIVE_TRANSFER', filters: { transfer_id: it.id } }))
        if (r) { const j = await (await replay(r)).json(); j.text = body.text || ''; return json(j) }
      }
      if (it.open) return card('open', `Opening ${it.code || 'it'}.`, { title: 'Opening', open: it.open })
      return card('empty', 'That one has no screen on the phone — it’s on the desktop app.')
    }
    hit = (prev !== '-' && get(`T:${prev}:${t}`)) || get(`T:-:${t}`)
    if (!hit && t) {
      const idx = askKeys(m), want = words(t)
      let best = null, score = 0
      for (const p of (prev !== '-' ? [prev, '-'] : ['-'])) {
        for (const c of idx.get(`${W} ${p}`) || []) {
          const s = dice(want, c.words) + (p === prev && p !== '-' ? 0.01 : 0)
          if (s > score) { score = s; best = c }
        }
      }
      if (best && score >= 0.8) hit = m.exact.get(best.key)
    }
  }
  if (hit) {
    const r = await (await replay(hit)).json()
    r.text = body.text || ''
    r.source = body.source || (body.text ? 'text' : 'tap')
    return json(r)
  }
  const ov = m.exact.get(`GET ${W} /api/assist/overview`)
  let sugg = ['What needs my attention today?', 'Show pending GRNs', 'Show low stock items', 'Show pending purchase orders']
  try { if (ov) sugg = (await (await replay(ov)).json()).suggestions || sugg } catch { /* defaults */ }
  return json({ ok: false, demo: true, kind: 'unknown', title: 'Not part of this demo',
    line: 'The demo answers a set of questions about its sample business. Try one of these:',
    text: body.text || '', items: [], metrics: [], total: 0,
    actions: sugg.slice(0, 5).map((s) => ({ label: s, ask: s })),
    intent: { intent: 'NONE', filters: {} }, context: body.context || {} })
}

// ---- the Command Center's Ask WAREXX (demo-data/tools/record_command_ask.py) ----
// A question is recorded under its words (norm, as the recorder normalises them);
// a close-enough phrasing answers too. Anything else is told it is not part of
// the demo, with the questions that are — never answered with something else.
const ASK = '/api/command/ask', TRACE = '/api/command/trace'
// Like norm, but letters of every script are kept, with their vowel signs: the
// box listens for Tamil as well as English (record_command_ask.py norm, in step)
const cmdNorm = (s) => String(s || '').toLowerCase().replace(/[’']/g, '')
  .replace(/[^\p{L}\p{M}\p{N}\- ]+/gu, ' ').split(/\s+/).filter(Boolean).join(' ')
  .replace(/^(?:(?:hey|ok|okay) )?warexx /, '').replace(/^please /, '').replace(/ please$/, '')
  .replace(/^show me /, 'show ')
const TAMIL = /[\u0B80-\u0BFF]/
let cmdIndexFor = null, cmdIndex = null
function commandKeys(m) {
  if (cmdIndexFor !== m) {
    cmdIndexFor = m; cmdIndex = []
    for (const k of m.exact.keys()) {
      const mm = k.match(/^POST - \/api\/command\/ask#Q:(.*)$/)
      if (mm) cmdIndex.push({ text: mm[1], words: words(mm[1]), key: k })
    }
  }
  return cmdIndex
}
async function commandAnswer(m, req) {
  let body = {}
  try { body = await req.clone().json() } catch { /* empty */ }
  const t = cmdNorm(body.q)
  let hit = t && m.exact.get(`POST - ${ASK}#Q:${t}`)
  if (!hit && t) {
    const want = words(t)
    let best = null, score = 0
    for (const c of commandKeys(m)) { const s = dice(want, c.words); if (s > score) { score = s; best = c } }
    if (best && score >= 0.8) hit = m.exact.get(best.key)
  }
  if (hit) return replay(hit)
  let sugg = ["Today's total sales", "Today's profit", 'Which products are low in stock?', 'Which floor has the highest sales?']
  const ex = m.exact.get('GET - /api/command/examples')
  try { if (ex) sugg = ((await (await replay(ex)).json()).examples || []).map((e) => e.q).filter(Boolean).slice(0, 6) } catch { /* defaults */ }
  // asked in Tamil: suggest the Tamil questions the demo can answer
  if (TAMIL.test(String(body.q || ''))) {
    const ta = commandKeys(m).map((c) => c.text).filter((x) => TAMIL.test(x))
    if (ta.length) {
      return json({ ok: false, demo: true, title: 'இந்த டெமோவில் இல்லை',
        line: 'இந்த டெமோ அதன் மாதிரி வணிகம் பற்றிய சில கேள்விகளுக்கு பதில் அளிக்கும். இவற்றில் ஒன்றைக் கேளுங்கள்:',
        suggestions: [...new Set(ta)].slice(0, 6) })
    }
  }
  return json({ ok: false, demo: true, title: 'Not part of this demo',
    line: 'The demo answers a set of questions about its sample business. Try one of these:', suggestions: sugg })
}

// ---- product search: the recorded catalogue, filtered as the server filters ----
// One recording of the whole catalogue per warehouse; a search is that list with
// the same four fields matched, so typing "shirt" shows shirts rather than the
// unfiltered first page.
async function productsAnswer(m, url, wh) {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase()
  const status = url.searchParams.get('status') || 'all'
  const base = m.exact.get(`GET ${wh} /api/inventory/products?status=all`) || m.exact.get(`GET 1 /api/inventory/products?status=all`)
  if (!base) return null
  let rows = await (await replay(base)).json()
  if (status === 'pending') rows = rows.filter((p) => !p.detailed)
  if (status === 'detailed') rows = rows.filter((p) => p.detailed)
  rows = rows.filter((p) => [p.description, p.sku, p.barcode, p.hsn].some((f) => String(f || '').toLowerCase().includes(q)))
  const off = +(url.searchParams.get('offset') || 0), lim = +(url.searchParams.get('limit') || 0)
  return json(lim ? rows.slice(off, off + lim) : rows.slice(off))
}

// ---- the Item Locator (tools/record_locator.py recorded its answers) ----
// One recorded answer per SKU and per carton label, and an index of every
// per-piece code -> its product and the piece's own number and status. A piece
// is answered as the real server answers it: its product, plus `unit`.
const LOCATE = '/api/inventory/locate'
let unitsP = null, unitsFor = null
const unitIndex = (m) => {
  if (unitsFor !== m) {
    unitsFor = m
    const e = m.exact.get(`GET - ${LOCATE}/units`)
    unitsP = e ? replay(e).then((r) => r.json()).catch(() => ({})) : Promise.resolve({})
  }
  return unitsP
}
async function locateAnswer(m, url) {
  const raw = (url.searchParams.get('code') || '').trim()
  if (!raw) return json({ detail: 'give a code to look up' }, 400)
  // the demo shows the sample codes as SMPL-; the same items printed as ESSA-
  // (the app's own prefix) are the same items, so both are read
  const norm = (c) => c.trim().toUpperCase().replace(/^ESSA-/, 'SMPL-')
  // a scanned QR carries the code among other fields (E1|66|SMPL-00066|…):
  // the whole text first, then each part of it
  const tries = [raw, ...raw.split(/[|,;\s]+/)].map(norm).filter(Boolean)
  const units = await unitIndex(m)
  for (const c of tries) {
    const hit = m.exact.get(`GET - ${LOCATE}?code=${c}`)
    if (hit) return replay(hit)
    const u = units[c]
    if (u) {
      const p = m.exact.get(`GET - ${LOCATE}?code=${u.sku}`)
      if (p) {
        const body = await replay(p).then((r) => r.json())
        return json({ ...body, code: c, unit: { id: null, code: c, seq: u.seq, status: u.status, printed: null } })
      }
    }
  }
  return json({ detail: `Nothing matches '${raw}'. It is not a product QR, a piece code, `
    + 'a carton label, a barcode or a SKU.' }, 404)
}

// A staff session (?staff=1, demo/main.jsx) has the real server for orders and accounts,
// and everyone else keeps the demo: public visitors never reach real data, or see a
// sign-in. The server checks every call regardless; this only decides who answers.
async function realServer(req, path) {
  const oms = path.startsWith('/api/oms/')
  const accounts = path.startsWith('/api/auth/') || path === '/api/users' || path.startsWith('/api/users/')
  if (!oms && !accounts) return false
  const staff = req.headers.get('X-Wx-Staff') === '1'
  if (!staff && !oms) return false                 // no call to the network for a demo sign-in
  const s = await omsStatus()
  return s.live && (staff || s.open_local)
}

async function answer(req, url) {
  if (url.pathname === '/api/oms/health') return json(await omsStatus())
  if (await realServer(req, url.pathname)) return fetch(req)
  const m = await manifest()
  const method = req.method.toUpperCase()
  const wh = req.headers.get('X-Essa-Warehouse') || '-'
  const path = url.pathname
  const key = `${method} ${wh} ${path}${url.search}`
  // The Item Locator answers ONE code, so it is never matched loosely: a code
  // nobody recorded must say "nothing matches", not replay some other item.
  if (method === 'GET' && path === LOCATE) return locateAnswer(m, url)
  if (method === 'POST' && path === CMD) return assistAnswer(m, req, wh)
  // the Command Center's question box (record_command_ask.py)
  if (method === 'POST' && path === ASK) return commandAnswer(m, req)
  // a code is followed only if it was recorded — never some other code's trail
  if (method === 'GET' && path === TRACE) {
    const e = m.exact.get(`GET - ${path}${url.search}`)
    return e ? replay(e) : json({ ok: false, title: 'Not part of this demo',
      line: 'The demo can follow the codes in its sample business — click a product in Leaders, or ask one of the suggested questions.' })
  }
  // a search the recording has no exact answer for: the catalogue, filtered
  if (method === 'GET' && path === '/api/inventory/products' && (url.searchParams.get('q') || '').trim()
      && !m.exact.get(key)) {
    const r = await productsAnswer(m, url, wh)
    if (r) return r
  }
  // a code lookup answers that code or nothing — never a neighbouring product
  if (method === 'GET' && path === '/api/inventory/lookup') {
    const c = (url.searchParams.get('code') || '').trim().toUpperCase().replace(/^ESSA-/, 'SMPL-')
    const e = m.exact.get(`GET - ${path}?code=${c}`)
    return e ? replay(e) : json({ detail: `No product for '${url.searchParams.get('code')}'` }, 404)
  }

  if (path.startsWith('/api/oms/')) return omsAnswer(m, req, method, path, url, wh)

  // HR's people: an employee added or edited in the demo is kept for the visit
  // (the recording cannot know them), so the record that was saved is the one
  // shown back — not the nearest recorded person.
  const hrEmp = await hrEmployeeAnswer(m, req, method, path, url)
  if (hrEmp) return hrEmp

  const hit = m.exact.get(key) || m.exact.get(`${method} - ${path}${url.search}`)
    || pick(m.byPath.get(`${method} ${wh} ${path}`), url)
    || pick(m.byPath.get(`${method} * ${path}`), url)
    || pick(m.byShape.get(`${method} ${wh} ${shape(path)}`), url)
    || pick(m.byShape.get(`${method} * ${shape(path)}`), url)
  if (hit) return replay(hit)
  // My profile (user menu): the Sample Admin's account; what the visitor edits
  // is kept by this worker for the visit, like every other save in the demo.
  if (path === '/api/auth/profile') {
    if (method === 'PUT') {
      let b = {}
      try { b = await req.clone().json() } catch { /* empty */ }
      const name = String(b.full_name || '').trim().replace(/\s+/g, ' ')
      if (!name) return json({ detail: 'Your name cannot be empty' }, 400)
      Object.assign(PROFILE, { full_name: name.slice(0, 80), job_title: String(b.job_title || '').trim().slice(0, 80),
        email: String(b.email || '').trim().toLowerCase().slice(0, 254), phone: String(b.phone || '').trim().slice(0, 20) })
      PROFILE.recent = [{ at: new Date().toISOString(), action: 'modify', screen: 'session', outcome: 'ok',
        summary: 'updated their profile (demo — resets when the demo restarts)', warehouse: '' }, ...PROFILE.recent].slice(0, 8)
    }
    return json(PROFILE)
  }
  // Signing in never depends on the recording: whatever is typed, the visitor is
  // the demo's Sample Admin. (A recorded answer, above, wins when there is one.)
  if (AUTH[path]) return json(AUTH[path])

  if (method === 'POST' && (path === '/api/documents/upload' || path === '/api/documents/manual')) {
    return sampleInvoice(m, wh, path)
  }
  if (method === 'GET' || method === 'HEAD') return missingRead(path)
  return acknowledgeWrite(req, path, m.meta)
}

// An invoice upload (or a blank manual entry): there is no server here to read a
// file, and pretending to would be a lie about the visitor's own bill. So the
// answer is one of the sample business's recorded invoices still awaiting review
// (in this warehouse when it has one), in the shape the upload answers with, and
// marked as the demo's — the screen says so instead of "recognised".
async function sampleInvoice(m, wh, path) {
  const pickFrom = (w) => [...m.exact.values()].filter((e) => e.method === 'GET' && e.wh === w && /^\/api\/documents\/\d+$/.test(e.path) && e.body)
  const docs = [...pickFrom(String(wh)), ...pickFrom('-')]
  const parsed = docs.map((e) => { try { return JSON.parse(e.body) } catch { return null } }).filter((j) => j && j.document)
  const sample = parsed.find((j) => j.document.status === 'needs_review') || parsed[0]
  const message = path.endsWith('/manual')
    ? 'This is the demo — new entries are not saved here, so here is a sample invoice to review instead.'
    : 'This is the demo — your file is not read here. Here is a sample invoice as WAREXX extracted it: review it, then Confirm.'
  if (!sample) return json({ detail: message }, 409)
  return json({ ...sample, demo: true, message, supplier_recognised: !!sample.document.supplier_id,
    profile_used: false, lr_filled: [] })
}

// ---- Order Management (OMS.jsx; the sample data is demo-data/tools/seed_oms.mjs) ----
// The one module with rules here rather than a recording: an order moves through
// its stages, stock is reserved and released, a return follows from a delivery.
// A browser stops an idle worker after about 30 seconds, which would lose anything
// kept only in memory, so the visit's state is written to the Cache API. A page
// load clears it (see the fetch listener), as a reload resets the rest of the demo.
const OMS_CACHE = 'wx-oms-visit', OMS_KEY = '/__oms_state'
let omsP = null, omsCleared = null
// Asked once per page load. A static host answers with a page or a 404, which is
// "no": a 5xx means the API exists and is failing, which must show as an error, not
// quietly turn into sample orders.
let omsLiveP = null
const omsStatus = () => (omsLiveP ||= fetch('/api/oms/health', { cache: 'no-store' })
  .then(async (r) => {
    if (r.status >= 500) return { live: true, open_local: false }
    const j = r.ok ? await r.json() : {}
    return { live: j.live === true, open_local: j.open_local === true }
  })
  .catch(() => ({ live: false, open_local: false })))
const omsReset = () => { omsP = null; omsCleared = self.caches ? caches.delete(OMS_CACHE) : null; return omsCleared }
const omsAgo = (h) => new Date(Date.now() - h * 3600000).toISOString()
const omsDated = (e) => { const { at_h, ...rest } = e; return { ...rest, at: omsAgo(at_h) } }

function omsFresh(seed) {
  const stock = {}
  for (const [wh, list] of Object.entries(seed.products)) for (const p of list) stock[`${wh}:${p.id}`] = p.stock
  const orders = seed.orders.map(({ age_h, promised_h, shipped_h, delivered_h, events, ...o }) => ({ ...o,
    created_at: omsAgo(age_h), promised_at: omsAgo(promised_h),
    shipped_at: shipped_h == null ? null : omsAgo(shipped_h), delivered_at: delivered_h == null ? null : omsAgo(delivered_h),
    events: events.map(omsDated) }))
  const returns = seed.returns.map(({ age_h, events, ...r }) => ({ ...r, created_at: omsAgo(age_h), events: events.map(omsDated) }))
  return { seed: { warehouses: seed.warehouses, products: seed.products, couriers: seed.couriers, channels: seed.channels,
    cancel_reasons: seed.cancel_reasons, hold_reasons: seed.hold_reasons, return_reasons: seed.return_reasons,
    promise_hours: seed.promise_hours }, stock, orders, returns,
    nextOrder: Math.max(...orders.map((o) => +o.no.slice(3))) + 1, nextReturn: Math.max(...returns.map((r) => +r.no.slice(4))) + 1 }
}
const omsState = (m) => (omsP ||= (async () => {
  await omsCleared
  if (self.caches) {
    const saved = await (await caches.open(OMS_CACHE)).match(OMS_KEY)
    if (saved) return saved.json()
  }
  const seed = await recordedBody(m, 'GET - /api/oms/seed')
  return seed ? omsFresh(seed) : null
})())
const omsSave = async (s) => {
  if (self.caches) await (await caches.open(OMS_CACHE)).put(OMS_KEY, json(s))
}

const OMS_RESERVING = new Set(['allocated', 'picking', 'packed'])
const omsHolds = (o) => OMS_RESERVING.has(o.status) || (o.status === 'on_hold' && o.held_from === 'allocated')
const omsReserved = (s, wh, id) => s.orders.filter((o) => o.wh === wh && omsHolds(o))
  .reduce((a, o) => a + o.lines.filter((l) => l.product_id === id).reduce((b, l) => b + l.qty, 0), 0)
const omsAvail = (s, wh, id) => (s.stock[`${wh}:${id}`] || 0) - omsReserved(s, wh, id)
const OMS_OPEN = new Set(['new', 'confirmed', 'allocated', 'picking', 'packed', 'backorder', 'on_hold'])
const omsLate = (o) => OMS_OPEN.has(o.status) && new Date(o.promised_at) < new Date()
const omsWhName = (s, id) => (s.seed.warehouses.find((w) => w.id === id) || {}).name || ''
const omsView = (s, o) => ({ ...o, wh_name: omsWhName(s, o.wh), late: omsLate(o), units: o.lines.reduce((a, l) => a + l.qty, 0) })
const omsReturned = (s, orderId, productId) => s.returns
  .filter((r) => r.order_id === orderId && r.status !== 'rejected')
  .reduce((a, r) => a + r.lines.filter((l) => l.product_id === productId).reduce((b, l) => b + l.qty, 0), 0)
const omsOrderDetail = (s, o) => ({ ...omsView(s, o), returns: s.returns.filter((r) => r.order_id === o.id),
  lines: o.lines.map((l) => ({ ...l, available: omsAvail(s, o.wh, l.product_id), returned: omsReturned(s, o.id, l.product_id) })) })
const omsLog = (rec, status, note, by = 'Sample Admin') => rec.events.push({ at: new Date().toISOString(), status, note, by })
const omsNo = (detail, status = 409) => json({ detail }, status)

function omsOrderAction(s, o, b) {
  const a = b.action
  const needs = (...from) => from.includes(o.status)
  const wrong = () => omsNo(`${o.no} is ${o.status.replace('_', ' ')}: it cannot do that now.`)
  let message
  if (a === 'confirm') {
    if (!needs('new')) return wrong()
    o.status = 'confirmed'; omsLog(o, 'confirmed', 'Order confirmed')
  } else if (a === 'allocate') {
    if (!needs('confirmed', 'backorder')) return wrong()
    const short = o.lines.filter((l) => omsAvail(s, o.wh, l.product_id) < l.qty)
    if (short.length) {
      const what = short.map((l) => `${l.sku} (need ${l.qty}, ${Math.max(0, omsAvail(s, o.wh, l.product_id))} free)`).join(', ')
      if (o.status !== 'backorder') { o.status = 'backorder'; omsLog(o, 'backorder', `Not enough stock: ${what}`) }
      message = `Not enough stock, so ${o.no} is on backorder: ${what}`
    } else {
      o.status = 'allocated'; omsLog(o, 'allocated', `Stock reserved at ${omsWhName(s, o.wh)}`)
    }
  } else if (a === 'pick') {
    if (!needs('allocated')) return wrong()
    o.status = 'picking'; omsLog(o, 'picking', 'Picking started')
  } else if (a === 'pack') {
    if (!needs('picking')) return wrong()
    o.status = 'packed'; omsLog(o, 'packed', 'Packed and labelled')
  } else if (a === 'ship') {
    if (!needs('packed')) return wrong()
    if (!b.courier) return omsNo('Choose a courier.', 422)
    for (const l of o.lines) s.stock[`${o.wh}:${l.product_id}`] = (s.stock[`${o.wh}:${l.product_id}`] || 0) - l.qty
    o.status = 'shipped'; o.courier = b.courier; o.awb = `AWB${5000000 + o.id * 37}`; o.shipped_at = new Date().toISOString()
    omsLog(o, 'shipped', `Handed to ${o.courier}, ${o.awb}`)
  } else if (a === 'deliver') {
    if (!needs('shipped')) return wrong()
    o.status = 'delivered'; o.delivered_at = new Date().toISOString(); omsLog(o, 'delivered', 'Delivered to the customer')
  } else if (a === 'hold') {
    if (!needs('new', 'confirmed', 'allocated', 'backorder')) return wrong()
    if (!b.reason) return omsNo('Say why it is on hold.', 422)
    o.held_from = o.status; o.status = 'on_hold'; o.hold_reason = b.reason; omsLog(o, 'on_hold', b.reason)
  } else if (a === 'release') {
    if (!needs('on_hold')) return wrong()
    o.status = o.held_from || 'confirmed'; o.held_from = null; o.hold_reason = null; omsLog(o, o.status, 'Released from hold')
  } else if (a === 'cancel') {
    if (!needs('new', 'confirmed', 'allocated', 'picking', 'packed', 'backorder', 'on_hold')) return wrong()
    if (!b.reason) return omsNo('Say why it is being cancelled.', 422)
    o.status = 'cancelled'; o.held_from = null; o.cancel_reason = b.reason
    omsLog(o, 'cancelled', o.payment === 'Prepaid' ? `${b.reason}. Prepaid, so a refund is due.` : b.reason)
  } else return omsNo('Unknown action.', 400)
  return { ok: true, message }
}

function omsReturnAction(s, r, b) {
  const a = b.action
  const wrong = () => omsNo(`${r.no} is ${r.status}: it cannot do that now.`)
  const order = s.orders.find((o) => o.id === r.order_id)
  if (a === 'approve') {
    if (r.status !== 'requested') return wrong()
    r.status = 'approved'; omsLog(r, 'approved', 'Return approved')
  } else if (a === 'reject') {
    if (r.status !== 'requested') return wrong()
    if (!b.reason) return omsNo('Say why it is rejected.', 422)
    r.status = 'rejected'; omsLog(r, 'rejected', b.reason)
  } else if (a === 'receive') {
    if (r.status !== 'approved') return wrong()
    if (!['good', 'damaged'].includes(b.condition)) return omsNo('Choose the condition of the goods.', 422)
    r.status = 'received'; r.condition = b.condition
    if (b.condition === 'good') for (const l of r.lines) s.stock[`${r.wh}:${l.product_id}`] = (s.stock[`${r.wh}:${l.product_id}`] || 0) + l.qty
    omsLog(r, 'received', b.condition === 'good' ? 'Goods received in good condition, back in stock' : 'Goods received damaged, not returned to stock')
  } else if (a === 'refund') {
    if (r.status !== 'received') return wrong()
    r.status = 'refunded'; r.refund_amount = r.value
    omsLog(r, 'refunded', `Refund of ₹${r.value} issued (demo: no money moves)`)
  } else if (a === 'exchange') {
    if (r.status !== 'received') return wrong()
    const no = `SO-${s.nextOrder++}`
    const id = Math.max(...s.orders.map((o) => o.id)) + 1
    const lines = r.lines.map((l) => ({ ...l, price: 0 }))
    const rep = { id, no, wh: r.wh, channel: r.channel, status: 'confirmed', customer: order.customer, payment: 'Prepaid',
      lines, subtotal: 0, shipping: 0, total: 0, created_at: new Date().toISOString(),
      promised_at: new Date(Date.now() + s.seed.promise_hours * 3600000).toISOString(), replacement_for: r.no, events: [] }
    omsLog(rep, 'confirmed', `Replacement for ${r.no}`)
    s.orders.push(rep)
    r.status = 'exchanged'; r.replacement_no = no; omsLog(r, 'exchanged', `Replacement order ${no} raised`)
  } else return omsNo('Unknown action.', 400)
  return { ok: true }
}

function omsSummary(s, wh, days) {
  const since = Date.now() - days * 86400000
  const orders = s.orders.filter((o) => (wh === '-' || o.wh === +wh) && new Date(o.created_at) >= new Date(since))
  const returns = s.returns.filter((r) => (wh === '-' || r.wh === +wh) && new Date(r.created_at) >= new Date(since))
  const live = orders.filter((o) => o.status !== 'cancelled')
  const group = (list, keyOf) => {
    const g = new Map()
    for (const o of list) {
      const k = keyOf(o), e = g.get(k) || { name: k, orders: 0, value: 0 }
      e.orders++; e.value += o.total; g.set(k, e)
    }
    return [...g.values()].sort((a, b) => b.value - a.value)
  }
  const counts = {}
  for (const o of orders) counts[o.status] = (counts[o.status] || 0) + 1
  const shipped = orders.filter((o) => o.shipped_at)
  const onTime = shipped.filter((o) => new Date(o.shipped_at) <= new Date(o.promised_at)).length
  const hours = shipped.map((o) => (new Date(o.shipped_at) - new Date(o.created_at)) / 3600000)
  const units = new Map()
  for (const o of live) for (const l of o.lines) {
    const e = units.get(l.sku) || { sku: l.sku, name: l.name, desc: l.desc, units: 0, value: 0 }
    e.units += l.qty; e.value += l.qty * l.price; units.set(l.sku, e)
  }
  const reasons = new Map()
  for (const r of returns) reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1)
  const delivered = orders.filter((o) => o.status === 'delivered').length
  return { days, total: orders.length, value: live.reduce((a, o) => a + o.total, 0), counts,
    open: orders.filter((o) => OMS_OPEN.has(o.status)).length,
    late: orders.filter(omsLate).sort((a, b) => new Date(a.promised_at) - new Date(b.promised_at)).map((o) => omsView(s, o)),
    backorders: orders.filter((o) => o.status === 'backorder').map((o) => omsView(s, o)),
    on_time_pct: shipped.length ? Math.round((onTime / shipped.length) * 100) : null,
    avg_ship_hours: hours.length ? Math.round(hours.reduce((a, h) => a + h, 0) / hours.length) : null,
    returns_open: returns.filter((r) => ['requested', 'approved', 'received'].includes(r.status)).length,
    return_rate_pct: delivered ? Math.round((returns.filter((r) => r.status !== 'rejected').length / delivered) * 100) : null,
    refunded: returns.reduce((a, r) => a + (r.refund_amount || 0), 0),
    by_channel: group(live, (o) => o.channel), by_warehouse: group(live, (o) => omsWhName(s, o.wh)),
    top_products: [...units.values()].sort((a, b) => b.units - a.units).slice(0, 10),
    return_reasons: [...reasons].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) }
}

async function omsAnswer(m, req, method, path, url, wh) {
  const s = await omsState(m)
  if (!s) return json({ detail: 'The order sample data is missing from this build.' }, 503)
  const inScope = (x) => wh === '-' || x.wh === +wh
  const body = method === 'POST' ? await hrBody(req) : {}
  const param = (k) => (url.searchParams.get(k) || '').trim()

  if (method === 'GET' && path === '/api/oms/session') return json({ live: false, signed_in: true })
  if (method === 'GET' && path === '/api/oms/options') {
    const { products, ...rest } = s.seed
    return json(rest)
  }
  if (method === 'GET' && path === '/api/oms/summary') return json(omsSummary(s, wh, +param('days') || 30))
  if (method === 'GET' && path === '/api/oms/products') {
    const at = +param('wh') || +wh
    const q = param('q').toLowerCase()
    const list = (s.seed.products[at] || []).map((p) => ({ ...p, stock: s.stock[`${at}:${p.id}`] || 0, available: omsAvail(s, at, p.id) }))
    return json(list.filter((p) => !q || `${p.sku} ${p.name} ${p.desc}`.toLowerCase().includes(q)))
  }
  if (method === 'GET' && path === '/api/oms/orders') {
    const scoped = s.orders.filter(inScope)
    const counts = { all: scoped.length, late: scoped.filter(omsLate).length }
    for (const o of scoped) counts[o.status] = (counts[o.status] || 0) + 1
    const q = param('q').toLowerCase()
    const rows = scoped.filter((o) => (!param('channel') || o.channel === param('channel'))
      && (!param('status') || (param('status') === 'late' ? omsLate(o) : o.status === param('status')))
      && (!q || `${o.no} ${o.customer.name} ${o.customer.phone} ${o.customer.city} ${o.lines.map((l) => l.sku).join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    return json({ rows: rows.map((o) => omsView(s, o)), counts })
  }
  if (method === 'POST' && path === '/api/oms/orders') {
    const at = +body.wh || +wh
    const catalogue = s.seed.products[at]
    if (!catalogue) return omsNo('Choose a warehouse.', 422)
    if (!(body.customer || {}).name?.trim()) return omsNo('Enter the customer\'s name.', 422)
    const asked = (body.lines || []).filter((l) => +l.qty > 0)
    if (!asked.length) return omsNo('Add at least one product.', 422)
    const lines = []
    for (const l of asked) {
      const p = catalogue.find((x) => x.id === +l.product_id)
      if (!p) return omsNo('That product is not at this warehouse.', 422)
      lines.push({ product_id: p.id, sku: p.sku, name: p.name, desc: p.desc, qty: +l.qty, price: p.price })
    }
    const subtotal = lines.reduce((a, l) => a + l.qty * l.price, 0)
    const shipping = subtotal >= 2000 ? 0 : 99
    const o = { id: Math.max(...s.orders.map((x) => x.id)) + 1, no: `SO-${s.nextOrder++}`, wh: at, channel: body.channel || 'Phone Order',
      status: 'new', customer: { phone: '', email: '', city: '', address: '', ...body.customer }, payment: body.payment === 'COD' ? 'COD' : 'Prepaid',
      lines, subtotal, shipping, total: subtotal + shipping, created_at: new Date().toISOString(),
      promised_at: new Date(Date.now() + s.seed.promise_hours * 3600000).toISOString(), shipped_at: null, delivered_at: null, events: [] }
    omsLog(o, 'new', `Entered by hand (${o.channel})`)
    s.orders.push(o)
    await omsSave(s)
    return json(omsOrderDetail(s, o))
  }
  const om = path.match(/^\/api\/oms\/orders\/(\d+)(\/action)?$/)
  if (om) {
    const o = s.orders.find((x) => x.id === +om[1] && inScope(x))
    if (!o) return omsNo('No such order here.', 404)
    if (method === 'GET' && !om[2]) return json(omsOrderDetail(s, o))
    if (method === 'POST' && om[2]) {
      const r = omsOrderAction(s, o, body)
      if (r instanceof Response) return r
      await omsSave(s)
      return json({ ...omsOrderDetail(s, o), message: r.message })
    }
  }
  if (method === 'GET' && path === '/api/oms/returns') {
    const scoped = s.returns.filter(inScope)
    const counts = { all: scoped.length }
    for (const r of scoped) counts[r.status] = (counts[r.status] || 0) + 1
    const q = param('q').toLowerCase()
    const rows = scoped.filter((r) => (!param('status') || r.status === param('status'))
      && (!q || `${r.no} ${r.order_no} ${r.customer}`.toLowerCase().includes(q)))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    return json({ rows, counts })
  }
  if (method === 'POST' && path === '/api/oms/returns') {
    const o = s.orders.find((x) => x.id === +body.order_id && inScope(x))
    if (!o) return omsNo('No such order here.', 404)
    if (o.status !== 'delivered') return omsNo('Only a delivered order can be returned.')
    if (!body.reason) return omsNo('Choose a reason.', 422)
    const asked = (body.lines || []).filter((l) => +l.qty > 0)
    if (!asked.length) return omsNo('Choose what is coming back.', 422)
    const lines = []
    for (const a of asked) {
      const l = o.lines.find((x) => x.product_id === +a.product_id)
      if (!l) return omsNo('That product is not on this order.', 422)
      if (+a.qty > l.qty - omsReturned(s, o.id, l.product_id)) return omsNo(`Only ${l.qty - omsReturned(s, o.id, l.product_id)} of ${l.sku} can still be returned.`, 422)
      lines.push({ product_id: l.product_id, sku: l.sku, name: l.name, desc: l.desc, qty: +a.qty, price: l.price })
    }
    const r = { id: Math.max(0, ...s.returns.map((x) => x.id)) + 1, no: `RMA-${s.nextReturn++}`, order_id: o.id, order_no: o.no, wh: o.wh,
      channel: o.channel, customer: o.customer.name, status: 'requested', reason: body.reason, lines,
      value: lines.reduce((a, l) => a + l.qty * l.price, 0), condition: null, refund_amount: null, created_at: new Date().toISOString(), events: [] }
    omsLog(r, 'requested', body.reason)
    s.returns.push(r)
    await omsSave(s)
    return json(r)
  }
  const rm = path.match(/^\/api\/oms\/returns\/(\d+)\/action$/)
  if (rm && method === 'POST') {
    const r = s.returns.find((x) => x.id === +rm[1] && inScope(x))
    if (!r) return omsNo('No such return here.', 404)
    const done = omsReturnAction(s, r, body)
    if (done instanceof Response) return done
    await omsSave(s)
    return json(r)
  }
  return json({ detail: 'Not part of this demo.' }, 404)
}

// ---- HR employees kept for the visit (demo-data/tools/record_hr.py recorded the rest) ----
// Added people get ids from 9001 up; an edit to a recorded person is laid over
// their recorded record. Both are gone on reload, like every save in the demo.
const HR_ADDED = new Map(), HR_EDITED = new Map()
let hrNextId = 9000
const EMP_RE = /^\/api\/hr\/employees\/(\d+)$/
const recordedBody = async (m, key) => {
  const e = m.exact.get(key)
  if (!e) return null
  try { return await (await replay(e)).json() } catch { return null }
}
async function hrBody(req) {
  try { return await req.clone().json() } catch { return {} }
}
// names for the ids a form sends, from the recorded options
async function hrNamed(m, rec) {
  const o = (await recordedBody(m, 'GET - /api/hr/options')) || {}
  const nameOf = (list, id) => ((list || []).find((x) => String(x.id) === String(id)) || {}).name || ''
  const sal = rec.salary || {}
  return { ...rec,
    department: nameOf(o.departments, rec.department_id), designation: nameOf(o.designations, rec.designation_id),
    shift: nameOf(o.shifts, rec.shift_id), manager: nameOf(o.employees, rec.reporting_to_id) || null,
    gross: Object.values(sal).reduce((a, v) => a + (+v || 0), 0) }
}
async function hrEmployeeAnswer(m, req, method, path, url) {
  if (!path.startsWith('/api/hr/employees')) return null
  if (method === 'POST' && path === '/api/hr/employees') {
    const b = await hrBody(req)
    if (!String(b.name || '').trim()) return json({ detail: 'Give the employee a name' }, 400)
    if (!b.joined_on) return json({ detail: 'When did they join? Put in the joining date' }, 400)
    const id = ++hrNextId
    const today = new Date().toISOString().slice(0, 10)
    const rec = await hrNamed(m, { ...b, id, code: b.code || 'EMP' + String(15 + HR_ADDED.size).padStart(4, '0'),   // the recording holds EMP0001–EMP0014
      status: 'active',
      photo: null, service: '', contracts: [], documents: [], reports: [], leave: [], advances: [],
      history: [{ id: 1, kind: 'Joined', date: b.joined_on, detail: 'Added in the demo', by: 'Sample Admin', at: today }] })
    HR_ADDED.set(id, rec)
    return json(rec)
  }
  const one = path.match(EMP_RE)
  if (one) {
    const id = +one[1]
    const base = HR_ADDED.get(id) || HR_EDITED.get(id) || await recordedBody(m, `GET - ${path}`)
    if (!base) return null
    if (method === 'PUT') {
      const rec = await hrNamed(m, { ...base, ...(await hrBody(req)), id })
      ;(HR_ADDED.has(id) ? HR_ADDED : HR_EDITED).set(id, rec)
      return json(rec)
    }
    if (method === 'GET') return (HR_ADDED.has(id) || HR_EDITED.has(id)) ? json(base) : null
    return null
  }
  if (method === 'GET' && path === '/api/hr/employees' && (HR_ADDED.size || HR_EDITED.size)) {
    const e = m.exact.get(`GET - ${path}${url.search}`) || pick(m.byPath.get(`GET * ${path}`), url)
    if (!e) return null
    let rows = []
    try { rows = await (await replay(e)).json() } catch { return null }
    if (!Array.isArray(rows)) return null
    rows = rows.map((r) => (HR_EDITED.has(r.id) ? { ...r, ...HR_EDITED.get(r.id) } : r))
    const st = url.searchParams.get('status') || ''
    const q = (url.searchParams.get('q') || '').toLowerCase()
    if (!st || st === 'current' || st === 'all') {
      rows = rows.concat([...HR_ADDED.values()].filter((r) => !q || r.name.toLowerCase().includes(q)))
    }
    return json(rows)
  }
  return null
}

// Of several recorded answers for one path, the one whose query shares the
// most parameters with this request (dates move on; the filter usually doesn't).
function pick(list, url) {
  if (!list || !list.length) return null
  if (list.length === 1) return list[0]
  const want = new URLSearchParams(url.search)
  let best = list[0], score = -1
  for (const e of list) {
    const got = new URLSearchParams(e.search || '')
    let s = 0
    for (const [k, v] of want) if (got.get(k) === v) s += 2; else if (got.has(k)) s += 1
    if (s > score) { best = e; score = s }
  }
  return best
}

async function replay(e) {
  const headers = { 'Content-Type': e.type || 'application/json', 'X-Warexx-Demo': '1' }
  if (e.disposition) headers['Content-Disposition'] = e.disposition
  if (e.location) headers.Location = e.location
  if (e.body !== undefined) return new Response(e.body, { status: e.status, headers })
  const r = await fetch(DATA + 'bodies/' + e.file)
  return new Response(await r.arrayBuffer(), { status: e.status, headers })
}

function missingRead(path) {
  if (path.startsWith('/pos') || path === '/m' || path.startsWith('/m/')) {
    return new Response(page('This screen is not part of the demo',
      'Everything else in the menu is — pick another screen to keep exploring.'),
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
  // A list nobody recorded is an empty list, not an error: the screen shows its
  // own "nothing here yet" instead of a failure.
  return json([], 200)
}

const SESSION = { ok: true, token: 'demo', user: 'superadmin', role: 'superadmin',
  role_label: 'Super Admin', full_name: 'Sample Admin', permissions: {},
  can: { manage_users: true, admin: true, command: true, boss: false } }
const AUTH = {
  '/api/auth/login': SESSION,
  '/api/auth/verify': SESSION,
  '/api/auth/me': { id: 1, username: 'superadmin', role: 'superadmin', role_label: 'Super Admin',
    full_name: 'Sample Admin', active: true, permissions: {} },
  '/api/auth/logout': { ok: true },
}
const PROFILE = { id: 1, username: 'superadmin', role: 'superadmin', role_label: 'Super Admin',
  full_name: 'Sample Admin', job_title: 'Operations head', email: 'admin@sample-business.example', phone: '+91 90000 00000',
  active: true, permissions: {}, created_by: 'system',
  created_at: new Date(Date.now() - 90 * 86400000).toISOString(), last_login_at: new Date().toISOString(),
  recent: [
    { at: new Date(Date.now() - 2 * 60000).toISOString(), action: 'signin', screen: 'session', outcome: 'ok', summary: 'signed in', warehouse: '' },
    { at: new Date(Date.now() - 26 * 3600000).toISOString(), action: 'create', screen: 'grn', outcome: 'ok', summary: 'posted a GRN — 120 units received', warehouse: 'Sample Warehouse A' },
    { at: new Date(Date.now() - 50 * 3600000).toISOString(), action: 'create', screen: 'purchases', outcome: 'ok', summary: 'raised a purchase order to a supplier', warehouse: 'Sample Warehouse A' },
  ] }

let nextId = 90000
async function acknowledgeWrite(req, path, meta) {
  if (path.startsWith('/pos')) {
    // a shop form: back to the page it came from, which still shows the sample
    return new Response(null, { status: 303, headers: { Location: req.referrer || '/pos/' } })
  }
  if (path === '/api/auth/logout') return json({ ok: true })
  let body = {}
  try { body = await req.clone().json() } catch { /* a form or a file */ }
  const id = ++nextId
  // Echo what was sent with an id and an "ok", which is what most screens read
  // back from a save. The message is what a toast shows if the screen surfaces it.
  return json({ ok: true, demo: true, id, ...(body && typeof body === 'object' ? body : {}),
    message: meta.writeMessage || 'Saved in the demo — sample data resets when you reload.' })
}

const json = (v, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { 'Content-Type': 'application/json', 'X-Warexx-Demo': '1' } })

const page = (title, text) => `<!doctype html><meta charset="utf-8"><body style="font:15px/1.6 Inter,system-ui,sans-serif;color:#1A1814;background:#F7F5F1;display:grid;place-items:center;min-height:90vh;margin:0"><div style="text-align:center;max-width:420px;padding:24px"><h2 style="margin:0 0 8px">${title}</h2><p style="color:#6E675E;margin:0">${text}</p></div>`
