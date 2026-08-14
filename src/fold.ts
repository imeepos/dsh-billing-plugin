/**
 * Replay fold of the durable session log into a bill. Pure and incremental:
 * `applyBillingEvent` advances a {@link BillingFoldState} one committed event
 * at a time, so the service and the package invariant can both replay any log
 * and detect the same violations independently.
 * @module dsh-billing
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BucketTotals, PricingPolicy } from './types.ts'
import type { BillingCall, BillModelRow } from './types.ts'
import { priceCall } from './pricing.ts'

/** Running bill for one session; mirror of the public {@link Bill} plus call detail. */
export interface BillingFoldState {
  calls: BillingCall[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  byModel: Map<string, BillModelRow>
  byBucket: { peak: BucketTotals; offPeak: BucketTotals }
}

/** A zero-cost fold state with no calls. */
export function emptyBillingFoldState(): BillingFoldState {
  const empty = (): BucketTotals => ({
    calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0,
  })
  return {
    calls: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    byModel: new Map(),
    byBucket: { peak: empty(), offPeak: empty() },
  }
}

/** Advance one bucket's totals by one call. */
function addToBucket(bucket: BucketTotals, call: BillingCall): void {
  bucket.calls += 1
  bucket.inputTokens += call.inputTokens
  bucket.outputTokens += call.outputTokens
  bucket.cacheReadTokens += call.cacheReadTokens
  bucket.cacheWriteTokens += call.cacheWriteTokens
  bucket.cost += call.cost
}

/**
 * Advance one fold by one committed event. Only `assistant/message` events
 * that carry a provider `usage` record contribute; every other event (and an
 * adapter that reported no usage) leaves the state untouched. The call's time
 * comes from the logged event, so peak/off-peak selection is itself a pure
 * function of the log plus the deployment policy — replay always reproduces
 * the same buckets.
 * @param state - fold to advance, mutated in place.
 * @param event - the next committed session event.
 * @param policy - resolved pricing policy (price table + peak windows + clock).
 */
export function applyBillingEvent(
  state: BillingFoldState,
  event: SessionEvent,
  policy: PricingPolicy,
): void {
  if (event.type !== 'assistant/message') return
  const usage = event.data.usage
  if (usage === undefined) return
  const source = event.data.message.source
  // The durable assistant/message contract fixes a model source; no fallback exists.
  const model = source.model
  const inputTokens = usage.inputTokens
  const outputTokens = usage.outputTokens
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const { cost, bucket } = priceCall(usage, model, event.time, policy)

  const call: BillingCall = {
    seq: event.seq,
    turn: event.data.turn,
    step: event.data.step,
    model,
    bucket,
    time: event.time,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost,
  }
  state.calls.push(call)
  state.inputTokens += inputTokens
  state.outputTokens += outputTokens
  state.cacheReadTokens += cacheReadTokens
  state.cacheWriteTokens += cacheWriteTokens
  state.cost += cost
  addToBucket(state.byBucket[bucket], call)

  const row = state.byModel.get(model)
  if (row === undefined) {
    state.byModel.set(model, {
      model,
      calls: 1,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
    })
    return
  }
  row.calls += 1
  row.inputTokens += inputTokens
  row.outputTokens += outputTokens
  row.cacheReadTokens += cacheReadTokens
  row.cacheWriteTokens += cacheWriteTokens
  row.cost += cost
}
