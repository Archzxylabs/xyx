#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# XYX Delivery Provenance Recorder — build draft/final provenance from chain facts
# ─────────────────────────────────────────────────────────────────────────────
# READ-ONLY. This script writes exactly one file: the provenance record named by
# PROVENANCE_OUT. It never deploys, broadcasts, signs, submits source
# verification, or reads a key.
#
# A record reaches `final` ONLY when every fact below was observed from TWO
# configured, DISTINCT RPC endpoints that independently agree, every deployment
# receipt is finalized, every immutable binding matches, and source verification
# is backed by an explicit evidence file produced by verify-xyx-delivery.sh.
# Anything else is still written — as a machine-readable `draft` carrying the
# exact reason codes that block finality — and the script exits nonzero.
#
# This script deliberately does NOT run verify-xyx-delivery.sh. Source
# verification is a separate, explicit operator action; provenance consumes its
# result only as evidence. A reachable explorer page, a queued submission, or a
# local artifact is never treated as verification.
#
# Usage:
#   ./record-xyx-delivery-provenance.sh \
#       <verifier_address> <registry_address> <protocol_address> \
#       <verifier_deploy_tx> <registry_deploy_tx> <protocol_deploy_tx>
#
# Environment:
#   MONAD_RPC_URL_PRIMARY           Primary RPC endpoint (required)
#   MONAD_RPC_URL_SECONDARY         A second, DISTINCT RPC endpoint (required for `final`)
#   MONAD_EXPLORER_URL              Explorer base URL (informational only)
#   MONAD_USDC_ADDRESS              Expected payment token address (required)
#   XYX_RP_ID                       Expected RP ID string (required)
#   PROVENANCE_OUT                  Output path (default: <script_dir>/provenance-draft.json)
#   PROVENANCE_VERIFICATION_RESULT  Path to source-verification evidence JSON.
#                                   Without it, source verification is recorded
#                                   `unverified` and the record cannot be final.
#
# Exit codes: 0 = final, 1 = draft written, 2 = invalid arguments,
#             3 = output directory missing or not writable,
#             4 = record construction failed (destination untouched).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This script lives at packages/contracts/script, so the repository root is THREE
# levels up. Deriving it from SCRIPT_DIR rather than $PWD is what makes every path
# below independent of the working directory the script is invoked from (repo root,
# packages/contracts, /tmp, or an absolute script path).
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Canonical Foundry root. The repo root is NOT one: `forge inspect` resolves the
# project from --root or the nearest foundry.toml walking up from $PWD, so run
# from the repository root it reports "No contract found with the name ..." and
# exits nonzero — the compiled artifact is never read. Deriving it from
# SCRIPT_DIR rather than $PWD is what makes that independent of where the script
# is invoked from (repo root, packages/contracts, /tmp, or an absolute path).
CONTRACTS_ROOT="${PROJECT_ROOT}/packages/contracts"

EXPECTED_CHAIN="10143"
# DeployXYXDelivery.s.sol hard-requires a 6-decimal token (TOKEN_WRONG_DECIMALS),
# so provenance must reject any other figure rather than record it.
EXPECTED_TOKEN_DECIMALS="6"

SOLC_VERSION="0.8.30"
OPTIMIZER=true
OPTIMIZER_RUNS=200
VIA_IR=true

FQ_VERIFIER="src/MonadP256Verifier.sol:MonadP256Verifier"
FQ_REGISTRY="src/XYXPasskeyRegistry.sol:XYXPasskeyRegistry"
FQ_PROTOCOL="src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol"

# ── Argument validation ──────────────────────────────────────────────────────
usage() {
  echo "Usage: $0 <verifier> <registry> <protocol> <verifier_tx> <registry_tx> <protocol_tx>" >&2
}

if [ "$#" -ne 6 ]; then
  echo "ERROR: expected 6 arguments, got $#" >&2
  usage
  exit 2
fi

VERIFIER="${1:-}"
REGISTRY="${2:-}"
PROTOCOL="${3:-}"
VERIFIER_TX="${4:-}"
REGISTRY_TX="${5:-}"
PROTOCOL_TX="${6:-}"

ADDR_RE='^0x[0-9a-fA-F]{40}$'
TX_RE='^0x[0-9a-fA-F]{64}$'

arg_error=""
for pair in "verifier address:$VERIFIER:$ADDR_RE" \
            "registry address:$REGISTRY:$ADDR_RE" \
            "protocol address:$PROTOCOL:$ADDR_RE" \
            "verifier deployment tx:$VERIFIER_TX:$TX_RE" \
            "registry deployment tx:$REGISTRY_TX:$TX_RE" \
            "protocol deployment tx:$PROTOCOL_TX:$TX_RE"; do
  IFS=':' read -r label value regex <<< "$pair"
  if ! printf '%s' "$value" | grep -qE "$regex"; then
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
EXPLORER="${MONAD_EXPLORER_URL:-}"
TOKEN="${MONAD_USDC_ADDRESS:-}"
RP_ID="${XYX_RP_ID:-}"
OUT="${PROVENANCE_OUT:-${SCRIPT_DIR}/provenance-draft.json}"
EV_FILE="${PROVENANCE_VERIFICATION_RESULT:-}"

# ── Reason accumulation ──────────────────────────────────────────────────────
# Every failure is captured as a stable, machine-readable reason code. Nothing
# here aborts the script: a draft record must always be reachable.
declare -a REASONS=()
declare -a NOTES=()

record_failure() {
  local reason="$1"
  # Argument validation and the on-chain re-read are independent checks, so the
  # same code can be recorded twice (an absent payment token address is caught by
  # both). Keep the first occurrence only: incompleteReasons is consumed as a
  # machine-readable list, and a repeated code would inflate its length.
  local prior
  for prior in ${REASONS[@]+"${REASONS[@]}"}; do
    if [ "$prior" = "$reason" ]; then
      echo "  FAIL  $reason" >&2
      return 0
    fi
  done
  REASONS+=("$reason")
  echo "  FAIL  $reason" >&2
}

record_note() {
  NOTES+=("$1")
  echo "  NOTE  $1"
}

pass() { echo "  PASS  $1"; }
section() { echo ""; echo "── $1 ──"; }

# ── Pure helpers ─────────────────────────────────────────────────────────────
# Normalize an ABI-encoded address word (or a bare address) to bare lowercase hex.
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

lower() { printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'; }

first_token() { awk 'NR==1 {print $1}' <<<"${1:-}"; }

# Decode a 32-byte ABI word (0x-prefixed hex) into its decimal value.
# `cast --to-dec` is arbitrary precision, so a huge uint cannot silently wrap
# the way bash arithmetic would. Exactly `0x` + 64 hex chars is accepted;
# short, long, empty, multi-word or non-hex input is a decode failure.
hex_word_to_dec() {
  local word="${1:-}"
  case "$word" in
    0x|0X) printf '' ; return 0 ;;
  esac
  local body="${word#0x}"
  body="${body#0X}"
  if [ "${#body}" -ne 64 ]; then
    printf ''
    return 0
  fi
  case "$body" in
    ""|*[!0-9a-fA-F]*) printf '' ; return 0 ;;
  esac
  # `cast` can exit 0 while printing something that is not a number; a value
  # that is not a plain decimal integer must never reach a numeric comparison
  # or a JSON number field.
  local dec
  dec=$(cast --to-dec "0x$body" 2>/dev/null || printf '')
  case "$dec" in
    ''|*[!0-9]*) printf '' ;;
    *) printf '%s' "$dec" ;;
  esac
}

