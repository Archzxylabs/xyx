#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# XYX Delivery Preflight — read-only dual-RPC, token, artifact, and env check
# ─────────────────────────────────────────────────────────────────────────────
# This script performs ZERO writes and ZERO broadcasts.
#
# OUTPUT CONTRACT: the primary output is human-readable (PASS/FAIL/WARN lines
# per check). As a convenience it also prints one final JSON line — a status
# object carrying "status", "failures", "checks_passed", and "checks_failed" —
# so an operator can tee it into a log. That JSON is the ONLY machine-readable
# output; there are no intermediate status/reason variables. Exit code is the
# authoritative machine signal: 0 = ready for authorization, 1 = not ready.
# This script never authorizes anything: it only reports readiness.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Walk up from script dir to find project root (marked by .git or foundry.toml)
_find_project_root() {
  local dir="$1"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.git" ] || [ -f "$dir/packages/contracts/foundry.toml" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  echo ""
  return 1
}

PROJECT_ROOT="$(_find_project_root "$SCRIPT_DIR")"
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

# .env.example documents XYX_RPC_URL / XYX_PRIMARY_RPC_URL / XYX_SECONDARY_RPC_URL
# as the operator-facing names, so those are accepted here as fallbacks. A
# silently unset endpoint would otherwise look like a typo in MONAD_RPC_URL_*
# when the operator had in fact followed the documented configuration.
PRIMARY_RPC="${MONAD_RPC_URL_PRIMARY:-${XYX_RPC_URL:-${XYX_PRIMARY_RPC_URL:-}}}"
SECONDARY_RPC="${MONAD_RPC_URL_SECONDARY:-${XYX_SECONDARY_RPC_URL:-}}"
TOKEN="${MONAD_USDC_ADDRESS:-${XYX_PAYMENT_TOKEN_ADDRESS:-}}"
# DeployXYXDelivery.s.sol broadcasts with `--account deployer-keystore`, so the
# funding address is a keystore account whose key never enters this script or
# the environment. Its address is therefore supplied explicitly rather than
# derived from key material. Empty means "not configured": the probe below
# reports that as a blocker instead of skipping the check silently, because an
# unfunded deployer fails only after gas and a broadcast have already been paid.
FUNDER="${XYX_DEPLOY_FUNDER_ADDRESS:-}"
RP_ID="${XYX_RP_ID:-}"
VERDICT_LIFETIME="${VERDICT_LIFETIME:-}"
EXPECTED_COMMIT="${DEPLOY_COMMIT:-}"
EXPECTED_CHAIN="10143"
# DeployXYXDelivery.s.sol hard-requires a 6-decimal token (TOKEN_WRONG_DECIMALS),
# so preflight must refuse an 18-decimal one rather than discovering it on-chain.
EXPECTED_TOKEN_DECIMALS="6"

if [ -t 1 ]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
else
  BOLD=''; GREEN=''; RED=''; YELLOW=''; NC=''
fi

CHECKS_PASSED=0
CHECKS_FAILED=0
declare -a FAILURES=()

section() { echo -e "\n${BOLD}══ $1 ══${NC}"; }
pass() { echo -e "  ${GREEN}PASS${NC}  $1"; CHECKS_PASSED=$((CHECKS_PASSED + 1)); }
fail() { echo -e "  ${RED}FAIL${NC}  $1"; CHECKS_FAILED=$((CHECKS_FAILED + 1)); FAILURES+=("$1"); }
warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; }

is_secret_name() {
  local name="${1:-}"
  echo "$name" | grep -qiE 'key|secret|mnemonic|seed|prf|password|credential|api.key|rpc.secret|private' && return 0 || return 1
}

