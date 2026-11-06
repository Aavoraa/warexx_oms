// ==========================================================================
//  Order Management — customer orders, from the channel to the doorstep and back
//  ------------------------------------------------------------------------
//  Five screens over one order: the dashboard, the inbox, fulfilment (allocate,
//  pick, pack, ship), customer returns and reports. An order only moves through
//  the stages the server allows, and stock is reserved when it is allocated.
//
//  For staff the server is lead-api/oms.py, behind their account (accounts.py).
//  For a demo visitor, sw.js answers the same calls from the
//  sample orders in demo-data/tools/seed_oms.mjs. Drawn from the same parts as HR
//  and Finance.
// ==========================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import { Loading } from './Loader.jsx'
import './hr.css'
import './oms.css'
import { FinPage, F, Sel, Empty, Modal, useRun, downloadCsv, errText } from './hr-kit.jsx'
import { Kpis, StatusBadge, Drawer, ErrorState } from './ui/kit.jsx'
import { money, Icon } from './App.jsx'

const CRUMB = 'Orders'
const inr = (v) => (v == null ? '—' : '₹ ' + money(v))
const whole = (v) => '₹ ' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
const when = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ', ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

const STATUS = {
  new: ['New', 'info'], confirmed: ['Confirmed', 'info'], allocated: ['Allocated', 'info'], backorder: ['Backorder', 'err'],
  picking: ['Picking', 'warn'], packed: ['Packed', 'warn'], shipped: ['Shipped', 'ok'], delivered: ['Delivered', 'ok'],
  on_hold: ['On hold', 'warn'], cancelled: ['Cancelled', 'muted'],
}
const RETURN_STATUS = {
  requested: ['Requested', 'info'], approved: ['Approved', 'warn'], received: ['Received', 'warn'],
  refunded: ['Refunded', 'ok'], exchanged: ['Exchanged', 'ok'], rejected: ['Rejected', 'muted'],
}
const Pill = ({ map, status }) => {
  const [label, tone] = map[status] || [status, 'muted']
  return <StatusBadge tone={tone}>{label}</StatusBadge>
}
const OrderPill = ({ status }) => <Pill map={STATUS} status={status} />
const ReturnPill = ({ status }) => <Pill map={RETURN_STATUS} status={status} />
const Late = () => <StatusBadge tone="err">Late</StatusBadge>

// The dashboard's tiles open the inbox already filtered to what they counted.
let inboxFilter = null

// What can be done to an order at each stage, and how it is drawn.
const NEXT_STEP = {
  new: { action: 'confirm', label: 'Confirm order' },
  confirmed: { action: 'allocate', label: 'Allocate stock' },
  backorder: { action: 'allocate', label: 'Try allocating again' },
  allocated: { action: 'pick', label: 'Start picking' },
  picking: { action: 'pack', label: 'Mark packed' },
  packed: { action: 'ship', label: 'Ship' },
  shipped: { action: 'deliver', label: 'Mark delivered' },
  on_hold: { action: 'release', label: 'Release from hold' },
}
const CAN_HOLD = new Set(['new', 'confirmed', 'allocated', 'backorder'])
const CAN_CANCEL = new Set(['new', 'confirmed', 'allocated', 'picking', 'packed', 'backorder', 'on_hold'])

function useOptions() {
  const [o, setO] = useState(null)
  useEffect(() => { api.omsGet('options').then(setO).catch(() => {}) }, [])
  return o || { warehouses: [], couriers: [], channels: [], cancel_reasons: [], hold_reasons: [], return_reasons: [] }
}

// One load, its error, and a way to read it again.
function useLoad(fn, deps) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(() => fn().then((d) => { setData(d); setError(null); return d }).catch((e) => setError(errText(e))), deps)   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])
  return [data, error, load]
}

// ---- asking for the one thing an action needs ------------------------------
function ReasonDialog({ title, label, options, confirm, onClose, onDone, danger }) {
  const [v, setV] = useState('')
  return (
    <Modal title={title} onClose={onClose} foot={<>
      <button className="btn" onClick={onClose}>Back</button>
      <button className={'btn ' + (danger ? 'danger' : 'primary')} disabled={!v} onClick={() => onDone(v)}>{confirm}</button></>}>
      <F label={label} req>
        {options ? <Sel value={v} onChange={setV} options={options} placeholder="Choose…" />
          : <input value={v} onChange={(e) => setV(e.target.value)} autoFocus />}
      </F>
    </Modal>
  )
}

