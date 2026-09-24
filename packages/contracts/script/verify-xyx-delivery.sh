#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# XYX Delivery Source Verification — submit explicit verification for
#             MonadP256Verifier, XYXPasskeyRegistry, XYXDeliveryProtocol
# ─────────────────────────────────────────────────────────────────────────────
# This script does NOT treat a reachable explorer page, a queued submission, a
# HTTP 200, a local artifact, or a successful exit code as verification.
#
# A contract is reported VERIFIED only after a POSITIVE TERMINAL tool response
# from the verification route itself. "Verification submitted", "in queue",
# "pending", an explorer URL, or an HTTP success is reported as `unverified`,
# never as VERIFIED.
#
# `forge verify-contract` is invoked EXACTLY ONCE per contract per execution of
# this script. Re-submitting a contract on a timer to "poll" would manufacture
# one acknowledgement per attempt and let a single positive response out of N
# look like convergence. Retrying is a human re-run, and every run is reported
# and counted separately (see the `verificationCommandInvocations` field in the
# JSON result).
#
# Default Testnet route is Sourcify (MonadVision), which requires NO API key:
#   forge verify-contract --root packages/contracts <address> <fully-qualified-name> \
#     --chain 10143 --verifier sourcify \
#     --verifier-url https://sourcify-api-monad.blockvision.org/
#
# The Etherscan / Monadscan route is EXPLICITLY OPT-IN and is the only route
# that needs a key. Set MONAD_VERIFY_ROUTE=etherscan and MONAD_EXPLORER_API_KEY
# to use it.
#
# Usage: ./verify-xyx-delivery.sh <verifier_address> <registry_address> <protocol_address>
# Requires: cast, forge, jq
#
# Environment:
#   MONAD_RPC_URL_PRIMARY      Primary RPC endpoint (required)
#   MONAD_RPC_URL_SECONDARY    A second, DISTINCT RPC endpoint (required)
#   MONAD_VERIFY_ROUTE         `sourcify` (default) or `etherscan` (explicit opt-in)
#   MONAD_SOURCIFY_VERIFIER_URL  Sourcify verifier endpoint (default: MonadVision)
#   MONAD_EXPLORER_API_KEY     Required ONLY for the etherscan route
#   MONAD_VERIFY_TIMEOUT       ACCEPTED BUT NO LONGER USED — this script makes one
#                              verify-contract call per contract per execution and
#                              never re-submits as a poll, so there is no polling
#                              window to bound. Retrying is a separate run.
#   MONAD_VERIFY_POLL_INTERVAL ACCEPTED BUT NO LONGER USED — see above. The
#                              etherscan route uses forge's own documented
#                              `--watch`, which waits on forge's single submission.
#   MONAD_EXPLORER_URL         Explorer base URL (informational only)
#   VERIFY_OUT                 Optional path for a machine-readable JSON result
#                              consumed by record-xyx-delivery-provenance.sh
#
# Exit codes: 0 = all three VERIFIED, 1 = any contract unverified or failed,
#             2 = invalid arguments or route configuration.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This script lives at packages/contracts/script, so the repository root is THREE
# levels up. Derived from SCRIPT_DIR rather than $PWD so the forge invocation below
# is identical from every working directory.
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Canonical Foundry root. The repository root is NOT a Foundry project root: the
# only foundry.toml lives in packages/contracts, so `forge verify-contract` run
# from the repo root resolves no project at all and cannot be pointed at these
# three sources. Passing --root explicitly makes the route both correct and
# identical from every working directory. Derived from SCRIPT_DIR, not $PWD.
CONTRACTS_ROOT="${PROJECT_ROOT}/packages/contracts"

EXPECTED_CHAIN="10143"
DEFAULT_SOURCIFY_VERIFIER_URL="https://sourcify-api-monad.blockvision.org/"