# Strip anything from a value that could carry a credential: an embedded
# `user:password@host` userinfo block, a query string, and a fragment. A name
# policy alone cannot catch these — `MONAD_RPC_URL_SECONDARY` does not read like
# a secret name, yet `https://user:TOKEN@node.example.com/rpc` most certainly is.
# Only scheme://host/path survives.
redact_value() {
  local v="${1:-}"
  [ -z "$v" ] && { printf ''; return 0; }
  case "$v" in
    *://*)
      local stripped="${v%%\?*}"; stripped="${stripped%%#*}"
      local scheme="" rest="$stripped"
      case "$stripped" in
        *://*) scheme="${stripped%%://*}://"; rest="${stripped#*://}" ;;
      esac
      local authority="${rest%%[/?]*}" tail=""
      case "$rest" in *[/?]*) tail="${rest#"$authority"}" ;; esac
      if [ "$authority" != "${authority%@*}" ] || [ "$authority" != "${authority##*@}" ]; then
        authority="[REDACTED-AUTHORITY]@${authority##*@}"
      fi
      local suffix=""
      case "$v" in *\?*|*#*) suffix='?[REDACTED]' ;; esac
      printf '%s%s%s%s' "$scheme" "$authority" "$tail" "$suffix"
      ;;
    *)
      printf '%s' "$v"
      ;;
  esac
}

safe_env() {
  local name="$1"
  local val="${!name:-}"
  if is_secret_name "$name"; then
    echo "  $name = (present — value not printed per secret-name policy)"
  elif [ -z "$val" ]; then
    echo "  $name = (unset)"
  else
    echo "  $name = $(redact_value "$val")"
  fi
}

# Decode a 32-byte ABI word (0x-prefixed hex) into its decimal value.
# `cast --to-dec` is arbitrary precision, so a token returning a huge uint
# cannot silently wrap the way bash arithmetic would.
#
# The input must be exactly `0x` followed by 64 hexadecimal characters. A
# truncated word, a padded/longer word, an empty value, a multi-word response,
# or anything with non-hex characters is a decode failure (empty output), not a
# value to be coerced: a tolerant decoder would turn a malformed RPC response
# into a decimals figure that was never reported by the token.
hex_word_to_dec() {
  local word="${1:-}"
  case "$word" in
    0x|0X) echo "" ; return 0 ;;
  esac
  local body="${word#0x}"
  body="${body#0X}"
  # Reject short words, long words, and embedded whitespace / multiword replies.
  if [ "${#body}" -ne 64 ]; then
    echo ""
    return 0
  fi
  case "$body" in
    ""|*[!0-9a-fA-F]*) echo "" ; return 0 ;;
  esac
  # `cast` can exit 0 while printing something that is not a number; a value
  # that is not a plain decimal integer must never reach a numeric comparison
  # or a JSON number field.
  local dec
  dec=$(cast --to-dec "0x$body" 2>/dev/null || echo "")
  case "$dec" in
    ""|*[!0-9]*) echo "" ;;
    *) echo "$dec" ;;
  esac
}

# Decode an ABI-encoded `string` return value into its UTF-8 text.
#
# `cast call "symbol()"` on a token that does not implement symbol() prints a
# revert reason; on a contract that returns a bare uint it prints a lone 32-byte
# word. Both are non-empty strings that pass a naive `[ -n … ]` test, so they
# would be reported as "Token symbol: <revert reason>" and compared across RPCs
# as though the token had reported a name. The decode below is therefore strict
# on the ABI layout — an offset word (0x20), a length word in [1, 32], and
# exactly that many bytes of right-padded data — and accepts no other shape.
abi_word_to_string() {
  local raw="${1:-}"
  local body="${raw#0x}"
  body="${body#0X}"
  # Must be exactly offset + length + one data word.
  if [ "${#body}" -ne 192 ]; then
    echo ""
    return 0
  fi
  case "$body" in
    ""|*[!0-9a-fA-F]*) echo ""
    return 0
    ;;
  esac
  # A dynamic type is head-encoded as an offset to its tail; an offset other
  # than 0x20 is not the shape `cast` produces for a single string return.
  if [ "${body:0:64}" != "0000000000000000000000000000000000000000000000000000000000000020" ]; then
    echo ""
    return 0
  fi
  local data_hex="${body:128:64}"
  local len_dec
  len_dec=$(hex_word_to_dec "0x${body:64:64}")
  # A zero-length or absurd length means this is not a `string` return: a
  # contract returning a bare word, or an abi.encode of something else.
  case "$len_dec" in
    ""|*[!0-9]*) echo "" ; return 0 ;;
  esac
  # A length word whose decimal form is wider than two digits cannot be in
  # [1,32]. Comparing it numerically would make the shell print "integer
  # expected" and return error status — which under `set -e` aborts the whole
  # preflight instead of rejecting this one field.
  if [ "${#len_dec}" -gt 2 ]; then
    echo ""
    return 0
  fi
  if [ "$len_dec" -lt 1 ] || [ "$len_dec" -gt 32 ]; then
    echo ""
    return 0
  fi
  # Only printable ASCII is accepted. Every byte of the string is validated
  # here, so the value cannot smuggle a control character (or an escape that
  # `printf %b` would later expand) into a log line or the JSON status output.
  local out="" i byte
  for (( i=0; i<len_dec; i++ )); do
    byte="${data_hex:$(( i * 2 )):2}"
    case "$byte" in
      2[1-9a-f]|3[0-9a-f]|4[0-9a-f]|5[0-9a-f]|6[0-9a-f]|7[0-9a-e]) ;;
      *) echo "" ; return 0 ;;
    esac
    out+="\\x$byte"
  done
  printf '%b' "$out"
}

# ── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     XYX Delivery Protocol — Monad Testnet Preflight      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"

# ── Section 1: Required Commands ─────────────────────────────────────────────
section "1. Required Commands"
COMMAND_OK=true

for cmd in bash forge cast jq node sha256sum; do
  if command -v "$cmd" >/dev/null 2>&1; then
    case "$cmd" in
      forge) version=$(forge --version 2>/dev/null | head -1 || echo "unknown") ;;
      cast)  version=$(cast --version 2>/dev/null | head -1 || echo "unknown") ;;
      *)     version=$($cmd --version 2>/dev/null | head -1 || echo "unknown") ;;
    esac
    pass "$cmd: $version"
  else
    fail "$cmd: not found"
    COMMAND_OK=false
  fi
done

# ── Section 2: RPC Configuration ─────────────────────────────────────────────
section "2. RPC Configuration"

is_http_url() {
  echo "${1:-}" | grep -qiE '^https?://'
}

# Reject a URL carrying credentials in its authority. `redact_url` in
# verify-xyx-delivery.sh strips userinfo purely so it never reaches a log, but
# HERE the endpoint is an input that must be rejected outright: an operator
# who embedded a token in `https://user:token@host/path` would otherwise be
# told the config is valid while the token rides into every diagnostic this
# script prints.
has_embedded_credentials() {
  local u="${1:-}"
  local scheme_stripped="${u#*://}"
  case "$u" in
    *://*) scheme_stripped="${u#*://}" ;;
    *) scheme_stripped="$u" ;;
  esac
  local authority="${scheme_stripped%%[/?#]*}"
  case "$authority" in
    *@*) return 0 ;;
  esac
  return 1
}

# Normalise an endpoint for ENDPOINT-IDENTITY comparison only.
#
# Two strings that differ only by a trailing slash, differing case in the
# scheme/host, a `?query=...` fragment, or a `#fragment` resolve to the same
# JSON-RPC service. Comparing raw strings therefore reports "distinct" for what
# is really one endpoint, and dual-RPC agreement becomes a single node agreeing
# with itself — which is exactly the failure this check exists to prevent.
#
# This function is used ONLY to decide whether the two configured endpoints
# name the same service. The normalised form is never logged, never used for a
# network call, and never written to output: the real endpoints are.
canonical_endpoint() {
  local u="${1:-}"
  local without_fragment="${u%%#*}"
  local without_query="${without_fragment%%\?*}"
  local lower
  lower=$(printf '%s' "$without_query" | tr '[:upper:]' '[:lower:]')
  # Strip every trailing slash so "…/rpc" == "…/rpc/".
  while [ "${lower}" != "${lower%/}" ]; do
    lower="${lower%/}"
  done
  printf '%s' "$lower"
}

safe_env "MONAD_RPC_URL_PRIMARY"
if [ -z "$PRIMARY_RPC" ]; then fail "MONAD_RPC_URL_PRIMARY is not set"; elif ! is_http_url "$PRIMARY_RPC"; then fail "MONAD_RPC_URL_PRIMARY is not a valid http(s) URL"; elif has_embedded_credentials "$PRIMARY_RPC"; then fail "MONAD_RPC_URL_PRIMARY must not embed credentials in the URL (supply auth via header/middleware, not userinfo)"; else pass "MONAD_RPC_URL_PRIMARY is a valid URL"; fi

