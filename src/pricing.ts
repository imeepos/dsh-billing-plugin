/**
 * Pure pricing helpers. Deployment prices and the peak window arrive through
 * config and are never code constants; these functions only turn a token
 * count, a clock time, and a price into a cost, so the fold and the tool stay
 * trivially testable.
 * @module dsh-billing
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { PeakWindow, PricingPolicy, PriceBucket, PriceBucketName } from './types.ts'

/** Price one model call's usage under one per-million-token bucket, in currency units. */
export function priceBucket(usage: TokenUsage, bucket: PriceBucket | undefined): number {
  if (bucket === undefined) return 0
  return (
    usage.inputTokens * bucket.inputPerMillion
    + usage.outputTokens * bucket.outputPerMillion
    + (usage.cacheReadTokens ?? 0) * (bucket.cacheReadPerMillion ?? 0)
    + (usage.cacheWriteTokens ?? 0) * (bucket.cacheWritePerMillion ?? 0)
  ) / 1_000_000
}

/**
 * The hour of day at `time` in the configured clock. The offset is east of
 * UTC in minutes; the default deployment uses 480 (Beijing, UTC+8, which has
 * no DST, so the arithmetic is exact).
 * @param time - Unix epoch ms.
 * @param utcOffsetMinutes - clock offset east of UTC in minutes.
 * @returns the wall-clock hour (0–23) at that time in the configured clock.
 */
export function clockHour(time: number, utcOffsetMinutes: number): number {
  return new Date(time + utcOffsetMinutes * 60_000).getUTCHours()
}

/**
 * Whether `time` falls inside any peak window. Windows are whole-hour
 * `[start, end)` ranges in the configured clock, so 12:00 and 18:00 are not
 * peak under the default `[[9, 12], [14, 18]]`.
 * @param time - Unix epoch ms of the call.
 * @param peakWindows - whole-hour peak windows.
 * @param utcOffsetMinutes - clock offset east of UTC in minutes.
 * @returns true when the call's wall-clock hour lies in a peak window.
 */
export function isPeakTime(time: number, peakWindows: readonly PeakWindow[], utcOffsetMinutes: number): boolean {
  const hour = clockHour(time, utcOffsetMinutes)
  return peakWindows.some(([start, end]) => hour >= start && hour < end)
}

/**
 * Pick the bucket name for a call time under the deployment policy.
 * @param time - Unix epoch ms of the call.
 * @param policy - resolved pricing policy (windows + clock offset).
 * @returns `'peak'` or `'offPeak'`.
 */
export function bucketForTime(time: number, policy: PricingPolicy): PriceBucketName {
  return isPeakTime(time, policy.peakWindows, policy.utcOffsetMinutes) ? 'peak' : 'offPeak'
}

/** The priced outcome of one call: its cost and the bucket that priced it. */
export interface PricedCall {
  cost: number
  bucket: PriceBucketName
}

/**
 * Price one model call under a peak/off-peak table at the call's logged time.
 * A table whose `effectiveFrom` lies in the future prices at zero (it is not
 * yet in effect); otherwise the peak or off-peak bucket applies by the call's
 * wall-clock hour. The bucket is returned so the fold can record it.
 * @param usage - provider-reported token accounting for the call.
 * @param model - model id the call ran on.
 * @param time - Unix epoch ms of the call (the logged `assistant/message` time).
 * @param policy - resolved pricing policy.
 * @returns the cost in `Config.currency` and the bucket that priced it.
 */
export function priceCall(usage: TokenUsage, model: string, time: number, policy: PricingPolicy): PricedCall {
  const price = policy.prices[model]
  if (price === undefined) return { cost: 0, bucket: 'offPeak' }
  const bucket = bucketForTime(time, policy)
  if (price.effectiveFrom !== undefined && time < price.effectiveFrom) {
    return { cost: 0, bucket }
  }
  return { cost: priceBucket(usage, bucket === 'peak' ? price.peak : price.offPeak), bucket }
}

/** Total tokens of one usage record, cache buckets included. */
export function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

/** Default peak windows: Beijing 09:00–12:00 and 14:00–18:00, end exclusive. */
export const DEFAULT_PEAK_WINDOWS: readonly PeakWindow[] = [[9, 12], [14, 18]] as const
/** Default clock offset: Beijing, UTC+8 (no DST). */
export const DEFAULT_UTC_OFFSET = 8 * 60