function RaiseReturn({ order, reasons, toast, onClose, onDone }) {
  const [qty, setQty] = useState({})
  const [reason, setReason] = useState('')
  const [busy, run] = useRun(toast)
  const lines = order.lines.map((l) => ({ ...l, left: l.qty - (l.returned || 0) }))
  const chosen = lines.filter((l) => +qty[l.product_id] > 0)
  const value = chosen.reduce((a, l) => a + l.price * +qty[l.product_id], 0)
  const save = async () => {
    const r = await run(() => api.omsPost('returns', { order_id: order.id, reason,
      lines: chosen.map((l) => ({ product_id: l.product_id, qty: +qty[l.product_id] })) }), (x) => `Return ${x.no} raised`)
    if (r) onDone()
  }
  return (
    <Modal wide title={`Raise a return on ${order.no}`} onClose={onClose} foot={<>
      <span className="small muted oms-foot-note">Value {inr(value)}</span>
      <button className="btn" onClick={onClose}>Back</button>
      <button className="btn primary" disabled={busy || !reason || !chosen.length} onClick={save}>Raise return</button></>}>
      <div className="tablewrap"><table className="items fin-table">
        <thead><tr><th>Product</th><th className="r">Delivered</th><th className="r">Can return</th><th className="r" style={{ width: 110 }}>Returning</th></tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.product_id}>
            <td><b>{l.sku}</b><div className="small muted">{l.desc || l.name}</div></td>
            <td className="r">{l.qty}</td><td className="r">{l.left}</td>
            <td className="r"><input type="number" min="0" max={l.left} disabled={!l.left} className="oms-qty" value={qty[l.product_id] ?? ''}
              onChange={(e) => setQty({ ...qty, [l.product_id]: Math.min(l.left, Math.max(0, +e.target.value || 0)) })} /></td>
          </tr>))}</tbody>
      </table></div>
      <F label="Reason" req style={{ marginTop: 12 }}>
        <Sel value={reason} onChange={setReason} options={reasons} placeholder="Choose…" />
      </F>
    </Modal>
  )
}