# ── Argument validation ──────────────────────────────────────────────────────
usage() {
  echo "Usage: $0 <verifier> <registry> <protocol>" >&2
}

if [ "$#" -ne 3 ]; then
  echo "ERROR: expected 3 arguments, got $#" >&2
  usage
  exit 2
fi

VERIFIER="${1:-}"
REGISTRY="${2:-}"
PROTOCOL="${3:-}"

ADDR_RE='^0x[0-9a-fA-F]{40}$'

arg_error=""
for pair in "verifier address:$VERIFIER" "registry address:$REGISTRY" "protocol address:$PROTOCOL"; do
  IFS=':' read -r label value <<< "$pair"
  if ! printf '%s' "$value" | grep -qE "$ADDR_RE"; then
    arg_error="${arg_error}${arg_error:+; }invalid $label"
  fi
done

if [ -n "$arg_error" ]; then
  echo "ERROR: $arg_error" >&2
  usage
  exit 2
fi

# ── Configuration ────────────────────────────────────────────────────────────
PRIMARY_RPC="${MONAD_RPC_URL_PRIMARY:-}"
SECONDARY_RPC="${MONAD_RPC_URL_SECONDARY:-}"
ROUTE="${MONAD_VERIFY_ROUTE:-sourcify}"
SOURCIFY_URL="${MONAD_SOURCIFY_VERIFIER_URL:-$DEFAULT_SOURCIFY_VERIFIER_URL}"
API_KEY="${MONAD_EXPLORER_API_KEY:-}"
EXPLORER="${MONAD_EXPLORER_URL:-}"
OUT="${VERIFY_OUT:-}"

if [ -t 1 ]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
else
  BOLD=''; GREEN=''; RED=''; YELLOW=''; NC=''
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
section() { echo -e ""; echo -e "${BOLD}── $1 ──${NC}"; }
pass() { echo -e "  ${GREEN}PASS${NC}  $1"; }
fail() { echo -e "  ${RED}FAIL${NC}  $1" >&2; }
warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; }

# Serialize the shell array of binding-failure reasons as a JSON array. Returns
# `[]` for an empty list, so a successful binding check serializes as
# `failures: []` rather than as an absent key.
json_string_array() {
  if [ "$#" -eq 0 ]; then
    printf '[]'
    return 0
  fi
  printf '%s\n' "$@" | jq -R . | jq -s .
}

lower() { printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'; }

redact_url() {
  local u="${1:-}"
  if [ -z "$u" ]; then
    printf ''
    return 0
  fi
  local stripped="${u%%\?*}"
  stripped="${stripped%%#*}"
  # Credentials can also travel in the userinfo component of the authority
  # (`https://user:password@host/path`), which carries no `?` or `#` and so was
  # previously redacted by nothing at all — it reached this function's output
  # verbatim, and that output is echoed and written to the machine-readable
  # JSON. Strip everything up to and including the LAST `@` in the authority,
  # so only the host (and any path) survives.
  local scheme="" rest="$stripped"
  case "$stripped" in
    *://*)
      scheme="${stripped%%://*}://"
      rest="${stripped#*://}"
      ;;
  esac
  local authority="${rest%%[/?]*}"
  local tail=""
  case "$rest" in
    *[/?]*) tail="${rest#"$authority"}" ;;
  esac
  if [ "$authority" != "${authority%@*}" ] || [ "$authority" != "${authority##*@}" ]; then
    authority="[REDACTED]@${authority##*@}"
  fi
  local result="${scheme}${authority}${tail}"
  case "$u" in
    *\?*|*#*) printf '%s?[REDACTED]' "$result" ;;
    *) printf '%s' "$result" ;;
  esac
}

# ── Banner ───────────────────────────────────────────────────────────────────
echo "=== XYX Delivery Source Verification ==="
echo "Verifier:  $VERIFIER"
echo "Registry:  $REGISTRY"
echo "Protocol:  $PROTOCOL"
echo ""

