import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import BillingService from '../src/index.ts'
import {
  bucketForTime, clockHour, priceBucket, priceCall,
  initBillingProjectionState, applyBillingProjection, viewBillingProjection,
} from '../src/index.ts'
import type { Config, ModelPrice, PricingPolicy } from '../src/index.ts'
import * as BillingInvariantCompanion from '../src/invariant.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * The official DeepSeek peak/off-peak table (announced for 2026-08-17 00:00
 * Beijing time): cache-read input, uncached input, and output per million
 * tokens in CNY. Peak windows default to Beijing 09:00–12:00 and 14:00–18:00.
 */
const DEEPSEEK_PRICES: Record<string, ModelPrice> = {
  'deepseek-v4-flash': {
    offPeak: { inputPerMillion: 1.5, outputPerMillion: 4.5, cacheReadPerMillion: 0.05 },
    peak: { inputPerMillion: 3.0, outputPerMillion: 9.0, cacheReadPerMillion: 0.10 },
  },
  'deepseek-v4-pro': {
    offPeak: { inputPerMillion: 4.5, outputPerMillion: 13.5, cacheReadPerMillion: 0.15 },
    peak: { inputPerMillion: 9.0, outputPerMillion: 27.0, cacheReadPerMillion: 0.30 },
  },
}

/** A usage record with every bucket populated. */
const USAGE: TokenUsage = {
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cacheReadTokens: 200_000,
  cacheWriteTokens: 0,
}

/** Epoch ms of a Beijing wall-clock time. */
function beijingTime(iso: string): number {
  return new Date(`${iso}+08:00`).getTime()
}

/** The resolved policy used by most fold tests (Beijing clock, default windows). */
const POLICY: PricingPolicy = {
  prices: DEEPSEEK_PRICES,
  peakWindows: [[9, 12], [14, 18]],
  utcOffsetMinutes: 8 * 60,
}

/** Freeze Date at a Beijing wall-clock time so appended events carry that time. */
function freezeBeijingClock(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(beijingTime(iso))
}

afterEach(() => {
  vi.useRealTimers()
})

/** Append one durable model call (step/start → assistant/message → step/end) to a session. */
function appendUsageCall(
  session: Session,
  turn: number,
  step: number,
  model: string,
  usage: TokenUsage,
): void {
  session.append('step/start', { turn, step })
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'mock', model },
    }),
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
}

