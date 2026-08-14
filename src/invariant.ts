/**
 * Package-owned durable-stream invariant for `dsh-billing`.
 * @module dsh-billing/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = 'dsh-billing'

/** Cordis companion plugin name. */
export const name = 'billing-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Cumulative non-negative token counts carried by the fold. */
interface TokenTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

const emptyTotals = (): TokenTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/**
 * Validate one candidate event against the durable-stream contract and, when
 * valid, fold it into `totals` in place. The invariant is config-independent:
 * the durable stream must never carry negative or non-finite usage counts
 * (pricing is a deployment projection on top of these facts).
 * @param totals - independent fold, mutated only when the event is valid.
 * @param event - the candidate session event.
 * @param fail - invariant reporter.
 */
function applyChecked(totals: TokenTotals, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'assistant/message') return
  const usage = event.data.usage
  if (usage === undefined) return
  const counts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
  ]
  if (counts.some(count => !Number.isFinite(count) || count < 0)) {
    fail(`session event ${event.seq} reports negative or non-finite usage: ${JSON.stringify(usage)}`)
  }
  totals.inputTokens += usage.inputTokens
  totals.outputTokens += usage.outputTokens
  totals.cacheReadTokens += usage.cacheReadTokens ?? 0
  totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0
}

/** Clone a fold so a candidate event can be validated without touching the published state. */
function cloneTotals(totals: TokenTotals): TokenTotals {
  return { ...totals }
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, { consumed: number; totals: TokenTotals }>()
  const staged = new WeakMap<SessionEvent, { session: Session; totals: TokenTotals }>()

  const seed = (session: Session): { consumed: number; totals: TokenTotals } => {
    const totals = emptyTotals()
    for (const event of session.events) applyChecked(totals, event, fail)
    const state = { consumed: session.events.length, totals }
    states.set(session, state)
    return state
  }
  const stateFor = (session: Session): { consumed: number; totals: TokenTotals } =>
    states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const totals = cloneTotals(stateFor(session).totals)
    applyChecked(totals, event, fail)
    staged.set(event, { session, totals })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching billing-fold validation')
    }
    staged.delete(event)
    states.set(session, { consumed: stateFor(session).consumed + 1, totals: candidate.totals })
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