# ── 0. Route configuration ───────────────────────────────────────────────────
section "0. Verification Route"

ROUTE_OK=true
VERIFIER_FLAGS=()
# Human/machine-readable description of the endpoint actually contacted. Kept as
# its own variable rather than indexed out of VERIFIER_FLAGS: the array holds the
# API key on the etherscan route, and an index that is correct for one route is
# wrong (and potentially a secret) for the other.
VERIFIER_ENDPOINT=""

case "$ROUTE" in
  sourcify)
    pass "Route: sourcify (MonadVision) — no API key required"
    VERIFIER_FLAGS=(--verifier sourcify --verifier-url "$SOURCIFY_URL")
    VERIFIER_ENDPOINT=$(redact_url "$SOURCIFY_URL")
    if [ -n "$API_KEY" ]; then
      warn "MONAD_EXPLORER_API_KEY is set but is not used by the sourcify route."
    fi
    ;;
  etherscan|monadscan)
    pass "Route: etherscan/monadscan (explicit opt-in)"
    if [ -z "$API_KEY" ]; then
      fail "MONAD_VERIFY_ROUTE=$ROUTE requires MONAD_EXPLORER_API_KEY"
      echo ""
      echo "The etherscan/monadscan route needs a key. The default sourcify route does not."
      exit 1
    fi
    # --watch is forge's own documented "wait for verification result after
    # submission". It is used ONLY here, so the single submission this script
    # makes resolves to a terminal status instead of stopping at "queued".
    # It is deliberately NOT used on the sourcify route, whose terminal response
    # is returned synchronously by the submission itself.
    VERIFIER_FLAGS=(--verifier etherscan --etherscan-api-key "$API_KEY" --watch)
    VERIFIER_ENDPOINT="etherscan-api (key redacted)"
    ;;
  *)
    fail "MONAD_VERIFY_ROUTE=$ROUTE is not a known route (expected: sourcify | etherscan)"
    exit 1
    ;;
esac

echo "  Verifier endpoint: $VERIFIER_ENDPOINT"

# ── 1. Chain ID check (both RPCs must independently report 10143) ────────────
section "1. Chain ID Verification"

RPC_CONFIG_OK=true

for pair in "PRIMARY:$PRIMARY_RPC" "SECONDARY:$SECONDARY_RPC"; do
  IFS=':' read -r label url <<< "$pair"
  if [ -z "$url" ]; then
    fail "MONAD_RPC_URL_${label} is not configured"
    RPC_CONFIG_OK=false
  elif ! printf '%s' "$url" | grep -qE '^https?://'; then
    fail "MONAD_RPC_URL_${label} is not an http(s) URL"
    RPC_CONFIG_OK=false
  elif printf '%s' "$url" | grep -qE '^[a-z]+://[^/]*@'; then
    fail "MONAD_RPC_URL_${label} contains embedded credentials"
    RPC_CONFIG_OK=false
  fi
done

if [ -n "$PRIMARY_RPC" ] && [ -n "$SECONDARY_RPC" ] && [ "$PRIMARY_RPC" = "$SECONDARY_RPC" ]; then
  fail "MONAD_RPC_URL_PRIMARY and MONAD_RPC_URL_SECONDARY must be distinct"
  RPC_CONFIG_OK=false
fi

if [ "$RPC_CONFIG_OK" != true ]; then
  echo ""
  echo "Two configured, distinct, credential-free RPC endpoints are required before any"
  echo "verification command runs, so the chain being verified against is unambiguous."
  exit 1
fi

for pair in "PRIMARY:$PRIMARY_RPC" "SECONDARY:$SECONDARY_RPC"; do
  IFS=':' read -r label url <<< "$pair"
  chain_id=$(cast chain-id --rpc-url "$url" 2>/dev/null || printf '')
  if [ -z "$chain_id" ]; then
    fail "[$label] chain ID unreadable"
    RPC_CONFIG_OK=false
  elif [ "$chain_id" != "$EXPECTED_CHAIN" ]; then
    fail "[$label] chain ID is $chain_id (expected $EXPECTED_CHAIN)"
    RPC_CONFIG_OK=false
  else
    pass "[$label] chain ID: $EXPECTED_CHAIN"
  fi
