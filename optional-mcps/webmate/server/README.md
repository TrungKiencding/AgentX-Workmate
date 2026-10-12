# WebMate bridge provenance

The checked-in bundle is built from the upstream revision in `VERSION` plus
`workmate-lifecycle.patch`. The patch is kept as readable source, including its
regression tests, rather than editing the generated `.mjs` file. It changes only
the existing file-command transport: lifecycle commands address every managed
browser and retain an atomic receipt in `commands/results/<id>.json` (128 newest
receipts). Developer extension installations are excluded from managed reloads.

Rebuild from a WebMate checkout:

```sh
python scripts/vendor_webmate_server.py --from ../AgentX-WebMate
```

The script archives the tracked source revision, applies the patch in a temporary
directory, builds there and updates the bundle hash, catalog hash and provenance
together. Dirty files in the source checkout are not included. `--no-build` is
refused while the patch is present. The sibling checkout is never modified.

When upstream incorporates this change, remove the corresponding patch hunks
(and eventually the patch file), then rebuild and rerun the tests. Patch conflicts
fail the build instead of silently dropping fixes. The catalog's `--dev` mode
intentionally builds the pinned upstream checkout; it does not include this
downstream patch. Desktop rejects a live multi-browser update when that bridge
does not acknowledge every participant. Use the bundled server for the complete
Workmate lifecycle until the patch is incorporated upstream.

Validation lives in `mcp-server/test/commands.test.mjs` inside the patch and in
`apps/desktop/electron/webmate/service.integration.test.ts`. The latter starts the
actual bundled server and Chrome on a private port/profile, rotates pairing,
updates the real signed extension bundle with two connections attached, and
checks rollback when the new extension fails to reconnect. It runs on hosts with
macOS Chrome installed and is explicitly skipped elsewhere. Windows lock and
rename recovery paths are covered by injected `EBUSY` failures in `updater.test.ts`;
this is not a substitute for testing a packaged Windows app on Windows.
