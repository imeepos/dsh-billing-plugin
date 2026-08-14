// Proves the billing projection unit actually registers when the plugin is
// composed through the real Loader with the real session-projection registry
// mounted earlier in the tree — the runtime shape of the web profile.
// Regression test for the constructor-time `ctx.get('sessionProjections')`
// probe: when the registry service is not yet started at BillingService
// construction (cordis plugin application is fiber-scheduled; the loader's
// async imports do not guarantee the earlier entry's service is visible to a
// later entry's constructor), registration is silently skipped and the web
// client's projectionValues never carry a `billing` key.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import BillingService from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('dsh-billing projection registration through the real Loader', () => {
  it('registers the billing unit when the registry plugin precedes it in the tree', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-billing-proj-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: 'dsh-billing'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session-projection', ProjectionPlugin],
      ['@deepseek-ai/dsh-session', SessionStore],
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

    const projections = ctx.get('sessionProjections')
    expect(projections).toBeDefined()
    const snapshot = projections!.snapshot(Session.create(SessionId('probe')))
    expect(Object.keys(snapshot.values)).toContain('billing')
  })
})
