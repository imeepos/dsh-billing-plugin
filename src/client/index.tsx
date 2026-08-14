/**
 * Client half of dsh-billing (Web platform) — SOURCE.
 *
 * This file is the React + TSX + Tailwind source of the billing floating
 * widget. It is NOT shipped directly: `npm run build:client` bundles it
 * (esbuild) with a Tailwind CSS pass and emits the `window.__ModuleLoader__`
 * bundle that the web client loads as this package's `./client` export —
 * the built artifact is `lib/client.js`, and only that file is shipped.
 *
 * The widget renders the `billing` session projection (registered by this
 * package's host half) from the session list store's `projectionValues` —
 * zero RPC, zero polling, zero model-context injection. It shows a draggable
 * bottom-right water-fill gauge (budget consumed %, 4 colour tiers) and a
 * detail panel with cost / budget / remaining, per-token-type amounts and
 * shares, and compact k/m/b token counts. Colours map to the dsw theme alias
 * tokens via the Tailwind config; labels follow the active locale through the
 * slot `locale` binding's `t` prop.
 */

import * as React from 'react'

/** Wire value of the `billing` session projection (host side: src/projection.ts). */
interface BillingProjectionValue {
  currency: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  budget?: number
  remaining?: number
  exhausted: boolean
  peakCost: number
  offPeakCost: number
  breakdown: { cacheRead: number; cacheMiss: number; output: number }
  effectiveFrom: number | undefined
  zeroPricedCalls: number
}

/** The session-list store shape we read (narrow projection of the real store). */
interface SessionListShape {
  current?: string
  byId: Record<string, { projectionValues?: { billing?: BillingProjectionValue } }>
}

/** Slot renderer props: standard hooks plus the locale-bound translate fn. */
interface SlotProps {
  useSessions: <T>(selector: (state: SessionListShape) => T) => T
  t?: (key: string) => string
}

const POS_KEY = 'dsh-billing-float-pos'
const SIZE = 56

/** zh / en dictionaries, namespace "billing-ui". */
const ZH: Record<string, string> = {
  costLabel: '费用', budgetLabel: '预算', remainingLabel: '剩',
  cacheHitLabel: '缓存命中', cacheMissLabel: '未命中', outputLabel: '输出',
  callsSuffix: '次', totalPrefix: '共', tokUnit: 'tok',
  pricingSince: '价格生效于', zeroPricedHint: '次调用为零计费（生效前或未定价模型）',
}
const EN: Record<string, string> = {
  costLabel: 'Cost', budgetLabel: 'Budget', remainingLabel: 'Left',
  cacheHitLabel: 'Cache hit', cacheMissLabel: 'Miss', outputLabel: 'Output',
  callsSuffix: 'calls', totalPrefix: 'total', tokUnit: 'tok',
  pricingSince: 'Price effective from', zeroPricedHint: 'call(s) priced at zero (pre-effective or unpriced model)',
}

/** 4-tier water colour by budget-consumed percentage. */
function tierColor(pct: number): string {
  if (pct >= 75) return 'var(--dsw-alias-state-error-primary)'
  if (pct >= 50) return 'var(--dsw-alias-state-warn-primary)'
  if (pct >= 25) return 'var(--dsw-alias-brand-primary)'
  return 'var(--dsw-alias-state-success-primary)'
}

/** Compact k/m/b token formatting. */
function fmtCompact(n: number | undefined): string {
  n = n || 0
  if (n < 1000) return String(n)
  const units: Array<[number, string]> = [[1e9, 'b'], [1e6, 'm'], [1e3, 'k']]
  for (const [div, suffix] of units) {
    if (n >= div) {
      const v = n / div
      const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10
      return String(rounded) + suffix
    }
  }
  return String(n)
}

