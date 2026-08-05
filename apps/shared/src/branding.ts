/**
 * Single source of truth for AgentX Workmate product identity — TypeScript side.
 *
 * Mirrors `branding.py` at the repo root. The desktop app, the web dashboard,
 * and the Ink TUI all import from here rather than hard-coding the product
 * name, so a rename stays a one-file edit per language.
 *
 * `tests/test_branding_consistency.py` parses this file and asserts every
 * value matches `branding.py` and `scripts/lib/branding.sh`, so the three
 * mirrors cannot drift.
 */

/** Full product name. Banner titles, About dialogs, installer windows. */
export const PRODUCT_NAME = 'AgentX Workmate'

/** Short form for tight spaces (status bars, response labels, bot names). */
export const SHORT_NAME = 'AgentX'

/** Legal entity that publishes the product. */
export const VENDOR_NAME = 'AstralX Technology'

/** Where users are told to send support requests. */
export const SUPPORT_EMAIL = 'kien.le@astralx.com.vn'

/** Brand glyph used as a decorative prefix in the CLI and TUI. */
export const BRAND_GLYPH = '⬡'

/** The command users type. Console-script entry point name. */
export const CLI_COMMAND = 'agentx'

/** Long-running gateway process entry point. */
export const GATEWAY_COMMAND = 'agentx-gateway'

/** Agent Client Protocol adapter entry point. */
export const ACP_COMMAND = 'agentx-acp'

/** Config/state directory under `$HOME` on POSIX (`~/.agentx`). */
export const CONFIG_DIR_POSIX = '.agentx'

/** Config/state directory under `%LOCALAPPDATA%` on Windows. */
export const CONFIG_DIR_WINDOWS = 'agentx'

/** Per-project instruction file, alongside AGENTS.md / CLAUDE.md. */
export const PROJECT_CONFIG_FILE = '.agentx.md'

/** Prefix for every environment variable the product reads or writes. */
export const ENV_PREFIX = 'AGENTX_'

/** Reverse-DNS application id. macOS bundle id, Windows AppUserModelId. */
export const APP_ID = 'com.agentx.workmate'

/** Custom URL scheme the desktop app registers (`agentx://…`). */
export const PROTOCOL_SCHEME = 'agentx'

/** Python distribution name. */
export const DIST_NAME = 'agentx-workmate'

/** Desktop application name. electron-builder productName / executableName. */
export const DESKTOP_APP_NAME = 'AgentX Workmate'

/**
 * Web presence. Not registered yet — an empty string means "no link", and
 * consumers must omit the surrounding UI rather than render a dead link.
 */
export const WEBSITE_URL = ''
export const DOCS_URL = ''

/**
 * Return the full environment variable name for a bare `name`.
 * `envName('HOME')` -> `'AGENTX_HOME'`.
 */
export const envName = (name: string): string => `${ENV_PREFIX}${name}`