# Best-effort decode of a dynamic `string` return. Only a well-formed
# offset/length/data triple is decoded; anything else is reported empty so the
# caller records "unreadable" instead of inventing a symbol.
abi_decode_string() {
  local raw="${1:-}"
  raw="${raw#0x}"
  raw="${raw#0X}"
  raw=$(printf '%s' "$raw" | tr -d ' \t\r\n')
  if [ "${#raw}" -lt 128 ]; then
    printf ''
    return 0
  fi
  local len_dec
  len_dec=$(hex_word_to_dec "0x${raw:64:64}")
  if [ -z "$len_dec" ] || [ "$len_dec" -gt 32 ]; then
    printf ''
    return 0
  fi
  local data_hex="${raw:128:$((len_dec * 2))}"
  local out="" i
  for ((i = 0; i < ${#data_hex}; i += 2)); do
    out+=$(printf "\\x${data_hex:i:2}")
  done
  printf '%s' "$out"
}

# Emit a JSON number for $1, or the literal `null` when $1 is not a plain
# non-negative decimal integer. An unreadable numeric fact MUST serialize as
# null: `0` is itself a plausible observation (a zero-decimal token, a
# zero-byte runtime, chain 0), so falling back to it would fabricate evidence.
# Every null this helper produces is paired with a stable reason code by
# `require_number` below, so a null can never appear silently in a record.
json_number_or_null() {
  case "${1:-}" in
    ''|*[!0-9]*) printf 'null' ;;
    *) printf '%s' "$1" ;;
  esac
}

# require_number <value> <reason-code>: record <reason-code> when <value> is
# about to serialize as JSON null. Called for every numeric field before the
# status decision, so an unreadable number is always visible in
# incompleteReasons and always blocks `final`.
require_number() {
  case "${1:-}" in
    ''|*[!0-9]*) record_failure "$2" ;;
  esac
}

json_bool() {
  if [ "${1:-false}" = "true" ]; then printf 'true'; else printf 'false'; fi
}

json_string_array() {
  if [ "$#" -eq 0 ]; then
    printf '[]'
    return 0
  fi
  printf '%s\n' "$@" | jq -R . | jq -s .
}

# Strip query string and fragment so an RPC URL carrying a token is never
# written into a public-safe record.
redact_url() {
  local u="${1:-}"
  if [ -z "$u" ]; then
    printf ''
    return 0
  fi
  local stripped="${u%%\?*}"
  stripped="${stripped%%#*}"
  case "$u" in
    *\?*|*#*) printf '%s?[REDACTED]' "$stripped" ;;
    *) printf '%s' "$stripped" ;;
  esac
}

# ── Banner ───────────────────────────────────────────────────────────────────
echo "=== XYX Delivery Provenance Recorder ==="
echo "Verifier:  $VERIFIER"
echo "Registry:  $REGISTRY"
echo "Protocol:  $PROTOCOL"
echo "Verifier TX: $VERIFIER_TX"
echo "Registry TX: $REGISTRY_TX"
echo "Protocol TX: $PROTOCOL_TX"
echo ""

# ── 0. RPC configuration ─────────────────────────────────────────────────────
section "0. RPC Configuration"

RPC_CONFIG_OK=true

if [ -z "$PRIMARY_RPC" ]; then
  record_failure "RPC_PRIMARY_MISSING"
  RPC_CONFIG_OK=false
elif ! printf '%s' "$PRIMARY_RPC" | grep -qE '^https?://'; then
  record_failure "RPC_PRIMARY_URL_INVALID"
  RPC_CONFIG_OK=false
elif printf '%s' "$PRIMARY_RPC" | grep -qE '^[a-z]+://[^/]*@'; then
  record_failure "RPC_PRIMARY_URL_CONTAINS_CREDENTIALS"
  RPC_CONFIG_OK=false
else
  pass "Primary RPC: $(redact_url "$PRIMARY_RPC")"
fi

if [ -z "$SECONDARY_RPC" ]; then
  record_failure "RPC_SECONDARY_MISSING"
  RPC_CONFIG_OK=false
elif ! printf '%s' "$SECONDARY_RPC" | grep -qE '^https?://'; then
  record_failure "RPC_SECONDARY_URL_INVALID"
  RPC_CONFIG_OK=false
elif printf '%s' "$SECONDARY_RPC" | grep -qE '^[a-z]+://[^/]*@'; then
  record_failure "RPC_SECONDARY_URL_CONTAINS_CREDENTIALS"
  RPC_CONFIG_OK=false
elif [ "$SECONDARY_RPC" = "$PRIMARY_RPC" ]; then
  record_failure "RPC_NOT_DISTINCT"
  RPC_CONFIG_OK=false
else
  pass "Secondary RPC: $(redact_url "$SECONDARY_RPC")"
fi

if [ "$RPC_CONFIG_OK" != true ]; then
  record_note "A final record requires two configured, distinct, credential-free RPC endpoints."
fi

# ── Dual-RPC read primitive ──────────────────────────────────────────────────
# dual_cast <what> <cast args...>
# Runs `cast <args...>` against BOTH configured RPCs. Sets DUAL_PRIMARY and
# DUAL_SECONDARY to the raw stdout of each and DUAL_OK=1 only when both
# answered and produced byte-identical output. Every failure mode is recorded
# as a stable reason code; this function never aborts the script.
dual_cast() {
  local what="$1"
  shift
  DUAL_PRIMARY=""
  DUAL_SECONDARY=""
  DUAL_OK=0

  if [ -z "$PRIMARY_RPC" ] || [ -z "$SECONDARY_RPC" ]; then
    record_failure "RPC_READ_SKIPPED:$what"
    return 1
  fi

  local p_out="" s_out=""
  local p_rc=0 s_rc=0
  p_out=$(cast "$@" --rpc-url "$PRIMARY_RPC" 2>/dev/null) || p_rc=1
  s_out=$(cast "$@" --rpc-url "$SECONDARY_RPC" 2>/dev/null) || s_rc=1

  if [ "$p_rc" -ne 0 ]; then
    record_failure "RPC_READ_FAILED:primary:$what"
    return 1
  fi
  if [ "$s_rc" -ne 0 ]; then
    record_failure "RPC_READ_FAILED:secondary:$what"
    return 1
  fi
  if [ "$p_out" != "$s_out" ]; then
    record_failure "RPC_DISAGREEMENT:$what"
    DUAL_PRIMARY="$p_out"
    DUAL_SECONDARY="$s_out"
    return 1
  fi

  DUAL_PRIMARY="$p_out"
  DUAL_SECONDARY="$s_out"
  DUAL_OK=1
  return 0
}

# ── 1. Chain ID (both RPCs must independently report 10143) ──────────────────
section "1. Chain ID Verification"

CHAIN_ID=""
CHAIN_OK=false

if dual_cast "chain-id" chain-id; then
  CHAIN_ID=$(first_token "$DUAL_PRIMARY")
  if [ "$CHAIN_ID" = "$EXPECTED_CHAIN" ]; then
    pass "Both RPCs independently report chain ID $EXPECTED_CHAIN"
    CHAIN_OK=true
  else
    record_failure "CHAIN_ID_MISMATCH:$CHAIN_ID"
  fi
fi