done

if [ "$RPC_CONFIG_OK" != true ]; then
  echo ""
  echo "Chain ID check failed; no verification command was run."
  exit 1
fi

# ── 2. Bytecode presence and immutable bindings ──────────────────────────────
section "2. Contract Bytecode and Bindings"

for spec in "MonadP256Verifier:$VERIFIER" "XYXPasskeyRegistry:$REGISTRY" "XYXDeliveryProtocol:$PROTOCOL"; do
  IFS=':' read -r label addr <<< "$spec"
  code=$(cast code "$addr" --rpc-url "$PRIMARY_RPC" 2>/dev/null || printf '')
  if [ -z "$code" ] || [ "$code" = "0x" ] || [ "${#code}" -le 2 ]; then
    fail "$label has no runtime bytecode at $addr"
  else
    pass "$label runtime bytecode present"
  fi
done

onchain_token=$(cast call "$PROTOCOL" "paymentToken()" --rpc-url "$PRIMARY_RPC" 2>/dev/null | awk 'NR==1 {print $1}')
onchain_registry=$(cast call "$PROTOCOL" "passkeyRegistry()" --rpc-url "$PRIMARY_RPC" 2>/dev/null | awk 'NR==1 {print $1}')
onchain_verifier=$(cast call "$REGISTRY" "p256Verifier()" --rpc-url "$PRIMARY_RPC" 2>/dev/null | awk 'NR==1 {print $1}')
onchain_rp_hash=$(cast call "$REGISTRY" "rpIdHash()" --rpc-url "$PRIMARY_RPC" 2>/dev/null | awk 'NR==1 {print $1}')

normalize_addr_word() {
  local w="${1:-}"
  w="${w#0x}"
  w="${w#0X}"
  w=$(printf '%s' "$w" | tr -d ' \t\r\n' | tr '[:upper:]' '[:lower:]')
  if [ "${#w}" -gt 40 ]; then
    w="${w: -40}"
  fi
  printf '%s' "$w"
}

echo "  Protocol.paymentToken():    $onchain_token"
echo "  Protocol.passkeyRegistry(): $onchain_registry"
echo "  Registry.p256Verifier():    $onchain_verifier"
echo "  Registry.rpIdHash():        $onchain_rp_hash"

# Binding state is RELEASE-GATING, not advisory.
#
# A contract whose source verifies while its immutable bindings point elsewhere
# is a verified *source* bound to the wrong wiring: the code an auditor read is
# not the code that will move funds. `BINDINGS_OK` therefore participates in
# the $ALL_VERIFIED decision exactly like a per-contract verification status,
# and the machine-readable result carries the binding state so a downstream
# consumer cannot read `contracts[].status == "verified"` in isolation.
#
# `BINDING_REASONS` records why, so a failure is reported as a named binding
# mismatch rather than as a vague "not all verified".
BINDINGS_OK=true
BINDING_REASONS=()
BINDING_FAILURE_COUNT=0

record_binding_failure() {
  BINDINGS_OK=false
  BINDING_FAILURE_COUNT=$((BINDING_FAILURE_COUNT + 1))
  BINDING_REASONS+=("$1")
}

if [ -n "${MONAD_USDC_ADDRESS:-}" ] && \
   [ "$(normalize_addr_word "$onchain_token")" != "$(normalize_addr_word "$MONAD_USDC_ADDRESS")" ]; then
  fail "Protocol.paymentToken() = $onchain_token (expected $MONAD_USDC_ADDRESS)"
  record_binding_failure "protocol.paymentToken does not match the expected payment token"
