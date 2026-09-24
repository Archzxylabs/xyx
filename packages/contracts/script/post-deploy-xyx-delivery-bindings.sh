#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# XYX Delivery Post-Deploy Binding Re-Read — READ ONLY
# ─────────────────────────────────────────────────────────────────────────────
# Re-reads immutable bindings, runtime bytecode hashes, and token identity from
# chain AFTER a deployment, and re-checks them against the planned constructor
# inputs. This script performs ZERO writes, ZERO broadcasts, and never touches
# a key.
#
# It does NOT deploy anything and cannot confirm that a deployment happened.
# "BINDINGS_MATCH" means only: the on-chain immutable state that exists right
# now agrees with the planned constructor inputs, as read independently from
# two configured, distinct RPC endpoints. It is not a receipt, not a finality
# claim, and not a source-verification claim.
#
# Usage: ./post-deploy-xyx-delivery-bindings.sh \
#           <verifier_address> <registry_address> <protocol_address>
#
# Environment (all required — there is no "skip validation" path):
#   MONAD_RPC_URL_PRIMARY    Primary RPC endpoint
#   MONAD_RPC_URL_SECONDARY  A second, DISTINCT RPC endpoint
#   MONAD_USDC_ADDRESS       Expected payment token address
#   XYX_RP_ID                Expected RP ID string
#   BINDINGS_OUT             Optional path for a machine-readable JSON result
#
# Exit codes: 0 = BINDINGS_MATCH, 1 = mismatch or unreadable state,
#             2 = invalid arguments or missing configuration.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

EXPECTED_CHAIN="10143"
# DeployXYXDelivery.s.sol hard-requires a 6-decimal token (TOKEN_WRONG_DECIMALS),
# so this re-read must reject any other figure rather than accept it.
EXPECTED_TOKEN_DECIMALS="6"

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
ZERO_ADDR="0x0000000000000000000000000000000000000000"

arg_error=""
for pair in "verifier address:$VERIFIER" "registry address:$REGISTRY" "protocol address:$PROTOCOL"; do
  IFS=':' read -r label value <<< "$pair"
  if ! printf '%s' "$value" | grep -qE "$ADDR_RE"; then
    arg_error="${arg_error}${arg_error:+; }invalid $label"
  elif [ "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" = "$ZERO_ADDR" ]; then
    arg_error="${arg_error}${arg_error:+; }zero $label"
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
TOKEN="${MONAD_USDC_ADDRESS:-}"
RP_ID="${XYX_RP_ID:-}"
OUT="${BINDINGS_OUT:-}"

# ── Reason accumulation (never aborts the script) ────────────────────────────
declare -a REASONS=()

record_failure() {
  REASONS+=("$1")
  echo "  FAIL  $1" >&2
}

pass() { echo "  PASS  $1"; }
section() { echo ""; echo "── $1 ──"; }

# ── Pure helpers ─────────────────────────────────────────────────────────────
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
# Exactly `0x` + 64 hex characters is accepted. A truncated word, a longer
# word, an empty value, a multi-word response, or any non-hex character is a
# decode failure (empty output), never a value to coerce — otherwise a
# malformed RPC response would become a decimals figure the token never sent.
# `cast --to-dec` is arbitrary precision, so a huge uint cannot wrap.
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

# Best-effort decode of an ABI `string` return. Only a well-formed
# offset/length/data triple is decoded; anything else is reported empty so the
# caller keeps the raw response (or "unreadable") instead of inventing a symbol.
# An ERC-20 symbol() converts to a 192-hex-char response, so this path is the
# normal one, not an edge case.
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

json_number() {
  case "${1:-}" in
    ''|*[!0-9]*) printf '0' ;;
    *) printf '%s' "$1" ;;
  esac
}

json_string_array() {
  if [ "$#" -eq 0 ]; then
    printf '[]'
    return 0
  fi
  printf '%s\n' "$@" | jq -R . | jq -s .
}

# Strip query string and fragment so an RPC URL carrying a token is never echoed.
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
echo "=== XYX Delivery Post-Deploy Binding Re-Read ==="
echo "Verifier:  $VERIFIER"
echo "Registry:  $REGISTRY"
echo "Protocol:  $PROTOCOL"
echo ""