safe_env "MONAD_RPC_URL_SECONDARY"
if [ -z "$SECONDARY_RPC" ]; then fail "MONAD_RPC_URL_SECONDARY is not set"; elif ! is_http_url "$SECONDARY_RPC"; then fail "MONAD_RPC_URL_SECONDARY is not a valid http(s) URL"; elif has_embedded_credentials "$SECONDARY_RPC"; then fail "MONAD_RPC_URL_SECONDARY must not embed credentials in the URL (supply auth via header/middleware, not userinfo)"; else pass "MONAD_RPC_URL_SECONDARY is a valid URL"; fi

if [ -n "$PRIMARY_RPC" ] && [ -n "$SECONDARY_RPC" ]; then
  canonical_primary="$(canonical_endpoint "$PRIMARY_RPC")"
  canonical_secondary="$(canonical_endpoint "$SECONDARY_RPC")"
  if [ "$canonical_primary" = "$canonical_secondary" ]; then
    fail "Primary and secondary RPC URLs resolve to the same endpoint after normalisation (dual-RPC agreement would be one node agreeing with itself)"
  else
    pass "Primary and secondary RPC URLs are endpoints that resolve differently"
  fi
fi

# ── Section 3: Chain ID Verification ─────────────────────────────────────────
section "3. Chain ID Verification"

CHAIN_OK=false

if [ -n "$PRIMARY_RPC" ] && [ "$COMMAND_OK" = true ]; then
  primary_chain=$(cast chain-id --rpc-url "$PRIMARY_RPC" 2>/dev/null || echo "")
  if [ -n "$primary_chain" ]; then
    pass "Primary RPC chain ID: $primary_chain (expected $EXPECTED_CHAIN)"
    if [ "$primary_chain" = "$EXPECTED_CHAIN" ]; then
      pass "Primary RPC matches expected chain ID"
    else
      fail "Primary RPC returned chain ID $primary_chain, expected $EXPECTED_CHAIN"
    fi
  else
    fail "Primary RPC unreachable or returned no chain ID"
  fi
else
  fail "Primary RPC unreachable or returned no chain ID"
fi

if [ -n "$SECONDARY_RPC" ] && [ "$COMMAND_OK" = true ]; then
  secondary_chain=$(cast chain-id --rpc-url "$SECONDARY_RPC" 2>/dev/null || echo "")
  if [ -n "$secondary_chain" ]; then
    pass "Secondary RPC chain ID: $secondary_chain (expected $EXPECTED_CHAIN)"
    if [ "$secondary_chain" = "$EXPECTED_CHAIN" ]; then
      pass "Secondary RPC matches expected chain ID"
    else
      fail "Secondary RPC returned chain ID $secondary_chain, expected $EXPECTED_CHAIN"
    fi
  else
    fail "Secondary RPC unreachable or returned no chain ID"
  fi
else
  fail "Secondary RPC unreachable or returned no chain ID"
fi

if [ -n "${primary_chain:-}" ] && [ -n "${secondary_chain:-}" ]; then
  if [ "$primary_chain" = "$secondary_chain" ]; then
    pass "Both RPCs agree on chain ID $primary_chain"
    CHAIN_OK=true
  else
    fail "RPC chain ID mismatch: primary=$primary_chain, secondary=$secondary_chain"
  fi
fi

# ── Section 4: Token Identity ────────────────────────────────────────────────
section "4. Token Identity"

safe_env "MONAD_USDC_ADDRESS"
if [ -z "$TOKEN" ]; then
  fail "MONAD_USDC_ADDRESS is not set"
elif ! echo "$TOKEN" | grep -qiE '^0x[0-9a-fA-F]{40}$'; then
  fail "MONAD_USDC_ADDRESS is not a valid address format"
else
  pass "MONAD_USDC_ADDRESS is a valid address format"
fi

