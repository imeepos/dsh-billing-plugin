// Proves the shipped `lib/client.js` is (1) syntactically valid JavaScript a
// browser can parse and (2) actually registers the plugin with the web
// client's `window.__ModuleLoader__` sink. The bundle is loaded by the
// harness as a classic script: if parsing throws, the script's `load` event
// still fires but the loader registration never runs — which the harness
// reports as `bundle ... loaded without registering "dsh-billing" via
// __ModuleLoader__.load`. Regression test for the build-script quoting bug
// that emitted `querySelector("style[data-plugin-css="dsh-billing"]")`.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const bundlePath = join(import.meta.dirname, '../lib/client.js')

describe('lib/client.js (shipped client bundle)', () => {
  it('is parseable JavaScript', async () => {
    const src = await readFile(bundlePath, 'utf8')
    // new Function compiles the body without executing it — a SyntaxError
    // here is exactly the browser failure mode.
    expect(() => { void new Function(src) }).not.toThrow()
  })

  it('registers the plugin via window.__ModuleLoader__.load', async () => {
    const src = await readFile(bundlePath, 'utf8')
    const load = vi.fn()
    const fakeWindow = { __ModuleLoader__: { load } }
    // Execute the bundle as the browser would, with the loader sink in place.
    // `window`/`document` are injected as parameters so top-level references
    // resolve without a real DOM; the factory body is not invoked.
    new Function('window', 'document', src)(fakeWindow, undefined)
    expect(load).toHaveBeenCalledTimes(1)
    const handoff = load.mock.calls[0][0] as { id: string; factory: unknown }
    expect(handoff.id).toBe('dsh-billing')
    expect(typeof handoff.factory).toBe('function')
  })
})