// ---- one order: who, what, where it has been, and what can happen next ------
function OrderDrawer({ id, options, toast, onClose, onChanged }) {
  const [o, error, load] = useLoad(() => api.omsGet(`orders/${id}`), [id])
  const [dialog, setDialog] = useState(null)
  const [busy, run] = useRun(toast)
  const act = async (action, extra, okMsg) => {
    setDialog(null)
    const r = await run(() => api.omsPost(`orders/${id}/action`, { action, ...extra }))
    if (!r) return
    toast(r.message || okMsg || `${r.no} is now ${(STATUS[r.status] || [r.status])[0].toLowerCase()}`, r.message ? 'err' : 'ok')
    await load(); onChanged?.()
  }
  const step = o && NEXT_STEP[o.status]
  const startStep = () => (step.action === 'ship' ? setDialog('ship') : act(step.action))
  const returnable = o?.status === 'delivered' && o.lines.some((l) => l.qty > (l.returned || 0))
  return (
    <Drawer title={o ? o.no : 'Order'} sub={o && `${o.channel} · ${o.wh_name}`} width={600} onClose={onClose} footer={o && <>
      {CAN_CANCEL.has(o.status) && <button className="btn danger" disabled={busy} onClick={() => setDialog('cancel')}>Cancel order</button>}
      {CAN_HOLD.has(o.status) && <button className="btn" disabled={busy} onClick={() => setDialog('hold')}>Put on hold</button>}
      {returnable && <button className="btn" disabled={busy} onClick={() => setDialog('return')}><Icon name="undo" size={14} /> Raise return</button>}
      {step && <button className="btn primary oms-foot-main" disabled={busy} onClick={startStep}>{step.label}</button>}
    </>}>
      {error ? <ErrorState onRetry={load}>{error}</ErrorState> : !o ? <Loading>Reading the order…</Loading> : <>
        <div className="oms-drawer-status"><OrderPill status={o.status} />{o.late && <Late />}
          {o.replacement_for && <span className="small muted">Replacement for {o.replacement_for}</span>}</div>
        {o.status === 'on_hold' && <div className="oms-note warn"><b>On hold:</b> {o.hold_reason}</div>}
        {o.status === 'cancelled' && <div className="oms-note"><b>Cancelled:</b> {o.cancel_reason}</div>}
        <div className="oms-facts">
          <div><span>Customer</span><b>{o.customer.name}</b>{o.customer.phone}<br />{o.customer.email}</div>
          <div><span>Deliver to</span>{o.customer.address}{o.customer.address && o.customer.city ? ', ' : ''}{o.customer.city}</div>
          <div><span>Payment</span><b>{o.payment}</b></div>
          <div><span>Ordered</span>{when(o.created_at)}</div>
          <div><span>Ship by</span>{when(o.promised_at)}</div>
          {o.courier && <div><span>Courier</span><b>{o.courier}</b>{o.awb}</div>}
        </div>
        <div className="tablewrap"><table className="items fin-table">
          <thead><tr><th>Product</th><th className="r">Qty</th><th className="r">Free stock</th><th className="r">Price</th><th className="r">Amount</th></tr></thead>
          <tbody>{o.lines.map((l) => (
            <tr key={l.product_id}>
              <td><b>{l.sku}</b><div className="small muted">{l.desc || l.name}</div></td>
              <td className="r">{l.qty}</td>
              <td className={'r' + (l.available < l.qty && ['confirmed', 'backorder', 'new'].includes(o.status) ? ' oms-short' : '')}>{Math.max(0, l.available)}</td>
              <td className="r">{money(l.price)}</td><td className="r">{money(l.qty * l.price)}</td>
            </tr>))}</tbody>
          <tfoot>
            <tr><td colSpan={4} className="r muted">Shipping</td><td className="r">{money(o.shipping)}</td></tr>
            <tr><td colSpan={4} className="r"><b>Total</b></td><td className="r"><b>{money(o.total)}</b></td></tr>
          </tfoot>
        </table></div>
        {o.returns.length > 0 && <div className="oms-subhead">Returns</div>}
        {o.returns.map((r) => <div key={r.id} className="oms-return-row"><b>{r.no}</b> <ReturnPill status={r.status} /> <span className="small muted">{r.reason}</span></div>)}
        <div className="oms-subhead">Timeline</div>
        <ol className="oms-timeline">
          {[...o.events].sort((a, b) => new Date(b.at) - new Date(a.at)).map((e, i) => (
            <li key={i}><b>{(STATUS[e.status] || [e.status])[0]}</b> <span className="small muted">{when(e.at)} · {e.by}</span><div className="small">{e.note}</div></li>))}
        </ol>
      </>}
      {dialog === 'cancel' && <ReasonDialog danger title={`Cancel ${o.no}?`} label="Reason" options={options.cancel_reasons} confirm="Cancel order"
        onClose={() => setDialog(null)} onDone={(reason) => act('cancel', { reason })} />}
      {dialog === 'hold' && <ReasonDialog title={`Put ${o.no} on hold`} label="Reason" options={options.hold_reasons} confirm="Put on hold"
        onClose={() => setDialog(null)} onDone={(reason) => act('hold', { reason })} />}
      {dialog === 'ship' && <ReasonDialog title={`Ship ${o.no}`} label="Courier" options={options.couriers} confirm="Ship"
        onClose={() => setDialog(null)} onDone={(courier) => act('ship', { courier })} />}
      {dialog === 'return' && <RaiseReturn order={o} reasons={options.return_reasons} toast={toast} onClose={() => setDialog(null)}
        onDone={async () => { setDialog(null); await load(); onChanged?.() }} />}
    </Drawer>
  )
}

