/**
 * Build the client half of dsh-billing.
 *
 * Source:  src/client/index.tsx   (React + TSX + Tailwind)
 * Config:  tailwind.config.mjs + src/client/styles.css
 * Output:  lib/client.js          (the `window.__ModuleLoader__` bundle the
 *          web client loads as the package's `./client` export)
 *
 * Pipeline: esbuild bundles the TSX (CJS, react/react-jsx-runtime external),
 * Tailwind (postcss) emits the utilities used by the markup, and the script
 * wraps both in the ModuleLoader registration with a guarded style-tag
 * injection — the same shape the shipped `dsh-client-*` bundles use.
 */
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import autoprefixer from 'autoprefixer'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src/client/index.tsx')
const cssEntry = join(root, 'src/client/styles.css')
const outFile = join(root, 'lib/client.js')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const bundleId = pkg.name // the loader entry id

// 1) TSX → CJS bundle, externals stay as require() for the ModuleLoader.
const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  write: false,
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
})
const js = result.outputFiles[0].text

// 2) Tailwind utilities for the classes used in the markup.
const cssInput = await readFile(cssEntry, 'utf8')
const tailwindCss = (await postcss([
  tailwind({ config: join(root, 'tailwind.config.mjs') }),
  autoprefixer(),
]).process(cssInput, { from: cssEntry })).css

// 3) Assemble the ModuleLoader bundle.
const cssJson = JSON.stringify(tailwindCss)
const wrapper = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(bundleId)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var CSS = ${cssJson};
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + ${JSON.stringify(bundleId)} + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.pluginCss = ${JSON.stringify(bundleId)};
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
${js}
		return module.exports;
	}
});
`

await writeFile(outFile, wrapper, 'utf8')
console.log(`✓ ${outFile} (${(wrapper.length / 1024).toFixed(1)} KiB, id=${bundleId})`)