/** The floating water-fill gauge + detail panel. */
export function BillingFloat(props: SlotProps): React.ReactElement | null {
  const { useSessions, t } = props
  const translate = t || ((key: string) => ZH[key] ?? key)
  const current = useSessions((s) => s.current)
  const bill = useSessions((s) => {
    const cur = s.current
    if (!cur) return undefined
    return s.byId[cur]?.projectionValues?.billing
  })

  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null)
  const [drag, setDrag] = React.useState<{ sx: number; sy: number; dx: number; dy: number } | null>(null)
  const [moved, setMoved] = React.useState(false)

  const clamp = (v: number, max: number): number =>
    (typeof max === 'number' && max > SIZE) ? Math.max(0, Math.min(v, max - SIZE)) : v

  // Restore the saved drag position (localStorage), clamped to the viewport.
  React.useEffect(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 0
    const h = typeof window !== 'undefined' ? window.innerHeight : 0
    let saved: { left?: unknown; top?: unknown } | null = null
    if (typeof localStorage !== 'undefined') {
      try { saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null') } catch { saved = null }
    }
    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
      setPos({ left: clamp(saved.left, w), top: clamp(saved.top, h) })
    } else {
      setPos({ left: clamp((w || 0) - SIZE - 16, w), top: clamp((h || 0) - SIZE - 48, h) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Window-level drag listeners while dragging.
  React.useEffect(() => {
    if (!drag || typeof window === 'undefined') return undefined
    const onMove = (e: MouseEvent) => {
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) setMoved(true)
      setPos({
        left: clamp(drag.dx + (e.clientX - drag.sx), window.innerWidth),
        top: clamp(drag.dy + (e.clientY - drag.sy), window.innerHeight),
      })
    }
    const onUp = () => setDrag(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag])

  // Persist the position once a drag ends.
  React.useEffect(() => {
    if (drag) return undefined
    if (pos && typeof localStorage !== 'undefined') {
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch { /* ignore */ }
    }
    return undefined
  }, [drag])

  if (!current) return null

  const fmt = (n: number | null | undefined): string =>
    (n === null || n === undefined) ? '—' : Number(n).toFixed(3)
  const pct = (bill && bill.budget !== undefined && bill.budget > 0)
    ? Math.min(100, Math.round((bill.cost / bill.budget) * 100))
    : 0

  const tank = (
    <div
      className="relative size-14 overflow-hidden rounded-full border border-border-l1 bg-bg-overlay shadow-md transition-colors cursor-grab active:cursor-grabbing hover:border-border-l2"
      onMouseDown={(e) => {
        e.preventDefault()
        setMoved(false)
        setDrag({ sx: e.clientX, sy: e.clientY, dx: pos ? pos.left : 0, dy: pos ? pos.top : 0 })
      }}
    >
      <div className="absolute inset-x-0 bottom-0" style={{ height: `${pct}%`, background: tierColor(pct) }} />
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-label-primary">
        <b className="text-sm font-bold tabular-nums">{pct}%</b>
        <small className="text-[9px] opacity-85 text-label-secondary">{translate('costLabel')}</small>
      </div>
    </div>
  )

  let detail: React.ReactElement | null = null
  if (bill) {
    const total = bill.cost || 0
    const bd = bill.breakdown || { cacheRead: 0, cacheMiss: 0, output: 0 }
    const share = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0)
    const rows = [
      { key: 'cacheRead', label: translate('cacheHitLabel'), value: bd.cacheRead, tokens: bill.cacheReadTokens || 0, color: 'var(--dsw-alias-brand-primary)' },
      { key: 'cacheMiss', label: translate('cacheMissLabel'), value: bd.cacheMiss, tokens: bill.inputTokens || 0, color: 'var(--dsw-alias-state-warn-primary)' },
      { key: 'output', label: translate('outputLabel'), value: bd.output, tokens: bill.outputTokens || 0, color: 'var(--dsw-alias-state-success-primary)' },
    ]
    const totalTokens = (bill.inputTokens || 0) + (bill.outputTokens || 0) + (bill.cacheReadTokens || 0) + (bill.cacheWriteTokens || 0)

    detail = (
      <div className="absolute bottom-16 right-0 w-[280px] rounded-xl border border-border-l1 bg-bg-overlay p-2.5 text-label-primary shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1.5 flex items-baseline justify-between">
          <b className="text-[13px]">{translate('costLabel')} {fmt(total)} {bill.currency}</b>
          <span>{translate('remainingLabel')} {fmt(bill.remaining)}</span>
        </div>
        <div className="mb-2 flex h-[5px] overflow-hidden rounded-[3px] bg-border-l1">
          {rows.map((r) => (
            <i key={r.key} style={{ width: `${share(r.value)}%`, background: r.color }} />
          ))}
        </div>
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-2 py-0.5">
            <span className="text-label-secondary">{r.label}</span>
            <span className="tabular-nums">{fmt(r.value)} {bill.currency} · {share(r.value)}% · {fmtCompact(r.tokens)} {translate('tokUnit')}</span>
          </div>
        ))}
        <div className="mt-1.5 flex justify-between border-t border-border-l1 pt-1.5 text-label-secondary">
          <span>{translate('budgetLabel')} {fmt(bill.budget)} {bill.currency}</span>
          <span>{bill.calls} {translate('callsSuffix')} · {translate('totalPrefix')} {fmtCompact(totalTokens)} {translate('tokUnit')}</span>
        </div>
        {bill.effectiveFrom !== undefined ? (
          <div className="mt-1 text-[10px] text-label-secondary/60">
            {translate('pricingSince')} {new Date(bill.effectiveFrom).toLocaleString()}
          </div>
        ) : null}
        {bill.zeroPricedCalls > 0 ? (
          <div className="mt-0.5 text-[10px] text-warn/80">
            ⚠ {bill.zeroPricedCalls} {translate('zeroPricedHint')}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className="pointer-events-auto fixed z-[1000] select-none font-sans text-xs leading-[1.4]"
      style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : undefined}
      onClick={() => {
        if (moved) { setMoved(false); return }
        setOpen((v) => !v)
      }}
    >
      {tank}
      {open ? detail : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Client plugin body: locale dictionaries + the shell.overlay slot entry.
// ---------------------------------------------------------------------------

/** Client services the plugin needs on ctx. */
export const inject = ['sessions', 'slots', 'locale']

/** @param ctx - the client root context. */
export function apply(ctx: { effect: (fn: () => unknown, label?: string) => void; locale: { register: (ns: string, dicts: Record<string, Record<string, string>>) => () => void }; slots: { inject: (key: string, cb: () => unknown) => void } }): void {
  ctx.effect(() => ctx.locale.register('billing-ui', { zh: ZH, en: EN }), 'dsh-billing: dictionaries')
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'billing-float',
      order: 10,
      locale: 'billing-ui',
    }, BillingFloat))
}
