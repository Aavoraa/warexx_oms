// The Order Management module's sample data (OMS.jsx, answered by sw.js):
//
//     node demo-data/tools/seed_oms.mjs
//
// Unlike HR, CRM and Finance there is no backend to record this from, so it is
// generated, from the sample business already recorded: the same warehouses and
// the same products at the same stock, so an order's SKU is one Inventory shows.
// Customers are fictional ("Sample Customer 07", *.example addresses).
//
// Times are kept as hours before "now" and turned into dates by the worker when
// a visit starts, so the orders are always recent however old the build is.
// Seeded, so running it twice gives the same file.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'recorded')
const MANIFEST = path.join(REC, 'manifest.json')
const KEY = 'GET - /api/oms/seed'
const FILE = 'oms-seed.json'

const m = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const bodyOf = (e) => JSON.parse(e.file ? readFileSync(path.join(REC, 'bodies', e.file), 'utf8') : e.body)

let state = 20261106
const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32 }
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1))
const pick = (list) => list[int(0, list.length - 1)]

// ---- the catalogue, per warehouse
const warehouses = m.meta.warehouses.map(({ id, name, code }) => ({ id, name, code }))
const products = {}
for (const w of warehouses) {
  const e = m.entries.find((x) => x.key === `GET ${w.id} /api/inventory/products?held=1`)
  if (!e) throw new Error(`no recorded stock for warehouse ${w.id}; is demo-data/recorded complete?`)
  products[w.id] = bodyOf(e).map((p) => ({
    id: p.id, sku: p.sku, name: p.name, desc: p.description || '', mrp: +p.mrp || 0,
    price: +p.sale_price || +p.mrp || 0, stock: Math.max(0, Math.round(+p.stock_qty || 0)),
  })).filter((p) => p.price > 0)
}

// ---- who, and through what
const CHANNELS = ['Website', 'Mobile App', 'Marketplace', 'Store Pickup', 'Phone Order']
const COURIERS = ['Sample Express', 'Demo Logistics', 'Example Couriers', 'Own Delivery Van']
const CITIES = ['Chennai', 'Coimbatore', 'Madurai', 'Bengaluru', 'Kochi', 'Hyderabad', 'Tiruchirappalli', 'Salem']
const RETURN_REASONS = ['Wrong size', 'Damaged in transit', 'Different from photo', 'Ordered by mistake', 'Quality not as expected']
const CANCEL_REASONS = ['Customer changed their mind', 'Payment not received', 'Duplicate order']
const HOLD_REASONS = ['Address needs confirming', 'Waiting for the customer to call back']

const customer = (n) => {
  const nn = String(n).padStart(2, '0')
  return { name: `Sample Customer ${nn}`, phone: `+91 90000 000${nn}`, email: `customer${nn}@sample-business.example`,
    city: pick(CITIES), address: `${int(1, 90)}, Sample Street, Sample Nagar` }
}

// what the seeded allocations have already claimed, so none is over-allocated
const claimed = new Map()
const free = (wh, p) => p.stock - (claimed.get(`${wh}:${p.id}`) || 0)
const claim = (wh, p, q) => claimed.set(`${wh}:${p.id}`, (claimed.get(`${wh}:${p.id}`) || 0) + q)

function makeLines(wh, holdsStock) {
  const lines = []
  const pool = products[wh].filter((p) => free(wh, p) >= 4)
  for (let i = 0, n = int(1, 3); i < n && pool.length; i++) {
    const p = pool.splice(int(0, pool.length - 1), 1)[0]
    const qty = int(1, 3)
    if (holdsStock) claim(wh, p, qty)
    lines.push({ product_id: p.id, sku: p.sku, name: p.name, desc: p.desc, qty, price: p.price })
  }
  return lines
}

// [status, hours since it came in, how many hours in it was shipped (delivered/shipped)]
const PLAN = [
  ...Array(7).fill().map(() => ['new', int(1, 20)]),
  ...Array(5).fill().map(() => ['confirmed', int(6, 40)]),
  ['confirmed', 84],                            // sat too long: late
  ...Array(4).fill().map(() => ['allocated', int(12, 48)]),
  ...Array(4).fill().map(() => ['picking', int(14, 50)]),
  ['picking', 96],                              // late
  ...Array(3).fill().map(() => ['packed', int(20, 60)]),
  ['packed', 78],                               // late
  ...Array(5).fill().map(() => ['shipped', int(40, 110), int(20, 40)]),
  ...Array(16).fill().map(() => ['delivered', int(90, 620), int(18, 66)]),
  ...Array(3).fill().map(() => ['delivered', int(120, 500), int(76, 100)]),   // shipped after the promise
  ...Array(3).fill().map(() => ['cancelled', int(30, 300)]),
  ...Array(2).fill().map(() => ['on_hold', int(8, 40)]),
  ...Array(2).fill().map(() => ['backorder', int(20, 60)]),
]
const PROMISE_H = 72
const HOLDS_STOCK = new Set(['allocated', 'picking', 'packed'])