else
  pass "Protocol.paymentToken() matches the expected token"
fi

if [ "$(normalize_addr_word "$onchain_registry")" != "$(normalize_addr_word "$REGISTRY")" ]; then
  fail "Protocol.passkeyRegistry() = $onchain_registry (expected $REGISTRY)"
  record_binding_failure "protocol.passkeyRegistry does not match the passkey registry address under test"
else
  pass "Protocol.passkeyRegistry() matches"
fi

if [ "$(normalize_addr_word "$onchain_verifier")" != "$(normalize_addr_word "$VERIFIER")" ]; then
  fail "Registry.p256Verifier() = $onchain_verifier (expected $VERIFIER)"
  record_binding_failure "passkeyRegistry.p256Verifier does not match the verifier address under test"
else
  pass "Registry.p256Verifier() matches"
fi

if [ "$(lower "$onchain_rp_hash")" = "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
  fail "Registry.rpIdHash() is zero"
  record_binding_failure "passkeyRegistry.rpIdHash is zero, so no passkey can match this deployment"
else
  pass "Registry.rpIdHash() is non-zero"
fi

# ── 3. Source verification via forge verify-contract ────────────────────────
section "3. Source Verification"

# Exact fully-qualified contract names. Anything else would verify different
# source than what is deployed.
CONTRACTS=(
  "$VERIFIER|MonadP256Verifier|src/MonadP256Verifier.sol:MonadP256Verifier"
  "$REGISTRY|XYXPasskeyRegistry|src/XYXPasskeyRegistry.sol:XYXPasskeyRegistry"
  "$PROTOCOL|XYXDeliveryProtocol|src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol"
)

# Positive TERMINAL responses only. A submission acknowledgement, a queue
# position, an explorer URL, an HTTP success, or a local artifact is NOT here.
VERIFIED_PATTERN='already verified|verification success|successfully verified|contract (source code )?(is )?verified|match found|status: (perfect|partial)|fully verified'

# Explicit failure responses.
FAILED_PATTERN='verification failed|verification error|bytecode does not match|bytecode mismatch|unable to verify|invalid api key|not a contract'

# Non-terminal responses. These are the ones an earlier version of this script
# silently swallowed while polling: a submission acknowledgement, a queue
# position, a "please wait", a monitor URL. They are matched so they can be
# classified as `unverified` WITH an explicit reason, rather than falling
# through to a generic timeout message that hides what actually happened.
NONTERMINAL_PATTERN='submitted|submission|queued|in queue|pending|verification in progress|please wait|check back|monitor|http 2[0-9][0-9]|status: (queued|pending|processing)'

declare -A OUTCOME=()
declare -A DIAGNOSTIC=()
# How many times THIS script locally executed `forge verify-contract` for each
# contract during THIS run.
#
# This counter exists only to prove the one-invocation-per-run invariant. It is
# NOT proof that a remote verifier received, accepted, queued, or completed any
# source-verification submission: the count is incremented immediately before
# the local command runs, and the command's exit code is deliberately swallowed
# so the output can be classified. A value of 1 with status `unverified` is the
# normal outcome when the route only acknowledges the request.
declare -A VERIFICATION_COMMAND_INVOCATIONS=()

for entry in "${CONTRACTS[@]}"; do
  IFS='|' read -r addr label source_path <<< "$entry"

  echo ""
  echo "  Initiating local verification command for $label..."
  echo "    Source:  $source_path"
  echo "    Address: $addr"

  # ONE `forge verify-contract` invocation per contract per execution.
  #
  # Deliberately NOT a poll loop. Re-submitting the same contract on a timer
  # would manufacture N acknowledgements for a single contract and let one
  # positive response out of N look like convergence, when it is really just the
  # same request repeated. The verifier decides the outcome; this script records
  # it. Re-running this script is how a human retries, and each run is
  # separately reported and separately counted.
  #
  # Counted here, immediately before the local command runs, so the count is a
  # fact about what THIS script did. It says nothing about what the verifier did
  # with the request — `OUTCOME` below is the only place a verification status is
  # decided, and it is decided from the response, never from this counter.
  VERIFICATION_COMMAND_INVOCATIONS["$label"]=$(( ${VERIFICATION_COMMAND_INVOCATIONS["$label"]:-0} + 1 ))

  output=$(forge verify-contract --root "$CONTRACTS_ROOT" --chain "$EXPECTED_CHAIN" "${VERIFIER_FLAGS[@]}" \
             "$addr" "$source_path" 2>&1 || true)

  # Classification is strictly ordered. A positive terminal response wins over
  # everything; an explicit failure wins over a non-terminal one; anything else
  # is unverified. Nothing but a positive TERMINAL response may produce
  # `verified`.
  outcome="unverified"
  # Named for the LOCAL command, not for a remote submission. Reaching this
  # default means the local `forge verify-contract` invocation returned output
  # this script could not classify at all — a refused root, a crashed CLI, or an
  # empty response. It is a statement about the command that ran here, never a
  # claim that a verifier received or accepted anything.
  diagnostic="no terminal response from the local verification command"

  if echo "$output" | grep -qiE "$VERIFIED_PATTERN"; then
    outcome="verified"
    diagnostic=$(echo "$output" | grep -iE "$VERIFIED_PATTERN" | head -1)
  elif echo "$output" | grep -qiE "$FAILED_PATTERN"; then
    outcome="failed"
    diagnostic=$(echo "$output" | grep -iE "$FAILED_PATTERN" | head -1)
  elif echo "$output" | grep -qiE "$NONTERMINAL_PATTERN"; then
    outcome="unverified"
    diagnostic="non-terminal response (submission acknowledged, not verified): $(echo "$output" | grep -iE "$NONTERMINAL_PATTERN" | head -1)"
  fi

  OUTCOME["$label"]="$outcome"
  DIAGNOSTIC["$label"]="$diagnostic"

  case "$outcome" in
    verified) echo -e "    ${GREEN}$label: VERIFIED${NC}" ;;
    failed)   echo -e "    ${RED}$label: VERIFICATION FAILED${NC}" ;;
    *)        echo -e "    ${YELLOW}$label: UNVERIFIED${NC}" ;;
  esac
  echo "    Response: $diagnostic"
