/**
 * JSON-safe session projection for the billing bill. The projection is the
 * official dsh channel that pushes derived per-session data to the web
 * client: `ctx.sessionProjections.register` feeds every committed session
 * event through `apply`, and the schema-validated `view` value lands in the
 * client's `projectionValues` — so the companion UI widget renders the bill
 * with zero RPC and zero model-context injection.
 *
 * Unlike {@link BillingFoldState} (which uses `Map` for per-model and
 * per-bucket rows), this state is plain JSON by the projection contract: it
 * aggregates the same totals the fold tracks, plus the per-token-type cost
 * breakdown the UI's detail panel shows.
 * @module dsh-billing
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PricingPolicy } from './types.ts'
import { priceCall } from './pricing.ts'

/** Round a currency amount to a display-stable precision (avoid floating-point noise). */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/** Plain-JSON projection state: aggregate bill totals, no Maps. */
export interface BillingProjectionState {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  peakCost: number
  offPeakCost: number
  cacheReadCost: number
  cacheMissCost: number
  outputCost: number
}

/** Wire value shipped to the client under the `billing` projection key. */
export interface BillingProjectionValue {
  currency: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  /** Present only when the deployment configured a budget. */
  budget?: number
  /** Present only when the deployment configured a budget. */
  remaining?: number
  exhausted: boolean
  peakCost: number
  offPeakCost: number
  breakdown: {
    cacheRead: number
    cacheMiss: number
    output: number
  }
}

/** Zod schema for the wire value (validated before it leaves the host). */
export const billingProjectionSchema = z.object({
  currency: z.string(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  cost: z.number(),
  budget: z.number().optional(),
  remaining: z.number().optional(),
  exhausted: z.boolean(),
  peakCost: z.number(),
  offPeakCost: z.number(),
  breakdown: z.object({
    cacheRead: z.number(),
    cacheMiss: z.number(),
    output: z.number(),
  }),
}) as z.ZodType<BillingProjectionValue>

/** The empty bill projection state. */
export function initBillingProjectionState(): BillingProjectionState {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    peakCost: 0,
    offPeakCost: 0,
    cacheReadCost: 0,
    cacheMissCost: 0,
    outputCost: 0,
  }
}

/**
 * Pure transition: one committed event → next state. Only `assistant/message`
 * events carrying a provider `usage` record contribute; every other event
 * returns the same state reference (zero downstream work). The per-type cost
 * breakdown uses the same linear decomposition as the UI's detail panel:
 * `price()` is linear in token counts, so the full price equals the sum of
 * the single-type prices at the call's logged time.
 */
export function applyBillingProjection(
  state: BillingProjectionState,
  event: SessionEvent,
  policy: PricingPolicy,
): BillingProjectionState {
  if (event.type !== 'assistant/message') return state
  const usage = event.data.usage
  if (usage === undefined) return state
  const model = event.data.message.source.model
  const time = event.time
  const { cost, bucket } = priceCall(usage, model, time, policy)
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const cacheReadCost = priceCall(
    { inputTokens: 0, outputTokens: 0, cacheReadTokens, cacheWriteTokens: 0 }, model, time, policy).cost
  const cacheMissCost = priceCall(
    { inputTokens: usage.inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, model, time, policy).cost
  const outputCost = priceCall(
    { inputTokens: 0, outputTokens: usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, model, time, policy).cost
  return {
    ...state,
    calls: state.calls + 1,
    inputTokens: state.inputTokens + usage.inputTokens,
    outputTokens: state.outputTokens + usage.outputTokens,
    cacheReadTokens: state.cacheReadTokens + cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens + cacheWriteTokens,
    cost: state.cost + cost,
    peakCost: state.peakCost + (bucket === 'peak' ? cost : 0),
    offPeakCost: state.offPeakCost + (bucket === 'offPeak' ? cost : 0),
    cacheReadCost: state.cacheReadCost + cacheReadCost,
    cacheMissCost: state.cacheMissCost + cacheMissCost,
    outputCost: state.outputCost + outputCost,
  }
}

/** State → wire payload (the read-side projection the client renders). */
export function viewBillingProjection(
  state: BillingProjectionState,
  currency: string,
  budget: number | undefined,
): BillingProjectionValue {
  const value: BillingProjectionValue = {
    currency,
    calls: state.calls,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
    cost: roundCost(state.cost),
    exhausted: budget !== undefined && state.cost >= budget,
    peakCost: roundCost(state.peakCost),
    offPeakCost: roundCost(state.offPeakCost),
    breakdown: {
      cacheRead: roundCost(state.cacheReadCost),
      cacheMiss: roundCost(state.cacheMissCost),
      output: roundCost(state.outputCost),
    },
  }
  if (budget !== undefined) {
    value.budget = budget
    value.remaining = roundCost(budget - state.cost)
  }
  return value
}
