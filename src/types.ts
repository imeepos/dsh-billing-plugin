/**
 * Public value types for the event-sourced billing service. The bill is
 * always a pure function of the owning session log plus the deployment price
 * table: nothing about spend is persisted separately, so a bill survives a
 * reload and reproduces identically from the same log.
 * @module dsh-billing
 */

/** Per-1,000,000-token prices for one time-of-day bucket, in `Config.currency`. */
export interface PriceBucket {
  /** Uncached input tokens per million. */
  inputPerMillion: number
  /** Output tokens per million. */
  outputPerMillion: number
  /** Cache-hit input tokens per million; omitted prices as zero. */
  cacheReadPerMillion?: number
  /** Cache-write input tokens per million; omitted prices as zero. */
  cacheWritePerMillion?: number
}

/** The two time-of-day buckets a call can land in. */
export type PriceBucketName = 'peak' | 'offPeak'

/**
 * Peak/off-peak prices for one model. `peak` applies during the configured
 * peak windows (default: Beijing time 09:00–12:00 and 14:00–18:00, end
 * exclusive); `offPeak` applies the rest of the day. `effectiveFrom` is an
 * optional Unix-epoch ms gate: calls before it price at zero, because the
 * table is not yet in effect (deploy the new table on its announced date).
 */
export interface ModelPrice {
  /** Prices applied outside the peak windows — the rest of the day. */
  offPeak: PriceBucket
  /** Prices applied during the configured peak windows (e.g. Beijing 09:00–12:00, 14:00–18:00). */
  peak: PriceBucket
  /** Unix epoch ms before which this table is not yet in effect (prices zero). */
  effectiveFrom?: number
}

/** One whole-hour window `[startHour, endHour)` in the configured clock. */
export type PeakWindow = readonly [startHour: number, endHour: number]

/** Resolved pricing policy: the price table plus the clock used for bucket selection. */
export interface PricingPolicy {
  prices: Record<string, ModelPrice>
  /** Whole-hour peak windows in the configured clock. */
  peakWindows: readonly PeakWindow[]
  /** Clock offset east of UTC in minutes. */
  utcOffsetMinutes: number
}

/**
 * Deployment billing policy. Every field is deployment-varying and changeable
 * from `cordis.yml`; prices are never code constants (see the README for the
 * rationale and a worked `cordis.yml` example).
 */
export interface Config {
  /** Currency code used in every monetary value; defaults to `CNY`. */
  currency?: string
  /** Per-model peak/off-peak price table keyed by model id; models absent here price at zero. */
  prices?: Record<string, ModelPrice>
  /** Whole-hour peak windows `[start, end)` in the configured clock; defaults to `[[9, 12], [14, 18]]`. */
  peakWindows?: PeakWindow[]
  /** Clock offset east of UTC in minutes for bucket selection; defaults to 480 (Beijing, UTC+8, no DST). */
  utcOffsetMinutes?: number
  /** Optional per-session hard spend cap in `currency`; must be positive when set. */
  budget?: number
}

/** Aggregate token/cost totals for one time-of-day bucket. */
export interface BucketTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}

/** One priced model call, folded from a durable `assistant/message` usage event. */
export interface BillingCall {
  /** Session log seq of the folding `assistant/message` event. */
  seq: number
  /** Turn and step of that event, for cross-referencing the conversation. */
  turn: number
  step: number
  /** Model id that produced the call, read from the message source. */
  model: string
  /** The time-of-day bucket the call's logged time landed in. */
  bucket: PriceBucketName
  /** Call time (Unix epoch ms), read from the logged event. */
  time: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Call cost in `Config.currency`, summed from the price table. */
  cost: number
}

/** Per-model aggregate row inside a {@link Bill}. */
export interface BillModelRow {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}

/** The current bill for one session, derived entirely from its event log. */
export interface Bill {
  currency: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  /** Per-model breakdown, ordered by descending cost then model id. */
  byModel: BillModelRow[]
  /** Per-bucket breakdown (peak / off-peak), so the time-segmented price is visible. */
  byBucket: Record<PriceBucketName, BucketTotals>
  /** Per-session spend cap, present only when the deployment configured one. */
  budget?: number
  /** `budget - cost`, present only with `budget`. */
  remaining?: number
  /** True when `budget` is configured and `cost` has reached or exceeded it. */
  exhausted: boolean
}