if [ "$CHAIN_OK" = true ] && [ "$COMMAND_OK" = true ] && [ -n "$TOKEN" ]; then
  # Check token bytecode on primary
  token_code_primary=$(cast code "$TOKEN" --rpc-url "$PRIMARY_RPC" 2>/dev/null || echo "")
  if [ -n "$token_code_primary" ] && [ "$token_code_primary" != "0x" ]; then
    pass "[PRIMARY] Token has bytecode (${#token_code_primary} chars)"
  else
    fail "[PRIMARY] Token has no bytecode at $TOKEN"
  fi

  # Check token bytecode on secondary
  token_code_secondary=$(cast code "$TOKEN" --rpc-url "$SECONDARY_RPC" 2>/dev/null || echo "")
  if [ -n "$token_code_secondary" ] && [ "$token_code_secondary" != "0x" ]; then
    pass "[SECONDARY] Token has bytecode (${#token_code_secondary} chars)"
  else
    fail "[SECONDARY] Token has no bytecode at $TOKEN"
  fi

  if [ -n "$token_code_primary" ] && [ -n "$token_code_secondary" ]; then
    if [ "$token_code_primary" = "$token_code_secondary" ]; then
      pass "Both RPCs return identical token bytecode"
    else
      fail "Token bytecode mismatch between RPCs"
    fi
  fi

  # Read token symbol and decimals via low-level calls. The symbol is decoded
  # strictly as an ABI `string`: `cast call` prints a revert reason for a token
  # without symbol(), and a single bare word for a token returning something
  # else. Both are non-empty and would otherwise be reported as a symbol and
  # then compared across RPCs as though the token had named itself.
  token_symbol_raw_primary=$(cast call "$TOKEN" "symbol()" --rpc-url "$PRIMARY_RPC" 2>/dev/null || echo "")
  token_symbol_primary=$(abi_word_to_string "$token_symbol_raw_primary")
  if [ -n "$token_symbol_primary" ]; then
    pass "[PRIMARY] Token symbol: $token_symbol_primary"
  elif [ -z "$token_symbol_raw_primary" ]; then
    fail "[PRIMARY] Token symbol() call failed"
  else
    fail "[PRIMARY] Token symbol() did not decode as an ABI string"
  fi

  token_decimals_primary_raw=$(cast call "$TOKEN" "decimals()" --rpc-url "$PRIMARY_RPC" 2>/dev/null || echo "")
  token_decimals_primary=$(hex_word_to_dec "$token_decimals_primary_raw")
  if [ -z "$token_decimals_primary" ]; then
    fail "[PRIMARY] Token decimals() read failed or returned a non-integer word"
  elif [ "$token_decimals_primary" = "$EXPECTED_TOKEN_DECIMALS" ]; then
    pass "[PRIMARY] Token decimals: $token_decimals_primary (expected $EXPECTED_TOKEN_DECIMALS)"
  else
    fail "[PRIMARY] TOKEN_WRONG_DECIMALS: token reports $token_decimals_primary decimals, DeployXYXDelivery requires $EXPECTED_TOKEN_DECIMALS"
  fi

  token_symbol_raw_secondary=$(cast call "$TOKEN" "symbol()" --rpc-url "$SECONDARY_RPC" 2>/dev/null || echo "")
  token_symbol_secondary=$(abi_word_to_string "$token_symbol_raw_secondary")
  if [ -n "$token_symbol_secondary" ]; then
    pass "[SECONDARY] Token symbol: $token_symbol_secondary"
  elif [ -z "$token_symbol_raw_secondary" ]; then
    fail "[SECONDARY] Token symbol() call failed"
  else
    fail "[SECONDARY] Token symbol() did not decode as an ABI string"
  fi

  token_decimals_secondary_raw=$(cast call "$TOKEN" "decimals()" --rpc-url "$SECONDARY_RPC" 2>/dev/null || echo "")
  token_decimals_secondary=$(hex_word_to_dec "$token_decimals_secondary_raw")
  if [ -z "$token_decimals_secondary" ]; then
    fail "[SECONDARY] Token decimals() read failed or returned a non-integer word"
  elif [ "$token_decimals_secondary" = "$EXPECTED_TOKEN_DECIMALS" ]; then
    pass "[SECONDARY] Token decimals: $token_decimals_secondary (expected $EXPECTED_TOKEN_DECIMALS)"
  else
    fail "[SECONDARY] TOKEN_WRONG_DECIMALS: token reports $token_decimals_secondary decimals, DeployXYXDelivery requires $EXPECTED_TOKEN_DECIMALS"
  fi

  if [ -n "$token_symbol_primary" ] && [ -n "$token_symbol_secondary" ]; then
    if [ "$token_symbol_primary" = "$token_symbol_secondary" ]; then
      pass "Both RPCs agree on token symbol"
    else
      fail "Token symbol mismatch: primary=$token_symbol_primary, secondary=$token_symbol_secondary"
    fi
  fi

  if [ -n "$token_decimals_primary" ] && [ -n "$token_decimals_secondary" ]; then
    if [ "$token_decimals_primary" = "$token_decimals_secondary" ]; then
      pass "Both RPCs agree on token decimals: $token_decimals_primary"
    else
      fail "Token decimals mismatch between RPCs: primary=$token_decimals_primary, secondary=$token_decimals_secondary"
    fi
  fi

  # Funder token balance. The funder is the keystore account that will pay gas
  # and seed the protocol, so an empty or zero balance is a hard blocker rather
  # than a warning — the deployment would fail after gas has been spent. The
  # balance is decoded through the same 32-byte-word guard as decimals() so a
  # revert reason or a malformed return cannot be read as a number.
  if [ -z "$FUNDER" ]; then
    fail "XYX_DEPLOY_FUNDER_ADDRESS is not set: cannot verify the deploying account holds the payment token"
  elif ! echo "$FUNDER" | grep -qiE '^0x[0-9a-fA-F]{40}$'; then
    fail "XYX_DEPLOY_FUNDER_ADDRESS is not a valid address format"
  else
    funder_bal_primary_raw=$(cast call "$TOKEN" "balanceOf(address)" "$FUNDER" --rpc-url "$PRIMARY_RPC" 2>/dev/null || echo "")
    funder_bal_primary=$(hex_word_to_dec "$funder_bal_primary_raw")
    if [ -z "$funder_bal_primary" ]; then
      fail "[PRIMARY] balanceOf(funder) failed or returned a non-integer word"
    elif [ "$funder_bal_primary" = "0" ]; then
      fail "[PRIMARY] DEPLOY_FUNDER_UNFUNDED: funder $FUNDER holds 0 of the payment token"
    else
      pass "[PRIMARY] Funder token balance: $funder_bal_primary"
    fi

    funder_bal_secondary_raw=$(cast call "$TOKEN" "balanceOf(address)" "$FUNDER" --rpc-url "$SECONDARY_RPC" 2>/dev/null || echo "")
    funder_bal_secondary=$(hex_word_to_dec "$funder_bal_secondary_raw")
    if [ -z "$funder_bal_secondary" ]; then
      fail "[SECONDARY] balanceOf(funder) failed or returned a non-integer word"
    elif [ "$funder_bal_secondary" = "0" ]; then
      fail "[SECONDARY] DEPLOY_FUNDER_UNFUNDED: funder $FUNDER holds 0 of the payment token"
    else
      pass "[SECONDARY] Funder token balance: $funder_bal_secondary"
    fi

    if [ -n "$funder_bal_primary" ] && [ -n "$funder_bal_secondary" ]; then
      if [ "$funder_bal_primary" = "$funder_bal_secondary" ]; then
        pass "Both RPCs agree on the funder token balance"
      else
        fail "Funder token balance mismatch between RPCs: primary=$funder_bal_primary, secondary=$funder_bal_secondary"
      fi
    fi
  fi
