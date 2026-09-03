/**
 * Smoke test for the plugin SDK surface additions.
 *
 * Verifies that `exposePluginSDK()` writes the new dialog/toast primitives to
 * `window.__AGENTX_PLUGIN_SDK__`. Each new key is checked individually so a
 * regression in one helper doesn't mask the others.
 *
 * Companion to the additive PR "feat(plugins): expose Dialog/ConfirmDialog/
 * Toast/useToast/useConfirmDelete on the plugin SDK". See issue #50547.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { exposePluginSDK } from "./registry";

/** Only the shape these assertions reach for — not the full SDK type. */
type PluginSdk = {
  components: Record<string, unknown>;
  hooks: Record<string, unknown>;
  sdkVersion: string;
};

// exposePluginSDK() writes to the global `window`, which this suite runs
// without. Cast once, here, instead of at four call sites.
const testGlobal = globalThis as unknown as {
  window: {
    __AGENTX_PLUGINS__: unknown;
    __AGENTX_PLUGIN_SDK__: PluginSdk | undefined;
  };
};

describe("plugin SDK dialog/toast surface", () => {
  beforeEach(() => {
    // Reset window between tests so exposePluginSDK() writes fresh.
    testGlobal.window = {
      __AGENTX_PLUGINS__: undefined,
      __AGENTX_PLUGIN_SDK__: undefined,
    };
  });

  it("exposes Dialog + subcomponents on components", () => {
    exposePluginSDK();
    const sdk = testGlobal.window.__AGENTX_PLUGIN_SDK__ as PluginSdk;
    expect(sdk.components.Dialog).toBeDefined();
    expect(sdk.components.DialogContent).toBeDefined();
    expect(sdk.components.DialogHeader).toBeDefined();
    expect(sdk.components.DialogTitle).toBeDefined();
    expect(sdk.components.DialogDescription).toBeDefined();
    expect(sdk.components.DialogFooter).toBeDefined();
    expect(sdk.components.DialogClose).toBeDefined();
    expect(sdk.components.ConfirmDialog).toBeDefined();
    expect(sdk.components.Toast).toBeDefined();
  });

  it("exposes useToast and useConfirmDelete on hooks", () => {
    exposePluginSDK();
    const sdk = testGlobal.window.__AGENTX_PLUGIN_SDK__ as PluginSdk;
    expect(typeof sdk.hooks.useToast).toBe("function");
    expect(typeof sdk.hooks.useConfirmDelete).toBe("function");
    // Original React hooks still present (no accidental removal).
    expect(typeof sdk.hooks.useState).toBe("function");
    expect(typeof sdk.hooks.useCallback).toBe("function");
  });

  it("does not bump SDK_CONTRACT_VERSION (additive change)", () => {
    exposePluginSDK();
    const sdk = testGlobal.window.__AGENTX_PLUGIN_SDK__ as PluginSdk;
    // Pre-existing version per registry.ts:98. This test fails if a future
    // PR accidentally bumps the major for an additive surface change.
    expect(sdk.sdkVersion).toBe("1.1.0");
  });
});