/** A parent Agent backed by a real Session. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

/** Boot the core spine + the billing service; the caller registers adapters. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(BillingService, config)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const d = ctx.on('agent/status', ({ agent: s, status: st }) => {
      if (s === agent && st === 'idle') { d(); resolve() }
    })
  })
}

describe('dsh-billing time-of-day pricing (pure)', () => {
  it('maps Beijing wall-clock hours to the default peak windows', () => {
    expect(clockHour(beijingTime('2026-08-17T10:00:00'), POLICY.utcOffsetMinutes)).toBe(10)
    expect(bucketForTime(beijingTime('2026-08-17T10:00:00'), POLICY)).toBe('peak')
    expect(bucketForTime(beijingTime('2026-08-17T11:59:59'), POLICY)).toBe('peak')
    expect(bucketForTime(beijingTime('2026-08-17T14:00:00'), POLICY)).toBe('peak')
    expect(bucketForTime(beijingTime('2026-08-17T17:59:59'), POLICY)).toBe('peak')
    // Window ends are exclusive: 12:00 and 18:00 are off-peak.
    expect(bucketForTime(beijingTime('2026-08-17T12:00:00'), POLICY)).toBe('offPeak')
    expect(bucketForTime(beijingTime('2026-08-17T18:00:00'), POLICY)).toBe('offPeak')
    expect(bucketForTime(beijingTime('2026-08-17T08:00:00'), POLICY)).toBe('offPeak')
    expect(bucketForTime(beijingTime('2026-08-17T13:00:00'), POLICY)).toBe('offPeak')
    expect(bucketForTime(beijingTime('2026-08-17T23:00:00'), POLICY)).toBe('offPeak')
    // 2026-08-17T02:00+08:00 is still 2026-08-16 in UTC: the clock is Beijing, not UTC.
    expect(clockHour(beijingTime('2026-08-17T02:00:00'), POLICY.utcOffsetMinutes)).toBe(2)
  })

  it('honors custom peak windows and a custom clock offset', () => {
    const london: PricingPolicy = { ...POLICY, utcOffsetMinutes: 0 }
    expect(bucketForTime(beijingTime('2026-08-17T10:00:00'), london)).toBe('offPeak')
    expect(bucketForTime(Date.UTC(2026, 7, 17, 10, 0, 0), london)).toBe('peak')
    const evening: PricingPolicy = { ...POLICY, peakWindows: [[20, 23]] }
    expect(bucketForTime(beijingTime('2026-08-17T22:00:00'), evening)).toBe('peak')
    expect(bucketForTime(beijingTime('2026-08-17T19:00:00'), evening)).toBe('offPeak')
    expect(bucketForTime(beijingTime('2026-08-17T23:00:00'), evening)).toBe('offPeak')
  })

  it('prices a call with the bucket of its own time: peak vs off-peak', () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 0 }
    const offPeakCost = priceCall(usage, 'deepseek-v4-flash', beijingTime('2026-08-17T13:00:00'), POLICY)
    expect(offPeakCost).toEqual({ cost: 1.5, bucket: 'offPeak' })
    const peakCost = priceCall(usage, 'deepseek-v4-flash', beijingTime('2026-08-17T10:00:00'), POLICY)
    expect(peakCost).toEqual({ cost: 3.0, bucket: 'peak' })
  })

  it('prices cache-read input at its discounted rate per bucket', () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }
    expect(priceCall(usage, 'deepseek-v4-flash', beijingTime('2026-08-17T13:00:00'), POLICY).cost).toBe(0.05)
    expect(priceCall(usage, 'deepseek-v4-flash', beijingTime('2026-08-17T10:00:00'), POLICY).cost).toBe(0.10)
    expect(priceCall(usage, 'deepseek-v4-pro', beijingTime('2026-08-17T10:00:00'), POLICY).cost).toBe(0.30)
  })

  it('prices an unpriced model at zero and a not-yet-effective table at zero', () => {
    expect(priceCall(USAGE, 'unknown-model', beijingTime('2026-08-17T10:00:00'), POLICY).cost).toBe(0)
    const notYet: PricingPolicy = {
      ...POLICY,
      prices: {
        'deepseek-v4-flash': {
          ...DEEPSEEK_PRICES['deepseek-v4-flash']!,
          effectiveFrom: beijingTime('2026-08-17T00:00:00'),
        },
      },
    }
    // The new table takes effect at 2026-08-17 00:00 Beijing: before it prices zero.
    expect(priceCall(USAGE, 'deepseek-v4-flash', beijingTime('2026-08-16T23:59:59'), notYet).cost).toBe(0)
    // On the effective date the bucket logic takes over.
    expect(priceCall(USAGE, 'deepseek-v4-flash', beijingTime('2026-08-17T10:00:00'), notYet).bucket).toBe('peak')
    // flash peak: 1M in @3.0 + 0.5M out @9.0 + 0.2M cache-read @0.10 = 7.52
    expect(priceBucket(USAGE, DEEPSEEK_PRICES['deepseek-v4-flash']!.peak)).toBe(7.52)
  })
})

describe('dsh-billing service (ctx.billing)', () => {
  it('rejects a non-positive budget at load', async () => {
    for (const budget of [0, -1, Number.NaN]) {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await expect(ctx.plugin(BillingService, { budget })).rejects.toThrow(/budget/)
    }
  })

  it('rejects malformed peak windows at load', async () => {
    for (const peakWindows of [[[9, 9]], [[12, 9]], [[-1, 12]], [[9, 25]]]) {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await expect(ctx.plugin(BillingService, { peakWindows } as unknown as Config)).rejects.toThrow(/peak window/)
    }
  })

  it('folds real agent-loop usage into a per-session bill with time-segmented prices', async () => {
    freezeBeijingClock('2026-08-17T13:00:00') // off-peak: 13:00 is outside both windows
    const ctx = await harness({ prices: DEEPSEEK_PRICES, currency: 'CNY' })
    const adapter = new MockAdapter([
      textResponse('first'),
      textResponse('second'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('fold'), { provider: 'mock', model: 'deepseek-v4-flash' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // MockAdapter reports 10 input + len(output) per call; two text calls at
    // the off-peak flash rate (1.5 / 4.5 per million). spend() rounds to 6 dp.
    const bill = ctx.billing.spend(agent.session)
    expect(bill.calls).toBe(2)
    expect(bill.cost).toBe(0.00008)
    expect(bill.byBucket.offPeak.calls).toBe(2)
    expect(bill.byBucket.peak.calls).toBe(0)
    expect(bill.byModel[0]!.model).toBe('deepseek-v4-flash')
  })

  it('prices the same loop at the peak rate when calls land in a peak window', async () => {
    freezeBeijingClock('2026-08-17T10:00:00') // peak: 10:00 is inside 09:00–12:00
    const ctx = await harness({ prices: DEEPSEEK_PRICES })
    const adapter = new MockAdapter([textResponse('hi')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('peak'), { provider: 'mock', model: 'deepseek-v4-flash' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const bill = ctx.billing.spend(agent.session)
    expect(bill.byBucket.peak.calls).toBe(1)
    expect(bill.cost).toBe((10 * 3.0 + 'hi'.length * 9.0) / 1_000_000)
    // The same usage at off-peak would cost half.
    expect(bill.byBucket.offPeak.cost).toBe(0)
  })

  it('recomputes the same bill after a fresh service instance (replay determinism)', async () => {
    freezeBeijingClock('2026-08-17T13:00:00')
    const ctx = await harness({ prices: DEEPSEEK_PRICES })
    const adapter = new MockAdapter([textResponse('hi')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('replay'), { provider: 'mock', model: 'deepseek-v4-flash' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const first = ctx.billing.spend(agent.session)

    // A second, unrelated service over the same log must reproduce the bill —
    // including the bucket, which is itself a pure function of logged times.
    const ctx2 = new Context()
    await mountAgentLoopTestDependencies(ctx2)
    await ctx2.plugin(BillingService, { prices: DEEPSEEK_PRICES })
    const second = ctx2.billing.spend(agent.session)
    expect(second).toEqual(first)
    expect(second.byBucket.offPeak.calls).toBe(1)
  })

  it('ignores assistant/message events without a provider usage record', async () => {
    const ctx = await harness({ prices: DEEPSEEK_PRICES })
    const agent = agentWithSession('no-usage')
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const bill = ctx.billing.spend(agent.session)
    expect(bill.calls).toBe(0)
    expect(bill.cost).toBe(0)
  })
})

describe('dsh-billing statistics-only contract (no model-context injection)', () => {
  it('registers no model-visible tool', async () => {
    const ctx = await harness({ prices: DEEPSEEK_PRICES })
    expect(ctx.tools.schemas().find(s => s.name === 'billing_status')).toBeUndefined()
  })

  it('injects nothing into the conversation when the budget is exceeded', async () => {
    freezeBeijingClock('2026-08-17T10:00:00') // peak rate: 1M in @3.0 → cost 3.0 > tiny budget
    const ctx = await harness({ prices: DEEPSEEK_PRICES, budget: 0.0001 })
    const adapter = new MockAdapter([
      (): Awaited<ReturnType<typeof textResponse>> => [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'spent' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'spent' } },
        { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 0 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      textResponse('still running'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('stats-only'), { provider: 'mock', model: 'deepseek-v4-flash' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(ctx.billing.spend(agent.session).exhausted).toBe(true)

    // The loop keeps running, and the log gains no plugin-sourced message:
    // overage is visible on the UI surface, never in the conversation.
    const assistantBefore = agent.session.events.filter(e => e.type === 'assistant/message').length
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(agent.session.events.filter(e => e.type === 'assistant/message').length).toBe(assistantBefore + 1)
    expect(adapter.requests).toHaveLength(2) // the second response streamed
    expect(agent.session.events.filter(e =>
      e.type === 'user/message' && e.data.source.kind !== 'user')).toHaveLength(0)
  })
})

describe('dsh-billing projection (client data channel)', () => {
  it('folds usage into a JSON-safe bill value with per-type breakdown', () => {
    freezeBeijingClock('2026-08-17T10:00:00') // peak — flash: 1M in @3.0 + 0.5M out @9.0 + 0.2M cache-read @0.10 = 7.52
    const owner = agentWithSession('projection')
    appendUsageCall(owner.session, 1, 1, 'deepseek-v4-flash', USAGE)
    let state = initBillingProjectionState()
    for (const ev of owner.session.events) state = applyBillingProjection(state, ev, POLICY)
    const value = viewBillingProjection(state, 'CNY', 10)
    expect(value.calls).toBe(1)
    expect(value.cost).toBe(7.52)
    expect(value.peakCost).toBe(7.52)
    expect(value.offPeakCost).toBe(0)
    expect(value.budget).toBe(10)
    expect(value.remaining).toBe(2.48)
    expect(value.exhausted).toBe(false)
    // Per-type: cache-read 0.2M @0.10 = 0.02, uncached input 1M @3.0 = 3.0, output 0.5M @9.0 = 4.5.
    expect(value.breakdown).toEqual({ cacheRead: 0.02, cacheMiss: 3.0, output: 4.5 })
  })

  it('marks exhausted and omits budget fields when none is configured', () => {
    freezeBeijingClock('2026-08-17T10:00:00')
    const owner = agentWithSession('projection-exhausted')
    appendUsageCall(owner.session, 1, 1, 'deepseek-v4-flash', USAGE)
    let state = initBillingProjectionState()
    for (const ev of owner.session.events) state = applyBillingProjection(state, ev, POLICY)
    expect(viewBillingProjection(state, 'CNY', 7).exhausted).toBe(true) // 7.52 >= 7
    const noBudget = viewBillingProjection(state, 'CNY', undefined)
    expect(noBudget.budget).toBeUndefined()
    expect(noBudget.remaining).toBeUndefined()
    expect(noBudget.exhausted).toBe(false)
  })
})

describe('dsh-billing durable-stream invariant', () => {
  async function setup(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(BillingInvariantCompanion)
    return ctx
  }

  it('accepts a stream whose usage counts are finite and non-negative', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('billing-invariant-valid'))
    expect(() => {
      appendUsageCall(session, 1, 1, 'deepseek-v4-flash', USAGE)
    }).not.toThrow()
    expect(() => {
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()
  })

  it('rejects negative usage before it commits and keeps the fold reusable', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('billing-invariant-invalid'))
    expect(() => {
      appendUsageCall(session, 1, 1, 'deepseek-v4-flash', {
        inputTokens: -5,
        outputTokens: 10,
      })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-billing',
    }))
    // The offending event never commits; only its preceding step/start stays.
    expect(session.events.filter(e => e.type === 'assistant/message')).toHaveLength(0)
    expect(session.seq).toBe(1)
    expect(() => {
      appendUsageCall(session, 1, 2, 'deepseek-v4-flash', USAGE)
    }).not.toThrow()
    expect(session.events.filter(e => e.type === 'assistant/message')).toHaveLength(1)
  })

  it('reconstructs an existing durable log before checking later events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('billing-invariant-late-load'))
    appendUsageCall(session, 1, 1, 'deepseek-v4-flash', USAGE)

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(BillingInvariantCompanion)
    expect(() => {
      session.append('turn/start', { turn: 2 })
    }).not.toThrow()
    expect(() => {
      appendUsageCall(session, 2, 1, 'deepseek-v4-flash', USAGE)
    }).not.toThrow()
  })
})