fi

# ── Section 5: RP ID and Hash ────────────────────────────────────────────────
section "5. RP ID and Hash"

if [ -z "$RP_ID" ]; then
  fail "XYX_RP_ID is not set"
else
  pass "XYX_RP_ID is set: $RP_ID"
  if echo "$RP_ID" | grep -qiE '[/:\\]'; then
    fail "XYX_RP_ID must be host-only (no /, :, or \\)"
  else
    pass "XYX_RP_ID is host-only: $RP_ID"
  fi

  rp_hash=$(echo -n "$RP_ID" | sha256sum | awk '{print $1}')
  rp_hash="0x$rp_hash"
  pass "XYX_RP_ID SHA-256: $rp_hash"

  if [ "${#rp_hash}" -ne 66 ] || ! echo "$rp_hash" | grep -qiE '^0x[0-9a-f]{64}$'; then
    fail "RP ID hash is not a valid bytes32"
  else
    pass "RP ID hash is valid bytes32"
  fi
fi

# ── Section 6: Verdict Lifetime ──────────────────────────────────────────────
section "6. Verdict Lifetime"

if [ -z "$VERDICT_LIFETIME" ]; then
  fail "VERDICT_LIFETIME is not set"
elif ! echo "$VERDICT_LIFETIME" | grep -qiE '^[0-9]+$'; then
  fail "VERDICT_LIFETIME is not a positive integer"
