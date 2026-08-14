// Proves the billing plugin's configuration is real deployment policy and not
// a constant: the official DeepSeek peak/off-peak table set in a cordis.yml
// booted through the real Loader drives both the service fold and the
// model-facing tool result, with the peak/off-peak bucket chosen by the call's
// logged Beijing time.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import BillingService from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.useRealTimers()
})

/** Epoch ms of a Beijing wall-clock time. */
function beijingTime(iso: string): number {
  return new Date(`${iso}+08:00`).getTime()
}

/** Freeze Date at a Beijing wall-clock time so appended events carry that time. */
function freezeBeijingClock(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(beijingTime(iso))
}

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(ctx: Context, id = 'billing-loader-agent'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  const value = {
    id: SessionId(id),
    options: {},
    session,
    inbox: { hasPending: false } as unknown as Agent['inbox'],
    status: 'idle' as const,
    ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: (task: (signal: AbortSignal) => unknown) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  ctx.agents.register(value)
  return value
}

/**
 * Boot a cordis.yml carrying the given billing config block through the real
 * Loader. The billing service activates once `ctx.tools` exists.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context after the Loader settles.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-billing-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'dsh-billing'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['dsh-billing', BillingService],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Append one durable model call with explicit usage to a session. */
function appendUsageCall(session: Session, usage: { inputTokens: number; outputTokens: number }): void {
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'mock', model: 'deepseek-v4-flash' },
    }),
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
}

/** The official peak/off-peak table announced for 2026-08-17 00:00 Beijing. */
const OFFICIAL_CONFIG = [
  '      currency: CNY',
  '      prices:',
  '        deepseek-v4-flash:',
  '          offPeak:',
  '            inputPerMillion: 1.5',
  '            outputPerMillion: 4.5',
  '            cacheReadPerMillion: 0.05',
  '          peak:',
  '            inputPerMillion: 3.0',
  '            outputPerMillion: 9.0',
  '            cacheReadPerMillion: 0.10',
  '        deepseek-v4-pro:',
  '          offPeak:',
  '            inputPerMillion: 4.5',
  '            outputPerMillion: 13.5',
  '            cacheReadPerMillion: 0.15',
  '          peak:',
  '            inputPerMillion: 9.0',
  '            outputPerMillion: 27.0',
  '            cacheReadPerMillion: 0.30',
]

describe('dsh-billing real Loader composition through cordis.yml', () => {
  it('activates ctx.billing from config and prices calls by their logged Beijing time', async () => {
    freezeBeijingClock('2026-08-17T10:00:00') // peak: 10:00 is inside 09:00–12:00
    const ctx = await boot(OFFICIAL_CONFIG)
    expect(ctx.get('billing')).toBeInstanceOf(BillingService)
    expect(ctx.tools.schemas().some(s => s.name === 'billing_status')).toBe(true)

    const owner = agentWithSession(ctx)
    appendUsageCall(owner.session, { inputTokens: 1_000_000, outputTokens: 500_000 })
    const bill = ctx.billing.spend(owner.session)
    // flash peak: 1M in @3.0 + 0.5M out @9.0 = 7.5 CNY
    expect(bill.cost).toBe(7.5)
    expect(bill.currency).toBe('CNY')
    expect(bill.byBucket.peak.calls).toBe(1)
    expect(bill.byBucket.offPeak.calls).toBe(0)

    // The model-facing tool reports the same Loader-derived bill end to end.
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'billing-loader-1' as never,
      name: 'billing_status',
      arguments: {},
      agent: owner,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected billing_status success')
    expect(result.value).toMatchObject({ cost: 7.5, currency: 'CNY', byBucket: { peak: { calls: 1 } } })
  })

  it('charges the same call at half the price when it lands in an off-peak hour', async () => {
    freezeBeijingClock('2026-08-17T13:00:00') // off-peak: outside both windows
    const ctx = await boot(OFFICIAL_CONFIG)
    const owner = agentWithSession(ctx)
    appendUsageCall(owner.session, { inputTokens: 1_000_000, outputTokens: 500_000 })
    // flash off-peak: 1M in @1.5 + 0.5M out @4.5 = 3.75 CNY — exactly half of peak.
    expect(ctx.billing.spend(owner.session).cost).toBe(3.75)
    expect(ctx.billing.spend(owner.session).byBucket.offPeak.calls).toBe(1)
  })

  it('fails loud at load when a peak window is malformed', async () => {
    await expect(boot([
      '      currency: CNY',
      '      peakWindows:',
      '        - [14, 9]',
    ])).rejects.toThrow(/peak window/)
  })
})