// ---- a new order, entered by hand --------------------------------------------
function NewOrder({ options, toast, onClose, onDone }) {
  const here = options.warehouses
  const [wh, setWh] = useState('')
  const [products, setProducts] = useState([])
  const [c, setC] = useState({ name: '', phone: '', city: '', address: '' })
  const [channel, setChannel] = useState('Phone Order')
  const [payment, setPayment] = useState('Prepaid')
  const [lines, setLines] = useState([{ product_id: '', qty: 1 }])
  const [busy, run] = useRun(toast)
  useEffect(() => {
    let live = true
    api.omsGet('products', { wh: wh || undefined }).then((p) => { if (live) setProducts(p) }).catch(() => { if (live) setProducts([]) })
    return () => { live = false }
  }, [wh])
  const atCentral = products.length === 0 && !wh
  const setLine = (i, k, v) => setLines(lines.map((l, n) => (n === i ? { ...l, [k]: v } : l)))
  const priced = lines.map((l) => ({ ...l, p: products.find((x) => x.id === +l.product_id) }))
  const total = priced.reduce((a, l) => a + (l.p ? l.p.price * (+l.qty || 0) : 0), 0)
  const ready = c.name.trim() && priced.some((l) => l.p && +l.qty > 0)
  const save = async () => {
    const r = await run(() => api.omsPost('orders', { wh: wh || undefined, customer: c, channel, payment,
      lines: priced.filter((l) => l.p).map((l) => ({ product_id: l.p.id, qty: +l.qty })) }), (x) => `Order ${x.no} created`)
    if (r) onDone(r)
  }
  return (
    <Modal wide title="New order" onClose={onClose} foot={<>
      <span className="small muted oms-foot-note">Goods {inr(total)}</span>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !ready} onClick={save}>Create order</button></>}>
      <div className="oms-form">
        {(atCentral || wh) && <F label="Warehouse" req>
          <Sel value={wh} onChange={(v) => { setWh(v); setLines([{ product_id: '', qty: 1 }]) }} placeholder="Choose…"
            options={here.map((w) => ({ value: w.id, label: w.name }))} /></F>}
        <F label="Customer name" req><input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></F>
        <F label="Phone"><input value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} /></F>
        <F label="City"><input value={c.city} onChange={(e) => setC({ ...c, city: e.target.value })} /></F>
        <F label="Address"><input value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} /></F>
        <F label="Channel"><Sel allowBlank={false} value={channel} onChange={setChannel} options={options.channels} /></F>
        <F label="Payment"><Sel allowBlank={false} value={payment} onChange={setPayment} options={['Prepaid', 'COD']} /></F>
      </div>
      <div className="oms-subhead">Products</div>
      {lines.map((l, i) => (
        <div key={i} className="oms-line">
          <select value={l.product_id} aria-label="Product" disabled={!products.length} onChange={(e) => setLine(i, 'product_id', e.target.value)}>
            <option value="">{products.length ? 'Choose a product…' : 'Choose a warehouse first'}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.desc || p.name} · ₹{p.price} · {Math.max(0, p.available)} free</option>)}
          </select>
          <input type="number" min="1" className="oms-qty" aria-label="Quantity" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} />
          <button className="btn" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, n) => n !== i))}><Icon name="x" size={14} /></button>
        </div>))}
      <button className="btn" onClick={() => setLines([...lines, { product_id: '', qty: 1 }])}><Icon name="plus" size={14} /> Add product</button>
    </Modal>
  )
}

// ---- the inbox ---------------------------------------------------------------
const INBOX_TABS = [['', 'All'], ['new', 'New'], ['confirmed', 'Confirmed'], ['backorder', 'Backorder'], ['on_hold', 'On hold'],
  ['late', 'Late'], ['shipped', 'Shipped'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']]

function Inbox({ toast }) {
  const options = useOptions()
  const [status, setStatus] = useState(() => { const f = inboxFilter; inboxFilter = null; return f || '' })
  const [channel, setChannel] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null)
  const [adding, setAdding] = useState(false)
  const [data, error, load] = useLoad(() => api.omsGet('orders', { status: status || undefined, channel: channel || undefined, q: q.trim() || undefined }), [status, channel, q])
  const rows = data?.rows
  return (
    <FinPage crumb={CRUMB} title="Order Inbox" sub="Every customer order, from every channel"
      actions={<>
        {rows?.length > 0 && <button className="btn" onClick={() => downloadCsv('orders', [['no', 'Order'], ['channel', 'Channel'], ['wh_name', 'Warehouse'],
          [(r) => r.customer.name, 'Customer'], ['payment', 'Payment'], ['total', 'Total'], ['status', 'Status'], ['created_at', 'Ordered']], rows)}><Icon name="download" size={14} /> Export CSV</button>}
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> New order</button></>}>
      <div className="oms-tabs" role="tablist">
        {INBOX_TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={status === k} className={'oms-tab' + (status === k ? ' on' : '')} onClick={() => setStatus(k)}>
            {label} <span>{data?.counts?.[k || 'all'] ?? 0}</span></button>))}
      </div>
      <div className="fin-toolbar flat">
        <F label="Search"><input placeholder="Order, customer, phone or SKU" value={q} onChange={(e) => setQ(e.target.value)} /></F>
        <F label="Channel"><Sel value={channel} onChange={setChannel} options={options.channels} /></F>
      </div>
      {error ? <ErrorState onRetry={load}>{error}</ErrorState> : !rows ? <Loading>Reading the orders…</Loading>
        : rows.length === 0 ? <Empty>No orders match.</Empty> : (
          <div className="tablewrap fin-scroll"><table className="items fin-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Channel</th><th>Warehouse</th><th className="r">Units</th><th className="r">Total</th><th>Payment</th><th>Ordered</th><th>Status</th></tr></thead>
            <tbody>{rows.map((o) => (
              <tr key={o.id} className="clickable" tabIndex={0} onClick={() => setOpen(o.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(o.id) }}>
                <td className="mono"><b>{o.no}</b></td>
                <td>{o.customer.name}<div className="small muted">{o.customer.city}</div></td>
                <td>{o.channel}</td><td>{o.wh_name}</td><td className="r">{o.units}</td><td className="r">{money(o.total)}</td>
                <td>{o.payment}</td><td>{when(o.created_at)}</td>
                <td className="oms-status-cell"><OrderPill status={o.status} />{o.late && <Late />}</td>
              </tr>))}</tbody>
          </table></div>)}
      {open && <OrderDrawer id={open} options={options} toast={toast} onClose={() => setOpen(null)} onChanged={load} />}
      {adding && <NewOrder options={options} toast={toast} onClose={() => setAdding(false)}
        onDone={(o) => { setAdding(false); load(); setOpen(o.id) }} />}
    </FinPage>
  )
}