# ── 0. RPC and expected-input configuration ──────────────────────────────────
section "0. RPC and Expected-Input Configuration"

RPC_CONFIG_OK=true

for pair in "PRIMARY:$PRIMARY_RPC" "SECONDARY:$SECONDARY_RPC"; do
  IFS=':' read -r label url <<< "$pair"
  if [ -z "$url" ]; then
    record_failure "RPC_${label}_MISSING"
    RPC_CONFIG_OK=false
  elif ! printf '%s' "$url" | grep -qE '^https?://'; then
    record_failure "RPC_${label}_URL_INVALID"
    RPC_CONFIG_OK=false
  elif printf '%s' "$url" | grep -qE '^[a-z]+://[^/]*@'; then
    record_failure "RPC_${label}_URL_CONTAINS_CREDENTIALS"
    RPC_CONFIG_OK=false
  fi
done

if [ -n "$PRIMARY_RPC" ] && [ -n "$SECONDARY_RPC" ] && [ "$PRIMARY_RPC" = "$SECONDARY_RPC" ]; then
  record_failure "RPC_NOT_DISTINCT"
  RPC_CONFIG_OK=false
fi

if [ "$RPC_CONFIG_OK" = true ]; then
  pass "Two distinct RPC endpoints configured: $(redact_url "$PRIMARY_RPC") / $(redact_url "$SECONDARY_RPC")"
else
  echo "  NOTE  A binding re-read requires two configured, distinct, credential-free RPC endpoints." >&2
fi

if [ -z "$TOKEN" ]; then
  record_failure "TOKEN_ADDRESS_MISSING"
elif ! printf '%s' "$TOKEN" | grep -qE "$ADDR_RE"; then
  record_failure "TOKEN_ADDRESS_INVALID"
elif [ "$(lower "$TOKEN")" = "$ZERO_ADDR" ]; then
  record_failure "TOKEN_ADDRESS_ZERO"
else
  pass "Expected payment token: $TOKEN"
fi

if [ -z "$RP_ID" ]; then
  record_failure "RP_ID_MISSING"
elif printf '%s' "$RP_ID" | grep -qE '[/:\\]'; then
  record_failure "RP_ID_NOT_HOST_ONLY"
else
  pass "Expected RP ID: $RP_ID"
fi

