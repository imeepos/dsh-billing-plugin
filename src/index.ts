/**
 * Event-sourced real-time billing for the DeepSeek Harness. The bill is a
 * pure function of the owning session log plus the deployment price table:
 * `ctx.billing.spend(session)` replays the durable `assistant/message` usage
 * events, so nothing about spend is persisted separately and a bill survives
 * reload identically. Pricing is time-segmented: each call is priced by the
 * peak or off-peak bucket of its logged time (Beijing clock by default), so
 * the bucket itself is a pure function of the log plus the deployment policy.
 *
 * The plugin is deliberately statistics-only: it provides the `ctx.billing`
 * service and injects nothing into the model context — no model tools, no
 * prompt sections, no chat messages. The companion UI plugin (billing-ui-float)
 * renders the bill in the web client, so spend visibility lives on the UI
 * surface and the model context stays clean.
 *
 * This is the standalone companion code of 《深入拆解 DeepSeek Harness》
 * (deepseek-harness-book/billing-plugin) — it is deliberately NOT part of the
 * official deepseek-harness repository.
 * @module dsh-billing
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyBillingFoldState, applyBillingEvent } from './fold.ts'
import type { BillingFoldState } from './fold.ts'
import { priceCall, DEFAULT_PEAK_WINDOWS, DEFAULT_UTC_OFFSET } from './pricing.ts'
import type { Bill, BucketTotals, Config, ModelPrice, PricingPolicy } from './types.ts'
import type { BillModelRow } from './types.ts'
import {
  initBillingProjectionState, applyBillingProjection, viewBillingProjection, billingProjectionSchema,
} from './projection.ts'
import type { BillingProjectionState, BillingProjectionValue } from './projection.ts'
// Force NodeNext resolution of the merge outlet before augmenting it.
import type {} from '@deepseek-ai/dsh-session-projection/types'
// Pull the package root's `Context.sessionProjections` augmentation (the /types
// outlet is pure types by design and carries no module declaration).
import type {} from '@deepseek-ai/dsh-session-projection'

export type * from './types.ts'
export {
  priceBucket, priceCall, bucketForTime, clockHour, isPeakTime, usageTokens,
  DEFAULT_PEAK_WINDOWS, DEFAULT_UTC_OFFSET,
} from './pricing.ts'
export { emptyBillingFoldState, applyBillingEvent } from './fold.ts'
export type { BillingFoldState } from './fold.ts'
export {
  initBillingProjectionState, applyBillingProjection, viewBillingProjection, billingProjectionSchema,
} from './projection.ts'
export type { BillingProjectionState, BillingProjectionValue } from './projection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    billing: BillingService
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    billing: BillingProjectionValue
  }
}

/** Round a currency amount to a display-stable precision (avoid floating-point noise). */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/** Sort per-model rows by descending cost, then model id, for a stable display order. */
function sortRows(rows: BillModelRow[]): BillModelRow[] {
  return [...rows].sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model))
}

/** The bucket-price schema shared by the peak and off-peak buckets. */
const priceBucketSchema = z.object({
  inputPerMillion: z.number().required(),
  outputPerMillion: z.number().required(),
  cacheReadPerMillion: z.number(),
  cacheWritePerMillion: z.number(),
})

/** Schemastery's tuple typing is imprecise for the window pair; validate at use. */
type RawPeakWindow = readonly (readonly [number, number])[]

/** Validate one whole-hour `[start, end)` window and reject it fail-loud when malformed. */
function resolvePeakWindows(windows: RawPeakWindow): RawPeakWindow {
  for (const [start, end] of windows) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) {
      throw new Error(`dsh-billing: invalid peak window [${start}, ${end}) — must satisfy 0 <= start < end <= 24`)
    }
  }
  return windows
}

/** Replay owner: one incremental fold per live session, caught up on demand. */
export class BillingService extends Service {
  /** Schemastery-validated deployment policy; see {@link Config}. */
  static Config: z<Config> = z.object({
    currency: z.string().default('CNY'),
    prices: z.dict(z.object({
      offPeak: priceBucketSchema,
      peak: priceBucketSchema,
      effectiveFrom: z.number(),
    })).default({}),
    peakWindows: z.array(z.tuple([z.number(), z.number()])).default([...DEFAULT_PEAK_WINDOWS] as [number, number][]),
    utcOffsetMinutes: z.number().default(DEFAULT_UTC_OFFSET),
    budget: z.number(),
  }) as unknown as z<Config>