// ---- fulfilment: the same orders, as work to be done ---------------------------
const BOARD = [
  { title: 'To allocate', statuses: ['confirmed', 'backorder'] },
  { title: 'To pick', statuses: ['allocated'] },
  { title: 'Picking', statuses: ['picking'] },
  { title: 'To ship', statuses: ['packed'] },
  { title: 'Out for delivery', statuses: ['shipped'] },
]

function Fulfilment({ toast }) {
  const options = useOptions()
  const [open, setOpen] = useState(null)
  const [shipping, setShipping] = useState(null)
  const [data, error, load] = useLoad(() => api.omsGet('orders'), [])
  const [busy, run] = useRun(toast)
  const act = async (o, action, extra) => {
    setShipping(null)
    const r = await run(() => api.omsPost(`orders/${o.id}/action`, { action, ...extra }))
    if (!r) return
    toast(r.message || `${r.no} is now ${(STATUS[r.status] || [r.status])[0].toLowerCase()}`, r.message ? 'err' : 'ok')
    load()
  }
  if (error) return <FinPage crumb={CRUMB} title="Fulfilment"><ErrorState onRetry={load}>{error}</ErrorState></FinPage>
  return (
    <FinPage crumb={CRUMB} title="Fulfilment" sub="Allocate stock, pick, pack and ship. The oldest order in each column comes first">
      {!data ? <Loading>Reading the orders…</Loading> : (
        <div className="oms-board">
          {BOARD.map((col) => {
            const cards = data.rows.filter((o) => col.statuses.includes(o.status))
              .sort((a, b) => new Date(a.promised_at) - new Date(b.promised_at))
            return (
              <section key={col.title} className="oms-col" aria-label={col.title}>
                <header>{col.title} <span>{cards.length}</span></header>
                <div className="oms-col-body">
                  {cards.length === 0 && <div className="small muted oms-col-empty">Nothing here</div>}
                  {cards.map((o) => {
                    const step = NEXT_STEP[o.status]
                    return (
                      <article key={o.id} className={'oms-card' + (o.late ? ' late' : '')}>
                        <button className="oms-card-open" onClick={() => setOpen(o.id)}>
                          <b className="mono">{o.no}</b>
                          <span className="small">{o.customer.name}</span>
                          <span className="small muted">{o.units} unit{o.units === 1 ? '' : 's'} · {o.wh_name}</span>
                          <span className="small muted">Ship by {when(o.promised_at)}</span>
                        </button>
                        <div className="oms-card-tags">{o.status === 'backorder' && <OrderPill status={o.status} />}{o.late && <Late />}</div>
                        <button className="btn oms-card-act" disabled={busy}
                          onClick={() => (step.action === 'ship' ? setShipping(o) : act(o, step.action))}>{step.label}</button>
                      </article>)
                  })}
                </div>
              </section>)
          })}
        </div>)}
      {open && <OrderDrawer id={open} options={options} toast={toast} onClose={() => setOpen(null)} onChanged={load} />}
      {shipping && <ReasonDialog title={`Ship ${shipping.no}`} label="Courier" options={options.couriers} confirm="Ship"
        onClose={() => setShipping(null)} onDone={(courier) => act(shipping, 'ship', { courier })} />}
    </FinPage>
  )
}