elif [ "$VERDICT_LIFETIME" -lt 1 ]; then
  fail "VERDICT_LIFETIME must be positive"
else
  pass "VERDICT_LIFETIME is a positive integer: $VERDICT_LIFETIME"
  uint64_max=18446744073709551615
  if [ "$VERDICT_LIFETIME" -gt "$uint64_max" ]; then
    fail "VERDICT_LIFETIME exceeds uint64 max"
  else
    pass "VERDICT_LIFETIME fits in uint64"
  fi
fi

# ── Section 7: Expected Commit ──────────────────────────────────────────────
section "7. Expected Commit"

if [ -z "$EXPECTED_COMMIT" ]; then
  fail "DEPLOY_COMMIT is not set"
elif ! echo "$EXPECTED_COMMIT" | grep -qiE '^[0-9a-f]{40}$'; then
  fail "DEPLOY_COMMIT is not a valid 40-char hex commit"
else
  pass "DEPLOY_COMMIT is a valid 40-char hex: $EXPECTED_COMMIT"
  if [ -d "$PROJECT_ROOT/.git" ]; then
    resolved=$(git -C "$PROJECT_ROOT" rev-parse "$EXPECTED_COMMIT" 2>/dev/null || echo "")
    if [ -n "$resolved" ]; then
      pass "DEPLOY_COMMIT resolves to an existing commit"
    else
      fail "DEPLOY_COMMIT does not resolve to an existing commit"
    fi
  fi
fi

# ── Section 8: Compiled Artifacts ────────────────────────────────────────────
section "8. Compiled Artifacts"

ARTIFACT_DIR="$PROJECT_ROOT/packages/contracts/out"

if [ ! -d "$ARTIFACT_DIR" ]; then
  fail "Artifact directory not found: $ARTIFACT_DIR (run 'forge build' first)"