  private readonly currency: string
  private readonly policy: PricingPolicy
  private readonly budget: number | undefined
  private readonly states = new WeakMap<Session, { consumed: number; state: BillingFoldState }>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'billing')
    // schemastery's .default() guarantees these fields after validation.
    this.currency = config.currency as string
    const peakWindows = resolvePeakWindows(config.peakWindows ?? [...DEFAULT_PEAK_WINDOWS])
    const utcOffsetMinutes = config.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET
    if (!Number.isFinite(utcOffsetMinutes)) {
      throw new Error(`dsh-billing: utcOffsetMinutes must be a finite number (got ${utcOffsetMinutes})`)
    }
    this.policy = {
      prices: config.prices as Record<string, ModelPrice>,
      peakWindows,
      utcOffsetMinutes,
    }
    const budget = config.budget
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
      throw new Error(`dsh-billing: budget must be a positive number (got ${budget})`)
    }
    this.budget = budget

    // Keep a touched session's fold warm so the next spend() call is cheap;
    // sessions nobody reads create no state.
    ctx.on('session/event', (session) => {
      if (this.states.has(session)) this._sync(session)
    })

    // Push the bill to the web client through the official projection channel:
    // the schema-validated `billing` value lands in the client's
    // projectionValues, so the companion UI renders it with zero RPC and zero
    // model-context injection. `ctx.inject` (not a constructor-time ctx.get
    // probe — plugin application is fiber-scheduled, so an earlier tree entry's
    // service is not guaranteed visible yet) re-runs when the registry arrives
    // and keeps headless assemblies without it unaffected.
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register({
        key: 'billing',
        schema: billingProjectionSchema,
        init: initBillingProjectionState,
        apply: (state: BillingProjectionState, event: SessionEvent) => applyBillingProjection(state, event, this.policy),
        view: (state: BillingProjectionState) => viewBillingProjection(state, this.currency, this.budget),
        stateVersion: 1,
      })
    })
  }

  /**
   * Price one model call's usage under the deployment table at a given time.
   * @param usage - provider-reported token accounting for the call.
   * @param model - model id the call ran on.
   * @param time - Unix epoch ms of the call; defaults to now.
   * @returns the cost in {@link Config.currency}, or zero when the model is
   *   unpriced or its table is not yet effective.
   */
  price(usage: TokenUsage, model: string, time: number = Date.now()): number {
    return priceCall(usage, model, time, this.policy).cost
  }

  /**
   * The current bill for one session, derived entirely from its durable log.
   * @param session - session to replay through its current durable tail.
   * @returns a detached bill with per-model and per-bucket breakdowns.
   */
  spend(session: Session): Bill {
    const state = this._sync(session)
    const byModel = sortRows([...state.byModel.values()])
      .map(row => ({ ...row, cost: roundCost(row.cost) }))
    const cost = roundCost(state.cost)
    const roundBucket = (bucket: 'peak' | 'offPeak'): BucketTotals => ({
      ...state.byBucket[bucket],
      cost: roundCost(state.byBucket[bucket].cost),
    })
    return {
      currency: this.currency,
      calls: state.calls.length,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheWriteTokens: state.cacheWriteTokens,
      cost,
      byModel,
      byBucket: { peak: roundBucket('peak'), offPeak: roundBucket('offPeak') },
      ...this.budget === undefined
        ? {}
        : { budget: this.budget, remaining: roundCost(this.budget - cost) },
      exhausted: this.budget !== undefined && cost >= this.budget,
    }
  }

  /** Advance one session's fold to the current durable tail. */
  private _sync(session: Session): BillingFoldState {
    let entry = this.states.get(session)
    if (entry === undefined) {
      entry = { consumed: 0, state: emptyBillingFoldState() }
      this.states.set(session, entry)
    }
    while (entry.consumed < session.events.length) {
      const event = session.events[entry.consumed]!
      applyBillingEvent(entry.state, event, this.policy)
      entry.consumed += 1
    }
    return entry.state
  }
}

export default BillingService