// ---- customer returns --------------------------------------------------------
const RETURN_TABS = [['', 'All'], ['requested', 'Requested'], ['approved', 'Approved'], ['received', 'Received'],
  ['refunded', 'Refunded'], ['exchanged', 'Exchanged'], ['rejected', 'Rejected']]

function Returns({ toast }) {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState(null)
  const [data, error, load] = useLoad(() => api.omsGet('returns', { status: status || undefined, q: q.trim() || undefined }), [status, q])
  const [busy, run] = useRun(toast)
  const act = async (r, action, extra, okMsg) => {
    setDialog(null)
    const done = await run(() => api.omsPost(`returns/${r.id}/action`, { action, ...extra }), okMsg)
    if (done) load()
  }
  const rows = data?.rows
  const buttons = (r) => ({
    requested: <>
      <button className="btn" disabled={busy} onClick={() => setDialog({ kind: 'reject', r })}>Reject</button>
      <button className="btn" disabled={busy} onClick={() => act(r, 'approve', null, `${r.no} approved`)}>Approve</button></>,
    approved: <button className="btn" disabled={busy} onClick={() => setDialog({ kind: 'receive', r })}>Receive goods</button>,
    received: <>
      <button className="btn" disabled={busy} onClick={() => act(r, 'exchange', null, `${r.no}: replacement order raised`)}>Exchange</button>
      <button className="btn" disabled={busy} onClick={() => act(r, 'refund', null, `${r.no}: refund recorded`)}>Refund {inr(r.value)}</button></>,
  }[r.status] || null)
  return (
    <FinPage crumb={CRUMB} title="Customer Returns" sub="Raised from a delivered order in the Order Inbox. Refunds here are records: no money moves">
      <div className="oms-tabs" role="tablist">
        {RETURN_TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={status === k} className={'oms-tab' + (status === k ? ' on' : '')} onClick={() => setStatus(k)}>
            {label} <span>{data?.counts?.[k || 'all'] ?? 0}</span></button>))}
      </div>
      <div className="fin-toolbar flat">
        <F label="Search"><input placeholder="Return, order or customer" value={q} onChange={(e) => setQ(e.target.value)} /></F>
      </div>
      {error ? <ErrorState onRetry={load}>{error}</ErrorState> : !rows ? <Loading>Reading the returns…</Loading>
        : rows.length === 0 ? <Empty>No returns match.</Empty> : (
          <div className="tablewrap fin-scroll"><table className="items fin-table">
            <thead><tr><th>Return</th><th>Order</th><th>Customer</th><th>Product</th><th>Reason</th><th className="r">Value</th><th>Raised</th><th>Status</th><th></th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td className="mono"><b>{r.no}</b></td><td className="mono">{r.order_no}</td><td>{r.customer}</td>
                <td>{r.lines.map((l) => <div key={l.product_id}>{l.qty} × {l.sku}</div>)}</td>
                <td>{r.reason}{r.condition === 'damaged' && <div className="small oms-short">Received damaged</div>}
                  {r.replacement_no && <div className="small muted">Replacement {r.replacement_no}</div>}</td>
                <td className="r">{money(r.value)}</td><td>{when(r.created_at)}</td>
                <td><ReturnPill status={r.status} /></td>
                <td className="oms-row-actions">{buttons(r)}</td>
              </tr>))}</tbody>
          </table></div>)}
      {dialog?.kind === 'reject' && <ReasonDialog danger title={`Reject ${dialog.r.no}`} label="Why?" confirm="Reject return"
        onClose={() => setDialog(null)} onDone={(reason) => act(dialog.r, 'reject', { reason }, `${dialog.r.no} rejected`)} />}
      {dialog?.kind === 'receive' && <ReasonDialog title={`Receive ${dialog.r.no}`} label="Condition of the goods" confirm="Receive"
        options={[{ value: 'good', label: 'Good: put back in stock' }, { value: 'damaged', label: 'Damaged: keep out of stock' }]}
        onClose={() => setDialog(null)} onDone={(condition) => act(dialog.r, 'receive', { condition }, `${dialog.r.no} received`)} />}
    </FinPage>
  )
}