done

# ── 4. Summary ───────────────────────────────────────────────────────────────
section "4. Verification Summary"

# Source verification and binding correctness are SEPARATE gates and BOTH must
# pass before ALL_VERIFIED may be printed. Three contracts can report
# `verified` from the verifier while `protocol.passkeyRegistry()` still points
# at a registry nobody verified: that is a verified source on the wrong
# deployment, and it is not a releasable state.
ALL_VERIFIED=true
if [ "$BINDINGS_OK" != true ]; then
  ALL_VERIFIED=false
fi

for entry in "${CONTRACTS[@]}"; do
  IFS='|' read -r addr label source_path <<< "$entry"
  status="${OUTCOME[$label]:-unverified}"
  diag="${DIAGNOSTIC[$label]:-no terminal response}"

  # Machine-readable, non-secret per-contract outcome. No API key, RPC URL,
  # keystore path, or private material is ever emitted here.
  echo "VERIFY_RESULT|$source_path|$addr|$status|$diag"

  case "$status" in
    verified) echo -e "  ${GREEN}$label: VERIFIED${NC} ($addr)" ;;
    failed)   echo -e "  ${RED}$label: FAILED${NC} ($addr)" ; ALL_VERIFIED=false ;;
    *)        echo -e "  ${YELLOW}$label: UNVERIFIED${NC} ($addr)" ; ALL_VERIFIED=false ;;
  esac
done