# ── 2. Runtime bytecode and code hashes (dual-RPC agreement) ─────────────────
section "2. Runtime Bytecode and Code Hashes"

declare -A CODE_HASH=()
declare -A CODE_LEN=()

for spec in "p256Verifier:$VERIFIER" "passkeyRegistry:$REGISTRY" "deliveryProtocol:$PROTOCOL"; do
  IFS=':' read -r label addr <<< "$spec"
  if dual_cast "code:$label" code "$addr"; then
    code=$(first_token "$DUAL_PRIMARY")
    if [ -z "$code" ] || [ "$code" = "0x" ] || [ "${#code}" -le 2 ]; then
      record_failure "CODE_MISSING:$label"
      continue
    fi
    # keccak is a pure local computation over the bytecode both RPCs just agreed
    # on — it does not depend on the endpoint, so hashing it twice would only
    # manufacture a spurious disagreement. Hash once, from the agreed bytes.
    hash=$(cast keccak "$code" 2>/dev/null || printf '')
    if [ -z "$hash" ] || [ "$hash" = "0x" ]; then
      record_failure "CODE_HASH_MISSING:$label"
      continue
    fi
    CODE_HASH["$label"]="$hash"
    CODE_LEN["$label"]=$(( (${#code} - 2) / 2 ))
    pass "$label runtime code hash (agreed by both RPCs): $hash (${CODE_LEN[$label]} bytes)"
  fi
done

# ── 3. Deployment receipts (dual-RPC agreement + finalization) ───────────────
section "3. Deployment Receipt Validation"

declare -A RCPT_BLOCK=()
declare -A RCPT_BLOCK_HASH=()
declare -A RCPT_STATUS=()
declare -A RCPT_FINALIZED=()

receipt_field() {
  printf '%s' "${1:-}" | jq -r ".${2} // empty" 2>/dev/null || printf ''
}

normalize_status() {
  local s
  s=$(lower "${1:-}")
  s=$(printf '%s' "$s" | tr -d ' \t\r\n')
  case "$s" in
    1|0x1|true) printf 'success' ;;
    0|0x0|false) printf 'reverted' ;;
    *) printf '%s' "$s" ;;
  esac
}

for spec in "p256Verifier:$VERIFIER_TX:$VERIFIER" \
            "passkeyRegistry:$REGISTRY_TX:$REGISTRY" \
            "deliveryProtocol:$PROTOCOL_TX:$PROTOCOL"; do
  IFS=':' read -r label tx expected_addr <<< "$spec"

  if ! dual_cast "receipt:$label" receipt "$tx" --json; then
    continue
  fi

  # Both RPCs returned identical receipt JSON; re-extract from each side anyway
  # so a per-field disagreement is reported rather than assumed away.
  p_block=$(receipt_field "$DUAL_PRIMARY" blockNumber)
  p_hash=$(receipt_field "$DUAL_PRIMARY" blockHash)
  p_status=$(receipt_field "$DUAL_PRIMARY" status)
  p_addr=$(receipt_field "$DUAL_PRIMARY" contractAddress)
  p_txhash=$(receipt_field "$DUAL_PRIMARY" transactionHash)

  s_block=$(receipt_field "$DUAL_SECONDARY" blockNumber)
  s_hash=$(receipt_field "$DUAL_SECONDARY" blockHash)
  s_status=$(receipt_field "$DUAL_SECONDARY" status)
  s_addr=$(receipt_field "$DUAL_SECONDARY" contractAddress)
  s_txhash=$(receipt_field "$DUAL_SECONDARY" transactionHash)

  for field in blockNumber blockHash status contractAddress transactionHash; do
    pv="p_$field"
    sv="s_$field"
    # `${!pv:-}` rather than `${!pv}`: a receipt that omits a field leaves the
    # indirect target unset, and `set -u` would abort the whole record.
    if [ "${!pv:-}" != "${!sv:-}" ]; then
      record_failure "RPC_DISAGREEMENT:receipt:$label:$field"
    fi
  done

  ok=true

  if [ -z "$p_block" ]; then
    record_failure "RECEIPT_BLOCK_NUMBER_MISSING:$label"
    ok=false
  fi
  if [ -z "$p_hash" ]; then
    record_failure "RECEIPT_BLOCK_HASH_MISSING:$label"
    ok=false
  fi
  if [ -z "$p_addr" ]; then
    record_failure "RECEIPT_CONTRACT_ADDRESS_MISSING:$label"
    ok=false
  fi
  if [ "$(lower "$p_txhash")" != "$(lower "$tx")" ]; then
    record_failure "RECEIPT_TX_HASH_MISMATCH:$label"
    ok=false
  fi

  norm_status=$(normalize_status "$p_status")
  if [ "$norm_status" != "success" ]; then
    record_failure "RECEIPT_STATUS_NOT_SUCCESS:$label:$norm_status"
    ok=false
  fi

  if [ "$(normalize_addr_word "$p_addr")" != "$(normalize_addr_word "$expected_addr")" ]; then
    record_failure "RECEIPT_ADDRESS_MISMATCH:$label"
    ok=false
  fi

  if [ "$ok" = true ]; then
    RCPT_BLOCK["$label"]="$p_block"
    RCPT_BLOCK_HASH["$label"]="$p_hash"
    RCPT_STATUS["$label"]="$norm_status"
    pass "$label receipt validated by both RPCs (block=$p_block, status=$norm_status)"
  fi
done

# Finalization: the finalized block height must be observed from both RPCs and
# must be at or above every deployment block.
FINALIZED_BLOCK=""
if dual_cast "finalized-block" block finalized --json; then
  fp=$(receipt_field "$DUAL_PRIMARY" number)
  fs=$(receipt_field "$DUAL_SECONDARY" number)
  if [ -z "$fp" ] || [ "$fp" != "$fs" ]; then
    record_failure "RPC_DISAGREEMENT:finalized-block"
  elif ! printf '%s' "$fp" | grep -qE '^[0-9]+$'; then
    record_failure "FINALIZED_BLOCK_UNREADABLE"
  else
    FINALIZED_BLOCK="$fp"
    pass "Both RPCs report finalized block $FINALIZED_BLOCK"
  fi
fi

for label in p256Verifier passkeyRegistry deliveryProtocol; do
  block_num="${RCPT_BLOCK[$label]:-}"
  if [ -z "$block_num" ]; then
    RCPT_FINALIZED["$label"]=false
    continue
  fi
  if [ -z "$FINALIZED_BLOCK" ]; then
    record_failure "RECEIPT_FINALIZATION_UNKNOWN:$label"
    RCPT_FINALIZED["$label"]=false
  elif [ "$FINALIZED_BLOCK" -lt "$block_num" ]; then
    record_failure "RECEIPT_NOT_FINALIZED:$label"
    RCPT_FINALIZED["$label"]=false
  else
    RCPT_FINALIZED["$label"]=true
    pass "$label receipt is finalized (deploy=$block_num, finalized=$FINALIZED_BLOCK)"
  fi
done

# ── 4. Immutable bindings (dual-RPC agreement) ───────────────────────────────
section "4. On-Chain Immutable Bindings"

declare -A BINDING=()

binding_read() {
  # binding_read <name> <contract> <signature>
  local name="$1" contract="$2" sig="$3"
  if ! dual_cast "binding:$name" call "$contract" "$sig"; then
    BINDING["$name"]=""
    return 1
  fi
  BINDING["$name"]=$(first_token "$DUAL_PRIMARY")
  printf '%s' "${BINDING[$name]}"
}

onchain_token=$(binding_read "paymentToken" "$PROTOCOL" "paymentToken()" || true)
onchain_registry=$(binding_read "passkeyRegistry" "$PROTOCOL" "passkeyRegistry()" || true)
onchain_verifier=$(binding_read "p256Verifier" "$REGISTRY" "p256Verifier()" || true)
onchain_rp_hash=$(binding_read "rpIdHash" "$REGISTRY" "rpIdHash()" || true)
onchain_max_lifetime=$(binding_read "maxVerdictLifetime" "$PROTOCOL" "maxVerdictLifetime()" || true)

echo "  Protocol.paymentToken():       $onchain_token"
echo "  Protocol.passkeyRegistry():    $onchain_registry"
echo "  Registry.p256Verifier():       $onchain_verifier"
echo "  Registry.rpIdHash():           $onchain_rp_hash"
echo "  Protocol.maxVerdictLifetime(): $onchain_max_lifetime"

RP_ID_HASH_OK=false
MAX_LIFETIME_OK=false
MAX_LIFETIME_DEC=""

if [ -z "$TOKEN" ]; then
  record_failure "TOKEN_ADDRESS_MISSING"
elif ! printf '%s' "$TOKEN" | grep -qE "$ADDR_RE"; then
  record_failure "TOKEN_ADDRESS_INVALID"
elif [ -z "$onchain_token" ]; then
  record_failure "BINDING_UNREADABLE:paymentToken"
elif [ "$(normalize_addr_word "$onchain_token")" != "$(normalize_addr_word "$TOKEN")" ]; then
  record_failure "BINDING_MISMATCH:paymentToken"
else
  pass "Protocol.paymentToken() matches the expected token"
fi

if [ -z "$onchain_registry" ]; then
  record_failure "BINDING_UNREADABLE:passkeyRegistry"
elif [ "$(normalize_addr_word "$onchain_registry")" != "$(normalize_addr_word "$REGISTRY")" ]; then
  record_failure "BINDING_MISMATCH:passkeyRegistry"
else
  pass "Protocol.passkeyRegistry() matches"
fi

if [ -z "$onchain_verifier" ]; then
  record_failure "BINDING_UNREADABLE:p256Verifier"
elif [ "$(normalize_addr_word "$onchain_verifier")" != "$(normalize_addr_word "$VERIFIER")" ]; then
  record_failure "BINDING_MISMATCH:p256Verifier"
else
  pass "Registry.p256Verifier() matches"
fi

if [ -z "$onchain_rp_hash" ]; then
  record_failure "BINDING_UNREADABLE:rpIdHash"
elif [ "$(lower "$onchain_rp_hash")" = "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
  record_failure "BINDING_ZERO:rpIdHash"
else
  RP_ID_HASH_OK=true
  pass "Registry.rpIdHash() is non-zero: $onchain_rp_hash"
fi

if [ -z "$onchain_max_lifetime" ]; then
  record_failure "BINDING_UNREADABLE:maxVerdictLifetime"
else
  MAX_LIFETIME_DEC=$(hex_word_to_dec "$onchain_max_lifetime")
  if [ -z "$MAX_LIFETIME_DEC" ]; then
    record_failure "BINDING_UNDECODABLE:maxVerdictLifetime"
  elif [ "$MAX_LIFETIME_DEC" = "0" ]; then
    record_failure "BINDING_ZERO:maxVerdictLifetime"
  else
    MAX_LIFETIME_OK=true
    pass "Protocol.maxVerdictLifetime() = $MAX_LIFETIME_DEC seconds"
  fi
fi

# ── 5. Token identity (dual-RPC agreement, strict ABI-word decoding) ─────────
section "5. Token Identity"

TOKEN_SYMBOL="unreadable"
TOKEN_DECIMALS=""

if [ -z "$TOKEN" ]; then
  record_failure "TOKEN_ADDRESS_MISSING"
else
  if dual_cast "token-code" code "$TOKEN"; then
    token_code=$(first_token "$DUAL_PRIMARY")
    if [ -z "$token_code" ] || [ "$token_code" = "0x" ] || [ "${#token_code}" -le 2 ]; then
      record_failure "TOKEN_CODE_MISSING"
    else
      pass "Token has runtime bytecode at $TOKEN"
    fi
  fi

  token_symbol_raw=""
  if dual_cast "token-symbol" call "$TOKEN" "symbol()"; then
    token_symbol_raw=$(first_token "$DUAL_PRIMARY")
  fi
  decoded_symbol=$(abi_decode_string "$token_symbol_raw")
  if [ -n "$decoded_symbol" ]; then
    TOKEN_SYMBOL="$decoded_symbol"
  elif [ -n "$token_symbol_raw" ]; then
    TOKEN_SYMBOL="$token_symbol_raw"
  fi
  echo "  Token symbol response: $token_symbol_raw"

  token_decimals_raw=""
  if dual_cast "token-decimals" call "$TOKEN" "decimals()"; then
    token_decimals_raw=$(first_token "$DUAL_PRIMARY")
  fi
  if [ -z "$token_decimals_raw" ]; then
    record_failure "TOKEN_DECIMALS_UNREADABLE"
  else
    TOKEN_DECIMALS=$(hex_word_to_dec "$token_decimals_raw")
    if [ -z "$TOKEN_DECIMALS" ]; then
      record_failure "TOKEN_DECIMALS_UNDECODABLE"
    elif [ "$TOKEN_DECIMALS" != "$EXPECTED_TOKEN_DECIMALS" ]; then
      record_failure "TOKEN_DECIMALS_MISMATCH:$TOKEN_DECIMALS"
    else
      pass "Token decimals = $TOKEN_DECIMALS (expected $EXPECTED_TOKEN_DECIMALS)"
    fi
  fi
fi

# ── 6. Constructor arguments (dual-RPC tx reads) ─────────────────────────────
section "6. Constructor Arguments"

declare -A CTOR_ARGS=()
declare -A CTOR_MATCH=()

forge_creation_bytecode() {
  local contract="$1"
  forge inspect --root "$CONTRACTS_ROOT" "$contract" bytecode 2>/dev/null || printf ''
}

CTOR_MATCH["p256Verifier"]=false
CTOR_MATCH["passkeyRegistry"]=false
CTOR_MATCH["deliveryProtocol"]=false
CTOR_ARGS["p256Verifier"]="0x"
CTOR_ARGS["passkeyRegistry"]="0x"
CTOR_ARGS["deliveryProtocol"]="0x"

# MonadP256Verifier takes no constructor arguments.
verifier_input=""
if dual_cast "tx:p256Verifier" tx "$VERIFIER_TX" --json; then
  verifier_input=$(receipt_field "$DUAL_PRIMARY" input)
fi
verifier_creation=$(forge_creation_bytecode "MonadP256Verifier")
if [ -z "$verifier_input" ]; then
  record_failure "CONSTRUCTOR_INPUT_UNREADABLE:p256Verifier"
elif [ -z "$verifier_creation" ]; then
  record_failure "CONSTRUCTOR_ARTIFACT_UNREADABLE:p256Verifier"
elif [ "${verifier_input:0:${#verifier_creation}}" != "$verifier_creation" ]; then
  record_failure "CONSTRUCTOR_BYTECODE_MISMATCH:p256Verifier"
else
  CTOR_MATCH["p256Verifier"]=true
  pass "MonadP256Verifier tx input matches compiled creation bytecode (no constructor args)"
fi

# XYXPasskeyRegistry(rpIdHash bytes32, verifier address)
# Solidity ABI-encodes each constructor argument as its own 32-byte word, so the
# argument blob is 2 * 64 = 128 hex chars. The bytes32 is exactly one word; the
# address is right-aligned inside the second word, occupying its last 40 chars.
# Reading the address at offset 64 would land in its left padding.
REGISTRY_SUFFIX_LEN=128
registry_input=""
if dual_cast "tx:passkeyRegistry" tx "$REGISTRY_TX" --json; then
  registry_input=$(receipt_field "$DUAL_PRIMARY" input)
fi
registry_creation=$(forge_creation_bytecode "XYXPasskeyRegistry")
if [ -z "$registry_input" ]; then
  record_failure "CONSTRUCTOR_INPUT_UNREADABLE:passkeyRegistry"
elif [ -z "$registry_creation" ]; then
  record_failure "CONSTRUCTOR_ARTIFACT_UNREADABLE:passkeyRegistry"
else
  reg_in_strip="${registry_input#0x}"
  reg_cr_strip="${registry_creation#0x}"
  if [ "${reg_in_strip:0:${#reg_cr_strip}}" != "$reg_cr_strip" ]; then
    record_failure "CONSTRUCTOR_BYTECODE_MISMATCH:passkeyRegistry"
  else
    reg_suffix="${reg_in_strip:${#reg_cr_strip}}"
    if [ "${#reg_suffix}" -ne "$REGISTRY_SUFFIX_LEN" ]; then
      record_failure "CONSTRUCTOR_ARGS_LENGTH_MISMATCH:passkeyRegistry"
    else
      CTOR_ARGS["passkeyRegistry"]="0x$reg_suffix"
      # Word 0 is the full rpIdHash; word 1 is the address, right-aligned.
      decoded_rp="0x${reg_suffix:0:64}"
      decoded_verifier="0x${reg_suffix:88:40}"
      rp_ok=true
      if [ "$(lower "$decoded_rp")" != "$(lower "$onchain_rp_hash")" ]; then
        record_failure "CONSTRUCTOR_RP_HASH_MISMATCH:passkeyRegistry"
        rp_ok=false
      fi
      if [ "$(normalize_addr_word "$decoded_verifier")" != "$(normalize_addr_word "$VERIFIER")" ]; then
        record_failure "CONSTRUCTOR_VERIFIER_MISMATCH:passkeyRegistry"
        rp_ok=false
      fi
      if [ "$rp_ok" = true ]; then
        CTOR_MATCH["passkeyRegistry"]=true
        pass "XYXPasskeyRegistry constructor args match on-chain bindings"
      fi
    fi
  fi
fi

# XYXDeliveryProtocol(token address, registry address, lifetime uint64)
# Three arguments, each ABI-encoded as a 32-byte word: 3 * 64 = 192 hex chars.
PROTOCOL_SUFFIX_LEN=192
protocol_input=""
if dual_cast "tx:deliveryProtocol" tx "$PROTOCOL_TX" --json; then
  protocol_input=$(receipt_field "$DUAL_PRIMARY" input)
fi
protocol_creation=$(forge_creation_bytecode "XYXDeliveryProtocol")
if [ -z "$protocol_input" ]; then
  record_failure "CONSTRUCTOR_INPUT_UNREADABLE:deliveryProtocol"
elif [ -z "$protocol_creation" ]; then
  record_failure "CONSTRUCTOR_ARTIFACT_UNREADABLE:deliveryProtocol"
else
  pro_in_strip="${protocol_input#0x}"
  pro_cr_strip="${protocol_creation#0x}"
  if [ "${pro_in_strip:0:${#pro_cr_strip}}" != "$pro_cr_strip" ]; then
    record_failure "CONSTRUCTOR_BYTECODE_MISMATCH:deliveryProtocol"
  else
    pro_suffix="${pro_in_strip:${#pro_cr_strip}}"
    if [ "${#pro_suffix}" -ne "$PROTOCOL_SUFFIX_LEN" ]; then
      record_failure "CONSTRUCTOR_ARGS_LENGTH_MISMATCH:deliveryProtocol"
    else
      CTOR_ARGS["deliveryProtocol"]="0x$pro_suffix"
      # Word 0 = token, word 1 = registry, word 2 = lifetime. Each address is
      # right-aligned inside its own word.
      decoded_token="0x${pro_suffix:24:40}"
      decoded_registry="0x${pro_suffix:88:40}"
      decoded_lifetime_raw="0x${pro_suffix:128:64}"
      decoded_lifetime=$(hex_word_to_dec "$decoded_lifetime_raw")
      pro_ok=true
      if [ -n "$TOKEN" ] && [ "$(normalize_addr_word "$decoded_token")" != "$(normalize_addr_word "$TOKEN")" ]; then
        record_failure "CONSTRUCTOR_TOKEN_MISMATCH:deliveryProtocol"
        pro_ok=false
      fi
      if [ "$(normalize_addr_word "$decoded_registry")" != "$(normalize_addr_word "$REGISTRY")" ]; then
        record_failure "CONSTRUCTOR_REGISTRY_MISMATCH:deliveryProtocol"
        pro_ok=false
      fi
      if [ -z "$decoded_lifetime" ]; then
        record_failure "CONSTRUCTOR_LIFETIME_UNDECODABLE:deliveryProtocol"
        pro_ok=false
      elif [ "$decoded_lifetime" != "$MAX_LIFETIME_DEC" ]; then
        record_failure "CONSTRUCTOR_LIFETIME_MISMATCH:deliveryProtocol"
        pro_ok=false
      fi
      if [ "$pro_ok" = true ]; then
        CTOR_MATCH["deliveryProtocol"]=true
        pass "XYXDeliveryProtocol constructor args match on-chain bindings"
      fi
    fi
  fi
fi

# ── 7. RP ID hash ────────────────────────────────────────────────────────────
section "7. RP ID Hash Verification"

if [ -z "$RP_ID" ]; then
  record_failure "RP_ID_MISSING"
elif printf '%s' "$RP_ID" | grep -qE '[/:\\]'; then
  record_failure "RP_ID_NOT_HOST_ONLY"
elif [ "$RP_ID_HASH_OK" != true ]; then
  record_failure "RP_ID_HASH_UNREADABLE"
else
  expected_rp_hash="0x$(printf '%s' "$RP_ID" | sha256sum | awk '{print $1}')"
  if [ "$(lower "$expected_rp_hash")" != "$(lower "$onchain_rp_hash")" ]; then
    record_failure "RP_ID_HASH_MISMATCH"
  else
    pass "RP ID hash matches on-chain rpIdHash(): $onchain_rp_hash"
  fi
fi

# ── 8. Source verification evidence (explicit, never invoked here) ───────────
section "8. Source Verification Evidence"

SOURCE_VERIFICATION_STATUS="unverified"
SOURCE_VERIFICATION_EVIDENCE=""
SOURCE_VERIFICATION_URL=""
# Binding state from the evidence file. A verified contract bound to the wrong
# deployment is verified SOURCE on the wrong wiring, so this is a distinct gate
# from the per-contract statuses below and it blocks `final` on its own.
BINDINGS_STATUS="unverified"
BINDINGS_FAILURE_COUNT=0
BINDINGS_FAILURES_JSON='[]'
declare -A SOURCE_VERIFICATION_BY_FQ=()
SOURCE_VERIFICATION_BY_FQ["$FQ_VERIFIER"]="unverified"
SOURCE_VERIFICATION_BY_FQ["$FQ_REGISTRY"]="unverified"
SOURCE_VERIFICATION_BY_FQ["$FQ_PROTOCOL"]="unverified"

if [ -z "$EV_FILE" ]; then
  record_failure "SOURCE_VERIFICATION_EVIDENCE_MISSING"
  record_note "Source verification is an explicit, separate action. Point PROVENANCE_VERIFICATION_RESULT at the JSON emitted by verify-xyx-delivery.sh."
elif [ ! -f "$EV_FILE" ] || [ ! -r "$EV_FILE" ]; then
  record_failure "SOURCE_VERIFICATION_EVIDENCE_UNREADABLE"
else
  ev_schema=$(jq -r '.schema // empty' "$EV_FILE" 2>/dev/null || printf '')
  ev_chain=$(jq -r '.chainId // empty' "$EV_FILE" 2>/dev/null || printf '')
  # The evidence must describe EXACTLY the three canonical contracts. A count or
  # name-set mismatch means this file is not the artifact this deployment's
  # verification produced — a stale record from an earlier run, or one carrying
  # an extra entry, can never elevate provenance to final.
  ev_fq_count=$(jq -r '.contracts | length' "$EV_FILE" 2>/dev/null || printf '')
  ev_fq_set=$(jq -r '[.contracts[]?.fullyQualifiedName] | sort | join(",")' "$EV_FILE" 2>/dev/null || printf '')
  # Built through the same jq expression the evidence is normalized with, so the
  # comparison is between two identically sorted, identically joined strings.
  expected_fq_set=$(printf '%s\n' "$FQ_VERIFIER" "$FQ_REGISTRY" "$FQ_PROTOCOL" \
    | jq -R . | jq -s -r 'sort | join(",")')

  if [ "$ev_schema" != "xyx.delivery.source-verification" ]; then
    record_failure "SOURCE_VERIFICATION_EVIDENCE_SCHEMA_MISMATCH"
  elif [ "$ev_chain" != "$EXPECTED_CHAIN" ]; then
    record_failure "SOURCE_VERIFICATION_EVIDENCE_CHAIN_MISMATCH"
  elif [ "$ev_fq_count" != "3" ]; then
    record_failure "SOURCE_VERIFICATION_EVIDENCE_CONTRACT_COUNT_MISMATCH:$ev_fq_count"
  elif [ "$ev_fq_set" != "$expected_fq_set" ]; then
    record_failure "SOURCE_VERIFICATION_EVIDENCE_CONTRACT_SET_MISMATCH"
  else
    SOURCE_VERIFICATION_EVIDENCE=$(basename "$EV_FILE")
    # The evidence must carry an explicit, verified bindings object. A file that
    # omits it entirely is not accepted as evidence of good bindings: absence is
    # not verification, it is just absence.
    ev_bindings_status=$(jq -r '.bindings.status // empty' "$EV_FILE" 2>/dev/null || printf '')
    ev_bindings_failures=$(jq -c '.bindings.failures // []' "$EV_FILE" 2>/dev/null || printf '[]')

    if [ "$ev_bindings_status" = "verified" ]; then
      BINDINGS_STATUS="verified"
      BINDINGS_FAILURE_COUNT=0
      BINDINGS_FAILURES_JSON='[]'
      pass "Binding status in verification evidence: verified"
    else
      if [ -n "$ev_bindings_status" ]; then
        BINDINGS_STATUS="$ev_bindings_status"
        record_failure "SOURCE_VERIFICATION_BINDINGS_NOT_VERIFIED:$BINDINGS_STATUS"
        record_note "Binding status in verification evidence: $ev_bindings_status. All three contracts can be source-verified while the immutable bindings are wrong; that is not a releasable deployment."
      else
        BINDINGS_STATUS="missing"
        record_failure "SOURCE_VERIFICATION_BINDINGS_NOT_VERIFIED:missing"
        record_note "Verification evidence carries no bindings status. Absence of a binding status is not evidence of correct bindings."
      fi
      # jq -c on a null/missing subtree yields `null`; normalize to [] so the
      # serialized record always shows an array.
      if [ "$ev_bindings_failures" = "null" ] || [ -z "$ev_bindings_failures" ]; then
        ev_bindings_failures='[]'
      fi
      BINDINGS_FAILURES_JSON="$ev_bindings_failures"
      BINDINGS_FAILURE_COUNT=$(printf '%s' "$BINDINGS_FAILURES_JSON" | jq -r 'length' 2>/dev/null || printf '0')
      # A wrong-value binding check is still blocked even when the emitter
      # reported no reasons, so the failure count can never understate the gate.
      if [ "${BINDINGS_FAILURE_COUNT:-0}" -lt 1 ]; then
        BINDINGS_FAILURE_COUNT=1
      fi
    fi

    all_verified=true
    for spec in "$FQ_VERIFIER|$VERIFIER" "$FQ_REGISTRY|$REGISTRY" "$FQ_PROTOCOL|$PROTOCOL"; do
      fqn="${spec%%|*}"
      addr="${spec##*|}"
      ev_status=$(jq -r --arg n "$fqn" '(.contracts[]? | select(.fullyQualifiedName == $n) | .status) // empty' "$EV_FILE" 2>/dev/null || printf '')
      ev_addr=$(jq -r --arg n "$fqn" '(.contracts[]? | select(.fullyQualifiedName == $n) | .address) // empty' "$EV_FILE" 2>/dev/null || printf '')

      if [ "$ev_status" = "verified" ] && \
         [ "$(normalize_addr_word "$ev_addr")" = "$(normalize_addr_word "$addr")" ]; then
        SOURCE_VERIFICATION_BY_FQ["$fqn"]="verified"
        pass "Source verification evidence: $fqn verified"
      else
        SOURCE_VERIFICATION_BY_FQ["$fqn"]="unverified"
        record_failure "SOURCE_VERIFICATION_UNVERIFIED:$fqn"
        all_verified=false
      fi
    done
    if [ "$all_verified" = true ]; then
      SOURCE_VERIFICATION_STATUS="verified"
      if [ -n "$EXPLORER" ]; then
        SOURCE_VERIFICATION_URL="$(redact_url "$EXPLORER")/address/$PROTOCOL"
      fi
    fi
  fi
fi

# ── 9. Source provenance ─────────────────────────────────────────────────────
section "9. Source Provenance"

COMMIT=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')
pass "Commit: $COMMIT"
pass "Compiler: solc $SOLC_VERSION, optimizer=$OPTIMIZER, runs=$OPTIMIZER_RUNS, via-ir=$VIA_IR"

# ── 10. Status decision ──────────────────────────────────────────────────────
section "10. Provenance Status"

# Every numeric field that is about to serialize as JSON `null` gets an explicit
# stable reason code here. `json_number_or_null` refuses to invent a `0`, so a
# missing figure is always visible in incompleteReasons and always blocks final.
require_number "$CHAIN_ID"        "CHAIN_ID_UNREADABLE"
require_number "$FINALIZED_BLOCK" "FINALIZED_BLOCK_UNREADABLE"
require_number "$OPTIMIZER_RUNS"  "OPTIMIZER_RUNS_UNREADABLE"
for label in p256Verifier passkeyRegistry deliveryProtocol; do
  require_number "${RCPT_BLOCK[$label]:-}" "RECEIPT_BLOCK_UNREADABLE:$label"
  require_number "${CODE_LEN[$label]:-}"   "RUNTIME_CODE_LENGTH_UNREADABLE:$label"
done
require_number "$TOKEN_DECIMALS"   "TOKEN_DECIMALS_UNREADABLE"
require_number "$MAX_LIFETIME_DEC" "BINDING_UNREADABLE:maxVerdictLifetime"

# `final` requires: two distinct RPCs that agree, finalized receipts for all
# three contracts, matching immutable bindings, decoded constructor args,
# matching token identity and RP ID hash, and explicit source-verification
# evidence for all three contracts. Nothing else promotes a draft.
STATUS="draft"

if [ "$CHAIN_OK" != true ]; then
  record_note "Blocking: chain ID was not independently confirmed as 10143 by both RPCs."
elif [ "$RPC_CONFIG_OK" != true ]; then
  record_note "Blocking: two configured, distinct, credential-free RPC endpoints are required."
elif [ "${#REASONS[@]}" -gt 0 ]; then
  record_note "Blocking: ${#REASONS[@]} unresolved reason(s) — see incompleteReasons."
else
  STATUS="final"
  pass "All checks passed — provenance is FINAL"
fi

if [ "$STATUS" = "draft" ]; then
  record_note "Provenance is DRAFT. It is not evidence of a verified Testnet deployment."
fi

# ── 11. Write the record ─────────────────────────────────────────────────────
section "11. Writing Provenance Record"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
OUT_DIR=$(dirname "$OUT")

# Writability is proved WITHOUT creating or truncating the destination: `touch
# "$OUT"` would leave a 0-byte file at $OUT even when record construction later
# fails, which a downstream reader could mistake for a valid (empty) record.
# Instead, create a sibling temp file and rename over the destination only once
# the complete JSON exists. A failure anywhere below therefore leaves an
# existing destination byte-for-byte intact and a nonexistent destination
# nonexistent.
if [ ! -d "$OUT_DIR" ]; then
  echo "ERROR: output directory does not exist: $OUT_DIR" >&2
  exit 3
fi
if ! OUT_TMP=$(mktemp "$OUT_DIR/.provenance.XXXXXX" 2>/dev/null); then
  echo "ERROR: output directory is not writable: $OUT_DIR" >&2
  exit 3
fi
trap 'rm -f "$OUT_TMP"' EXIT

REASONS_JSON=$(json_string_array ${REASONS[@]+"${REASONS[@]}"})
NOTES_JSON=$(json_string_array ${NOTES[@]+"${NOTES[@]}"})
FQ_JSON=$(jq -n \
  --arg v "${SOURCE_VERIFICATION_BY_FQ[$FQ_VERIFIER]:-unverified}" \
  --arg r "${SOURCE_VERIFICATION_BY_FQ[$FQ_REGISTRY]:-unverified}" \
  --arg p "${SOURCE_VERIFICATION_BY_FQ[$FQ_PROTOCOL]:-unverified}" \
  --arg vn "$FQ_VERIFIER" --arg rn "$FQ_REGISTRY" --arg pn "$FQ_PROTOCOL" \
  '{($vn): $v, ($rn): $r, ($pn): $p}')

jq -n \
  --arg schema "xyx.delivery.provenance" \
  --arg status "$STATUS" \
  --arg timestamp "$TIMESTAMP" \
  --argjson chainId "$(json_number_or_null "$CHAIN_ID")" \
  --arg commit "$COMMIT" \
  --arg solc "$SOLC_VERSION" \
  --argjson optimizer "$(json_bool "$OPTIMIZER")" \
  --argjson optimizerRuns "$(json_number_or_null "$OPTIMIZER_RUNS")" \
  --argjson viaIr "$(json_bool "$VIA_IR")" \
  --arg primaryRpc "$(redact_url "$PRIMARY_RPC")" \
  --arg secondaryRpc "$(redact_url "$SECONDARY_RPC")" \
  --arg rpcAgreement "$( [ "$RPC_CONFIG_OK" = true ] && printf 'dual' || printf 'none' )" \
  --argjson finalizedBlock "$(json_number_or_null "$FINALIZED_BLOCK")" \
  --arg verifier "$VERIFIER" \
  --arg verifierTx "$VERIFIER_TX" \
  --arg verifierBlock "${RCPT_BLOCK[p256Verifier]:-}" \
  --arg verifierBlockHash "${RCPT_BLOCK_HASH[p256Verifier]:-}" \
  --arg verifierStatus "${RCPT_STATUS[p256Verifier]:-}" \
  --argjson verifierFinalized "$(json_bool "${RCPT_FINALIZED[p256Verifier]:-false}")" \
  --arg verifierCodeHash "${CODE_HASH[p256Verifier]:-}" \
  --argjson verifierCodeLen "$(json_number_or_null "${CODE_LEN[p256Verifier]:-}")" \
  --arg verifierCtor "${CTOR_ARGS[p256Verifier]:-0x}" \
  --argjson verifierCtorMatch "$(json_bool "${CTOR_MATCH[p256Verifier]:-false}")" \
  --arg verifierSource "${SOURCE_VERIFICATION_BY_FQ[$FQ_VERIFIER]:-unverified}" \
  --arg registry "$REGISTRY" \
  --arg registryTx "$REGISTRY_TX" \
  --arg registryBlock "${RCPT_BLOCK[passkeyRegistry]:-}" \
  --arg registryBlockHash "${RCPT_BLOCK_HASH[passkeyRegistry]:-}" \
  --arg registryStatus "${RCPT_STATUS[passkeyRegistry]:-}" \
  --argjson registryFinalized "$(json_bool "${RCPT_FINALIZED[passkeyRegistry]:-false}")" \
  --arg registryCodeHash "${CODE_HASH[passkeyRegistry]:-}" \
  --argjson registryCodeLen "$(json_number_or_null "${CODE_LEN[passkeyRegistry]:-}")" \
  --arg registryCtor "${CTOR_ARGS[passkeyRegistry]:-0x}" \
  --argjson registryCtorMatch "$(json_bool "${CTOR_MATCH[passkeyRegistry]:-false}")" \
  --arg registrySource "${SOURCE_VERIFICATION_BY_FQ[$FQ_REGISTRY]:-unverified}" \
  --arg protocol "$PROTOCOL" \
  --arg protocolTx "$PROTOCOL_TX" \
  --arg protocolBlock "${RCPT_BLOCK[deliveryProtocol]:-}" \
  --arg protocolBlockHash "${RCPT_BLOCK_HASH[deliveryProtocol]:-}" \
  --arg protocolStatus "${RCPT_STATUS[deliveryProtocol]:-}" \
  --argjson protocolFinalized "$(json_bool "${RCPT_FINALIZED[deliveryProtocol]:-false}")" \
  --arg protocolCodeHash "${CODE_HASH[deliveryProtocol]:-}" \
  --argjson protocolCodeLen "$(json_number_or_null "${CODE_LEN[deliveryProtocol]:-}")" \
  --arg protocolCtor "${CTOR_ARGS[deliveryProtocol]:-0x}" \
  --argjson protocolCtorMatch "$(json_bool "${CTOR_MATCH[deliveryProtocol]:-false}")" \
  --arg protocolSource "${SOURCE_VERIFICATION_BY_FQ[$FQ_PROTOCOL]:-unverified}" \
  --arg token "${TOKEN:-}" \
  --arg tokenSymbol "$TOKEN_SYMBOL" \
  --argjson tokenDecimals "$(json_number_or_null "$TOKEN_DECIMALS")" \
  --arg rpId "${RP_ID:-}" \
  --arg rpIdHash "${onchain_rp_hash:-}" \
  --argjson maxVerdictLifetime "$(json_number_or_null "$MAX_LIFETIME_DEC")" \
  --arg verifierFq "$FQ_VERIFIER" \
  --arg registryFq "$FQ_REGISTRY" \
  --arg protocolFq "$FQ_PROTOCOL" \
  --arg verificationStatus "$SOURCE_VERIFICATION_STATUS" \
  --arg verificationEvidence "$SOURCE_VERIFICATION_EVIDENCE" \
  --arg verificationUrl "$SOURCE_VERIFICATION_URL" \
  --argjson verificationByContract "$FQ_JSON" \
  --arg bindingsStatus "$BINDINGS_STATUS" \
  --arg bindingsFailureCount "$BINDINGS_FAILURE_COUNT" \
  --argjson bindingsFailures "$BINDINGS_FAILURES_JSON" \
  --argjson incompleteReasons "$REASONS_JSON" \
  --argjson notes "$NOTES_JSON" \
  '{
    schema: $schema,
    status: $status,
    generatedAt: $timestamp,
    chainId: $chainId,
    evidence: {
      rpcAgreement: $rpcAgreement,
      primaryRpc: $primaryRpc,
      secondaryRpc: $secondaryRpc,
      finalizedBlock: $finalizedBlock
    },
    commit: $commit,
    compiler: {
      solc: $solc,
      optimizer: $optimizer,
      optimizerRuns: $optimizerRuns,
      viaIr: $viaIr
    },
    contracts: {
      p256Verifier: {
        fullyQualifiedName: $verifierFq,
        address: $verifier,
        deploymentTx: $verifierTx,
        blockNumber: (if $verifierBlock == "" then null else ($verifierBlock | tonumber) end),
        blockHash: (if $verifierBlockHash == "" then null else $verifierBlockHash end),
        receiptStatus: (if $verifierStatus == "" then null else $verifierStatus end),
        finalized: $verifierFinalized,
        runtimeCodeHash: (if $verifierCodeHash == "" then null else $verifierCodeHash end),
        runtimeCodeLength: $verifierCodeLen,
        constructorArgs: $verifierCtor,
        constructorArgsMatchOnChainBindings: $verifierCtorMatch,
        sourceVerification: $verifierSource
      },
      passkeyRegistry: {
        fullyQualifiedName: $registryFq,
        address: $registry,
        deploymentTx: $registryTx,
        blockNumber: (if $registryBlock == "" then null else ($registryBlock | tonumber) end),
        blockHash: (if $registryBlockHash == "" then null else $registryBlockHash end),
        receiptStatus: (if $registryStatus == "" then null else $registryStatus end),
        finalized: $registryFinalized,
        runtimeCodeHash: (if $registryCodeHash == "" then null else $registryCodeHash end),
        runtimeCodeLength: $registryCodeLen,
        constructorArgs: $registryCtor,
        constructorArgsMatchOnChainBindings: $registryCtorMatch,
        rpIdHash: (if $rpIdHash == "" then null else $rpIdHash end),
        p256Verifier: $verifier,
        sourceVerification: $registrySource
      },
      deliveryProtocol: {
        fullyQualifiedName: $protocolFq,
        address: $protocol,
        deploymentTx: $protocolTx,
        blockNumber: (if $protocolBlock == "" then null else ($protocolBlock | tonumber) end),
        blockHash: (if $protocolBlockHash == "" then null else $protocolBlockHash end),
        receiptStatus: (if $protocolStatus == "" then null else $protocolStatus end),
        finalized: $protocolFinalized,
        runtimeCodeHash: (if $protocolCodeHash == "" then null else $protocolCodeHash end),
        runtimeCodeLength: $protocolCodeLen,
        constructorArgs: $protocolCtor,
        constructorArgsMatchOnChainBindings: $protocolCtorMatch,
        paymentToken: $token,
        passkeyRegistry: $registry,
        maxVerdictLifetime: $maxVerdictLifetime,
        sourceVerification: $protocolSource
      }
    },
    bindings: {
      protocolPaymentToken: $token,
      protocolPasskeyRegistry: $registry,
      registryP256Verifier: $verifier,
      registryRpIdHash: (if $rpIdHash == "" then null else $rpIdHash end),
      protocolMaxVerdictLifetime: $maxVerdictLifetime
    },
    token: {
      address: $token,
      symbol: $tokenSymbol,
      decimals: $tokenDecimals
    },
    sourceVerification: {
      status: $verificationStatus,
      evidenceFile: (if $verificationEvidence == "" then null else $verificationEvidence end),
      explorerUrl: (if $verificationUrl == "" then null else $verificationUrl end),
      contracts: $verificationByContract,
      bindings: {
        status: $bindingsStatus,
        failureCount: ($bindingsFailureCount | tonumber),
        failures: $bindingsFailures
      }
    },
    # `verified` requires BOTH a verified source for all three contracts AND
    # verified immutable bindings. It is deliberately not a synonym for
    # `sourceVerification.status`, because that status alone would be true for a
    # verified contract wired to the wrong registry.
    verified: (($verificationStatus == "verified") and ($bindingsStatus == "verified")),
    incompleteReasons: $incompleteReasons,
    notes: $notes
  }' > "$OUT_TMP" || {
    # jq failed. The destination was never touched, so remove only our temp file
    # and exit nonzero: a pre-existing record survives byte-for-byte and a
    # nonexistent destination stays nonexistent.
    echo "ERROR: provenance record construction failed; $OUT was not modified" >&2
    exit 4
  }