// ---- dashboard and reports -----------------------------------------------------
const PERIODS = [{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }]
const pct = (v) => (v == null ? '—' : v + '%')

function Bars({ rows, value, format }) {
  const top = Math.max(1, ...rows.map(value))
  return (
    <div className="oms-bars">
      {rows.map((r) => (
        <div key={r.name} className="oms-bar">
          <span className="oms-bar-name">{r.name}</span>
          <span className="oms-bar-track"><i style={{ width: `${(value(r) / top) * 100}%` }} /></span>
          <span className="oms-bar-val">{format(r)}</span>
        </div>))}
    </div>
  )
}

const PIPELINE = ['new', 'confirmed', 'allocated', 'picking', 'packed', 'shipped', 'delivered']

function Dashboard({ toast, go }) {
  const options = useOptions()
  const [days, setDays] = useState('30')
  const [open, setOpen] = useState(null)
  const [s, error, load] = useLoad(() => api.omsGet('summary', { days }), [days])
  const inbox = (status) => { inboxFilter = status; go('oms_orders') }
  return (
    <FinPage crumb={CRUMB} title="Order Dashboard" sub="What came in, where it has got to, and what needs attention"
      actions={<div className="oms-period"><Sel allowBlank={false} value={days} onChange={setDays} options={PERIODS} /></div>}>
      {error ? <ErrorState onRetry={load}>{error}</ErrorState> : !s ? <Loading>Adding up the orders…</Loading> : <>
        <Kpis items={[
          { label: 'Orders', icon: 'inbox', value: s.total, sub: whole(s.value) + ' value', onClick: () => inbox('') },
          { label: 'Open', icon: 'clock', value: s.open, sub: 'still to be shipped' },
          { label: 'Late', icon: 'alert', tone: s.late.length ? 'err' : 'ok', value: s.late.length, sub: 'past their ship-by time', onClick: () => inbox('late') },
          { label: 'Shipped on time', icon: 'truck', tone: 'ok', value: pct(s.on_time_pct), sub: s.avg_ship_hours == null ? '' : `${s.avg_ship_hours} hours on average` },
          { label: 'Open returns', icon: 'undo', tone: s.returns_open ? 'warn' : undefined, value: s.returns_open, sub: `${pct(s.return_rate_pct)} return rate`, onClick: () => go('oms_returns') },
        ]} />
        <div className="oms-panel">
          <div className="oms-subhead">Where orders are now</div>
          <div className="oms-pipeline">
            {PIPELINE.map((k) => (
              <button key={k} className="oms-stage" onClick={() => (['new', 'confirmed', 'shipped', 'delivered'].includes(k) ? inbox(k) : go('oms_fulfilment'))}>
                <b>{s.counts[k] || 0}</b><span>{STATUS[k][0]}</span></button>))}
          </div>
        </div>
        <div className="oms-grid">
          <div className="oms-panel">
            <div className="oms-subhead">Needs attention</div>
            {s.late.length + s.backorders.length === 0 ? <Empty>Nothing is late or short.</Empty> : (
              <div className="tablewrap"><table className="items fin-table">
                <thead><tr><th>Order</th><th>Customer</th><th>Ship by</th><th>Status</th></tr></thead>
                <tbody>{[...s.late, ...s.backorders.filter((b) => !s.late.some((l) => l.id === b.id))].map((o) => (
                  <tr key={o.id} className="clickable" tabIndex={0} onClick={() => setOpen(o.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(o.id) }}>
                    <td className="mono"><b>{o.no}</b></td><td>{o.customer.name}</td><td>{when(o.promised_at)}</td>
                    <td className="oms-status-cell"><OrderPill status={o.status} />{o.late && <Late />}</td>
                  </tr>))}</tbody>
              </table></div>)}
          </div>
          <div className="oms-panel">
            <div className="oms-subhead">Orders by channel</div>
            <Bars rows={[...s.by_channel].sort((x, y) => y.orders - x.orders)} value={(r) => r.orders} format={(r) => `${r.orders} · ${whole(r.value)}`} />
          </div>
        </div>
      </>}
      {open && <OrderDrawer id={open} options={options} toast={toast} onClose={() => setOpen(null)} onChanged={load} />}
    </FinPage>
  )
}

