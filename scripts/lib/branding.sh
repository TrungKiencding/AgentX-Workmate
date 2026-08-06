#!/usr/bin/env bash
# Single source of truth for AgentX Workmate product identity — shell side.
#
# Mirrors branding.py at the repo root. Sourced by scripts/install.sh and the
# other POSIX installers so they never hard-code the product name.
#
# tests/test_branding_consistency.py parses this file and asserts every value
# matches branding.py and apps/shared/src/branding.ts, so the three mirrors
# cannot drift.
#
# Usage:  . "$(dirname "$0")/lib/branding.sh"

# Full product name. Banner titles, installer headings.
BRAND_PRODUCT_NAME="AgentX Workmate"

# Short form for tight spaces.
BRAND_SHORT_NAME="AgentX"

# Legal entity that publishes the product.
BRAND_VENDOR_NAME="AstralX Technology"

# Where users are told to send support requests.
BRAND_SUPPORT_EMAIL="kien.le@astralx.com.vn"

# Brand glyph used as a decorative prefix.
BRAND_GLYPH="⬡"

# The command users type.
BRAND_CLI_COMMAND="agentx"

# Long-running gateway process entry point.
BRAND_GATEWAY_COMMAND="agentx-gateway"

# Agent Client Protocol adapter entry point.
BRAND_ACP_COMMAND="agentx-acp"

# Config/state directory under $HOME on POSIX.
BRAND_CONFIG_DIR_POSIX=".agentx"

# Config/state directory under %LOCALAPPDATA% on Windows.
BRAND_CONFIG_DIR_WINDOWS="agentx"

# Per-project instruction file.
BRAND_PROJECT_CONFIG_FILE=".agentx.md"

# Prefix for every environment variable the product reads or writes.
BRAND_ENV_PREFIX="AGENTX_"

# Reverse-DNS application id.
BRAND_APP_ID="com.agentx.workmate"

# Custom URL scheme the desktop app registers.
BRAND_PROTOCOL_SCHEME="agentx"

# Python distribution name.
BRAND_DIST_NAME="agentx-workmate"

# Desktop application name.
BRAND_DESKTOP_APP_NAME="AgentX Workmate"

# Web presence. Not registered yet — empty means "no link". A caller must
# omit the whole line when these are empty rather than print a dead URL.
BRAND_WEBSITE_URL=""
BRAND_DOCS_URL=""

# Canonical source repository. Install one-liners and update checks derive
# their URLs from this, so retargeting a fork is a one-line change.
BRAND_REPO_URL="https://github.com/TrungKiencding/AgentX-Workmate"
