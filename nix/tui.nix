# nix/tui.nix — AgentX TUI (Ink/React) compiled with tsc and bundled
{ hermesNpmLib, ... }:
hermesNpmLib.buildNpmPackage {
  dirs = [
    "ui-tui"
    "apps/shared"
  ];

  doCheck = false;

  buildPhase = ''
    # esbuild bundles everything — no need for tsc or vite.
    # Run from the workspace root where node_modules/ lives.
    node ui-tui/scripts/build.mjs
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/agentx-tui
    # esbuild writes to ui-tui/dist/ from the source root (no cd).
    cp -r ui-tui/dist $out/lib/agentx-tui/dist

    # package.json kept for "type": "module" resolution on `node dist/entry.js`.
    cp ui-tui/package.json $out/lib/agentx-tui/

    runHook postInstall
  '';
}