function ReportTable({ title, file, cols, rows, empty }) {
  return (
    <div className="oms-panel">
      <div className="oms-report-head"><div className="oms-subhead">{title}</div>
        {rows.length > 0 && <button className="btn" onClick={() => downloadCsv(file, cols.map(([k, label]) => [k, label]), rows)}><Icon name="download" size={14} /> CSV</button>}</div>
      {rows.length === 0 ? <Empty>{empty}</Empty> : (
        <div className="tablewrap"><table className="items fin-table">
          <thead><tr>{cols.map(([, label, right]) => <th key={label} className={right ? 'r' : undefined}>{label}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>{cols.map(([k, label, right, fmt]) => <td key={label} className={right ? 'r' : undefined}>{fmt ? fmt(r[k]) : r[k]}</td>)}</tr>))}</tbody>
        </table></div>)}
    </div>
  )
}

function Reports() {
  const [days, setDays] = useState('30')
  const [s, error, load] = useLoad(() => api.omsGet('summary', { days }), [days])
  const orderCols = useMemo(() => [['name', 'Name'], ['orders', 'Orders', true], ['value', 'Value (₹)', true, money]], [])
  return (
    <FinPage crumb={CRUMB} title="Order Reports" sub="Sales by channel and warehouse, best sellers and why goods come back"
      actions={<div className="oms-period"><Sel allowBlank={false} value={days} onChange={setDays} options={PERIODS} /></div>}>
      {error ? <ErrorState onRetry={load}>{error}</ErrorState> : !s ? <Loading>Adding up the orders…</Loading> : <>
        <Kpis items={[
          { label: 'Order value', icon: 'rupee', value: whole(s.value), sub: `${s.total} orders, cancelled left out of the value` },
          { label: 'Cancelled', icon: 'x', value: s.counts.cancelled || 0 },
          { label: 'Refunded', icon: 'undo', value: whole(s.refunded), sub: 'records: no money moves' },
          { label: 'Return rate', icon: 'percent', value: pct(s.return_rate_pct), sub: 'of delivered orders' },
        ]} />
        <div className="oms-grid">
          <ReportTable title="By channel" file="orders-by-channel" cols={orderCols} rows={s.by_channel} empty="No orders in this period." />
          <ReportTable title="By warehouse" file="orders-by-warehouse" cols={orderCols} rows={s.by_warehouse} empty="No orders in this period." />
          <ReportTable title="Best sellers" file="best-sellers" rows={s.top_products} empty="No orders in this period."
            cols={[['sku', 'SKU'], ['desc', 'Product'], ['units', 'Units', true], ['value', 'Value (₹)', true, money]]} />
          <ReportTable title="Why goods come back" file="return-reasons" rows={s.return_reasons} empty="No returns in this period."
            cols={[['name', 'Reason'], ['count', 'Returns', true]]} />
        </div>
      </>}
    </FinPage>
  )
}

export const OMS_SCREENS = [
  ['oms_dashboard', 'Order Dashboard', 'What came in, where it has got to, and what needs attention'],
  ['oms_orders', 'Order Inbox', 'Every customer order, from every channel'],
  ['oms_fulfilment', 'Fulfilment', 'Allocate stock, pick, pack and ship'],
  ['oms_returns', 'Customer Returns', 'Return requests, receiving goods back, refunds and exchanges'],
  ['oms_reports', 'Order Reports', 'Sales by channel, best sellers and return reasons'],
]

export default function OMS(props) {
  const [session, setSession] = useState(null)
  const [error, setError] = useState(null)
  const read = useCallback(() => {
    setError(null)
    return api.omsGet('session').then(setSession).catch((e) => setError(errText(e)))
  }, [])
  useEffect(() => { read() }, [read])
  if (error) return <FinPage crumb={CRUMB} title="Orders"><ErrorState onRetry={read}>{error}</ErrorState></FinPage>
  if (!session) return <FinPage crumb={CRUMB} title="Orders"><Loading>Connecting…</Loading></FinPage>
  return <>
    {!session.live && <div className="oms-sample small">Sample orders: changes last until you reload.</div>}
    <Screen {...props} />
  </>
}

function Screen({ screen, toast, go }) {
  if (screen === 'oms_orders') return <Inbox toast={toast} />
  if (screen === 'oms_fulfilment') return <Fulfilment toast={toast} />
  if (screen === 'oms_returns') return <Returns toast={toast} />
  if (screen === 'oms_reports') return <Reports />
  return <Dashboard toast={toast} go={go} />
}