# ── Dual-RPC read primitive ──────────────────────────────────────────────────
# dual_cast <what> <cast args...>
# Runs `cast <args...>` against BOTH configured RPCs. Sets DUAL_PRIMARY and
# DUAL_SECONDARY to the raw stdout of each and DUAL_OK=1 only when both
# answered with byte-identical output. Every failure mode is recorded; this
# function never aborts the script.
dual_cast() {
  local what="$1"
  shift
  DUAL_PRIMARY=""
  DUAL_SECONDARY=""
  DUAL_OK=0

  if [ "$RPC_CONFIG_OK" != true ]; then
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

if dual_cast "chain-id" chain-id; then
  chain_id=$(first_token "$DUAL_PRIMARY")
  if [ "$chain_id" = "$EXPECTED_CHAIN" ]; then
    pass "Both RPCs independently report chain ID $EXPECTED_CHAIN"
  else
    record_failure "CHAIN_ID_MISMATCH:$chain_id"
  fi
fi

# ── 2. Runtime bytecode presence and hash (dual-RPC agreement) ───────────────
section "2. Runtime Bytecode"

declare -A CODE_HASH=()
declare -A CODE_LEN=()

for spec in "p256Verifier:$VERIFIER" "passkeyRegistry:$REGISTRY" "deliveryProtocol:$PROTOCOL"; do
  IFS=':' read -r label addr <<< "$spec"
  if ! dual_cast "code:$label" code "$addr"; then
    continue
  fi
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
  pass "$label runtime code present, agreed hash $hash (${CODE_LEN[$label]} bytes)"
done

# ── 3. Immutable bindings (dual-RPC agreement, normalized comparison) ────────
section "3. Immutable Bindings"

declare -A BINDING=()

binding_read() {
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
onchain_max_lifetime=$(binding_read "maxVerdictLifetime" "$PROTOCOL" "maxVerdictLifetime()" || true)
onchain_verifier=$(binding_read "p256Verifier" "$REGISTRY" "p256Verifier()" || true)
onchain_rp_hash=$(binding_read "rpIdHash" "$REGISTRY" "rpIdHash()" || true)

echo "  Protocol.paymentToken():       $onchain_token"
echo "  Protocol.passkeyRegistry():    $onchain_registry"
echo "  Protocol.maxVerdictLifetime(): $onchain_max_lifetime"
echo "  Registry.p256Verifier():       $onchain_verifier"
echo "  Registry.rpIdHash():           $onchain_rp_hash"

if [ -z "$onchain_token" ]; then
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
  pass "Registry.rpIdHash() is non-zero: $onchain_rp_hash"
fi

MAX_LIFETIME_DEC=""
if [ -z "$onchain_max_lifetime" ]; then
  record_failure "BINDING_UNREADABLE:maxVerdictLifetime"
else
  MAX_LIFETIME_DEC=$(hex_word_to_dec "$onchain_max_lifetime")
  if [ -z "$MAX_LIFETIME_DEC" ]; then
    record_failure "BINDING_UNDECODABLE:maxVerdictLifetime"
  elif [ "$MAX_LIFETIME_DEC" = "0" ]; then
    record_failure "BINDING_ZERO:maxVerdictLifetime"
  else
    pass "Protocol.maxVerdictLifetime() = $MAX_LIFETIME_DEC seconds"
  fi
fi

# ── 4. RP ID hash cross-check ───────────────────────────────────────────────
section "4. RP ID Hash Cross-Check"

if [ -z "$RP_ID" ]; then
  record_failure "RP_ID_MISSING"
elif [ -z "$onchain_rp_hash" ]; then
  record_failure "RP_ID_HASH_UNREADABLE"
else
  expected_rp_hash="0x$(printf '%s' "$RP_ID" | sha256sum | awk '{print $1}')"
  if [ "$(lower "$expected_rp_hash")" != "$(lower "$onchain_rp_hash")" ]; then
    record_failure "RP_ID_HASH_MISMATCH"
  else
    pass "RP ID hash matches on-chain rpIdHash(): $onchain_rp_hash"
  fi
fi

# ── 5. Token identity (dual-RPC, strict ABI-word decimals decoding) ──────────
section "5. Token Identity"

TOKEN_SYMBOL="unreadable"
TOKEN_DECIMALS=""

if [ -z "$TOKEN" ]; then
  record_failure "TOKEN_ADDRESS_MISSING"
elif ! dual_cast "token-code" code "$TOKEN"; then
  :
else
  token_code=$(first_token "$DUAL_PRIMARY")
  if [ -z "$token_code" ] || [ "$token_code" = "0x" ] || [ "${#token_code}" -le 2 ]; then
    record_failure "TOKEN_CODE_MISSING"
  else
    pass "Token has runtime bytecode at $TOKEN"
  fi

  token_symbol_raw=""
  if dual_cast "token-symbol" call "$TOKEN" "symbol()"; then
    token_symbol_raw=$(first_token "$DUAL_PRIMARY")
  fi
  # A real `cast call` decodes an ERC-20 symbol() as an ABI `string`, i.e. a
  # head/tail triple (offset / length / bytes-padded) that the call spans
  # 192 hex chars across — NOT a bare symbol. Recording the raw words here would
  # write `0x…0020` into the machine-readable record as the token symbol, so
  # decode it the same strict way the provenance recorder does, and fall back to
  # the raw response only when it cannot be decoded.
  decoded_symbol=$(abi_decode_string "$token_symbol_raw")
  if [ -n "$decoded_symbol" ]; then
    TOKEN_SYMBOL="$decoded_symbol"
  else
    TOKEN_SYMBOL="${token_symbol_raw:-unreadable}"
  fi

  token_decimals_raw=""
  if dual_cast "token-decimals" call "$TOKEN" "decimals()"; then
    token_decimals_raw=$(first_token "$DUAL_PRIMARY")
  fi
  echo "  Token: $TOKEN_SYMBOL (decimals response: ${token_decimals_raw:-unreadable})"

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

# ── 6. Result ────────────────────────────────────────────────────────────────
section "6. Binding Re-Read Result"

if [ "${#REASONS[@]}" -eq 0 ]; then
  RESULT="BINDINGS_MATCH"
  echo "BINDINGS_MATCH"
  echo ""
  echo "Verifier:  $VERIFIER"
  echo "Registry:  $REGISTRY (rpIdHash=$onchain_rp_hash, verifier=$onchain_verifier)"
  echo "Protocol:  $PROTOCOL (token=$onchain_token, registry=$onchain_registry, maxVerdictLifetime=$MAX_LIFETIME_DEC)"
  echo ""
  echo "On-chain immutable state agrees with the planned constructor inputs, as read"
  echo "independently from two distinct RPC endpoints. This is a binding re-read only:"
  echo "it is not a receipt, not a finality claim, and not source verification."
else
  RESULT="BINDINGS_MISMATCH"
  echo "BINDINGS_MISMATCH"
  echo ""
  # Distinct checks can independently record the same code: an absent payment
  # token address is reported both while validating arguments and again while
  # re-reading on-chain state. Emit each reason once, in first-seen order, so a
  # consumer can count the reasons array without deduplicating it first.
  declare -a UNIQUE_REASONS=()
  for reason in ${REASONS[@]+"${REASONS[@]}"}; do
    duplicate=false
    for prior in ${UNIQUE_REASONS[@]+"${UNIQUE_REASONS[@]}"}; do
      if [ "$reason" = "$prior" ]; then duplicate=true; break; fi
    done
    if [ "$duplicate" = false ]; then UNIQUE_REASONS+=("$reason"); fi
  done
  for reason in ${UNIQUE_REASONS[@]+"${UNIQUE_REASONS[@]}"}; do
    echo "REASON=$reason"
  done
fi

if [ -n "$OUT" ]; then
  reasons_json=$(json_string_array ${UNIQUE_REASONS[@]+"${UNIQUE_REASONS[@]}"})
  jq -n \
    --arg result "$RESULT" \
    --arg verifier "$VERIFIER" \
    --arg registry "$REGISTRY" \
    --arg protocol "$PROTOCOL" \
    --arg verifierCodeHash "${CODE_HASH[p256Verifier]:-}" \
    --arg registryCodeHash "${CODE_HASH[passkeyRegistry]:-}" \
    --arg protocolCodeHash "${CODE_HASH[deliveryProtocol]:-}" \
    --arg rpIdHash "${onchain_rp_hash:-}" \
    --argjson maxVerdictLifetime "$(json_number "$MAX_LIFETIME_DEC")" \
    --arg token "${TOKEN:-}" \
    --arg tokenSymbol "$TOKEN_SYMBOL" \
    --argjson tokenDecimals "$(json_number "$TOKEN_DECIMALS")" \
    --argjson reasons "$reasons_json" \
    '{
      result: $result,
      contracts: {
        p256Verifier: {address: $verifier, runtimeCodeHash: (if $verifierCodeHash == "" then null else $verifierCodeHash end)},
        passkeyRegistry: {address: $registry, runtimeCodeHash: (if $registryCodeHash == "" then null else $registryCodeHash end)},
        deliveryProtocol: {address: $protocol, runtimeCodeHash: (if $protocolCodeHash == "" then null else $protocolCodeHash end)}
      },
      bindings: {
        protocolPaymentToken: $token,
        protocolPasskeyRegistry: $registry,
        registryP256Verifier: $verifier,
        registryRpIdHash: (if $rpIdHash == "" then null else $rpIdHash end),
        protocolMaxVerdictLifetime: $maxVerdictLifetime
      },
      token: {address: $token, symbol: $tokenSymbol, decimals: $tokenDecimals},
      reasons: $reasons
    }' > "$OUT"
  echo ""
  echo "Machine-readable result written to: $OUT"
fi

if [ "$RESULT" = "BINDINGS_MATCH" ]; then
  exit 0
fi
exit 1