# The complete record now exists at OUT_TMP. An atomic rename is the point at
# which the destination changes, so the destination is never observed partial.
mv -f "$OUT_TMP" "$OUT"
trap - EXIT

echo ""
echo "Provenance written to: $OUT"
echo "Status: $STATUS"
echo ""

if [ "$STATUS" = "draft" ]; then
  echo "NOTE: Provenance is DRAFT and exits nonzero. It becomes FINAL only when:"
  echo "  1. MONAD_RPC_URL_PRIMARY and MONAD_RPC_URL_SECONDARY are set, distinct, and credential-free"
  echo "  2. Both RPCs independently agree on chain ID 10143"
  echo "  3. All three deployment receipts are present, successful, and finalized"
  echo "  4. Runtime bytecode is present for all three contracts and agreed by both RPCs"
  echo "  5. All immutable bindings match and all constructor args decode to them"
  echo "  6. The payment token reports 6 decimals from both RPCs"
  echo "  7. XYX_RP_ID hashes to the on-chain rpIdHash()"
  echo "  8. Source verification evidence exists for all three contracts"
  echo "  9. The verification evidence reports bindings.status == \"verified\" (a verified contract on the wrong wiring is not releasable)"
  exit 1
fi

echo "Provenance is FINAL. Every fact above was observed from two distinct RPCs."
exit 0