echo ""
echo "  Immutable bindings:"
if [ "$BINDINGS_OK" = true ]; then
  echo -e "    ${GREEN}BINDINGS: VERIFIED${NC}"
else
  echo -e "    ${RED}BINDINGS: FAILED${NC}"
  ALL_VERIFIED=false
  for reason in ${BINDING_REASONS[@]+"${BINDING_REASONS[@]}"}; do
    echo "      - $reason"
  done
fi

echo ""

if [ "$ALL_VERIFIED" = true ]; then
  echo "ALL_VERIFIED"
  if [ -n "$EXPLORER" ]; then
    echo "Explorer: $(redact_url "$EXPLORER")/address/$PROTOCOL"
  fi
else
  echo "NOT_ALL_VERIFIED"
  echo ""
  echo "A contract is VERIFIED only when the verification route returned a"
  echo "positive terminal response. BINDINGS are VERIFIED only when every"
  echo "immutable wiring check passed. Both are required; neither implies the"
  echo "other, and a verified contract bound to the wrong deployment is not"
  echo "releasable."
fi

# ── 5. Machine-readable result ───────────────────────────────────────────────
if [ -n "$OUT" ]; then
  contracts_json=$(for entry in "${CONTRACTS[@]}"; do
    IFS='|' read -r addr label source_path <<< "$entry"
    # `verificationCommandInvocations` is the number of local forge
    # verify-contract CLI calls THIS script initiated for this contract during
    # this run. It is deliberately named for the command rather than for a
    # submission: it must never be read as proof that a remote verifier
    # accepted, queued, or completed a source-verification submission. Only
    # `status` carries verification evidence, and only from a positive terminal
    # tool response.
    jq -n --arg fqn "$source_path" --arg addr "$addr" \
          --arg label "$label" \
          --arg status "${OUTCOME[$label]:-unverified}" \
          --arg diag "${DIAGNOSTIC[$label]:-no terminal response}" \
          --argjson invocations "${VERIFICATION_COMMAND_INVOCATIONS[$label]:-0}" \
          '{fullyQualifiedName: $fqn, address: $addr, name: $label, status: $status, diagnostic: $diag, verificationCommandInvocations: $invocations}'
  done | jq -s .)

  # The binding state is emitted as its own object so a consumer can never read
  # `contracts[].status` in isolation and conclude the whole run succeeded. A
  # consumer that checks only per-contract statuses would miss exactly the
  # failure this gate exists to surface.
  bindings_json=$(jq -n \
    --arg status "$( [ "$BINDINGS_OK" = true ] && printf 'verified' || printf 'failed' )" \
    --argjson ok "$( [ "$BINDINGS_OK" = true ] && printf 'true' || printf 'false' )" \
    --argjson failures "$(json_string_array ${BINDING_REASONS[@]+"${BINDING_REASONS[@]}"})" \
    --arg count "$BINDING_FAILURE_COUNT" \
    '{status: $status, ok: $ok, failureCount: ($count | tonumber), failures: $failures}')

  jq -n \
    --arg schema "xyx.delivery.source-verification" \
    --argjson chainId "$EXPECTED_CHAIN" \
    --arg route "$ROUTE" \
    --arg verifierUrl "$VERIFIER_ENDPOINT" \
    --argjson contracts "$contracts_json" \
    --argjson bindings "$bindings_json" \
    --arg allVerified "$( [ "$ALL_VERIFIED" = true ] && printf 'true' || printf 'false' )" \
    '{schema: $schema, chainId: $chainId, route: $route, verifierUrl: $verifierUrl, allVerified: ($allVerified == "true"), contracts: $contracts, bindings: $bindings}' \
    > "$OUT"
  echo ""
  echo "Machine-readable verification result written to: $OUT"
  echo "record-xyx-delivery-provenance.sh consumes this file via PROVENANCE_VERIFICATION_RESULT."
fi

if [ "$ALL_VERIFIED" = true ]; then
  exit 0
fi
exit 1
