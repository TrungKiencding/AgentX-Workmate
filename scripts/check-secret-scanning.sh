#!/usr/bin/env bash
#
# Prove the secret scanner is actually looking.
#
# A scanner that has quietly stopped working — a broken config, a rule set that
# no longer loads, an allowlist that grew until it matched everything — passes
# every run and looks exactly like a clean tree. So before CI trusts a clean
# result, it plants a secret, requires gitleaks to find it, and takes it away
# again.
#
# Runs in CI (.github/workflows/lint.yml) and is worth running by hand after
# editing .gitleaks.toml:
#
#     scripts/check-secret-scanning.sh
#
# Exits non-zero, loudly, if the planted secret is NOT caught.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "error: gitleaks is not installed." >&2
  echo "  macOS: brew install gitleaks" >&2
  echo "  else:  https://github.com/gitleaks/gitleaks/releases" >&2
  exit 127
fi

# Somewhere the allowlist does not cover. Under deploy/ specifically, because
# that is the directory this whole gate exists for.
CANARY="deploy/second-brain/.secret-scanning-canary"

cleanup() {
  rm -f "$CANARY"
}
trap cleanup EXIT

# Two unmistakable shapes, not one: a token and a private key, matched by two
# different rules, so that a single rule going missing upstream cannot quietly
# retire the canary.
#
# Not an AWS key — gitleaks 8.30 does not flag a bare `AKIA…` without
# surrounding context, so a canary built on one would report this gate broken
# while the gate was fine.
#
# Assembled at runtime and deleted on exit, so the script itself is not a
# finding and the whole secret never sits on disk in one piece.
{
  printf 'token = "gh%s_%s"\n' "p" "0Fk3S3cr3tCanaryNotARealTokenAAAAAAAA"
  printf -- '-----BEGIN %s PRIVATE KEY-----\n' "RSA"
  printf 'MIIEowIBAAKCAQEAx7Qk9vZ2QmVsb25nc1RvTm9ib2R5QXRBbGxUaGlzSXNGYWtl\n'
  printf -- '-----END %s PRIVATE KEY-----\n' "RSA"
} > "$CANARY"

echo "Planted a secret at $CANARY; expecting gitleaks to find it."

if gitleaks dir --no-banner --redact --exit-code 1 "$CANARY" >/dev/null 2>&1; then
  cat >&2 <<'MESSAGE'

  SECRET SCANNING IS NOT WORKING.

  gitleaks reported a clean result for a file holding a token and a private
  key. Until this is fixed, every green run of this job means nothing.
  Likely causes, in order:

    * .gitleaks.toml no longer parses, or [extend] useDefault was turned off
    * the allowlist grew a path pattern broad enough to cover deploy/
    * gitleaks was upgraded across a breaking change in its CLI or rules

MESSAGE
  exit 1
fi

echo "Secret scanning is awake."
