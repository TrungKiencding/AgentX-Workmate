/**
 * Monkey-patch: under Node 26 a test that records a trace never finishes. Its
 * body passes in milliseconds, then it fails with "Test timeout of 90000ms
 * exceeded" and leaves a truncated trace.zip.
 *
 * When a test ends, the runner merges the trace chunks it recorded into the
 * test's trace.zip (`mergeTraceFiles` in playwright/lib/worker/testTracing.js),
 * streaming every entry out of the chunk zips with the yauzl bundled in
 * playwright-core. yauzl's file reader (fd-slicer) sets `destroyed = true` on
 * its stream at EOF, before `push(null)` — and on current Node that property
 * is `Readable#destroyed` itself. Node 24 still hands the consumer whatever is
 * buffered at that point; Node 26 does not. So an entry larger than one
 * 64 KiB read, whose consumer pushed back, never delivers its tail: the merge
 * waits for it forever and the "trace recording" fixture never finishes its
 * teardown. Electron specs hit it on every test, because their trace chunks
 * carry the app's fonts and images.
 *
 * The patch reads each zip into memory and hands yauzl the buffer instead: its
 * buffer reader serves entries from a plain PassThrough and never marks it
 * destroyed. A trace chunk is at most a few MB. `yauzl.open` itself is a
 * non-configurable getter on the bundle's ESM-interop object that reads
 * through to the CommonJS module in `yauzl.default`, so that is where the
 * patch goes.
 *
 * Imported from playwright.config.ts, so it runs in every worker — where the
 * merge happens.
 *
 * Pinned dependency: like fix-electron-tracing.ts this reaches into
 * playwright-core internals (@playwright/test is pinned exact in
 * package.json). Drop it once the bundled yauzl stops destroying its stream
 * at EOF: without the patch, any spec that records a trace hangs under Node 26.
 */

import * as fs from 'node:fs'
import { createRequire } from 'node:module'

type OpenCallback = (error: Error | null, zipFile?: unknown) => void

interface Yauzl {
  open: (path: string, ...args: [object, OpenCallback] | [OpenCallback]) => void
  fromBuffer: (buffer: Buffer, options: object, callback: OpenCallback) => void
}

const require = createRequire(import.meta.url)
const { yauzl } = require('playwright-core/lib/zipBundle') as { yauzl: Yauzl & { default: Yauzl } }

yauzl.default.open = (path, ...args) => {
  const [options, callback]: [object, OpenCallback] = args.length === 2 ? args : [{}, args[0]]

  fs.readFile(path, (error, buffer) => (error ? callback(error) : yauzl.fromBuffer(buffer, options, callback)))
}
