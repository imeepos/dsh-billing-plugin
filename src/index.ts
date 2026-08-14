/**
 * Event-sourced real-time billing for the DeepSeek Harness. The bill is a
 * pure function of the owning session log plus the deployment price table:
 * `ctx.billing.spend(session)` replays the durable `assistant/message` usage
 * events, so nothing about spend is persisted separately and a bill survives
 * reload identically. Pricing is time-segmented: each call is priced by the
 * peak or off-peak bucket of its logged time (Beijing clock by default), so
 * the bucket itself is a pure function of the log plus the deployment policy.
 * The plugin ships three roles — a Service (ctx.billing), a model-visible
 * Consumer tool (`billing_status`), and a Policy guard that rejects further
 * steps once a configured budget is exhausted.
 *
 * This is the standalone companion code of 《深入拆解 DeepSeek Harness》
 * (deepseek-harness-book/billing-plugin) — it is deliberately NOT part of the
 * official deepseek-harness repository.
 * @module dsh-billing
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { emptyBillingFoldState, applyBillingEvent } from './fold.ts'
import type { BillingFoldState } from './fold.ts'
import { priceCall, DEFAULT_PEAK_WINDOWS, DEFAULT_UTC_OFFSET } from './pricing.ts'
import type { Bill, BucketTotals, Config, ModelPrice, PricingPolicy } from './types.ts'
import type { BillModelRow } from './types.ts'

export type * from './types.ts'
export {
  priceBucket, priceCall, bucketForTime, clockHour, isPeakTime, usageTokens,
  DEFAULT_PEAK_WINDOWS, DEFAULT_UTC_OFFSET,
} from './pricing.ts'
export { emptyBillingFoldState, applyBillingEvent } from './fold.ts'
export type { BillingFoldState } from './fold.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    billing: BillingService
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

/** The source stamped on the durable budget notice the guard appends. */
const BUDGET_NOTICE_SOURCE: MessageSource = {
  kind: 'plugin',
  plugin: 'dsh-billing',
  form: 'notice',
  summary: 'billing budget exhausted',
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
  static inject = ['tools']

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
  private readonly notified = new WeakSet<Session>()

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

    // Consumer role: the model can read its own real-time spend. The answer
    // is derived from logged usage events and their logged times, so
    // "model-visible ⟺ logged" holds by construction — the tool never needs
    // to log anything extra to be honest, because every number it reports is
    // a function of the log.
    ctx.tools.register(defineTool({
      name: 'billing_status',
      description: 'Read the real-time spend of the current session: token counts and '
        + 'estimated cost per model, plus remaining budget when one is configured. The bill '
        + 'replays the session log, so it is always current. Prices are time-segmented: each '
        + 'call is charged the peak or off-peak rate of its own call time (Beijing clock by '
        + 'default). Use it to monitor cost during long tasks and to confirm when a '
        + 'configured budget is nearly exhausted.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            currency: { type: 'string', required: true },
            calls: { type: 'integer', required: true },
            inputTokens: { type: 'integer', required: true },
            outputTokens: { type: 'integer', required: true },
            cacheReadTokens: { type: 'integer', required: true },
            cacheWriteTokens: { type: 'integer', required: true },
            cost: { type: 'number', required: true },
            budget: { type: 'number' },
            remaining: { type: 'number' },
            exhausted: { type: 'boolean', required: true },
            byBucket: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                peak: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    calls: { type: 'integer', required: true },
                    inputTokens: { type: 'integer', required: true },
                    outputTokens: { type: 'integer', required: true },
                    cacheReadTokens: { type: 'integer', required: true },
                    cacheWriteTokens: { type: 'integer', required: true },
                    cost: { type: 'number', required: true },
                  },
                },
                offPeak: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    calls: { type: 'integer', required: true },
                    inputTokens: { type: 'integer', required: true },
                    outputTokens: { type: 'integer', required: true },
                    cacheReadTokens: { type: 'integer', required: true },
                    cacheWriteTokens: { type: 'integer', required: true },
                    cost: { type: 'number', required: true },
                  },
                },
              },
            },
            byModel: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  model: { type: 'string', required: true },
                  calls: { type: 'integer', required: true },
                  inputTokens: { type: 'integer', required: true },
                  outputTokens: { type: 'integer', required: true },
                  cacheReadTokens: { type: 'integer', required: true },
                  cacheWriteTokens: { type: 'integer', required: true },
                  cost: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: (_args, value: Bill) => [{
          type: 'text',
          text: `Billing: ${value.calls} call(s), ${value.cost} ${value.currency} `
            + `(in ${value.inputTokens} / out ${value.outputTokens} / cache-read ${value.cacheReadTokens} `
            + `/ cache-write ${value.cacheWriteTokens} tokens; `
            + `peak ${value.byBucket.peak.calls} call(s) ${value.byBucket.peak.cost} / `
            + `off-peak ${value.byBucket.offPeak.calls} call(s) ${value.byBucket.offPeak.cost})`
            + (value.budget === undefined
              ? ''
              : ` — budget ${value.budget} ${value.currency}, remaining ${value.remaining} ${value.currency}, `
                + (value.exhausted ? 'EXHAUSTED' : 'available')),
        }],
      },
      execute: (_args, exec) => {
        if (!exec.agent) {
          throw new Error('billing_status requires an owning agent session')
        }
        return Promise.resolve(this.spend(exec.agent.session))
      },
      presentCall: () => ({ card: 'generic', title: 'Check billing status', kind: 'other', rawInput: {} }),
    }))

    this.installBudgetGuard(ctx)
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

  /** Policy role: stop the loop once a configured budget is exhausted. */
  private installBudgetGuard(ctx: Context): void {
    if (this.budget === undefined) return
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const bill = this.spend(agent.session)
      if (!bill.exhausted) return next()
      if (!this.notified.has(agent.session)) {
        this.notified.add(agent.session)
        agent.session.append('user/message', createUserMessage({
          content: [{
            type: 'text',
            text: `Billing budget exhausted: this session spent ${bill.cost} ${this.currency} `
              + `against a ${bill.budget} ${this.currency} budget. Further model calls are blocked `
              + 'until a higher billing.budget is configured in cordis.yml or a new session starts.',
          }],
          source: BUDGET_NOTICE_SOURCE,
        }), { surfaceOp: 'append' })
      }
      return { kind: 'reject' }
    })
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