else
  pass "Artifact directory exists: $ARTIFACT_DIR"

  # Foundry writes out/<File>.sol/<Contract>.json — one directory per source
  # file, not one flat file per contract. The flat path can never match, so
  # the artifact gate would fail even after a clean build.
  for artifact in MonadP256Verifier XYXPasskeyRegistry XYXDeliveryProtocol; do
    artifact_path=$(find "$ARTIFACT_DIR" -type f -path "*/${artifact}.sol/${artifact}.json" -print -quit 2>/dev/null)
    if [ -n "$artifact_path" ]; then
      # Also confirm the artifact declares the expected contract name and
      # carries non-empty creation bytecode, so a stale artifact with the
      # right path but empty bytecode cannot pass the gate.
      contract_name=$(node -e '
        const fs = require("fs");
        try {
          const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          process.stdout.write(a.contractName || "");
        } catch { process.stdout.write(""); }
      ' "$artifact_path" 2>/dev/null)
      bytecode_len=$(node -e '
        const fs = require("fs");
        try {
          const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const b = a.bytecode && a.bytecode.object ? a.bytecode.object : "";
          process.stdout.write(String(Math.max(0, Math.floor((b.length - 2) / 2))));
        } catch { process.stdout.write("0"); }
      ' "$artifact_path" 2>/dev/null)

      if [ "$contract_name" != "$artifact" ]; then
        fail "Artifact contract name mismatch: $artifact_path declares '$contract_name', expected '$artifact'"
      elif [ "${bytecode_len:-0}" -eq 0 ]; then
        fail "Artifact has empty creation bytecode: $artifact_path"
      else
        pass "Artifact found: $artifact (${bytecode_len} bytes of creation bytecode)"
      fi
    else
      fail "Artifact not found: $ARTIFACT_DIR/*/${artifact}.sol/${artifact}.json"
    fi
  done
fi

# ── Section 9: Foundry Configuration ─────────────────────────────────────────
section "9. Foundry Configuration"

FOUNDRY_TOML="$PROJECT_ROOT/packages/contracts/foundry.toml"

if [ ! -f "$FOUNDRY_TOML" ]; then
  fail "foundry.toml not found at $FOUNDRY_TOML"
else
  pass "foundry.toml found at $FOUNDRY_TOML"

  chain_id=$(grep -E '^\s*chain_id\s*=' "$FOUNDRY_TOML" | head -1 | sed 's/.*=\s*//' | tr -d '"' | tr -d "'" | tr -d ' ')
  if [ "$chain_id" = "10143" ]; then
    pass "foundry.toml chain_id is 10143"
  else
    fail "foundry.toml chain_id is '$chain_id', expected 10143"
  fi

  network=$(grep -E '^\s*network\s*=' "$FOUNDRY_TOML" | head -1 | sed 's/.*=\s*//' | tr -d '"' | tr -d "'" | tr -d ' ')
  if [ "$network" = "monad" ]; then
    pass "foundry.toml network is monad"
  else
    fail "foundry.toml network is '$network', expected monad"
  fi
fi

# ── Section 10: Environment Secret Scan ──────────────────────────────────────
section "10. Environment Secret Scan"
SECRET_COUNT=0
declare -a SECRET_VARS=()

while IFS='=' read -r name val; do
  name_only="${name%%:*}"
  if is_secret_name "$name_only"; then
    SECRET_COUNT=$((SECRET_COUNT + 1))
    SECRET_VARS+=("$name_only")
  fi
done < <(env)

if [ "$SECRET_COUNT" -eq 0 ]; then
  pass "No secret-named environment variables detected"
else
  warn "$SECRET_COUNT secret-named env vars detected (values not printed): ${SECRET_VARS[*]}"
fi

# ── Section 11: Source Cleanliness ──────────────────────────────────────────
section "11. Source Cleanliness"

if [ -d "$PROJECT_ROOT/.git" ]; then
  # Count uncommitted non-doc files. `grep -c` prints a count on stdout, but it
  # also exits 1 when it matched nothing, and under `set -e` that exit would
  # kill the script before the count is read. Capturing it with `|| true` keeps
  # the count (which is 0) instead of the `echo 0` fallback that previously
  # produced "0\n0" — a value no shell comparison accepts, which made the
  # check report PASS for every working tree, dirty or clean.
  dirty=$(git -C "$PROJECT_ROOT" diff --name-only 2>/dev/null | grep -vE '\.md$' | grep -c '' || true)
  case "$dirty" in
    ''|*[!0-9]*) dirty=0 ;;
  esac
  if [ "$dirty" -gt 0 ]; then
    warn "$dirty non-doc files have uncommitted changes"
  else
    pass "No uncommitted non-doc changes"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Preflight Results"
echo "═══════════════════════════════════════════════════════════"
echo "  Checks passed: $CHECKS_PASSED"
echo "  Checks failed: $CHECKS_FAILED"

if [ "$CHECKS_FAILED" -gt 0 ]; then
  echo ""
  echo "  Failures:"
  for f in "${FAILURES[@]}"; do
    echo "    • $f"
  done
  echo ""
  echo "Status: NOT_READY"
  echo ""
  echo "Required before proceeding:"
  echo "  1. Confirm chain ID 10143 from both configured RPCs"
  echo "  2. Set MONAD_RPC_URL_PRIMARY and MONAD_RPC_URL_SECONDARY (distinct)"
  echo "  3. Confirm payment token address and identity (USDC, 6 decimals)"
  echo "  4. Set XYX_DEPLOY_FUNDER_ADDRESS to the deploying keystore account's address, holding a non-zero payment-token balance visible on both RPCs"
  echo "  5. Set XYX_RP_ID to host-only HTTPS RP ID"
  echo "  6. Set VERDICT_LIFETIME (positive uint64 seconds)"
  echo "  7. Set DEPLOY_COMMIT to actual git commit"
  echo "  8. Run 'forge build' to generate artifacts"

  # Machine-readable JSON
  failures_json=$(printf '%s\n' "${FAILURES[@]}" | jq -R . | jq -s .)
  echo ""
  echo "Machine-readable status:"
  echo "{\"status\":\"NOT_READY\",\"failures\":$failures_json,\"checks_passed\":$CHECKS_PASSED,\"checks_failed\":$CHECKS_FAILED}"
  exit 1
else
  echo ""
  echo "Status: READY"
  echo ""
  echo "All preflight checks passed. Environment is ready for deployment."
  echo "Next step: obtain explicit broadcast authorization before running DeployXYXDelivery.s.sol"

  echo ""
  echo "Machine-readable status:"
  echo "{\"status\":\"ready_for_authorization\",\"checks_passed\":$CHECKS_PASSED,\"checks_failed\":0}"
  exit 0
fi