const orders = []
let no = 10001
PLAN.forEach(([status, age, shippedAfter], i) => {
  const w = warehouses[i % warehouses.length]
  const c = customer((i % 40) + 1)
  let lines = makeLines(w.id, HOLDS_STOCK.has(status))
  if (status === 'backorder') {                 // asks for more than the shelf holds
    const low = [...products[w.id]].sort((a, b) => free(w.id, a) - free(w.id, b))[i % 3]
    lines = [{ product_id: low.id, sku: low.sku, name: low.name, desc: low.desc, qty: Math.max(0, free(w.id, low)) + int(2, 6), price: low.price }]
  }
  const subtotal = lines.reduce((a, l) => a + l.qty * l.price, 0)
  const shipping = subtotal >= 2000 ? 0 : 99
  const channel = CHANNELS[int(0, CHANNELS.length - 1)]
  const events = [{ at_h: age, status: 'new', note: `Came in through ${channel}`, by: channel }]
  const step = (st, h, note, by = 'Sample Staff 06') => events.push({ at_h: Math.max(0, age - h), status: st, note, by })
  const reached = ['confirmed', 'allocated', 'picking', 'packed', 'shipped', 'delivered']
  const stage = reached.indexOf(status)
  if (stage >= 0 || status === 'backorder') step('confirmed', Math.min(3, age / 6), 'Order confirmed')
  if (stage >= 1) step('allocated', Math.min(6, age / 5), 'Stock reserved at ' + w.name)
  if (status === 'backorder') step('backorder', Math.min(6, age / 5), 'Not enough stock to reserve')
  if (stage >= 2) step('picking', Math.min(10, age / 4), 'Picking started')
  if (stage >= 3) step('packed', Math.min(16, age / 3), 'Packed and labelled')
  const o = { id: i + 1, no: `SO-${no++}`, wh: w.id, channel, status, customer: c, payment: rnd() < 0.7 ? 'Prepaid' : 'COD',
    lines, subtotal, shipping, total: subtotal + shipping, age_h: age, promised_h: age - PROMISE_H, events }
  if (stage >= 4) {
    o.courier = pick(COURIERS); o.awb = `AWB${int(4000000, 4999999)}`
    o.shipped_h = Math.max(0, age - shippedAfter)
    events.push({ at_h: o.shipped_h, status: 'shipped', note: `Handed to ${o.courier}, ${o.awb}`, by: 'Sample Staff 06' })
  }
  if (status === 'delivered') {
    o.delivered_h = Math.max(0, o.shipped_h - int(10, 40))
    events.push({ at_h: o.delivered_h, status: 'delivered', note: 'Delivered to the customer', by: o.courier })
  }
  if (status === 'cancelled') {
    o.cancel_reason = pick(CANCEL_REASONS)
    step('cancelled', Math.min(8, age / 3), o.cancel_reason)
  }
  if (status === 'on_hold') {
    o.hold_reason = pick(HOLD_REASONS); o.held_from = 'confirmed'
    step('confirmed', Math.min(3, age / 6), 'Order confirmed')
    step('on_hold', Math.min(5, age / 4), o.hold_reason)
  }
  orders.push(o)
})

// ---- returns, against delivered orders
const delivered = orders.filter((o) => o.status === 'delivered')
const RETURN_PLAN = ['requested', 'requested', 'requested', 'approved', 'approved', 'received', 'refunded', 'refunded', 'exchanged', 'rejected']
const returns = RETURN_PLAN.map((status, i) => {
  const o = delivered[i * 2 % delivered.length]
  const l = o.lines[0]
  const age = Math.max(1, o.delivered_h - int(0, Math.max(0, o.delivered_h - 2)))
  const reason = RETURN_REASONS[i % RETURN_REASONS.length]
  const value = l.price
  const events = [{ at_h: age, status: 'requested', note: reason, by: o.customer.name }]
  const seq = { approved: ['approved'], received: ['approved', 'received'], refunded: ['approved', 'received', 'refunded'],
    exchanged: ['approved', 'received', 'exchanged'], rejected: ['rejected'] }[status] || []
  seq.forEach((st, k) => events.push({ at_h: Math.max(0, age * (1 - (k + 1) / (seq.length + 1))), status: st,
    note: { approved: 'Return approved', received: 'Goods received, in good condition', refunded: `Refund issued to the ${o.payment === 'COD' ? 'bank account' : 'original payment method'}`,
      exchanged: 'Replacement arranged', rejected: 'Outside the return window' }[st], by: 'Sample Staff 06' }))
  return { id: i + 1, no: `RMA-${2001 + i}`, order_id: o.id, order_no: o.no, wh: o.wh, channel: o.channel, customer: o.customer.name,
    status, reason, lines: [{ product_id: l.product_id, sku: l.sku, name: l.name, desc: l.desc, qty: 1, price: l.price }], value,
    condition: seq.includes('received') ? 'good' : null, refund_amount: status === 'refunded' ? value : null, age_h: age, events }
})

const seed = { warehouses, products, couriers: COURIERS, channels: CHANNELS, cancel_reasons: CANCEL_REASONS,
  hold_reasons: HOLD_REASONS, return_reasons: RETURN_REASONS, promise_hours: PROMISE_H, orders, returns }
writeFileSync(path.join(REC, 'bodies', FILE), JSON.stringify(seed))

m.entries = m.entries.filter((e) => e.key !== KEY)
m.entries.push({ key: KEY, method: 'GET', wh: '-', path: '/api/oms/seed', search: '', status: 200, type: 'application/json', file: FILE })
m.meta.oms = { source: 'generated from the recorded catalogue by demo-data/tools/seed_oms.mjs', orders: orders.length, returns: returns.length }
writeFileSync(MANIFEST, JSON.stringify(m))
console.log(`${orders.length} orders, ${returns.length} returns, ${warehouses.map((w) => products[w.id].length).join('/')} products → recorded/bodies/${FILE}`)
