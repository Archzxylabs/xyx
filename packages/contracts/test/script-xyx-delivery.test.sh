#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Offline tests for XYX delivery shell scripts
# Uses temporary directory with mocked cast/forge/jq/bash utilities.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This suite lives at packages/contracts/test, so the repository root is THREE
# levels up, not two. Resolving only two levels lands on packages/, which makes
# every path built from PROJECT_ROOT (the contracts root, the artifact directory)
# point at nonexistent locations and the tests that depend on them vacuous.
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# The canonical Foundry root the scripts under test must pass to every forge
# invocation. Exported because the mock forge validates --root against it.
export MOCK_CONTRACTS_ROOT="$PROJECT_ROOT/packages/contracts"

# Scripts under test (in the script/ directory, one level up from this test dir)
SCRIPT_BASE="$(cd "$SCRIPT_DIR/../script" && pwd)"
PREFLIGHT="$SCRIPT_BASE/preflight-xyx-delivery.sh"
VERIFY="$SCRIPT_BASE/verify-xyx-delivery.sh"
PROVENANCE="$SCRIPT_BASE/record-xyx-delivery-provenance.sh"
BINDINGS="$SCRIPT_BASE/post-deploy-xyx-delivery-bindings.sh"

PASS=0
FAIL=0
TOTAL=0

passed() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
}

failed() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
}

section() {
  echo ""
  echo "── $1 ──"
}

# ── forge verify-contract invocation accounting ──────────────────────────────
# The mock forge appends one "<address> <fully-qualified-name>" line per
# invocation to $MOCK_STATE_DIR/verify-invocations.log. These helpers read that
# log so a test can prove the script submitted each contract exactly once
# instead of re-submitting it on a timer to "poll".
invocation_count() {
  local log="$1" addr="$2"
  if [ ! -f "$log" ]; then
    printf '0'
    return 0
  fi
  printf '%s' "$(grep -c "^$addr " "$log" 2>/dev/null || true)"
}

invocation_total() {
  local log="$1"
  if [ ! -f "$log" ]; then
    printf '0'
    return 0
  fi
  printf '%s' "$(grep -c . "$log" 2>/dev/null || true)"
}

# ── Mock utility setup ───────────────────────────────────────────────────────
setup_mock_dir() {
  local mock_dir="$1"
  mkdir -p "$mock_dir/bin"

  # mock cast
  cat > "$mock_dir/bin/cast" <<'CAST_EOF'
#!/usr/bin/env bash
# Mock cast: reads state from $MOCK_STATE_DIR, handles --rpc-url flags
STATE_DIR="${MOCK_STATE_DIR:-}"
if [ -z "$STATE_DIR" ]; then
  echo "ERROR: MOCK_STATE_DIR not set" >&2
  exit 1
fi

# Arbitrary-precision hex -> decimal. Real `cast --to-dec` is arbitrary
# precision; bash arithmetic is 64-bit and would silently wrap a large uint
# (e.g. maxVerdictLifetime = 2**200) into a plausible-looking wrong number,
# which would make the provenance numeric tests vacuous.
hex_to_dec() {
  local h="${1:-}"
  h="${h#0x}"
  h="${h#0X}"
  h=$(printf '%s' "$h" | tr '[:upper:]' '[:lower:]')
  case "$h" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  while [ "${#h}" -gt 1 ] && [ "${h:0:1}" = "0" ]; do
    h="${h:1}"
  done
  if [ "$h" = "0" ]; then
    printf '0'
    return 0
  fi
  # Decimal big-int: dec = dec*16 + digit, holding dec as a digit array.
  local digits=() i j d carry v out
  for ((i = 0; i < ${#h}; i++)); do
    d=$((16#${h:i:1}))
    carry=$d
    for ((j = ${#digits[@]} - 1; j >= 0; j--)); do
      v=$(( digits[j] * 16 + carry ))
      digits[j]=$(( v % 10 ))
      carry=$(( v / 10 ))
    done
    while [ "$carry" -gt 0 ]; do
      digits=("$(( carry % 10 ))" ${digits[@]+"${digits[@]}"})
      carry=$(( carry / 10 ))
    done
  done
  out=""
  for ((j = 0; j < ${#digits[@]}; j++)); do
    out+="${digits[j]}"
  done
  printf '%s' "$out"
}

# Strip --rpc-url and its value
filtered=()
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc-url) shift 2 ;;
    *) filtered+=("$1"); shift ;;
  esac
done
set -- "${filtered[@]}"

cmd="${1:-}"
shift || true

case "$cmd" in
  chain-id)
    cat "$STATE_DIR/chain-id.txt" 2>/dev/null || echo "10143"
    ;;
  --to-dec)
    # Real `cast --to-dec` converts a hex word to a decimal integer.
    v="${1:-}"
    if hex_to_dec "$v"; then
      echo
    else
      exit 1
    fi
    ;;
  code)
    addr="${1:-}"
    echo "$addr" | grep -qi '0x0000000000000000000000000000000000000000' && echo "0x" && exit 0
    cat "$STATE_DIR/bytecode-${addr}.hex" 2>/dev/null || echo "0x60806040526004361015610011575f80fd5b"
    ;;
  call)
    addr="${1:-}"
    method="${2:-}"
    case "$method" in
      "paymentToken()") cat "$STATE_DIR/call-paymentToken.txt" 2>/dev/null || echo "$addr" ;;
      "passkeyRegistry()") cat "$STATE_DIR/call-passkeyRegistry.txt" 2>/dev/null || echo "$addr" ;;
      "p256Verifier()") cat "$STATE_DIR/call-p256Verifier.txt" 2>/dev/null || echo "$addr" ;;
      "rpIdHash()") cat "$STATE_DIR/call-rpIdHash.txt" 2>/dev/null || echo "0x$(echo -n 'xyx.local' | sha256sum | awk '{print $1}')" ;;
      "maxVerdictLifetime()") cat "$STATE_DIR/call-maxVerdictLifetime.txt" 2>/dev/null || echo "0x0000000000000000000000000000000000000000000000000000000000000384" ;;
      "decimals()") cat "$STATE_DIR/call-decimals.txt" 2>/dev/null || echo "0x0000000000000000000000000000000000000000000000000000000000000006" ;;
      # Real `cast call` decodes an ERC-20 `symbol()` return as an ABI
      # `string`, which is a head/tail triple: word 1 = 0x20 (data offset),
      # word 2 = byte length, word 3 = the bytes right-padded into the word.
      # A mock that echoed the bare text would hand preflight a value that its
      # strict ABI decoder must reject — so the mock, not the script, would be
      # the thing manufacturing the failure. "USDC" encodes to 192 hex chars.
      "symbol()")
        if [ -f "$STATE_DIR/call-symbol.txt" ]; then
          cat "$STATE_DIR/call-symbol.txt"
        else
          printf '0x%064x%064x' 32 4
          printf '55534443%058d' 0
          echo
        fi
        ;;
      # Real `cast call <token> balanceOf(address) <holder>` returns one
      # ABI-encoded uint256 word. Without this branch preflight's funder probe
      # sees an empty reply and reports a failure for a token that is, in the
      # mock's own world, funded — again a mock-manufactured failure.
      "balanceOf(address)")
        holder="${3:-}"
        holder=$(printf '%s' "$holder" | tr '[:upper:]' '[:lower:]')
        if [ -f "$STATE_DIR/call-balance-${holder}.txt" ]; then
          cat "$STATE_DIR/call-balance-${holder}.txt"
        else
          # 1000 units of a 6-decimal token.
          printf '0x%064x' 1000000000
          echo
        fi
        ;;
      *) echo "" ;;
    esac
    ;;
  receipt)
    tx="${1:-}"
    cat "$STATE_DIR/receipt-$tx.json" 2>/dev/null || echo '{"blockNumber":"100","blockHash":"0xabc123","status":"0x1","contractAddress":"0xdeadbeef"}'
    ;;
  tx)
    # Real `cast tx <hash> --json` returns a JSON transaction object whose `input`
    # field is the calldata — for a contract creation, the creation bytecode plus
    # the constructor arguments. record-xyx-delivery-provenance.sh reads `.input`
    # off that object, so a mock that echoed the bare hex made every
    # CONSTRUCTOR_* check fail with INPUT_UNREADABLE and no record could ever be
    # exercised on the path where those checks pass.
    tx="${1:-}"
    in_hex=$(cat "$STATE_DIR/txinput-$tx.txt" 2>/dev/null || printf '')
    if [ -z "$in_hex" ]; then
      # No fixture for this tx. Real cast fails; the script treats that as an
      # unreadable input, which is what a test exercising that path expects.
      echo "Error: transaction $tx not found" >&2
      exit 1
    fi
    jq -nc --arg i "$in_hex" '{input: $i}'
    ;;
  keccak)
    # Deterministic stand-in derived from the actual bytes being hashed. A real
    # keccak256 needs an implementation this suite does not carry, and the old
    # `$RANDOM` made every run emit a different hash for identical input, so no
    # record was ever reproducible. Derived from the input, at least the same
    # bytecode always yields the same recorded hash.
    v="${1:-}"
    printf '0x%s' "$(printf '%s' "$v" | sha256sum | awk '{print $1}')"
    ;;
  block)
    sub="${1:-}"
    case "$sub" in
      finalized)
        echo '{"number":150}'
        ;;
    esac
    ;;
  inspect) echo "mock";;
  *) echo "mock output";;
esac
CAST_EOF
  chmod +x "$mock_dir/bin/cast"

  # mock forge
  #
  # Faithful to the ONE surface this repository is allowed to use:
  #   forge verify-contract --root packages/contracts <address> <fully-qualified-name> \
  #     --chain 10143 --verifier sourcify \
  #     --verifier-url https://sourcify-api-monad.blockvision.org/
  #
  # It parses and VALIDATES every one of those arguments. A mock that ignored
  # --chain, --verifier and --verifier-url would let a script that verified the
  # wrong chain, or through a different route, pass this suite — the mock would
  # be the thing manufacturing the success. Every invocation is also logged, so
  # a test can prove the script submitted each contract exactly once instead of
  # re-submitting it on a timer to "poll".
  #
  # --root is required, absolute, and must equal the canonical contracts root.
  # There is nothing to work around without it: the repository root has no
  # foundry.toml, so `forge verify-contract` invoked from there addresses no
  # project at all. Accepting a wrong root would let the route look right while
  # resolving sources from somewhere else.
  cat > "$mock_dir/bin/forge" <<'FORGE_EOF'
#!/usr/bin/env bash
STATE_DIR="${MOCK_STATE_DIR:-}"
if [ -z "$STATE_DIR" ]; then
  echo "ERROR: MOCK_STATE_DIR not set" >&2
  exit 1
fi

EXPECTED_CHAIN="10143"
EXPECTED_VERIFIER="sourcify"
EXPECTED_VERIFIER_URL="https://sourcify-api-monad.blockvision.org/"
# The etherscan route is explicit opt-in and is the only one carrying a key. The
# mock accepts exactly the key this suite hands the script, so a script that
# dropped the key, substituted one of its own, or leaked a real one cannot pass.
EXPECTED_ETHERSCAN_KEY="${MOCK_ETHERSCAN_API_KEY:-}"

  # The only route carrying a key. The mock accepts exactly the key this suite
  # hands the script, so a script that dropped the key, substituted one of its
  # own, or leaked a real one cannot pass.
EXPECTED_ETHERSCAN_KEY="${MOCK_ETHERSCAN_API_KEY:-}"
# The canonical Foundry root, which every forge invocation must pass as --root.
# Supplied by the suite so the mock is checked against the real absolute path
# the scripts derive, never against a path that merely looks plausible.
EXPECTED_ROOT="${MOCK_CONTRACTS_ROOT:-}"

cmd="${1:-}"

# Shared by both subcommands: parse the --root flag out of $@, leaving the rest
# in `rest`, and reject an invocation that omits it, passes a non-absolute
# value, or passes anything but the canonical root.
#
# The rejection is written to stderr and exits 1 with EMPTY stdout, which is
# exactly what real `forge` does for an unresolvable project root: the callers
# all read stdout under `2>/dev/null`, so an unreadable root surfaces as an
# unreadable artifact rather than as an answer.
require_root() {
  root=""
  rest=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --root)  root="${2:-}"; shift 2 ;;
      --root=*) root="${1#--root=}"; shift ;;
      *) rest+=("$1"); shift ;;
    esac
  done
  if [ -z "$root" ]; then
    echo "Error: no --root given; foundry needs an explicit project root" >&2
    exit 1
  fi
  case "$root" in
    /*) ;;
    *) echo "Error: --root must be an absolute path: $root" >&2; exit 1 ;;
  esac
  if [ "$root" != "$EXPECTED_ROOT" ]; then
    echo "Error: --root $root is not the canonical contracts root ($EXPECTED_ROOT)" >&2
    exit 1
  fi
}

case "$cmd" in
  --version) echo "forge 1.0.0 (mock)" ;;
  verify-contract)
    shift
    require_root "$@"
    set -- "${rest[@]}"

    chain=""
    verifier=""
    verifier_url=""
    api_key=""
    watch_seen="no"
    positional=()

    while [ $# -gt 0 ]; do
      case "$1" in
        --chain)              chain="${2:-}"; shift 2 ;;
        --verifier)           verifier="${2:-}"; shift 2 ;;
        --verifier-url)       verifier_url="${2:-}"; shift 2 ;;
        # Captured so it can be checked against the one this suite issued, and so
        # it is never written to a log, a result file, or stdout.
        --etherscan-api-key)  api_key="${2:-}"; shift 2 ;;
        --watch)              watch_seen="yes"; shift ;;
        --)                   shift
                             while [ $# -gt 0 ]; do positional+=("$1"); shift; done ;;
        -*)                   echo "Error: Unknown flag: $1" >&2; exit 1 ;;
        *)                    positional+=("$1"); shift ;;
      esac
    done

    if [ "${#positional[@]}" -ne 2 ]; then
      echo "Error: Invalid number of arguments" >&2
      exit 1
    fi
    addr="${positional[0]}"
    fqn="${positional[1]}"

    ADDR_RE='^0x[0-9a-fA-F]{40}$'
    if ! printf '%s' "$addr" | grep -qE "$ADDR_RE"; then
      echo "Error: Invalid address: $addr" >&2
      exit 1
    fi
    if [ "$chain" != "$EXPECTED_CHAIN" ]; then
      echo "Error: Invalid chain: $chain (expected $EXPECTED_CHAIN)" >&2
      exit 1
    fi
    if [ "$verifier" != "$EXPECTED_VERIFIER" ] && [ "$verifier" != "etherscan" ]; then
      echo "Error: Invalid verifier: $verifier (expected $EXPECTED_VERIFIER or etherscan)" >&2
      exit 1
    fi
    # The Sourcify endpoint is pinned only on the Sourcify route. The etherscan
    # route is reached through forge's own explorer integration and carries no
    # --verifier-url, so enforcing one there would reject the legitimate route.
    if [ "$verifier" = "$EXPECTED_VERIFIER" ] && [ "$verifier_url" != "$EXPECTED_VERIFIER_URL" ]; then
      echo "Error: Invalid verifier URL: $verifier_url" >&2
      exit 1
    fi
    if [ "$verifier" = "etherscan" ]; then
      # Etherscan/Monadscan is the only route that takes a key, and the only one
      # that needs `--watch`: its verification is asynchronous, so a submission
      # without --watch stops at "submitted" and can never be a terminal answer.
      if [ -z "$api_key" ]; then
        echo "Error: the etherscan verifier requires --etherscan-api-key" >&2
        exit 1
      fi
      if [ "$api_key" != "$EXPECTED_ETHERSCAN_KEY" ]; then
        echo "Error: rejected an etherscan API key this suite did not issue" >&2
        exit 1
      fi
      if [ "$watch_seen" != "yes" ]; then
        echo "Error: the etherscan verifier requires --watch" >&2
        exit 1
      fi
    fi
    case "$fqn" in
      src/MonadP256Verifier.sol:MonadP256Verifier|\
src/XYXPasskeyRegistry.sol:XYXPasskeyRegistry|\
src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol) ;;
      *)
        echo "Error: Unknown contract: $fqn" >&2
        exit 1
        ;;
    esac

    # Log the invocation BEFORE deciding the outcome, so a rejected or
    # non-terminal attempt is still counted. The route flags are recorded too —
    # never the key — so a test can prove --watch was passed on the etherscan
    # route and withheld on the sourcify route.
    echo "$addr $fqn verifier=$verifier watch=$watch_seen" >> "$STATE_DIR/verify-invocations.log"

    ver_file="$STATE_DIR/verified-$addr.txt"
    if [ -f "$ver_file" ]; then
      # Positive TERMINAL response.
      echo "Contract $fqn is already verified at $addr"
      exit 0
    fi

    # Non-terminal response only: the submission was acknowledged. Real forge
    # exits 0 here too, which is exactly why an exit code cannot be read as
    # verification.
    echo "Start verification for ($fqn) $addr"
    echo "Submitted contract for verification:"
    echo "    Response: \`OK\`"
    echo "    GUID: $(printf '%s' "$addr$fqn" | sha256sum | awk '{print $1}')"
    echo "    URL: $EXPECTED_VERIFIER_URL"
    ;;
  inspect)
    # `forge inspect --root <contracts-root> <ContractName> bytecode` returns the
    # compiled creation bytecode, which record-xyx-delivery-provenance.sh uses to
    # confirm the deployment tx input starts with the compiled artifact and to
    # slice out the constructor arguments. A mock that always answered "mock" made
    # every CONSTRUCTOR_* check fail, so no record could be exercised on the path
    # where they pass. The real bytecode lives in creation-<ContractName>.hex; when
    # that file is absent the old non-answer stands, so tests that rely on the
    # artifact being unreadable keep failing that way.
    #
    # require_root runs first, so an invocation with no root, a relative root, or
    # the wrong root is refused before any artifact is consulted — that is what
    # makes `CONSTRUCTOR_ARTIFACT_UNREADABLE` reachable at all.
    require_root "${@:2}"
    set -- "${rest[@]}"
    inspect_contract="${1:-}"
    if [ $# -ne 2 ] || [ "${2:-}" != "bytecode" ]; then
      echo "Error: usage: forge inspect --root <root> <ContractName> bytecode" >&2
      exit 1
    fi
    if [ -f "$STATE_DIR/creation-${inspect_contract}.hex" ]; then
      cat "$STATE_DIR/creation-${inspect_contract}.hex"
    else
      echo "mock"
    fi
    ;;
  *) echo "mock forge output" ;;
esac
FORGE_EOF
  chmod +x "$mock_dir/bin/forge"

  # NOTE: `jq` and `sha256sum` are deliberately NOT mocked. Both are real,
  # deterministic, locally available tools the scripts genuinely depend on:
  # shadowing jq would make every JSON assertion vacuous (and would make the
  # scripts emit a copy of their own jq program text as their "record"), and
  # shadowing sha256sum would make the RP-ID hash cross-check compare two
  # identical fake hashes. `git` and `date` are still mocked so the suite does
  # not depend on repository state or wall-clock time.
  # mock git
  cat > "$mock_dir/bin/git" <<'GIT_EOF'
#!/usr/bin/env bash
cmd="${1:-}"
case "$cmd" in
  -C) shift; PROJECT_ROOT="$1"; shift; cmd="${1:-}" ;;
esac
case "$cmd" in
  rev-parse) echo "abc123def456abc123def456abc123def456abc1" ;;
  diff) echo "" ;;
  *) ;;
esac
GIT_EOF
  chmod +x "$mock_dir/bin/git"

  # mock date
  cat > "$mock_dir/bin/date" <<'DATE_EOF'
#!/usr/bin/env bash
echo "2025-01-15T00:00:00Z"
DATE_EOF
  chmod +x "$mock_dir/bin/date"

  # mock bash for bash -n checks
  cp "$(command -v bash)" "$mock_dir/bin/bash"

  echo "$mock_dir"
}

# ── Create mock state ────────────────────────────────────────────────────────
create_mock_state() {
  local state_dir="$1"
  mkdir -p "$state_dir"
  echo "10143" > "$state_dir/chain-id.txt"

  local verifier_addr="0x1111111111111111111111111111111111111111"
  local registry_addr="0x2222222222222222222222222222222222222222"
  local protocol_addr="0x3333333333333333333333333333333333333333"
  local token_addr="0x4444444444444444444444444444444444444444"
  local rp_hash="0x$(echo -n 'xyx.local' | sha256sum | awk '{print $1}')"

  echo "$token_addr" > "$state_dir/call-paymentToken.txt"
  echo "$registry_addr" > "$state_dir/call-passkeyRegistry.txt"
  echo "$verifier_addr" > "$state_dir/call-p256Verifier.txt"
  echo "$rp_hash" > "$state_dir/call-rpIdHash.txt"
  echo "0x0000000000000000000000000000000000000000000000000000000000000384" > "$state_dir/call-maxVerdictLifetime.txt"
  echo "0x0000000000000000000000000000000000000000000000000000000000000006" > "$state_dir/call-decimals.txt"
  # NOTE: deliberately NOT writing call-symbol.txt. A real `cast call` decodes
  # an ERC-20 symbol() as an ABI string, so the mock's symbol() branch already
  # returns a valid head/tail triple. Seeding the bare literal "USDC" here would
  # hand preflight a value its strict ABI decoder must reject, making the mock —
  # not the script — the source of the failure. Tests that need a malformed
  # symbol vector write their own call-symbol.txt.

  # Bytecode for each contract
  echo "0x60806040526004361015610011575f80fd5b5f3560e01c637cd633d814610024575f80fd" > "$state_dir/bytecode-${verifier_addr}.hex"
  echo "0x60c0346100c257601f611db938819003918201601f19168301916001600160401b0383" > "$state_dir/bytecode-${registry_addr}.hex"
  echo "0x6101c0806040523461022f57606081611ced80380380916100208285610233565b8339" > "$state_dir/bytecode-${protocol_addr}.hex"
  echo "0x60806040526004361015610011575f80fd5b5f3560e01c9081631494e2f614610f21" > "$state_dir/bytecode-${token_addr}.hex"

  # Receipts
  cat > "$state_dir/receipt-0xaaa1111111111111111111111111111111111111111111111111111111111111.json" <<REC_EOF
{"blockNumber":"100","blockHash":"0xabc1111111111111111111111111111111111111111111111111111111111111","status":"0x1","contractAddress":"$verifier_addr"}
REC_EOF
  cat > "$state_dir/receipt-0xbbb2222222222222222222222222222222222222222222222222222222222222.json" <<REC_EOF
{"blockNumber":"101","blockHash":"0xdef1111111111111111111111111111111111111111111111111111111111111","status":"0x1","contractAddress":"$registry_addr"}
REC_EOF
  cat > "$state_dir/receipt-0xccc3333333333333333333333333333333333333333333333333333333333333.json" <<REC_EOF
{"blockNumber":"102","blockHash":"0x1231111111111111111111111111111111111111111111111111111111111111","status":"0x1","contractAddress":"$protocol_addr"}
REC_EOF

  # Failed receipt
  cat > "$state_dir/receipt-0xfff1111111111111111111111111111111111111111111111111111111111111.json" <<REC_EOF
{"blockNumber":"103","blockHash":"0xfail111111111111111111111111111111111111111111111111111111111111","status":"0x0","contractAddress":""}
REC_EOF

  # Tx inputs (with creation bytecode prefix + constructor suffix)
  local verifier_creation="0x608080604052346015576102ba908161001a8239f35b5f80fdfe60806040526004361015610011575f80fd5b5f3560e01c637cd633d814610024575f80fd5b346100585760a036600319011261005857602061004e60843560643560443560243560043561005c565b6040519015158152f35b5f80fd"
  local registry_creation="0x60c0346100c257601f611db938819003918201601f19168301916001600160401b038311848410176100c65780849260409485528339810103126100c25780516020909101516001600160a01b03811691908281036100c25781159081156100b8575b506100a95760805260a052604051611cde90816100db82396080518181816102290152818161090a01526109dc015260a0518181816094015281816104070152610bb50152f35b63c52a9bd360e01b5f5260045ffd5b90503b155f610062565b5f80fd"
  local protocol_creation="0x6101c0806040523461022f57606081611ced80380380916100208285610233565b83398101031261022f576100338161026a565b9060406100426020830161026a565b910151916001600160401b03831680840361022f57604051610065604082610233565b600c815260208101906b5859582044656c697665727960a01b82526040519161008f604084610233565b600183526020830191603160f81b835260017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00556100cc8161027e565b610120526100d984610414565b61014052519020918260e05251902080610100524660a0526040519060208201927f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f8452604083015260608201524660808201523060a082015260a0815261014260c082610233565b5190206080523060c052813b15908115610225575b811561021c575b5061020d576001600160a01b039081166101605216610180526101a0526040516117a0908161054d823960805181611471015260a0518161152e015260c0518161143b015260e051816114c0015261010051816114e601526101205181610c1101526101405181610c3a0152610160518181816103800152818161086101528181610aeb0152610ecf0152610180518181816102530152610a5b01526101a05181818161053e0152610d100152f35b63c52a9bd360e01b5f5260045ffd5b9050155f61015e565b833b159150610157565b5f80fd5b601f909101601f19168101906001600160401b0382119082101761025657604052565b634e487b7160e01b5f52604160045260245ffd5b51906001600160a01b038216820361022f57565b908151602081105f146102f8575090601f8151116102b85760208151910151602082106102a9571790565b5f198260200360031b1b161790565b604460209160405192839163305a27a960e01b83528160048401528051918291826024860152018484015e5f828201840152601f01601f19168101030190fd5b6001600160401b038111610256575f54600181811c9116801561040a575b60208210146103f657601f81116103c4575b50602092601f821160011461036557928192935f9261035a575b50508160011b915f199060031b1c1916175f5560ff90565b015190505f80610342565b601f198216935f8052805f20915f5b8681106103ac5750836001959610610394575b505050811b015f5560ff90565b01515f1960f88460031b161c191690555f8080610387565b91926020600181928685015181550194019201610374565b5f8052601f60205f20910160051c810190601f830160051c015b8181106103eb5750610328565b5f81556001016103de565b634e487b7160e01b5f52602260045260245ffd5b90607f1690610316565b908151602081105f1461043f575090601f8151116102b85760208151910151602082106102a9571790565b6001600160401b03811161025657600154600181811c91168015610542575b60208210146103f657601f811161050f575b50602092601f82116001146104ae57928192935f926104a3575b50508160011b915f199060031b1c19161760015560ff90565b015190505f8061048a565b601f1982169360015f52805f20915f5b8681106104f757508360019596106104df575b505050811b0160015560ff90565b01515f1960f88460031b161c191690555f80806104d1565b919260206001819286850151815501940192016104be565b60015f52601f60205f20910160051c810190601f830160051c015b8181106105375750610470565b5f815560010161052a565b90607f169061045e56fe"

  # Registry constructor args: XYXPasskeyRegistry(bytes32 rpIdHash, address verifier).
  # Solidity ABI-encodes each constructor argument as its own 32-byte word, so
  # this is 2 * 64 = 128 hex chars, NOT the 104 that packed encoding would give.
  # Encoded here in pure bash rather than through `cast abi-encode`: this fixture
  # is built while a mock `cast` is still on PATH, so shelling out to the real
  # one would silently yield nothing and every CONSTRUCTOR_* check would then be
  # asserted against an empty argument blob.
  local reg_suffix="${rp_hash#0x}"
  reg_suffix+="$(printf '%024d' 0)$(printf '%s' "$verifier_addr" | sed 's/^0x//')"
  # Protocol constructor args: XYXDeliveryProtocol(address token, address registry, uint64 lifetime)
  # Three ABI words = 192 hex chars. 900 decimal is 0x384, left-padded to 16 hex.
  local proto_suffix
  proto_suffix="$(printf '%024d' 0)$(printf '%s' "$token_addr" | sed 's/^0x//')"
  proto_suffix+="$(printf '%024d' 0)$(printf '%s' "$registry_addr" | sed 's/^0x//')"
  proto_suffix+="$(printf '%048d' 0)$(printf '%016x' 900)"

  echo "${verifier_creation}6080" > "$state_dir/txinput-0xaaa1111111111111111111111111111111111111111111111111111111111111.txt"
  echo "${registry_creation}${reg_suffix}" > "$state_dir/txinput-0xbbb2222222222222222222222222222222222222222222222222222222222222.txt"
  echo "${protocol_creation}${proto_suffix}" > "$state_dir/txinput-0xccc3333333333333333333333333333333333333333333333333333333333333.txt"
}

# ── Upgrade a mock state into a fully valid finalized deployment ──────────────
# create_mock_state supplies the chain ID, runtime bytecode, immutable bindings,
# token identity and RP ID hash. A provenance record reaches `final` only when,
# in addition, every deployment receipt carries its OWN transaction hash — so the
# receipt is provably the receipt of the tx that was passed in — and the compiled
# creation bytecode is readable through `forge inspect`. This helper adds exactly
# those two things and nothing else, leaving a single variable free for a test to
# set: the source-verification evidence.
finalize_mock_state() {
  local state_dir="$1"
  local verifier_addr="0x1111111111111111111111111111111111111111"
  local registry_addr="0x2222222222222222222222222222222222222222"
  local protocol_addr="0x3333333333333333333333333333333333333333"

  # Receipts that carry their own transaction hash.
  cat > "$state_dir/receipt-0xaaa1111111111111111111111111111111111111111111111111111111111111.json" <<REC_EOF
{"blockNumber":"100","blockHash":"0xabc1111111111111111111111111111111111111111111111111111111111111","status":"0x1","contractAddress":"$verifier_addr","transactionHash":"0xaaa1111111111111111111111111111111111111111111111111111111111111"}
REC_EOF
  cat > "$state_dir/receipt-0xbbb2222222222222222222222222222222222222222222222222222222222222.json" <<REC_EOF
{"blockNumber":"101","blockHash":"0xdef1111111111111111111111111111111111111111111111111111111111111","status":"0x1","contractAddress":"$registry_addr","transactionHash":"0xbbb2222222222222222222222222222222222222222222222222222222222222"}
REC_EOF
  cat > "$state_dir/receipt-0xccc3333333333333333333333333333333333333333333333333333333333333.json" <<REC_EOF
{"blockNumber":"102","blockHash":"0x1231111111111111111111111111111111111111111111111111111111111111","status":"0x1","contractAddress":"$protocol_addr","transactionHash":"0xccc3333333333333333333333333333333333333333333333333333333333333"}
REC_EOF

  local v_in r_in p_in
  v_in=$(cat "$state_dir/txinput-0xaaa1111111111111111111111111111111111111111111111111111111111111.txt")
  r_in=$(cat "$state_dir/txinput-0xbbb2222222222222222222222222222222222222222222222222222222222222.txt")
  p_in=$(cat "$state_dir/txinput-0xccc3333333333333333333333333333333333333333333333333333333333333.txt")

  # MonadP256Verifier takes no constructor arguments, so its deployment tx input
  # IS its creation bytecode. create_mock_state appends a stray 4-hex-digit
  # suffix; drop it so the fixture matches what a real deployment produces.
  printf '%s\n' "${v_in:0:${#v_in}-4}" > "$state_dir/txinput-0xaaa1111111111111111111111111111111111111111111111111111111111111.txt"

  # `forge inspect <Name> bytecode` = the deployment tx input minus the
  # constructor arguments (128 hex chars for XYXPasskeyRegistry: two ABI words;
  # 192 for XYXDeliveryProtocol: three ABI words). Derived from the tx inputs
  # this fixture already provides rather than restated, so the two can never
  # drift apart.
  printf '%s\n' "${v_in:0:${#v_in}-4}" > "$state_dir/creation-MonadP256Verifier.hex"
  printf '%s\n' "${r_in:0:${#r_in}-128}" > "$state_dir/creation-XYXPasskeyRegistry.hex"
  printf '%s\n' "${p_in:0:${#p_in}-192}" > "$state_dir/creation-XYXDeliveryProtocol.hex"
}

# ── Source-verification evidence ──────────────────────────────────────────────
# Writes the exact JSON shape verify-xyx-delivery.sh emits, so provenance is
# tested against the artifact it will really be handed rather than a convenient
# stand-in. $2..$4 are the three deployed addresses and must match the addresses
# passed to provenance, because provenance cross-checks every fully-qualified
# name against the address it was given.
#
# The fifth argument is the binding status the fake evidence carries. It
# defaults to `verified` so the positive-path tests exercise the real gate; the
# negative tests pass `failed` or `missing` to prove the provenance script
# refuses evidence whose immutable bindings are not verified.
#
# `verificationCommandInvocations` is a count of LOCAL forge CLI calls, never
# proof of a remote submission, so it is kept at 1 here for every contract.
write_verification_evidence() {
  local path="$1" verifier="$2" registry="$3" protocol="$4"
  local binding_mode="${5:-verified}"
  local bindings_json
  case "$binding_mode" in
    verified)
      bindings_json='{"status": "verified", "ok": true, "failureCount": 0, "failures": []}'
      ;;
    failed)
      bindings_json='{"status": "failed", "ok": false, "failureCount": 2, "failures": ["protocol.passkeyRegistry does not match the passkey registry address under test", "passkeyRegistry.rpIdHash is zero, so no passkey can match this deployment"]}'
      ;;
    missing)
      # Deliberately omitted, as an older emitter would.
      bindings_json='{}'
      ;;
    *)
      echo "write_verification_evidence: unknown binding mode '$binding_mode'" >&2
      return 2
      ;;
  esac
  jq -n \
    --arg schema "xyx.delivery.source-verification" \
    --argjson chainId 10143 \
    --arg route "sourcify" \
    --arg verifierUrl "https://sourcify-api-monad.blockvision.org/" \
    --arg v "$verifier" --arg r "$registry" --arg p "$protocol" \
    --argjson bindings "$bindings_json" \
    '{
      schema: $schema,
      chainId: $chainId,
      route: $route,
      verifierUrl: $verifierUrl,
      allVerified: true,
      contracts: [
        {fullyQualifiedName: "src/MonadP256Verifier.sol:MonadP256Verifier",
         address: $v, name: "MonadP256Verifier", status: "verified",
         diagnostic: "Contract src/MonadP256Verifier.sol:MonadP256Verifier is already verified",
         verificationCommandInvocations: 1},
        {fullyQualifiedName: "src/XYXPasskeyRegistry.sol:XYXPasskeyRegistry",
         address: $r, name: "XYXPasskeyRegistry", status: "verified",
         diagnostic: "Contract src/XYXPasskeyRegistry.sol:XYXPasskeyRegistry is already verified",
         verificationCommandInvocations: 1},
        {fullyQualifiedName: "src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol",
         address: $p, name: "XYXDeliveryProtocol", status: "verified",
         diagnostic: "Contract src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol is already verified",
         verificationCommandInvocations: 1}
      ],
      bindings: $bindings
    }' > "$path"
}

# The record at $1 must be exactly ONE complete JSON document carrying every
# top-level section the provenance schema defines. A partial write, a truncated
# file, an empty file, or two concatenated documents all fail this.
record_is_complete() {
  jq -se '
    length == 1
    and (.[0].schema == "xyx.delivery.provenance")
    and (.[0] | has("status") and has("contracts") and has("bindings")
                and has("token") and has("sourceVerification")
                and has("incompleteReasons") and has("notes"))
  ' "$1" >/dev/null 2>&1
}

# True when the text on stdin contains any 16-character window of the key named
# by $1. This is the precise version of "no key-shaped text leaked": the whole
# key, a truncated key, and a fragment that survived redaction all match, while
# the test harness's own paths, contract names, addresses and hashes do not — so
# the assertion cannot pass on a harness artifact or fail on legitimate output.
# A shorter window would start matching unrelated long words; a longer one would
# miss a key that was cut short by truncation.
leaks_key_fragment() {
  local key="$1" text="$2" i
  for ((i = 0; i + 16 <= ${#key}; i++)); do
    if printf '%s' "$text" | grep -qF -- "${key:i:16}"; then
      printf '%s' "${key:i:16}"
      return 0
    fi
  done
  return 1
}

# ═══════════════════════════════════════════════════════════════════════════════
# TESTS
# ═══════════════════════════════════════════════════════════════════════════════

echo "=== XYX Delivery Script Offline Tests ==="
echo ""

# ── Test 1: Bash -n syntax checks ───────────────────────────────────────────
section "Syntax Checks (bash -n)"

for script in "$PREFLIGHT" "$VERIFY" "$PROVENANCE" "$BINDINGS"; do
  if bash -n "$script" 2>/dev/null; then
    passed "$(basename "$script") passes bash -n"
  else
    failed "$(basename "$script") fails bash -n"
  fi
done

# ── Test 2: Preflight with correct env ─────────────────────────────────────
section "Preflight: Correct Environment"

mock_dir=$(setup_mock_dir "/tmp/xyx-mock-preflight-ok-$$")
state_dir="$mock_dir/state"
create_mock_state "$state_dir"

PATH="$mock_dir/bin:$PATH"
export MOCK_STATE_DIR="$state_dir"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
export MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444"
export XYX_RP_ID="xyx.local"
export VERDICT_LIFETIME="900"
export DEPLOY_COMMIT="abc123def456abc123def456abc123def456abc1"

# Preflight should pass env/token/chain checks but fail on artifacts
if bash "$PREFLIGHT" >/dev/null 2>&1; then
  passed "preflight passes with correct env"
else
  output=$("$PREFLIGHT" 2>&1 || true)
  if echo "$output" | grep -qi "Artifact"; then
    passed "preflight fails only on artifacts (env/token/chain OK)"
  else
    failed "preflight did not pass with correct env"
  fi
fi

# ── Test 3: Preflight fails with wrong chain ID ─────────────────────────────
section "Preflight: Wrong Chain ID"

mock_dir2=$(setup_mock_dir "/tmp/xyx-mock-preflight-chain-$$")
state_dir2="$mock_dir2/state"
mkdir -p "$state_dir2"
echo "99999" > "$state_dir2/chain-id.txt"
echo "0x60806040526004361015610011575f80fd5b" > "$state_dir2/bytecode-0x4444444444444444444444444444444444444444.hex"

PATH="$mock_dir2/bin:$PATH"
export MOCK_STATE_DIR="$state_dir2"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"

if "$PREFLIGHT" >/dev/null 2>&1; then
  failed "preflight should fail with wrong chain ID"
else
  passed "preflight fails with wrong chain ID"
fi

# ── Test 4: Preflight fails with identical RPCs ─────────────────────────────
section "Preflight: Identical RPC URLs"

mock_dir3=$(setup_mock_dir "/tmp/xyx-mock-preflight-same-rpc-$$")
state_dir3="$mock_dir3/state"
create_mock_state "$state_dir3"

PATH="$mock_dir3/bin:$PATH"
export MOCK_STATE_DIR="$state_dir3"
export MONAD_RPC_URL_PRIMARY="https://same.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://same.monad.xyz"

if "$PREFLIGHT" >/dev/null 2>&1; then
  failed "preflight should fail with identical RPCs"
else
  passed "preflight fails with identical RPC URLs"
fi

# ── Test 5: Preflight fails with missing RP ID ──────────────────────────────
section "Preflight: Missing RP ID"

mock_dir4=$(setup_mock_dir "/tmp/xyx-mock-preflight-no-rp-$$")
state_dir4="$mock_dir4/state"
create_mock_state "$state_dir4"

PATH="$mock_dir4/bin:$PATH"
export MOCK_STATE_DIR="$state_dir4"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
unset XYX_RP_ID

if "$PREFLIGHT" >/dev/null 2>&1; then
  failed "preflight should fail without RP ID"
else
  passed "preflight fails without RP ID"
fi

# ── Test 6: Preflight fails with host-only RP ID containing path ────────────
section "Preflight: RP ID with Path"

mock_dir5=$(setup_mock_dir "/tmp/xyx-mock-preflight-rp-path-$$")
state_dir5="$mock_dir5/state"
create_mock_state "$state_dir5"

PATH="$mock_dir5/bin:$PATH"
export MOCK_STATE_DIR="$state_dir5"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
export XYX_RP_ID="xyx.local/path"

# Preflight rejects an RP ID carrying a path with a stable reason, and — because
# `set -e` is in play — still exits nonzero rather than silently continuing.
output=$("$PREFLIGHT" 2>&1 || true)
preflight_rc=0
"$PREFLIGHT" >/dev/null 2>&1 || preflight_rc=$?

if echo "$output" | grep -q "host-only"; then
  if [ "$preflight_rc" -eq 0 ]; then
    failed "preflight reported an RP ID path problem but exited 0"
  else
    passed "preflight rejects RP ID with path and exits nonzero"
  fi
else
  failed "preflight accepted an RP ID containing a path: $(echo "$output" | grep -i 'rp' | head -2)"
fi

# ── Test 7: Preflight detects missing artifacts ─────────────────────────────
section "Preflight: Missing Artifacts"

# Create a clean state with no artifacts
mock_dir6=$(setup_mock_dir "/tmp/xyx-mock-preflight-no-artifacts-$$")
state_dir6="$mock_dir6/state"
mkdir -p "$state_dir6"
echo "10143" > "$state_dir6/chain-id.txt"
echo "0x60806040526004361015610011575f80fd5b" > "$state_dir6/bytecode-0x4444444444444444444444444444444444444444.hex"

PATH="$mock_dir6/bin:$PATH"
export MOCK_STATE_DIR="$state_dir6"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
export MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444"
export XYX_RP_ID="xyx.local"
export VERDICT_LIFETIME="900"
export DEPLOY_COMMIT="abc123def456abc123def456abc123def456abc1"

# Remove artifact dir to simulate missing build
orig_artifact_dir="$PROJECT_ROOT/packages/contracts/out"
if [ -d "$orig_artifact_dir" ]; then
  mv "$orig_artifact_dir" "${orig_artifact_dir}.bak"
fi

if "$PREFLIGHT" >/dev/null 2>&1; then
  failed "preflight should fail without artifacts"
else
  passed "preflight fails without compiled artifacts"
fi

# Restore
if [ -d "${orig_artifact_dir}.bak" ]; then
  mv "${orig_artifact_dir}.bak" "$orig_artifact_dir"
fi

# ── Test 8: Provenance with correct inputs ──────────────────────────────────
section "Provenance: Correct Inputs"

mock_dir7=$(setup_mock_dir "/tmp/xyx-mock-provenance-ok-$$")
state_dir7="$mock_dir7/state"
create_mock_state "$state_dir7"

# Mark all contracts as verified
echo "verified" > "$state_dir7/verified-0x3333333333333333333333333333333333333333.txt"
echo "verified" > "$state_dir7/verified-0x2222222222222222222222222222222222222222.txt"
echo "verified" > "$state_dir7/verified-0x1111111111111111111111111111111111111111.txt"

PATH="$mock_dir7/bin:$PATH"
export MOCK_STATE_DIR="$state_dir7"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
export MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444"
export XYX_RP_ID="xyx.local"

# The mock chain has no finalized block and no verification evidence, so the
# honest outcome here is a `draft` that exits nonzero. Assert against the record
# the script actually writes (PROVENANCE_OUT) rather than an unused temp file.
OUT_FILE="$mock_dir7/provenance.json"
export PROVENANCE_OUT="$OUT_FILE"
PROV_RC=0
"$PROVENANCE" \
  "0x1111111111111111111111111111111111111111" \
  "0x2222222222222222222222222222222222222222" \
  "0x3333333333333333333333333333333333333333" \
  "0xaaa1111111111111111111111111111111111111111111111111111111111111" \
  "0xbbb2222222222222222222222222222222222222222222222222222222222222" \
  "0xccc3333333333333333333333333333333333333333333333333333333333333" \
  >/dev/null 2>&1 || PROV_RC=$?
unset PROVENANCE_OUT

# A `draft` MUST exit nonzero — an unverified deployment is never a pass.
if [ "$PROV_RC" -eq 0 ]; then
  failed "provenance exited 0 (final) without finality, verification evidence, or a finalized block"
elif [ ! -s "$OUT_FILE" ]; then
  failed "provenance wrote no record on the draft path"
elif ! jq -e '.schema == "xyx.delivery.provenance"' "$OUT_FILE" >/dev/null 2>&1; then
  failed "provenance record does not carry the expected schema"
elif ! jq -e '.status == "draft"' "$OUT_FILE" >/dev/null 2>&1; then
  failed "provenance record status is not draft"
elif ! jq -e '(.incompleteReasons | length) > 0' "$OUT_FILE" >/dev/null 2>&1; then
  failed "draft provenance carries no reason codes explaining what is missing"
elif ! jq -e '.verified == false' "$OUT_FILE" >/dev/null 2>&1; then
  failed "draft provenance claims verified: true"
else
  passed "provenance writes a valid draft record with reason codes and exits nonzero"
fi
rm -f "$OUT_FILE"

# ── Test 9: Provenance fails with failed receipt ─────────────────────────────
section "Provenance: Failed Receipt"

mock_dir8=$(setup_mock_dir "/tmp/xyx-mock-provenance-fail-$$")
state_dir8="$mock_dir8/state"
create_mock_state "$state_dir8"

# Override verifier receipt with reverted status
cat > "$state_dir8/receipt-0xaaa1111111111111111111111111111111111111111111111111111111111111.json" <<'REC_EOF'
{"blockNumber":"100","blockHash":"0xabc1111111111111111111111111111111111111111111111111111111111111","status":"0x0","contractAddress":""}
REC_EOF

PATH="$mock_dir8/bin:$PATH"
export MOCK_STATE_DIR="$state_dir8"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
export MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444"
export XYX_RP_ID="xyx.local"

if "$PROVENANCE" \
  "0x1111111111111111111111111111111111111111" \
  "0x2222222222222222222222222222222222222222" \
  "0x3333333333333333333333333333333333333333" \
  "0xaaa1111111111111111111111111111111111111111111111111111111111111" \
  "0xbbb2222222222222222222222222222222222222222222222222222222222222" \
  "0xccc3333333333333333333333333333333333333333333333333333333333333" \
  >/dev/null 2>&1; then
  failed "provenance should fail with reverted receipt"
else
  passed "provenance fails with reverted receipt"
fi

# ── Test 10: Provenance fails with contract address mismatch ─────────────────
section "Provenance: Contract Address Mismatch"

mock_dir9=$(setup_mock_dir "/tmp/xyx-mock-provenance-mismatch-$$")
state_dir9="$mock_dir9/state"
create_mock_state "$state_dir9"

PATH="$mock_dir9/bin:$PATH"
export MOCK_STATE_DIR="$state_dir9"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
export MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444"
export XYX_RP_ID="xyx.local"

if "$PROVENANCE" \
  "0xWRONG1111111111111111111111111111111111111" \
  "0x2222222222222222222222222222222222222222" \
  "0x3333333333333333333333333333333333333333" \
  "0xaaa1111111111111111111111111111111111111111111111111111111111111" \
  "0xbbb2222222222222222222222222222222222222222222222222222222222222" \
  "0xccc3333333333333333333333333333333333333333333333333333333333333" \
  >/dev/null 2>&1; then
  failed "provenance should fail with wrong verifier address"
else
  passed "provenance fails with contract address mismatch"
fi

# ── Test 11: Bindings script passes with valid state ────────────────────────
section "Post-Deploy Bindings: Valid State"

mock_dir10=$(setup_mock_dir "/tmp/xyx-mock-bindings-ok-$$")
state_dir10="$mock_dir10/state"
create_mock_state "$state_dir10"

PATH="$mock_dir10/bin:$PATH"
export MOCK_STATE_DIR="$state_dir10"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
export MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444"
export XYX_RP_ID="xyx.local"

if "$BINDINGS" \
  "0x1111111111111111111111111111111111111111" \
  "0x2222222222222222222222222222222222222222" \
  "0x3333333333333333333333333333333333333333" \
  >/dev/null 2>&1; then
  passed "post-deploy bindings pass with valid state"
else
  failed "post-deploy bindings should pass with valid state"
fi

# ── Test 12: Bindings script fails with wrong chain ─────────────────────────
section "Post-Deploy Bindings: Wrong Chain"

mock_dir11=$(setup_mock_dir "/tmp/xyx-mock-bindings-chain-$$")
state_dir11="$mock_dir11/state"
mkdir -p "$state_dir11"
echo "99999" > "$state_dir11/chain-id.txt"
echo "0x60806040526004361015610011575f80fd5b" > "$state_dir11/bytecode-0x1111111111111111111111111111111111111111.hex"
echo "0x60806040526004361015610011575f80fd5b" > "$state_dir11/bytecode-0x2222222222222222222222222222222222222222.hex"
echo "0x60806040526004361015610011575f80fd5b" > "$state_dir11/bytecode-0x3333333333333333333333333333333333333333.hex"

PATH="$mock_dir11/bin:$PATH"
export MOCK_STATE_DIR="$state_dir11"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"

if "$BINDINGS" \
  "0x1111111111111111111111111111111111111111" \
  "0x2222222222222222222222222222222222222222" \
  "0x3333333333333333333333333333333333333333" \
  >/dev/null 2>&1; then
  failed "post-deploy bindings should fail with wrong chain"
else
  passed "post-deploy bindings fail with wrong chain ID"
fi

# ── Test 13: Verify script claims VERIFIED only from a positive terminal response
section "Source Verification: Positive Terminal Response (True Positive)"

V_ADDR_V="0x1111111111111111111111111111111111111111"
V_ADDR_R="0x2222222222222222222222222222222222222222"
V_ADDR_P="0x3333333333333333333333333333333333333333"

mock_dir12=$(setup_mock_dir "/tmp/xyx-mock-verify-$$")
state_dir12="$mock_dir12/state"
create_mock_state "$state_dir12"
rm -f "$state_dir12/verify-invocations.log"

# Every route returns a positive TERMINAL response for its contract.
for a in "$V_ADDR_V" "$V_ADDR_R" "$V_ADDR_P"; do
  echo "verified" > "$state_dir12/verified-$a.txt"
done

PATH="$mock_dir12/bin:$PATH"
export MOCK_STATE_DIR="$state_dir12"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
# Sourcify is the default keyless route, so no API key is set here. The old
# MONAD_VERIFY_TIMEOUT / MONAD_VERIFY_POLL_INTERVAL exports are gone: the script
# no longer polls, so setting them would only be exercising an unused knob.

V_OUT=$(mktemp)
V_JSON="$mock_dir12/verify-result.json"
rm -f "$V_JSON"
VERIFY_RC=0
VERIFY_OUT="$V_JSON" "$VERIFY" \
  "$V_ADDR_V" "$V_ADDR_R" "$V_ADDR_P" \
  >"$V_OUT" 2>&1 || VERIFY_RC=$?

if [ "$VERIFY_RC" -ne 0 ]; then
  failed "source verification exited $VERIFY_RC with three positive terminal responses"
elif ! grep -qx "ALL_VERIFIED" "$V_OUT"; then
  # -x matters: "NOT_ALL_VERIFIED" must never satisfy an ALL_VERIFIED check.
  failed "source verification exited 0 without printing exactly ALL_VERIFIED"
elif grep -qx "NOT_ALL_VERIFIED" "$V_OUT"; then
  failed "source verification printed both ALL_VERIFIED and NOT_ALL_VERIFIED"
else
  passed "source verification exits 0 and prints exactly ALL_VERIFIED"
fi

# Machine-readable outcome: all three must be `verified`, and nothing else.
if [ ! -s "$V_JSON" ]; then
  failed "VERIFY_OUT wrote no machine-readable result on the true-positive path"
elif ! jq -e '.schema == "xyx.delivery.source-verification"' "$V_JSON" >/dev/null 2>&1; then
  failed "verification result does not carry the source-verification schema"
elif ! jq -e '.chainId == 10143' "$V_JSON" >/dev/null 2>&1; then
  failed "verification result does not record chain ID 10143"
elif ! jq -e '(.contracts | length) == 3' "$V_JSON" >/dev/null 2>&1; then
  failed "verification result does not describe exactly three contracts"
elif ! jq -e '[.contracts[].status] | all(. == "verified")' "$V_JSON" >/dev/null 2>&1; then
  failed "not every contract outcome is 'verified': $(jq -c '[.contracts[] | {name, status}]' "$V_JSON")"
else
  passed "every contract outcome in the machine-readable result is 'verified'"
fi

# Each canonical contract must have been invoked EXACTLY ONCE by this script.
# Re-invoking on a timer to "poll" would show up here as a count above 1.
once_each=true
for a in "$V_ADDR_V" "$V_ADDR_R" "$V_ADDR_P"; do
  n=$(invocation_count "$state_dir12/verify-invocations.log" "$a")
  if [ "$n" != "1" ]; then
    failed "contract $a was invoked $n time(s), expected exactly 1"
    once_each=false
  fi
done
if [ "$once_each" = true ]; then
  total=$(invocation_total "$state_dir12/verify-invocations.log")
  if [ "$total" = "3" ]; then
    passed "each contract was invoked exactly once (3 invocations for 3 contracts)"
  else
    failed "expected exactly 3 verification command invocations total, found $total"
  fi
fi

# The JSON field must be named for what it counts — a local CLI invocation — and
# every contract entry must report exactly one. A count above 1 here would mean
# the script re-invoked the command for a contract it had already tried.
if jq -e '[.contracts[].verificationCommandInvocations] | all(. == 1)' "$V_JSON" >/dev/null 2>&1; then
  passed "every contract entry records verificationCommandInvocations == 1"
else
  failed "verificationCommandInvocations is not 1 for every contract: $(jq -c '[.contracts[] | {name, verificationCommandInvocations}]' "$V_JSON" 2>/dev/null)"
fi

# The old field name is gone for good: `submissions` claimed a remote verifier
# accepted something, which the invocation count cannot prove.
if jq -e 'has("submissions") or ([.contracts[] | has("submissions")] | any)' "$V_JSON" >/dev/null 2>&1; then
  failed "verification result still carries a misleading 'submissions' key: $(jq -c '[.contracts[] | {name, submissions}]' "$V_JSON")"
else
  passed "verification result contains no 'submissions' key"
fi

# The default Sourcify route answers synchronously, so it must NOT carry
# --watch: that flag exists to wait for an asynchronous route, and passing it
# here would change what the submission means.
sourcify_flags=true
for spec in "$V_ADDR_V|src/MonadP256Verifier.sol:MonadP256Verifier" \
            "$V_ADDR_R|src/XYXPasskeyRegistry.sol:XYXPasskeyRegistry" \
            "$V_ADDR_P|src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol"; do
  IFS='|' read -r a fqn <<< "$spec"
  if ! grep -qxF "$a $fqn verifier=sourcify watch=no" \
      "$state_dir12/verify-invocations.log" 2>/dev/null; then
    failed "sourcify submission for $a did not record verifier=sourcify watch=no: $(grep "^$a " "$state_dir12/verify-invocations.log" || echo '<none>')"
    sourcify_flags=false
  fi
done
if [ "$sourcify_flags" = true ]; then
  passed "the sourcify route submits with --verifier sourcify and no --watch"
fi

# The script's own `verificationCommandInvocations` field is a self-report of
# LOCAL commands it ran. Cross-check it against the mock's log, which is ground
# truth, so a script that under-reports its own invocation count cannot pass.
if [ -s "$V_JSON" ]; then
  reported=true
  for a in "$V_ADDR_V" "$V_ADDR_R" "$V_ADDR_P"; do
    claimed=$(jq -r --arg a "$a" '.contracts[] | select(.address == $a) | .verificationCommandInvocations' "$V_JSON" 2>/dev/null)
    actual=$(invocation_count "$state_dir12/verify-invocations.log" "$a")
    if [ "$claimed" != "$actual" ]; then
      failed "script reported $claimed local command invocation(s) for $a but made $actual"
      reported=false
    fi
  done
  if [ "$reported" = true ]; then
    passed "the script's self-reported verificationCommandInvocations matches the mock's log"
  fi
fi
rm -f "$V_OUT" "$V_JSON"

# ── Test 13b: Verification is NOT claimed from a non-terminal response ──────
section "Source Verification: Submission Is Not Verification"

mock_dir12b=$(setup_mock_dir "/tmp/xyx-mock-verify-pending-$$")
state_dir12b="$mock_dir12b/state"
create_mock_state "$state_dir12b"
rm -f "$state_dir12b/verify-invocations.log"

# No verified-*.txt: the mock route only ever acknowledges the submission.
PATH="$mock_dir12b/bin:$PATH"
export MOCK_STATE_DIR="$state_dir12b"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"

V_OUT=$(mktemp)
V_JSON="$mock_dir12b/verify-result.json"
rm -f "$V_JSON"
# `|| VERIFY_RC=$?` keeps `set -e` from aborting the harness on the expected
# nonzero exit; without it the assignment would short-circuit the whole script.
VERIFY_RC=0
VERIFY_OUT="$V_JSON" "$VERIFY" \
  "$V_ADDR_V" "$V_ADDR_R" "$V_ADDR_P" \
  >"$V_OUT" 2>&1 || VERIFY_RC=$?

if [ "$VERIFY_RC" -eq 0 ]; then
  failed "source verification exited 0 with only a submission acknowledgement"
elif grep -qx "ALL_VERIFIED" "$V_OUT"; then
  failed "source verification claimed ALL_VERIFIED from a queued submission"
elif grep -qx "NOT_ALL_VERIFIED" "$V_OUT"; then
  passed "source verification refuses to claim VERIFIED from a queued submission"
else
  failed "source verification gave no verdict on a non-terminal response: $(tail -2 "$V_OUT")"
fi

# A queued/pending acknowledgement must serialize as `unverified`, never
# `verified`, and must still say why.
if [ ! -s "$V_JSON" ]; then
  failed "VERIFY_OUT wrote no machine-readable result on the non-terminal path"
elif ! jq -e '[.contracts[].status] | all(. == "unverified")' "$V_JSON" >/dev/null 2>&1; then
  failed "a queued submission did not serialize as unverified: $(jq -c '[.contracts[] | {name, status}]' "$V_JSON")"
elif ! jq -e '[.contracts[].diagnostic] | all(test("non-terminal"))' "$V_JSON" >/dev/null 2>&1; then
  failed "non-terminal outcomes carry no explicit reason: $(jq -c '[.contracts[].diagnostic]' "$V_JSON")"
else
  passed "queued/pending responses serialize as unverified with an explicit reason"
fi

# The invocation count must still exist and still be exactly 1 for every
# contract, but it must NOT be read as proof of anything remote: an invocation is
# what this script did locally, and a queued response means the verifier did not
# confirm anything.
if jq -e '[.contracts[].verificationCommandInvocations] | all(. == 1)' "$V_JSON" >/dev/null 2>&1; then
  passed "every contract records verificationCommandInvocations == 1 on the non-terminal path"
else
  failed "verificationCommandInvocations is not 1 for every contract on the non-terminal path: $(jq -c '[.contracts[] | {name, verificationCommandInvocations}]' "$V_JSON" 2>/dev/null)"
fi

# An invocation count of 1 must never be mistaken for a completed submission:
# the count is present precisely while every outcome is still `unverified`.
if jq -e '[.contracts[] | select(.verificationCommandInvocations == 1 and .status == "verified")] | length > 0' "$V_JSON" >/dev/null 2>&1; then
  failed "an invocation count implied a verified outcome on the non-terminal path"
else
  passed "an invocation count never implies remote submission or verification"
fi

if jq -e 'has("submissions") or ([.contracts[] | has("submissions")] | any)' "$V_JSON" >/dev/null 2>&1; then
  failed "non-terminal result still carries a misleading 'submissions' key"
else
  passed "non-terminal result contains no 'submissions' key"
fi

# A single execution must still be a single local command per contract, even when
# nothing verifies.
once_each=true
for a in "$V_ADDR_V" "$V_ADDR_R" "$V_ADDR_P"; do
  n=$(invocation_count "$state_dir12b/verify-invocations.log" "$a")
  if [ "$n" != "1" ]; then
    failed "contract $a was invoked $n time(s) on the non-terminal path, expected exactly 1"
    once_each=false
  fi
done
if [ "$once_each" = true ]; then
  passed "each contract was invoked exactly once even when nothing verifies"
fi
rm -f "$V_OUT" "$V_JSON"

# ── Test 13c: The offline mock itself must not manufacture success ──────────
section "Offline Mock: Rejects Wrong Chain, Route, URL, and Contract Name"

mock_dir12c=$(setup_mock_dir "/tmp/xyx-mock-verify-strict-$$")
state_dir12c="$mock_dir12c/state"
create_mock_state "$state_dir12c"
rm -f "$state_dir12c/verify-invocations.log"

# A mock that ignored --chain / --verifier / --verifier-url would let a script
# verifying the wrong chain, or through a different route, pass this suite: the
# mock would be the thing producing the success. Each of these must be refused.
#
# Every call below carries the canonical --root. Without it each of these would
# be refused for the missing root rather than for the defect being described,
# and the test would pass without checking the thing it names.
mock_rejects() {
  local desc="$1"; shift
  local out rc=0
  out=$(MOCK_STATE_DIR="$state_dir12c" "$mock_dir12c/bin/forge" verify-contract "$@" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    failed "mock forge accepted an invalid invocation: $desc -> $out"
  else
    passed "mock forge refuses: $desc"
  fi
}

# Asserts the rejection is about the ROOT. --root is validated before every other
# flag, so an invocation with an unresolvable root would otherwise be refused
# before --chain is ever examined and would make the checks below vacuous.
mock_rejects_for_root() {
  local desc="$1"; shift
  local out rc=0
  out=$(MOCK_STATE_DIR="$state_dir12c" "$mock_dir12c/bin/forge" verify-contract "$@" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    failed "mock forge accepted an invocation with a bad root: $desc -> $out"
  elif ! printf '%s' "$out" | grep -qi "root"; then
    failed "mock forge rejected $desc for a reason other than the root: $out"
  else
    passed "mock forge refuses $desc, reporting the root"
  fi
}

mock_rejects_for_root "a missing --root" \
  --chain 10143 --verifier sourcify \
  --verifier-url "https://sourcify-api-monad.blockvision.org/" \
  "$V_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier"

mock_rejects_for_root "a relative --root" \
  --root packages/contracts --chain 10143 --verifier sourcify \
  --verifier-url "https://sourcify-api-monad.blockvision.org/" \
  "$V_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier"

mock_rejects_for_root "an absolute --root that is not the contracts root" \
  --root /tmp --chain 10143 --verifier sourcify \
  --verifier-url "https://sourcify-api-monad.blockvision.org/" \
  "$V_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier"

mock_rejects_for_root "a plausible-looking but nonexistent contract root" \
  --root "$PROJECT_ROOT/packages/packages/contracts" --chain 10143 --verifier sourcify \
  --verifier-url "https://sourcify-api-monad.blockvision.org/" \
  "$V_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier"

mock_rejects "chain 1 instead of 10143" \
  --root "$MOCK_CONTRACTS_ROOT" \
  --chain 1 --verifier sourcify \
  --verifier-url "https://sourcify-api-monad.blockvision.org/" \
  "$V_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier"

mock_rejects "the etherscan route without an API key or --watch" \
  --root "$MOCK_CONTRACTS_ROOT" \
  --chain 10143 --verifier etherscan \
  --verifier-url "https://sourcify-api-monad.blockvision.org/" \
  "$V_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier"

mock_rejects "a foreign verifier URL" \
  --root "$MOCK_CONTRACTS_ROOT" \
  --chain 10143 --verifier sourcify \
  --verifier-url "https://attacker.example/" \
  "$V_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier"

mock_rejects "an unknown fully-qualified contract name" \
  --root "$MOCK_CONTRACTS_ROOT" \
  --chain 10143 --verifier sourcify \
  --verifier-url "https://sourcify-api-monad.blockvision.org/" \
  "$V_ADDR_V" "src/NotARealContract.sol:NotARealContract"

mock_rejects "a malformed address" \
  --root "$MOCK_CONTRACTS_ROOT" \
  --chain 10143 --verifier sourcify \
  --verifier-url "https://sourcify-api-monad.blockvision.org/" \
  "0x1234" "src/MonadP256Verifier.sol:MonadP256Verifier"

mock_rejects "a missing fully-qualified contract name" \
  --root "$MOCK_CONTRACTS_ROOT" \
  --chain 10143 --verifier sourcify \
  --verifier-url "https://sourcify-api-monad.blockvision.org/" \
  "$V_ADDR_V"

# ...and the canonical invocation must be accepted, logged once, and must NOT
# create any verification state of its own.
if MOCK_STATE_DIR="$state_dir12c" "$mock_dir12c/bin/forge" verify-contract \
    --root "$MOCK_CONTRACTS_ROOT" \
    --chain 10143 --verifier sourcify \
    --verifier-url "https://sourcify-api-monad.blockvision.org/" \
    "$V_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier" >/dev/null 2>&1; then
  n=$(invocation_count "$state_dir12c/verify-invocations.log" "$V_ADDR_V")
  if [ "$n" = "1" ]; then
    passed "mock forge accepts the canonical sourcify invocation and logs it once"
  else
    failed "canonical invocation was logged $n time(s), expected 1"
  fi
else
  failed "mock forge refused the canonical sourcify invocation"
fi

# The mock must never write its own verified-* state: a mock that pre-created
# the success it then reports would make every verification claim circular.
if [ -e "$state_dir12c/verified-$V_ADDR_V.txt" ]; then
  failed "mock forge created verification state for $V_ADDR_V"
else
  passed "mock forge creates no verification state of its own"
fi

# ── Test 13d: Provenance output is atomic ───────────────────────────────────
section "Provenance: Atomic Output On Failure"

# Runs the provenance script against a fixed mock environment, varying only the
# output path, so the failure modes below are the only thing that differs.
PROV_STATE_DIR=""
run_provenance() {
  PROVENANCE_OUT="$1" MOCK_STATE_DIR="$PROV_STATE_DIR" \
    MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz" \
    MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz" \
    MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444" \
    XYX_RP_ID="xyx.local" \
    "$PROVENANCE" \
      "0x1111111111111111111111111111111111111111" \
      "0x2222222222222222222222222222222222222222" \
      "0x3333333333333333333333333333333333333333" \
      "0xaaa1111111111111111111111111111111111111111111111111111111111111" \
      "0xbbb2222222222222222222222222222222222222222222222222222222222222" \
      "0xccc3333333333333333333333333333333333333333333333333333333333333"
}

stray_files() {
  find "$1" -mindepth 1 -maxdepth 1 ! -name "$2" -printf '%f '
}

# (a) A pre-existing destination must survive a failed record byte-for-byte.
mock_dir15=$(setup_mock_dir "/tmp/xyx-mock-provenance-atomic-$$")
state_dir15="$mock_dir15/state"
create_mock_state "$state_dir15"
PROV_STATE_DIR="$state_dir15"
out_dir15="$mock_dir15/out"
mkdir -p "$out_dir15"
OUT_FILE15="$out_dir15/provenance.json"
printf '{"schema":"xyx.delivery.provenance","status":"final","sentinel":"PRE-EXISTING RECORD"}\n' > "$OUT_FILE15"
BEFORE_HASH15=$(sha256sum "$OUT_FILE15" | awk '{print $1}')

# An unwritable output directory is a deterministic record-generation failure.
# The previous implementation called `touch "$OUT"` first, which left a 0-byte
# file at the destination before the record existed.
chmod 555 "$out_dir15"
ATOMIC_RC=0
run_provenance "$OUT_FILE15" >/dev/null 2>&1 || ATOMIC_RC=$?
chmod 755 "$out_dir15"

if [ "$ATOMIC_RC" -eq 0 ]; then
  failed "provenance exited 0 with an unwritable output directory"
elif [ ! -f "$OUT_FILE15" ]; then
  failed "provenance destroyed a pre-existing destination record"
elif [ "$(sha256sum "$OUT_FILE15" | awk '{print $1}')" != "$BEFORE_HASH15" ]; then
  failed "a pre-existing destination record was modified by a failed run"
elif [ -n "$(stray_files "$out_dir15" 'provenance.json')" ]; then
  failed "a failed run left temp files behind: $(stray_files "$out_dir15" 'provenance.json')"
else
  passed "a failed run preserves a pre-existing destination byte-for-byte and leaves no temp file"
fi

# (b) A destination that does not exist must stay nonexistent — never a 0-byte
# file a downstream reader could mistake for a valid record.
mock_dir16=$(setup_mock_dir "/tmp/xyx-mock-provenance-newdest-$$")
state_dir16="$mock_dir16/state"
create_mock_state "$state_dir16"
PROV_STATE_DIR="$state_dir16"
out_dir16="$mock_dir16/out"
mkdir -p "$out_dir16"
OUT_FILE16="$out_dir16/provenance.json"
chmod 555 "$out_dir16"
NEWDEST_RC=0
run_provenance "$OUT_FILE16" >/dev/null 2>&1 || NEWDEST_RC=$?
chmod 755 "$out_dir16"

if [ "$NEWDEST_RC" -eq 0 ]; then
  failed "provenance exited 0 with an unwritable output directory"
elif [ -e "$OUT_FILE16" ]; then
  failed "a failed run created a destination that did not exist before ($(stat -c '%s bytes' "$OUT_FILE16"))"
elif [ -n "$(stray_files "$out_dir16" 'provenance.json')" ]; then
  failed "a failed run left temp files behind: $(stray_files "$out_dir16" 'provenance.json')"
else
  passed "a failed run leaves a nonexistent destination nonexistent and leaves no temp file"
fi

# (c) A failure AFTER the record is built (the rename itself) must also leave
# the destination untouched and clean up only the temp file.
mock_dir17=$(setup_mock_dir "/tmp/xyx-mock-provenance-rename-$$")
state_dir17="$mock_dir17/state"
create_mock_state "$state_dir17"
PROV_STATE_DIR="$state_dir17"
out_dir17="$mock_dir17/out"
mkdir -p "$out_dir17/destination-is-a-directory"
OUT_FILE17="$out_dir17/destination-is-a-directory"
printf 'not a provenance record\n' > "$OUT_FILE17/keep.txt"
RENAME_RC=0
run_provenance "$OUT_FILE17" >/dev/null 2>&1 || RENAME_RC=$?

if [ "$RENAME_RC" -eq 0 ]; then
  failed "provenance exited 0 when the destination could not be replaced"
elif [ ! -f "$OUT_FILE17/keep.txt" ]; then
  failed "a failed rename destroyed the pre-existing destination"
elif [ -n "$(stray_files "$out_dir17" 'destination-is-a-directory')" ]; then
  failed "a failed rename left temp files behind: $(stray_files "$out_dir17" 'destination-is-a-directory')"
else
  passed "a failed rename preserves the destination and removes only its temp file"
fi

# ── Test 13e: Unreadable numbers serialize as null, never as a plausible 0 ──
section "Provenance: Invalid Numeric Fields Serialize As Null"

mock_dir18=$(setup_mock_dir "/tmp/xyx-mock-provenance-nullnum-$$")
state_dir18="$mock_dir18/state"
create_mock_state "$state_dir18"

# Three independently unreadable numeric facts: the chain ID, the token's
# decimals, and the protocol's max verdict lifetime. `0` is a plausible value
# for all three (chain 0, a zero-decimal token, a zero lifetime), so falling
# back to it would fabricate evidence rather than report a gap.
printf 'not-a-chain-id\n' > "$state_dir18/chain-id.txt"
printf '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n' > "$state_dir18/call-decimals.txt"
printf '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n' > "$state_dir18/call-maxVerdictLifetime.txt"

PROV_STATE_DIR="$state_dir18"
OUT_FILE18="$mock_dir18/provenance.json"
rm -f "$OUT_FILE18"
NULLNUM_RC=0
run_provenance "$OUT_FILE18" >/dev/null 2>&1 || NULLNUM_RC=$?

if [ "$NULLNUM_RC" -eq 0 ]; then
  failed "provenance reached final with unreadable chain, decimals, and lifetime"
elif [ ! -s "$OUT_FILE18" ]; then
  failed "provenance wrote no draft record for unreadable numeric fields"
else
  nullnum_ok=true
  if ! jq -e '.chainId == null' "$OUT_FILE18" >/dev/null 2>&1; then
    failed "an unreadable chain ID did not serialize as null: $(jq -c '.chainId' "$OUT_FILE18")"
    nullnum_ok=false
  fi
  if ! jq -e '.token.decimals == null' "$OUT_FILE18" >/dev/null 2>&1; then
    failed "unreadable token decimals did not serialize as null: $(jq -c '.token.decimals' "$OUT_FILE18")"
    nullnum_ok=false
  fi
  if ! jq -e '.protocol.maxVerdictLifetime == null' "$OUT_FILE18" >/dev/null 2>&1; then
    failed "an unreadable max verdict lifetime did not serialize as null: $(jq -c '.protocol.maxVerdictLifetime' "$OUT_FILE18")"
    nullnum_ok=false
  fi
  if ! jq -e '(.incompleteReasons | length) > 0' "$OUT_FILE18" >/dev/null 2>&1; then
    failed "unreadable numeric fields produced no draft reason codes"
    nullnum_ok=false
  fi
  # Every null above must be paired with an explicit reason code.
  for reason in CHAIN_ID_UNREADABLE TOKEN_DECIMALS_UNREADABLE BINDING_UNREADABLE:maxVerdictLifetime; do
    if ! jq -e --arg r "$reason" '(.incompleteReasons | index($r)) != null' "$OUT_FILE18" >/dev/null 2>&1; then
      failed "no reason code recorded for $reason"
      nullnum_ok=false
    fi
  done
  if [ "$nullnum_ok" = true ]; then
    passed "unreadable chain/decimals/lifetime serialize as null with matching reason codes"
  fi
fi
rm -f "$OUT_FILE18"

# ── Test 14: Two-RPC disagreement ───────────────────────────────────────────
section "Preflight: Two-RPC Chain Disagreement"

mock_dir13=$(setup_mock_dir "/tmp/xyx-mock-preflight-disagree-$$")
state_dir13="$mock_dir13/state"
mkdir -p "$state_dir13"
echo "10143" > "$state_dir13/chain-id.txt"
echo "99999" > "$state_dir13/chain-id-secondary.txt"
echo "0x60806040526004361015610011575f80fd5b" > "$state_dir13/bytecode-0x4444444444444444444444444444444444444444.hex"

# Mock cast that returns different chain IDs for different RPCs
cat > "$mock_dir13/bin/cast" <<'CAST_EOF'
#!/usr/bin/env bash
STATE_DIR="${MOCK_STATE_DIR:-}"
case "${1:-}" in
  chain-id)
    rpc="${2:-}"
    if echo "$rpc" | grep -qi "secondary"; then
      cat "$STATE_DIR/chain-id-secondary.txt" 2>/dev/null || echo "10143"
    else
      cat "$STATE_DIR/chain-id.txt" 2>/dev/null || echo "10143"
    fi
    ;;
  *) echo "mock";;
esac
CAST_EOF
chmod +x "$mock_dir13/bin/cast"

PATH="$mock_dir13/bin:$PATH"
export MOCK_STATE_DIR="$state_dir13"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
export MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444"
export XYX_RP_ID="xyx.local"
export VERDICT_LIFETIME="900"
export DEPLOY_COMMIT="abc123def456abc123def456abc123def456abc1"

if "$PREFLIGHT" >/dev/null 2>&1; then
  failed "preflight should fail with RPC chain disagreement"
else
  passed "preflight fails with two-RPC chain disagreement"
fi

# ── Test 15: Script invoked from non-script directory ───────────────────────
section "Provenance: Non-Script Working Directory"

mock_dir14=$(setup_mock_dir "/tmp/xyx-mock-provenance-cwd-$$")
state_dir14="$mock_dir14/state"
create_mock_state "$state_dir14"

echo "verified" > "$state_dir14/verified-0x3333333333333333333333333333333333333333.txt"

PATH="$mock_dir14/bin:$PATH"
export MOCK_STATE_DIR="$state_dir14"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
export MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444"
export XYX_RP_ID="xyx.local"

# The script writes to PROVENANCE_OUT, not to a fixed path, so the honest
# assertion is that the record lands at PROVENANCE_OUT unchanged even when the
# working directory is unrelated — and that no stray default file is created
# next to the script.
CWD_OUT_FILE="$mock_dir14/provenance-cwd.json"
DEFAULT_OUT="$SCRIPT_BASE/provenance-draft.json"
rm -f "$DEFAULT_OUT"

PROV_CWD_RC=0
( cd /tmp && PROVENANCE_OUT="$CWD_OUT_FILE" MOCK_STATE_DIR="$state_dir14" \
  MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz" \
  MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz" \
  MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444" \
  XYX_RP_ID="xyx.local" \
  "$PROVENANCE" \
    "0x1111111111111111111111111111111111111111" \
    "0x2222222222222222222222222222222222222222" \
    "0x3333333333333333333333333333333333333333" \
    "0xaaa1111111111111111111111111111111111111111111111111111111111111" \
    "0xbbb2222222222222222222222222222222222222222222222222222222222222" \
    "0xccc3333333333333333333333333333333333333333333333333333333333333" \
    >/dev/null 2>&1 ) || PROV_CWD_RC=$?

if [ "$PROV_CWD_RC" -eq 0 ]; then
  failed "provenance exited 0 (final) with no verification evidence and no finalized block"
elif [ ! -s "$CWD_OUT_FILE" ]; then
  failed "provenance did not honor PROVENANCE_OUT when run from /tmp"
elif ! jq -e '.status == "draft"' "$CWD_OUT_FILE" >/dev/null 2>&1; then
  failed "provenance record written from /tmp is not a draft record"
elif [ -e "$DEFAULT_OUT" ]; then
  failed "provenance created a stray default record at $DEFAULT_OUT"
else
  passed "provenance honors PROVENANCE_OUT from a different cwd and leaves no default file"
fi
rm -f "$CWD_OUT_FILE" "$DEFAULT_OUT"

# ═══════════════════════════════════════════════════════════════════════════════
# Task A: provenance verification-evidence fixtures
# ═══════════════════════════════════════════════════════════════════════════════
section "Provenance: Verification Evidence Gates Finality"

# One canonical address/tx pair set, reused by every fixture below. The evidence
# file must describe exactly these addresses, because provenance cross-checks
# every fully-qualified name against the address it was given on the command line.
F_ADDR_V="0x1111111111111111111111111111111111111111"
F_ADDR_R="0x2222222222222222222222222222222222222222"
F_ADDR_P="0x3333333333333333333333333333333333333333"
F_TX_V="0xaaa1111111111111111111111111111111111111111111111111111111111111"
F_TX_R="0xbbb2222222222222222222222222222222222222222222222222222222222222"
F_TX_P="0xccc3333333333333333333333333333333333333333333333333333333333333"

# Set by run_provenance_case when it is asked to keep its workspace, so a
# follow-up assertion can inspect the record the gate actually wrote.
LAST_PROVENANCE_RECORD=""
LAST_PROVENANCE_ROOT=""

run_provenance_case() {
  # run_provenance_case <desc> <jq-mutation|-> <expected-reason|->
  #                    [binding_mode=verified] [keep]
  # With "-" for the last two arguments the evidence is the valid one and the
  # record must reach `final` with exit 0. Otherwise the evidence carries exactly
  # one defect, and the run must exit nonzero while still writing a complete
  # draft record naming the one reason code that blocks finality.
  # `binding_mode` seeds the immutable-bindings object in the evidence (verified,
  # failed, or missing); `keep` leaves the workspace in place.
  local desc="$1" mutation="$2" expected="$3"
  local binding_mode="${4:-verified}" keep="${5:-}"
  local case_root mock_bin state ev out_dir out rc before after sentinel
  case_root=$(mktemp -d "/tmp/xyx-mock-provenance-ev-XXXXXX")
  setup_mock_dir "$case_root" >/dev/null
  mock_bin="$case_root/bin"
  state="$case_root/state"
  create_mock_state "$state"
  # Everything except the evidence is made fully valid, so the only variable in
  # play is the evidence itself.
  finalize_mock_state "$state"

  ev="$case_root/verification.json"
  write_verification_evidence "$ev" "$F_ADDR_V" "$F_ADDR_R" "$F_ADDR_P" "$binding_mode"
  if [ "$mutation" != "-" ]; then
    jq "$mutation" "$ev" > "$ev.tmp" && mv -f "$ev.tmp" "$ev"
  fi

  # The destination already holds a complete, valid record. The run must leave
  # exactly one complete JSON document there — never a partial or concatenated
  # one — and must leave no temp file behind, which is what makes the write
  # atomic rather than an in-place truncate and rewrite.
  out_dir="$case_root/out"
  mkdir -p "$out_dir"
  out="$out_dir/provenance.json"
  printf '%s\n' '{"schema":"xyx.delivery.provenance","status":"draft","verified":false,"sentinel":"PRE-EXISTING RECORD"}' > "$out"
  before=$(sha256sum "$out" | awk '{print $1}')

  rc=0
  PATH="$mock_bin:$PATH" \
  PROVENANCE_VERIFICATION_RESULT="$ev" \
  PROVENANCE_OUT="$out" \
  MOCK_STATE_DIR="$state" \
  MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz" \
  MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz" \
  MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444" \
  XYX_RP_ID="xyx.local" \
    "$PROVENANCE" "$F_ADDR_V" "$F_ADDR_R" "$F_ADDR_P" \
      "$F_TX_V" "$F_TX_R" "$F_TX_P" \
    >"$case_root/stdout.log" 2>&1 || rc=$?
  after=$(sha256sum "$out" | awk '{print $1}')

  if [ "$expected" = "-" ]; then
    # ── The valid evidence: the record must be FINAL ──
    if [ "$rc" -ne 0 ]; then
      failed "$desc: provenance exited $rc, expected 0 ($(tail -3 "$case_root/stdout.log" | tr '\n' ' '))"
    else
      passed "$desc: provenance exits 0 with valid evidence"
    fi
    if ! record_is_complete "$out"; then
      failed "$desc: the record written is not one complete JSON document"
    elif ! jq -e '.status == "final"' "$out" >/dev/null 2>&1; then
      failed "$desc: status is $(jq -r '.status' "$out"), expected final"
    elif ! jq -e '.verified == true' "$out" >/dev/null 2>&1; then
      failed "$desc: verified is not true"
    elif ! jq -e '(.incompleteReasons | length) == 0' "$out" >/dev/null 2>&1; then
      failed "$desc: incompleteReasons is not empty: $(jq -c '.incompleteReasons' "$out")"
    else
      passed "$desc: status=final, verified=true, incompleteReasons empty"
    fi
    if ! jq -e '.sourceVerification.status == "verified"' "$out" >/dev/null 2>&1; then
      failed "$desc: sourceVerification.status is not verified"
    elif ! jq -e '.sourceVerification.evidenceFile == "verification.json"' "$out" >/dev/null 2>&1; then
      failed "$desc: sourceVerification does not name the evidence file it consumed"
    else
      passed "$desc: source verification is recorded as verified from the evidence file"
    fi
    if ! jq -e '[.sourceVerification.contracts[]] | all(. == "verified")' "$out" >/dev/null 2>&1; then
      failed "$desc: not every source-verification entry is verified: $(jq -c '.sourceVerification.contracts' "$out")"
    else
      passed "$desc: all three source-verification evidence entries are verified"
    fi
    # The FQ names and addresses recorded in the provenance must be exactly the
    # deployment inputs, not the evidence file's word for them.
    fq_ok=true
    for spec in "p256Verifier|$F_ADDR_V|src/MonadP256Verifier.sol:MonadP256Verifier" \
                "passkeyRegistry|$F_ADDR_R|src/XYXPasskeyRegistry.sol:XYXPasskeyRegistry" \
                "deliveryProtocol|$F_ADDR_P|src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol"; do
      IFS='|' read -r key addr fqn <<< "$spec"
      if ! jq -e --arg k "$key" --arg a "$addr" --arg f "$fqn" \
          '.contracts[$k].address == $a and .contracts[$k].fullyQualifiedName == $f' \
          "$out" >/dev/null 2>&1; then
        failed "$desc: $key does not record $addr / $fqn: $(jq -c --arg k "$key" '.contracts[$k]' "$out")"
        fq_ok=false
      fi
    done
    if [ "$fq_ok" = true ]; then
      passed "$desc: every contract's FQ name and address match the deployment inputs"
    fi
  else
    # ── A defective evidence file: the record must stay DRAFT ──
    if [ "$rc" -eq 0 ]; then
      failed "$desc: provenance exited 0, expected nonzero"
    else
      passed "$desc: provenance exits nonzero"
    fi
    if ! record_is_complete "$out"; then
      failed "$desc: the destination does not hold exactly one complete JSON record"
    else
      passed "$desc: a complete JSON record was written to the destination"
    fi
    if ! jq -e '.status == "draft"' "$out" >/dev/null 2>&1; then
      failed "$desc: status is $(jq -r '.status' "$out" 2>/dev/null), expected draft"
    else
      passed "$desc: status is draft"
    fi
    if ! jq -e '.verified == false' "$out" >/dev/null 2>&1; then
      failed "$desc: verified is not false"
    else
      passed "$desc: verified is false"
    fi
    if ! jq -e --arg r "$expected" '(.incompleteReasons | index($r)) != null' "$out" >/dev/null 2>&1; then
      failed "$desc: expected reason $expected, got $(jq -c '.incompleteReasons' "$out")"
    elif ! jq -e '(.incompleteReasons | length) == 1' "$out" >/dev/null 2>&1; then
      failed "$desc: reason codes are not isolated to $expected: $(jq -c '.incompleteReasons' "$out")"
    else
      passed "$desc: exactly the stable reason code $expected is recorded"
    fi
    # Atomicity: the pre-existing destination was replaced wholesale by a
    # complete record, never appended to, truncated, or left half-written.
    if [ "$after" = "$before" ]; then
      failed "$desc: the destination was never written, so nothing is known about the atomic path"
    elif [ -n "$(find "$out_dir" -mindepth 1 -maxdepth 1 ! -name 'provenance.json' -printf '%f ')" ]; then
      failed "$desc: temp files left beside the record: $(find "$out_dir" -mindepth 1 -maxdepth 1 ! -name 'provenance.json' -printf '%f ')"
    else
      passed "$desc: the pre-existing destination was replaced atomically and remains valid"
    fi
  fi
  if [ "$keep" = "keep" ]; then
    LAST_PROVENANCE_RECORD="$out"
    LAST_PROVENANCE_ROOT="$case_root"
  else
    rm -rf "$case_root"
  fi
}

# ── The valid case: every check passes, so the record is FINAL ────────────────
run_provenance_case "valid evidence" - -

# ── Negative case 1: the evidence file is not the artifact this suite's schema ──
run_provenance_case "wrong evidence schema" \
  '.schema = "xyx.delivery.source-verification.v2"' \
  "SOURCE_VERIFICATION_EVIDENCE_SCHEMA_MISMATCH"

# ── Negative case 2: the evidence describes another chain ─────────────────────
run_provenance_case "wrong evidence chain ID" \
  '.chainId = 1' \
  "SOURCE_VERIFICATION_EVIDENCE_CHAIN_MISMATCH"

# ── Negative case 3: a canonical FQ name is missing (count stays 3) ───────────
# The name set, not the count, is what must catch this: three entries that are
# not THE three canonical contracts are as bad as two.
run_provenance_case "missing canonical FQ name" \
  '.contracts |= map(if .fullyQualifiedName == "src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol"
                     then .fullyQualifiedName = "src/XYXDeliveryProtocol.sol:XYXDeliveryProtocolV2"
                     else . end)' \
  "SOURCE_VERIFICATION_EVIDENCE_CONTRACT_SET_MISMATCH"

# ── Negative case 4: a duplicate/extra FQ entry ───────────────────────────────
run_provenance_case "duplicate FQ entry" \
  '.contracts += [.contracts[2]]' \
  "SOURCE_VERIFICATION_EVIDENCE_CONTRACT_COUNT_MISMATCH:4"

# ── Negative case 5: the right FQ name attached to the wrong contract ─────────
run_provenance_case "exact FQ name with a wrong address" \
  '.contracts |= map(if .fullyQualifiedName == "src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol"
                     then .address = "0x9999999999999999999999999999999999999999"
                     else . end)' \
  "SOURCE_VERIFICATION_UNVERIFIED:src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol"

# ── Negative case 6: one contract is not verified ─────────────────────────────
run_provenance_case "one contract not verified" \
  '.contracts |= map(if .fullyQualifiedName == "src/XYXPasskeyRegistry.sol:XYXPasskeyRegistry"
                     then .status = "unverified"
                     else . end)' \
  "SOURCE_VERIFICATION_UNVERIFIED:src/XYXPasskeyRegistry.sol:XYXPasskeyRegistry"

# ── Negative case 7: source-verified, but the immutable bindings are not ──────
# All three contracts are verified on the explorer while their immutable wiring
# points elsewhere. Source verification is a fact about the code, not about the
# deployment, so it can never carry this record to `final`.
run_provenance_case "bindings not verified in evidence" \
  - "SOURCE_VERIFICATION_BINDINGS_NOT_VERIFIED:failed" failed keep
if ! jq -e '.sourceVerification.status == "verified"' "$LAST_PROVENANCE_RECORD" >/dev/null 2>&1; then
  failed "bindings not verified: sourceVerification.status should still be verified, got $(jq -r '.sourceVerification.status' "$LAST_PROVENANCE_RECORD") -- the gates must be independent"
else
  passed "bindings not verified: the source gate stays verified while the binding gate blocks"
fi
if ! jq -e '.sourceVerification.bindings.status == "failed"' "$LAST_PROVENANCE_RECORD" >/dev/null 2>&1; then
  failed "bindings not verified: the record does not carry bindings.status == failed: $(jq -c '.sourceVerification.bindings' "$LAST_PROVENANCE_RECORD")"
elif ! jq -e '.sourceVerification.bindings.failureCount == 2' "$LAST_PROVENANCE_RECORD" >/dev/null 2>&1; then
  failed "bindings not verified: failureCount is not the evidence's 2: $(jq -c '.sourceVerification.bindings' "$LAST_PROVENANCE_RECORD")"
elif ! jq -e '(.sourceVerification.bindings.failures | length) == 2' "$LAST_PROVENANCE_RECORD" >/dev/null 2>&1; then
  failed "bindings not verified: the evidence's failure reasons were dropped: $(jq -c '.sourceVerification.bindings.failures' "$LAST_PROVENANCE_RECORD")"
else
  passed "bindings not verified: status, failureCount and reasons are carried into the record"
fi
rm -rf "$LAST_PROVENANCE_ROOT"

# ── Negative case 8: the evidence carries no bindings object at all ───────────
# An older emitter wrote only the per-contract statuses. Its silence about the
# immutable bindings is not evidence that they are correct, so the record must
# stay a draft with a distinct reason code.
run_provenance_case "evidence has no bindings object" \
  'del(.bindings)' \
  "SOURCE_VERIFICATION_BINDINGS_NOT_VERIFIED:missing" verified keep
if ! jq -e '.sourceVerification.bindings.status == "missing"' "$LAST_PROVENANCE_RECORD" >/dev/null 2>&1; then
  failed "no bindings object: status should be recorded as missing, got $(jq -r '.sourceVerification.bindings.status' "$LAST_PROVENANCE_RECORD")"
elif ! jq -e '.sourceVerification.bindings.failureCount == 1' "$LAST_PROVENANCE_RECORD" >/dev/null 2>&1; then
  failed "no bindings object: failureCount must floor at 1 so an empty report cannot understate the gate: $(jq -c '.sourceVerification.bindings' "$LAST_PROVENANCE_RECORD")"
elif ! jq -e '.sourceVerification.bindings.failures == []' "$LAST_PROVENANCE_RECORD" >/dev/null 2>&1; then
  failed "no bindings object: failures must serialize as an empty array, got $(jq -c '.sourceVerification.bindings.failures' "$LAST_PROVENANCE_RECORD")"
else
  passed "no bindings object: absence is recorded as its own failure, never as success"
fi
rm -rf "$LAST_PROVENANCE_ROOT"

# ═══════════════════════════════════════════════════════════════════════════════
# Task B: the explicit Etherscan route
# ═══════════════════════════════════════════════════════════════════════════════
section "Source Verification: Etherscan Route Without A Key"

E_ADDR_V="0x1111111111111111111111111111111111111111"
E_ADDR_R="0x2222222222222222222222222222222222222222"
E_ADDR_P="0x3333333333333333333333333333333333333333"

mock_dir19=$(setup_mock_dir "/tmp/xyx-mock-verify-etherscan-nokey-$$")
state_dir19="$mock_dir19/state"
create_mock_state "$state_dir19"
rm -f "$state_dir19/verify-invocations.log"

PATH="$mock_dir19/bin:$PATH"
export MOCK_STATE_DIR="$state_dir19"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"
export MONAD_VERIFY_ROUTE=etherscan
unset MONAD_EXPLORER_API_KEY

V_JSON19="$mock_dir19/verify-result.json"
V_OUT19=$(mktemp)
rm -f "$V_JSON19"
E_RC=0
VERIFY_OUT="$V_JSON19" "$VERIFY" \
  "$E_ADDR_V" "$E_ADDR_R" "$E_ADDR_P" \
  >"$V_OUT19" 2>&1 || E_RC=$?

if [ "$E_RC" -eq 0 ]; then
  failed "the etherscan route exited 0 with no API key"
else
  passed "the etherscan route exits nonzero when MONAD_EXPLORER_API_KEY is unset"
fi

if [ "$(invocation_total "$state_dir19/verify-invocations.log")" != "0" ]; then
  failed "the etherscan route submitted verification before discovering the key was missing"
else
  passed "the missing key is caught before any forge submission"
fi

if [ -e "$V_JSON19" ]; then
  failed "the etherscan route wrote a machine-readable result with no API key"
else
  passed "no verification result file is written on the missing-key path"
fi

if grep -q "MONAD_EXPLORER_API_KEY" "$V_OUT19"; then
  passed "the failure names the variable that must be set"
else
  failed "the missing-key failure does not name MONAD_EXPLORER_API_KEY: $(tail -2 "$V_OUT19")"
fi

# The missing-key path must not write a key: there is no key to write, so any
# key-shaped fragment in its output would be one the script invented or sourced
# from somewhere else. Nothing is set here, so this asserts only that the failure
# is about the absence of a key, not about any key value.
if grep -qE '(api[_-]?key|explorer[_-]?key)["'"'"']?\s*[:=]\s*["'"'"']?[A-Za-z0-9_-]{8,}' "$V_OUT19"; then
  failed "the missing-key path wrote a key value in its message"
else
  passed "the missing-key path states no key value"
fi
rm -f "$V_OUT19" "$V_JSON19"
unset MONAD_VERIFY_ROUTE

section "Source Verification: Explicit Etherscan Route With A Key"

# A test-only key. It is long enough to be key-shaped, so the leak assertions
# below would catch it if the script echoed it anywhere.
TEST_ETHERSCAN_KEY="mock-etherscan-key-not-a-real-secret-0123456789abcdef"

mock_dir20=$(setup_mock_dir "/tmp/xyx-mock-verify-etherscan-$$")
state_dir20="$mock_dir20/state"
create_mock_state "$state_dir20"
rm -f "$state_dir20/verify-invocations.log"

for a in "$E_ADDR_V" "$E_ADDR_R" "$E_ADDR_P"; do
  echo "verified" > "$state_dir20/verified-$a.txt"
done

PATH="$mock_dir20/bin:$PATH"
export MOCK_STATE_DIR="$state_dir20"
export MOCK_ETHERSCAN_API_KEY="$TEST_ETHERSCAN_KEY"
export MONAD_VERIFY_ROUTE=etherscan
export MONAD_EXPLORER_API_KEY="$TEST_ETHERSCAN_KEY"
export MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz"
export MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz"

V_JSON20="$mock_dir20/verify-result.json"
V_OUT20=$(mktemp)
rm -f "$V_JSON20"
B_RC=0
VERIFY_OUT="$V_JSON20" "$VERIFY" \
  "$E_ADDR_V" "$E_ADDR_R" "$E_ADDR_P" \
  >"$V_OUT20" 2>&1 || B_RC=$?

if [ "$B_RC" -ne 0 ]; then
  failed "the explicit etherscan route exited $B_RC with a key and three positive responses"
elif ! grep -qx "ALL_VERIFIED" "$V_OUT20"; then
  failed "the etherscan route exited 0 without printing exactly ALL_VERIFIED"
else
  passed "the etherscan route exits 0 and prints exactly ALL_VERIFIED"
fi

# The mock must have seen --verifier etherscan AND --watch on every submission.
# Both are load-bearing: the wrong verifier goes to the wrong endpoint, and
# without --watch an asynchronous submission stops at "submitted".
route_ok=true
for spec in "$E_ADDR_V|src/MonadP256Verifier.sol:MonadP256Verifier" \
            "$E_ADDR_R|src/XYXPasskeyRegistry.sol:XYXPasskeyRegistry" \
            "$E_ADDR_P|src/XYXDeliveryProtocol.sol:XYXDeliveryProtocol"; do
  IFS='|' read -r a fqn <<< "$spec"
  if ! grep -qxF "$a $fqn verifier=etherscan watch=yes" \
      "$state_dir20/verify-invocations.log" 2>/dev/null; then
    failed "etherscan submission for $a did not record verifier=etherscan watch=yes: $(grep "^$a " "$state_dir20/verify-invocations.log" || echo '<none>')"
    route_ok=false
  fi
done
if [ "$route_ok" = true ]; then
  passed "every etherscan submission carries --verifier etherscan and --watch"
fi

# Exactly one local command per contract, counted from the mock's log.
once_each=true
for a in "$E_ADDR_V" "$E_ADDR_R" "$E_ADDR_P"; do
  n=$(invocation_count "$state_dir20/verify-invocations.log" "$a")
  if [ "$n" != "1" ]; then
    failed "contract $a was invoked $n time(s) on the etherscan route, expected exactly 1"
    once_each=false
  fi
done
if [ "$once_each" = true ]; then
  total=$(invocation_total "$state_dir20/verify-invocations.log")
  if [ "$total" = "3" ]; then
    passed "the etherscan route invokes verification once per contract"
  else
    failed "expected exactly 3 verification command invocations on the etherscan route, found $total"
  fi
fi

# The etherscan route also reports the renamed field, with the same meaning: one
# local command per contract, no `submissions` key.
if jq -e '[.contracts[].verificationCommandInvocations] | all(. == 1)' "$V_JSON20" >/dev/null 2>&1; then
  passed "every etherscan contract entry records verificationCommandInvocations == 1"
else
  failed "verificationCommandInvocations is not 1 for every etherscan contract: $(jq -c '[.contracts[] | {name, verificationCommandInvocations}]' "$V_JSON20" 2>/dev/null)"
fi

if jq -e 'has("submissions") or ([.contracts[] | has("submissions")] | any)' "$V_JSON20" >/dev/null 2>&1; then
  failed "the etherscan result still carries a misleading 'submissions' key"
else
  passed "the etherscan result contains no 'submissions' key"
fi

# The mock returned positive terminal responses, so all three must be verified.
if [ ! -s "$V_JSON20" ]; then
  failed "the etherscan route wrote no machine-readable result"
elif ! jq -e '[.contracts[].status] | all(. == "verified")' "$V_JSON20" >/dev/null 2>&1; then
  failed "not every etherscan contract outcome is verified: $(jq -c '[.contracts[] | {name, status}]' "$V_JSON20")"
else
  passed "all three contracts verify on the etherscan route"
fi

# Neither the human-readable output nor the machine-readable result may carry the
# key, in any form: not the key itself, not a truncated key, and not a fragment
# that would survive a redaction that only masked the middle.
leaked_out=$(leaks_key_fragment "$TEST_ETHERSCAN_KEY" "$(cat "$V_OUT20")" || true)
leaked_json=""
if [ -s "$V_JSON20" ]; then
  leaked_json=$(leaks_key_fragment "$TEST_ETHERSCAN_KEY" "$(cat "$V_JSON20")" || true)
fi
if [ -n "$leaked_out" ]; then
  failed "the etherscan route leaked a fragment of the API key to stdout/stderr: $leaked_out"
elif [ -n "$leaked_json" ]; then
  failed "the etherscan route leaked a fragment of the API key to VERIFY_OUT: $leaked_json"
else
  passed "neither stdout/stderr nor VERIFY_OUT contains any fragment of the API key"
fi

# The mock must itself refuse an etherscan invocation that is missing the key or
# missing --watch, and must refuse a key it did not issue — and must not echo the
# key it refuses. Each carries the canonical --root so the rejection is about the
# etherscan route, not about an unresolvable project root.
mock_rejects_key() {
  local desc="$1"; shift
  local out rc=0
  out=$(MOCK_STATE_DIR="$state_dir20" "$mock_dir20/bin/forge" verify-contract "$@" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    failed "mock forge accepted an invalid etherscan invocation: $desc -> $out"
  elif printf '%s' "$out" | grep -qF "$TEST_ETHERSCAN_KEY"; then
    failed "mock forge echoed the API key while refusing: $desc"
  else
    passed "mock forge refuses: $desc"
  fi
}

mock_rejects_key "etherscan without an API key" \
  --root "$MOCK_CONTRACTS_ROOT" \
  --chain 10143 --verifier etherscan --watch \
  "$E_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier"

mock_rejects_key "etherscan without --watch" \
  --root "$MOCK_CONTRACTS_ROOT" \
  --chain 10143 --verifier etherscan --etherscan-api-key "$TEST_ETHERSCAN_KEY" \
  "$E_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier"

mock_rejects_key "etherscan with a key this suite did not issue" \
  --root "$MOCK_CONTRACTS_ROOT" \
  --chain 10143 --verifier etherscan --etherscan-api-key "not-the-issued-key-0123456789abcdefghij" --watch \
  "$E_ADDR_V" "src/MonadP256Verifier.sol:MonadP256Verifier"

rm -f "$V_OUT20" "$V_JSON20"
unset MONAD_VERIFY_ROUTE MONAD_EXPLORER_API_KEY MOCK_ETHERSCAN_API_KEY

# ═══════════════════════════════════════════════════════════════════════════════
# Task B2: the immutable bindings are an independent gate in the source
# verification script. All three contracts can be source-verified while the
# wiring they were deployed with points somewhere else. That run must not print
# ALL_VERIFIED, and its machine-readable record must carry the binding state in
# its own object so no consumer can read contracts[].status alone.
# ═══════════════════════════════════════════════════════════════════════════════
section "Source Verification: Bindings Gate ALL_VERIFIED"

B_ADDR_V="$E_ADDR_V"
B_ADDR_R="$E_ADDR_R"
B_ADDR_P="$E_ADDR_P"

# run_binding_case <desc> <mutations> <expected reason> <expected count>
# <mutations> is one or more newline-separated <mock-state-file>=<value> specs,
# each of which rewrites one on-chain immutable read the mock cast will answer.
# The three contracts all verify; only the mutated reads are wrong.
run_binding_case() {
  local desc="$1" mutation="$2" expect_reason="$3" expect_count="$4"
  local case_root mock_bin state rc out out_log
  case_root=$(mktemp -d "/tmp/xyx-mock-verify-bindings-XXXXXX")
  setup_mock_dir "$case_root" >/dev/null
  mock_bin="$case_root/bin"
  state="$case_root/state"
  create_mock_state "$state"
  rm -f "$state/verify-invocations.log"

  for a in "$B_ADDR_V" "$B_ADDR_R" "$B_ADDR_P"; do
    echo "verified" > "$state/verified-$a.txt"
  done

  # The defects: on-chain immutable values that no longer match the deployment.
  # Each spec is <mock-state-file>=<new value>, so the mutation is data the mock
  # `cast` reads rather than shell built here.
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    printf '%s\n' "${spec#*=}" > "$state/${spec%%=*}"
  done <<< "$mutation"

  out="$case_root/verify-result.json"
  out_log=$(mktemp)
  rm -f "$out"
  rc=0
  PATH="$mock_bin:$PATH" \
  MOCK_STATE_DIR="$state" \
  MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz" \
  MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz" \
  MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444" \
  XYX_RP_ID="xyx.local" \
    VERIFY_OUT="$out" "$VERIFY" "$B_ADDR_V" "$B_ADDR_R" "$B_ADDR_P" \
    >"$out_log" 2>&1 || rc=$?

  if [ "$rc" -eq 0 ]; then
    failed "$desc: the route exited 0 with a failed immutable binding"
  elif grep -qx "ALL_VERIFIED" "$out_log"; then
    failed "$desc: the route printed exactly ALL_VERIFIED despite a failed binding"
  elif ! grep -qx "NOT_ALL_VERIFIED" "$out_log"; then
    failed "$desc: the route did not print exactly NOT_ALL_VERIFIED: $(tail -3 "$out_log" | tr '\n' ' ')"
  else
    passed "$desc: sources verified, bindings failed, so NOT_ALL_VERIFIED"
  fi

  if ! grep -q "BINDINGS: FAILED" "$out_log"; then
    failed "$desc: the summary does not report the binding gate as FAILED"
  elif ! grep -qF "$expect_reason" "$out_log"; then
    failed "$desc: the summary does not name the binding reason: $(grep -A4 'BINDINGS: FAILED' "$out_log" | tr '\n' ' ')"
  else
    passed "$desc: the failing binding is named in the human summary"
  fi

  # The source gate must stay green on its own: these are two independent gates,
  # so a binding failure must not relabel a verified contract.
  if ! jq -e '[.contracts[]] | all(.status == "verified")' "$out" >/dev/null 2>&1; then
    failed "$desc: a binding failure relabeled a verified contract: $(jq -c '[.contracts[].status]' "$out")"
  else
    passed "$desc: all three contracts remain individually verified"
  fi

  if ! jq -e '.bindings.ok == false' "$out" >/dev/null 2>&1; then
    failed "$desc: bindings.ok is not false: $(jq -c '.bindings' "$out")"
  elif ! jq -e '.bindings.status == "failed"' "$out" >/dev/null 2>&1; then
    failed "$desc: bindings.status is not failed: $(jq -c '.bindings' "$out")"
  elif ! jq -e ".bindings.failureCount == $expect_count" "$out" >/dev/null 2>&1; then
    failed "$desc: bindings.failureCount is not $expect_count: $(jq -c '.bindings' "$out")"
  elif ! jq -e --arg r "$expect_reason" '.bindings.failures | index($r) != null' "$out" >/dev/null 2>&1; then
    failed "$desc: bindings.failures does not carry the reason: $(jq -c '.bindings.failures' "$out")"
  elif ! jq -e ".bindings.failures | length == $expect_count" "$out" >/dev/null 2>&1; then
    failed "$desc: bindings.failures lists $(jq -r '.bindings.failures | length' "$out") reasons, expected $expect_count: $(jq -c '.bindings.failures' "$out")"
  else
    passed "$desc: the record carries status, ok, failureCount and the named reasons"
  fi

  if ! jq -e '.allVerified == false' "$out" >/dev/null 2>&1; then
    failed "$desc: allVerified must be false when the binding gate fails"
  else
    passed "$desc: allVerified is false"
  fi

  # A consumer reading only contracts[].status would see three verified entries
  # and conclude success; the record must not let that pass as a release.
  if ! jq -e '([.contracts[]] | all(.status == "verified")) and (.bindings.ok == false)
              and (.allVerified == false)' "$out" >/dev/null 2>&1; then
    failed "$desc: the record does not separate the source gate from the binding gate"
  else
    passed "$desc: the two gates are independently readable in the record"
  fi

  rm -rf "$case_root"
  rm -f "$out_log"
}

run_binding_case "protocol bound to the wrong registry" \
  'call-passkeyRegistry.txt=0x9999999999999999999999999999999999999999' \
  "protocol.passkeyRegistry does not match the passkey registry address under test" 1

run_binding_case "zero rpIdHash" \
  'call-rpIdHash.txt=0x0000000000000000000000000000000000000000000000000000000000000000' \
  "passkeyRegistry.rpIdHash is zero, so no passkey can match this deployment" 1

# Two independent defects must be counted and named separately, never collapsed
# into one generic failure.
run_binding_case "two wrong bindings at once" \
  'call-rpIdHash.txt=0x0000000000000000000000000000000000000000000000000000000000000000
call-p256Verifier.txt=0x8888888888888888888888888888888888888888' \
  "passkeyRegistry.rpIdHash is zero, so no passkey can match this deployment" 2

# ═══════════════════════════════════════════════════════════════════════════════
# Task C: canonical Foundry root resolution
#
# The repository root is NOT a Foundry project root. The only foundry.toml lives
# at packages/contracts/foundry.toml, and forge resolves its project from --root
# or from the nearest foundry.toml walking up from $PWD — so from the repo root
# `forge inspect MonadP256Verifier bytecode` fails with "No contract found with
# the name" and `forge verify-contract` addresses no project at all. These tests
# pin the fix: every forge invocation carries --root <canonical contracts root>.
# ═══════════════════════════════════════════════════════════════════════════════
section "Foundry Root: Provenance Constructor Decoding"

# A forge mock wrapper that STRIP --root, or REWRITES it to a wrong value, is how
# these tests simulate the failure modes without editing the scripts under test.
# The wrapper sits ahead of the real mock on PATH and forwards everything else
# untouched, so the only variable in each run is the root.
make_forge_wrapper() {
  # make_forge_wrapper <dir> <mode>
  #   drop    -> delete --root <path> from the argument list entirely
  #   rebase  -> rewrite --root <path> to a different absolute path
  local dir="$1" mode="$2" real_forge="$3"
  cat > "$dir" <<WRAP_EOF
#!/usr/bin/env bash
args=()
while [ \$# -gt 0 ]; do
  case "\$1" in
    --root)
      case "$mode" in
        drop)   shift 2 ;;
        rebase) args+=(--root "\$REPO_ROOT/packages/packages/contracts"); shift 2 ;;
      esac
      ;;
    *) args+=("\$1"); shift ;;
  esac
done
exec "$real_forge" \${args[@]+"\${args[@]}"}
WRAP_EOF
  chmod +x "$dir"
}

# Runs provenance with the real mock forge shadowed by a wrapper of mode $1, and
# echoes "rc=<n> reasons=<reason codes> decoded=<contracts with ctor args>" for the
# caller to assert on.
#
# $2 is a READY-TO-USE state directory (already created, finalized, and carrying
# valid verification evidence), copied verbatim into the sandbox. Building the
# fixture inside the sandbox would reset the very facts these tests vary, so the
# caller owns fixture construction and this function only changes the forge root.
run_provenance_with_forge_mode() {
  # run_provenance_with_forge_mode <mode> <ready_state_dir>
  local mode="$1" state="$2"
  local case_root mock_bin real_forge log rc reasons ctor_ok
  case_root=$(mktemp -d "/tmp/xyx-root-prov-XXXXXX")
  setup_mock_dir "$case_root" >/dev/null
  mock_bin="$case_root/bin"
  real_forge="$mock_bin/forge"

  if [ "$mode" != "keep" ]; then
    # Order matters: move the real mock to forge.real FIRST, then write the
    # wrapper at forge. Writing the wrapper first would leave mv moving the
    # wrapper itself, so $mock_bin/forge would not exist and the script under
    # test would fall through to the real forge on PATH — testing nothing.
    mv "$real_forge" "$mock_bin/forge.real"
    make_forge_wrapper "$mock_bin/forge" "$mode" "$mock_bin/forge.real"
  fi

  cp -r "$state" "$case_root/state"

  log="$case_root/provenance.json"
  rc=0
  PATH="$mock_bin:$PATH" \
  PROVENANCE_VERIFICATION_RESULT="$state/verification.json" \
  PROVENANCE_OUT="$log" \
  MOCK_STATE_DIR="$case_root/state" \
  REPO_ROOT="$PROJECT_ROOT" \
  MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz" \
  MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz" \
  MONAD_USDC_ADDRESS="0x4444444444444444444444444444444444444444" \
  XYX_RP_ID="xyx.local" \
    "$PROVENANCE" "$F_ADDR_V" "$F_ADDR_R" "$F_ADDR_P" \
      "$F_TX_V" "$F_TX_R" "$F_TX_P" >/dev/null 2>&1 || rc=$?

  reasons=$(jq -r '[.incompleteReasons[]] | join(",")' "$log" 2>/dev/null || printf 'NO_RECORD')
  # The record field is `constructorArgs` (not `constructorArguments`).
  # MonadP256Verifier takes no constructor arguments and stays at "0x", so only
  # the registry (2 words) and the protocol (3 words) can ever decode to a real
  # value. Counting "!= null" would be vacuous: the field is always present.
  ctor_ok=$(jq -r '[.contracts[]? | select((.constructorArgs // "0x") != "0x")] | length' "$log" 2>/dev/null || printf 'NO_RECORD')
  rm -rf "$case_root"
  printf 'rc=%s reasons=%s decoded=%s' "$rc" "$reasons" "$ctor_ok"
}

# A ready-to-use state directory: the fixture is fully finalized and verified, so
# the ONLY variable between the three runs below is the forge root. The evidence
# file lives INSIDE state/ because run_provenance_with_forge_mode copies the whole
# directory, and PROVENANCE_VERIFICATION_RESULT must survive that copy.
root_state=$(mktemp -d "/tmp/xyx-root-state-XXXXXX")
setup_mock_dir "$root_state" >/dev/null
create_mock_state "$root_state/state"
finalize_mock_state "$root_state/state"
write_verification_evidence "$root_state/state/verification.json" "$F_ADDR_V" "$F_ADDR_R" "$F_ADDR_P"

# ── E1: the canonical root is the only one that decodes constructor arguments ──
baseline=$(run_provenance_with_forge_mode keep "$root_state/state")

if ! printf '%s' "$baseline" | grep -q '^rc=0 '; then
  failed "provenance does not reach final even with the canonical root: $baseline"
elif ! printf '%s' "$baseline" | grep -q 'reasons= '; then
  failed "the canonical root still records blocking reasons: $baseline"
elif ! printf '%s' "$baseline" | grep -q 'decoded=2'; then
  failed "the canonical root did not decode the registry and protocol constructor arguments: $baseline"
else
  passed "provenance reaches final with rc=0 and decodes registry+protocol constructor arguments only with the canonical root"
fi

# ── E1b: no --root at all must surface as ARTIFACT_UNREADABLE, not as success ──
dropped=$(run_provenance_with_forge_mode drop "$root_state/state")

if printf '%s' "$dropped" | grep -q '^rc=0 '; then
  failed "provenance claimed final with forge --root omitted: $dropped"
elif ! printf '%s' "$dropped" | grep -q 'CONSTRUCTOR_ARTIFACT_UNREADABLE:p256Verifier'; then
  failed "omitting --root did not report CONSTRUCTOR_ARTIFACT_UNREADABLE:p256Verifier: $dropped"
elif ! printf '%s' "$dropped" | grep -q 'decoded=0'; then
  failed "omitting --root still decoded constructor arguments: $dropped"
else
  passed "omitting --root reports CONSTRUCTOR_ARTIFACT_UNREADABLE and the record stays draft"
fi

# ── E1c: a wrong --root must be rejected the same way ──
rebased=$(run_provenance_with_forge_mode rebase "$root_state/state")

if printf '%s' "$rebased" | grep -q '^rc=0 '; then
  failed "provenance claimed final with a wrong forge --root: $rebased"
elif ! printf '%s' "$rebased" | grep -q 'CONSTRUCTOR_ARTIFACT_UNREADABLE:p256Verifier'; then
  failed "a wrong --root did not report CONSTRUCTOR_ARTIFACT_UNREADABLE:p256Verifier: $rebased"
elif ! printf '%s' "$rebased" | grep -q 'decoded=0'; then
  failed "a wrong --root still decoded constructor arguments: $rebased"
else
  passed "a wrong forge --root reports CONSTRUCTOR_ARTIFACT_UNREADABLE and the record stays draft"
fi

rm -rf "$root_state"

section "Foundry Root: Source Verification Route"

# E3/E4 — the Sourcify positive path must depend on the canonical root.
#
# The verify script's default route is Sourcify, and the mock forge returns a
# positive terminal response whenever --root resolves. So the SAME mock that
# produces ALL_VERIFIED with the canonical root must produce NOT_ALL_VERIFIED
# when the root is dropped or wrong. The only thing that differs between the
# runs is the wrapper in front of the mock.
# E3/E4 — the Sourcify positive path must depend on the canonical root.
#
# The verify script's default route is Sourcify, and the mock forge returns a
# positive terminal response whenever --root resolves. So the SAME mock that
# produces ALL_VERIFIED with the canonical root must produce NOT_ALL_VERIFIED
# when the root is dropped or wrong. The only thing that differs between the
# runs is the wrapper in front of the mock.
#
# VERIFY_OUT is enabled on every mode, not just the good one, so the
# machine-readable result is asserted on the failing paths too. That is where a
# misleading field name does its damage: an invocation count read as a submission
# count would make a run that verified nothing look like it had submitted work.
run_verify_with_forge_mode() {
  # run_verify_with_forge_mode <mode>
  #   -> echoes "rc=<n> verdict=<word> log=<n> statuses=<csv> invocations=<csv> subs=<y|n>"
  #      log          mock invocations actually accepted by the mock
  #      statuses     JSON .contracts[].status joined
  #      invocations  JSON .contracts[].verificationCommandInvocations joined
  #      subs         whether a `submissions` key appears anywhere in the JSON
  local mode="$1"
  local case_root mock_bin real_forge state log rc total json statuses invocations subs
  case_root=$(mktemp -d "/tmp/xyx-root-verify-XXXXXX")
  setup_mock_dir "$case_root" >/dev/null
  mock_bin="$case_root/bin"
  real_forge="$mock_bin/forge"

  if [ "$mode" != "keep" ]; then
    # See run_provenance_with_forge_mode: the real mock must move aside first.
    mv "$real_forge" "$mock_bin/forge.real"
    make_forge_wrapper "$mock_bin/forge" "$mode" "$mock_bin/forge.real"
  fi

  state="$case_root/state"
  create_mock_state "$state"
  rm -f "$state/verify-invocations.log"
  for a in "$F_ADDR_V" "$F_ADDR_R" "$F_ADDR_P"; do
    echo "verified" > "$state/verified-$a.txt"
  done

  log="$case_root/out.log"
  json="$case_root/verify.json"
  rc=0
  PATH="$mock_bin:$PATH" \
  MOCK_STATE_DIR="$state" \
  REPO_ROOT="$PROJECT_ROOT" \
  MONAD_RPC_URL_PRIMARY="https://primary.monad.xyz" \
  MONAD_RPC_URL_SECONDARY="https://secondary.monad.xyz" \
  VERIFY_OUT="$json" \
    "$VERIFY" "$F_ADDR_V" "$F_ADDR_R" "$F_ADDR_P" >"$log" 2>&1 || rc=$?

  if grep -qx "ALL_VERIFIED" "$log"; then
    verdict="ALL_VERIFIED"
  elif grep -qx "NOT_ALL_VERIFIED" "$log"; then
    verdict="NOT_ALL_VERIFIED"
  else
    verdict="NO_VERDICT"
  fi
  total=$(invocation_total "$state/verify-invocations.log")
  statuses=$(jq -r '[.contracts[]?.status] | join(",")' "$json" 2>/dev/null || printf 'NO_JSON')
  invocations=$(jq -r '[.contracts[]?.verificationCommandInvocations] | join(",")' "$json" 2>/dev/null || printf 'NO_JSON')
  if jq -e 'has("submissions") or ([.contracts[]? | has("submissions")] | any)' "$json" >/dev/null 2>&1; then
    subs="yes"
  else
    subs="no"
  fi
  rm -rf "$case_root"
  printf 'rc=%s verdict=%s log=%s statuses=%s invocations=%s subs=%s' \
    "$rc" "$verdict" "$total" "$statuses" "$invocations" "$subs"
}

sourcify_canonical=$(run_verify_with_forge_mode keep)

if ! printf '%s' "$sourcify_canonical" | grep -q '^rc=0 verdict=ALL_VERIFIED log=3 '; then
  failed "the sourcify positive path does not succeed with the canonical root: $sourcify_canonical"
elif ! printf '%s' "$sourcify_canonical" | grep -q 'statuses=verified,verified,verified '; then
  failed "the canonical sourcify path did not report all three contracts verified: $sourcify_canonical"
elif ! printf '%s' "$sourcify_canonical" | grep -q ' invocations=1,1,1 '; then
  failed "the canonical sourcify path did not record one command invocation per contract: $sourcify_canonical"
elif ! printf '%s' "$sourcify_canonical" | grep -q ' subs=no$'; then
  failed "the canonical sourcify result still carries a 'submissions' key: $sourcify_canonical"
else
  passed "the sourcify positive path succeeds only with the canonical root: rc=0, ALL_VERIFIED, 3 accepted invocations, 3 verified"
fi

# ── E3/E4 mandatory: the bad-root paths must fail, and the JSON must say so ────
# Verified with VERIFY_OUT enabled so the machine-readable result is checked on
# the failing path, which is where an invocation count could masquerade as proof
# that verification work was submitted to a verifier.
for bad_mode in drop rebase; do
  if [ "$bad_mode" = drop ]; then
    bad_desc="--root omitted"
  else
    bad_desc="a wrong --root"
  fi

  bad=$(run_verify_with_forge_mode "$bad_mode")

  if printf '%s' "$bad" | grep -q 'verdict=ALL_VERIFIED'; then
    failed "the sourcify route claimed ALL_VERIFIED with $bad_desc: $bad"
  elif ! printf '%s' "$bad" | grep -q '^rc=[1-9] '; then
    failed "the sourcify route exited 0 with $bad_desc: $bad"
  elif ! printf '%s' "$bad" | grep -q 'statuses=unverified,unverified,unverified '; then
    failed "with $bad_desc not every contract serializes as unverified: $bad"
  elif ! printf '%s' "$bad" | grep -q ' subs=no$'; then
    failed "the bad-root result still carries a misleading 'submissions' key: $bad"
  # A refused root means the mock never accepted a verifier-compatible
  # invocation. The local command WAS still run, so the invocation count is
  # honestly 1 per contract — it records this script's own action.
  elif printf '%s' "$bad" | grep -q 'log=[1-9]'; then
    failed "the mock logged a verifier-compatible invocation with $bad_desc: $bad"
  elif ! printf '%s' "$bad" | grep -q ' invocations=1,1,1 '; then
    failed "with $bad_desc the local command attempt is not recorded as exactly one per contract: $bad"
  else
    passed "with $bad_desc the route exits nonzero, reports all unverified, logs no verifier-compatible invocation, and records one local command attempt per contract: $bad"
  fi
done

section "Foundry Root: Read-Only Real Foundry Invariants"

# These assert the ACTUAL tool resolves the canonical root, with no mock and no
# RPC: `forge inspect` reads a local artifact and never contacts a chain. The
# invariant is that the explicit root is what makes the call work, and that the
# bytecode it returns is the same regardless of the working directory.
if ! command -v forge >/dev/null 2>&1; then
  failed "forge is not on PATH, so the real root-resolution invariants cannot be checked"
else
  # The real forge may be lower on PATH than a leftover mock, so resolve it by
  # its own absolute path.
  real_forge_bin=$(command -v forge)

  root_inspect="$PROJECT_ROOT/packages/contracts"
  tmp_inspect="$(mktemp -d /tmp/xyx-forge-root-XXXXXX)"

  from_root=$(cd "$PROJECT_ROOT" && "$real_forge_bin" inspect --root "$root_inspect" MonadP256Verifier bytecode 2>/dev/null || true)
  from_tmp=$(cd "$tmp_inspect" && "$real_forge_bin" inspect --root "$root_inspect" MonadP256Verifier bytecode 2>/dev/null || true)

  rm -rf "$tmp_inspect"

  if [ -z "$from_root" ]; then
    failed "forge inspect from the repository root with the explicit --root returned no bytecode"
  elif [ -z "$from_tmp" ]; then
    failed "forge inspect from /tmp with the explicit absolute --root returned no bytecode"
  elif [ "$from_tmp" != "$from_root" ]; then
    failed "forge inspect returned different bytecode from /tmp than from the repository root"
  else
    passed "forge inspect with the explicit --root returns nonempty bytecode from the repo root and from /tmp, and both agree"
  fi

  # And the documented reason the explicit root is required: without it, from
  # the repository root, forge resolves no project.
  no_root=$(cd "$PROJECT_ROOT" && "$real_forge_bin" inspect MonadP256Verifier bytecode 2>/dev/null || true)

  if [ -n "$no_root" ]; then
    failed "forge inspect from the repo root succeeded WITHOUT --root, so the explicit root is not required here"
  else
    passed "forge inspect from the repository root without --root resolves no contract, which is why --root is mandatory"
  fi

  # A wrong absolute root must not silently resolve to the canonical project.
  wrong_root=$(cd "$PROJECT_ROOT" && "$real_forge_bin" inspect --root /tmp MonadP256Verifier bytecode 2>/dev/null || true)

  if [ "$wrong_root" = "$from_root" ]; then
    failed "forge inspect with an unrelated --root returned the canonical bytecode"
  else
    passed "forge inspect with an unrelated --root does not resolve the canonical contract"
  fi
fi

# ── Test 16: Retired legacy verification scripts fail closed ─────────────────
# verify-source-precheck.sh and verify-source.sh used to print PASS/VERIFIED
# from explorer reachability and from a polled substring. They are retired, not
# repaired: each must refuse to run before it touches any argument, RPC URL,
# API key, or explorer URL. These tests must NOT put a mock cast/forge/curl on
# PATH, so a script that parsed arguments or reached the network would fail.
section "Legacy Script Retirement: Fail Closed"

RETIRED_PRECheck="$SCRIPT_BASE/verify-source-precheck.sh"
RETIRED_SOURCE="$SCRIPT_BASE/verify-source.sh"
RETIREMENT_MESSAGE='LEGACY_SCRIPT_RETIRED: use verify-xyx-delivery.sh for XYXDeliveryProtocol'

for retired in "$RETIRED_PRECheck" "$RETIRED_SOURCE"; do
  retired_name="$(basename "$retired")"

  if [ ! -f "$retired" ]; then
    failed "$retired_name exists to be retired"
    continue
  fi

  # Run with a deliberately empty environment and an unresolvable PATH so that
  # any attempt to resolve an external binary, parse a positional argument, or
  # read the environment surfaces as a nonzero exit rather than a misleading
  # success. `bash` is invoked by absolute path because env would otherwise
  # resolve it through the PATH it is being asked to install.
  out=$(env -i PATH=/nonexistent /usr/bin/bash "$retired" 2>&1) && rc=0 || rc=$?

  if [ "$rc" -eq 0 ]; then
    failed "$retired_name exited 0; it must never report a verification result"
  else
    passed "$retired_name exits nonzero (rc=$rc)"
  fi

  if printf '%s' "$out" | grep -qF "$RETIREMENT_MESSAGE"; then
    passed "$retired_name prints the exact retirement message to stderr"
  else
    failed "$retired_name did not print the exact retirement message"
  fi

  # stdout must stay empty: the retirement notice is diagnostic, not a result.
  retired_stdout=$(env -i PATH=/nonexistent /usr/bin/bash "$retired" 2>/dev/null) || true
  if [ -n "$retired_stdout" ]; then
    failed "$retired_name wrote to stdout: '$retired_stdout'"
  else
    passed "$retired_name writes nothing to stdout"
  fi

  for banned in PASS VERIFIED "source verified" "source verification complete" '{"verified"'; do
    if printf '%s' "$out" | grep -qiF "$banned"; then
      failed "$retired_name printed banned success token '$banned'"
    else
      passed "$retired_name never prints '$banned'"
    fi
  done
done

# The retirement must not depend on a friendly environment: a realistic-looking
# invocation, with a live-looking RPC, explorer, API key, and plausible
# addresses, must still fail closed before any of that is used.
realistic_out=$(
  MONAD_RPC_URL='https://testnet-rpc.monad.xyz' \
  MONAD_EXPLORER_URL='https://testnet.monad.xyz' \
  MONAD_EXPLORER_API_KEY='offline-not-a-real-key' \
  MONAD_VERIFY_TIMEOUT=300 \
  MONAD_VERIFY_POLL_INTERVAL=10 \
  bash "$RETIRED_SOURCE" \
    0x1111111111111111111111111111111111111111 \
    0x2222222222222222222222222222222222222222 \
    0x3333333333333333333333333333333333333333 2>&1
) && realistic_rc=0 || realistic_rc=$?
if [ "$realistic_rc" -eq 0 ]; then
  failed "verify-source.sh exited 0 when given a full set of plausible arguments and env vars"
else
  passed "verify-source.sh still fails closed with a full set of plausible arguments and env vars (rc=$realistic_rc)"
fi
if printf '%s' "$realistic_out" | grep -qF "$RETIREMENT_MESSAGE"; then
  passed "verify-source.sh prints the retirement message before using its arguments"
else
  failed "verify-source.sh did not print the retirement message when fully invoked"
fi

# The same for the precheck, whose signature is three addresses.
precheck_out=$(
  MONAD_RPC_URL='https://testnet-rpc.monad.xyz' \
  MONAD_EXPLORER_URL='https://testnet.monad.xyz' \
  MONAD_EXPLORER_API_KEY='offline-not-a-real-key' \
  bash "$RETIRED_PRECheck" \
    0x1111111111111111111111111111111111111111 \
    0x2222222222222222222222222222222222222222 \
    0x3333333333333333333333333333333333333333 2>&1
) && precheck_rc=0 || precheck_rc=$?
if [ "$precheck_rc" -eq 0 ]; then
  failed "verify-source-precheck.sh exited 0 when given a full set of plausible arguments and env vars"
else
  passed "verify-source-precheck.sh still fails closed with a full set of plausible arguments and env vars (rc=$precheck_rc)"
fi
if printf '%s' "$precheck_out" | grep -qiF 'not found or not executable'; then
  # A retired script must say so, not claim it was missing.
  failed "verify-source-precheck.sh reports itself as missing instead of retired"
else
  passed "verify-source-precheck.sh reports retirement, not absence"
fi

# The exit code must be stable so callers can distinguish "retired" from
# "verification failed for a real reason".
declare -A RETIRED_CODES=()
for retired in "$RETIRED_PRECheck" "$RETIRED_SOURCE"; do
  for round in 1 2 3; do
    code=0
    /usr/bin/bash "$retired" >/dev/null 2>&1 && code=0 || code=$?
    RETIRED_CODES["$code"]=1
  done
done
if [ "${#RETIRED_CODES[@]}" -eq 1 ]; then
  passed "retired scripts return one stable exit code across repeated runs"
else
  failed "retired scripts returned differing exit codes: ${!RETIRED_CODES[*]}"
fi

# The canonical path must remain the only tested source-verification route.
if grep -q 'verify-xyx-delivery.sh' "$VERIFY"; then
  passed "verify-xyx-delivery.sh remains the canonical source-verification script"
else
  failed "verify-xyx-delivery.sh no longer names itself as canonical"
fi

# No canonical script may delegate to a retired one. The retired stingers above
# would otherwise resurface as a PASS inside record-provenance.sh.
for canonical in "$VERIFY" "$PROVENANCE" "$PREFLIGHT" "$BINDINGS"; do
  canon_name="$(basename "$canonical")"
  if grep -nE '(^|[^[:alnum:]_-])(verify-source\.sh|verify-source-precheck\.sh)' "$canonical" >/dev/null 2>&1; then
    failed "$canon_name still references a retired verification script"
  else
    passed "$canon_name does not reference a retired verification script"
  fi
done

# ── Retired single-RPC legacy twins ─────────────────────────────────────────
# record-provenance.sh and post-deploy-bindings.sh were the single-RPC
# predecessors of record-xyx-delivery-provenance.sh and
# post-deploy-xyx-delivery-bindings.sh. A single endpoint (with a hardcoded
# live default) can never establish two-node agreement, so anything they printed
# — including "PASS: Chain ID is 10143" or a written provenance.json — looked
# canonical without being canonical. They are retired stingers, not repaired.

RETIRED_PROVENANCE_LEGACY="$SCRIPT_BASE/record-provenance.sh"
RETIRED_BINDINGS_LEGACY="$SCRIPT_BASE/post-deploy-bindings.sh"
LEGACY_STING_FILE="/tmp/xyx-legacy-sting-$$.json"

for retired in "$RETIRED_PROVENANCE_LEGACY" "$RETIRED_BINDINGS_LEGACY"; do
  retired_name="$(basename "$retired")"

  if [ ! -f "$retired" ]; then
    failed "$retired_name exists to be retired"
    continue
  fi

  # The stub must not have been accidentally restored to its working body.
  if grep -qE '^\s*(cast|jq|git) ' "$retired"; then
    failed "$retired_name is retired but still invokes cast/jq/git"
  else
    passed "$retired_name invokes no cast/jq/git before failing closed"
  fi

  out=$(env -i PATH=/nonexistent /usr/bin/bash "$retired" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    failed "$retired_name exited 0; it must never report a result"
  else
    passed "$retired_name exits nonzero (rc=$rc)"
  fi

  if printf '%s' "$out" | grep -qF 'LEGACY_SCRIPT_RETIRED:'; then
    passed "$retired_name prints the retirement marker to stderr"
  else
    failed "$retired_name did not print the retirement marker"
  fi

  retired_stdout=$(env -i PATH=/nonexistent /usr/bin/bash "$retired" 2>/dev/null) || true
  if [ -n "$retired_stdout" ]; then
    failed "$retired_name wrote to stdout: '$retired_stdout'"
  else
    passed "$retired_name writes nothing to stdout"
  fi

  for banned in PASS VALIDATED '"verified" ' UNVERIFIED_FALSE; do
    if printf '%s' "$out" | grep -qiF "$banned"; then
      failed "$retired_name printed banned success token '$banned'"
    else
      passed "$retired_name never prints '$banned'"
    fi
  done
done

# A fully-formed invocation — three plausible addresses, a poisoned RPC, and a
# writable PROVENANCE_OUT — must still fail closed and write nothing.
legacy_prov_out=$(env -i PATH=/usr/bin:/bin \
  MONAD_RPC_URL='https://testnet-rpc.monad.xyz' \
  MONAD_USDC_ADDRESS='0x534b2f3A21130d7a60830c2Df862319e593943A3' \
  XYX_RP_ID='xyx.local' \
  PROVENANCE_OUT="$LEGACY_STING_FILE" \
  bash "$RETIRED_PROVENANCE_LEGACY" \
    0x1111111111111111111111111111111111111111 \
    0x2222222222222222222222222222222222222222 \
    0x3333333333333333333333333333333333333333 \
    0x4444444444444444444444444444444444444444 \
    0x5555555555555555555555555555555555555555 \
    0x6666666666666666666666666666666666666666 2>&1) && legacy_prov_rc=0 || legacy_prov_rc=$?
if [ "$legacy_prov_rc" -eq 0 ]; then
  failed "record-provenance.sh exited 0 when given a full set of plausible arguments"
else
  passed "record-provenance.sh still fails closed when fully invoked (rc=$legacy_prov_rc)"
fi
if [ -e "$LEGACY_STING_FILE" ]; then
  failed "record-provenance.sh wrote a provenance file before failing closed"
  rm -f "$LEGACY_STING_FILE"
else
  passed "record-provenance.sh writes no provenance file"
fi

legacy_bind_out=$(env -i PATH=/usr/bin:/bin \
  MONAD_RPC_URL='https://testnet-rpc.monad.xyz' \
  bash "$RETIRED_BINDINGS_LEGACY" \
    0x1111111111111111111111111111111111111111 \
    0x2222222222222222222222222222222222222222 \
    0x3333333333333333333333333333333333333333 2>&1) && legacy_bind_rc=0 || legacy_bind_rc=$?
if [ "$legacy_bind_rc" -eq 0 ]; then
  failed "post-deploy-bindings.sh exited 0 when given a full set of plausible arguments"
else
  passed "post-deploy-bindings.sh still fails closed when fully invoked (rc=$legacy_bind_rc)"
fi

# Retirement is advisory documentation, not authorization: the single-RPC names
# stay available so no caller that still references them breaks silently, while
# the canonical dual-RPC twins remain the only supported route.
for canonical in "$PROVENANCE" "$BINDINGS"; do
  canon_name="$(basename "$canonical")"
  if grep -q 'MONAD_RPC_URL_PRIMARY' "$canonical" && grep -q 'MONAD_RPC_URL_SECONDARY' "$canonical"; then
    passed "$canon_name is the dual-RPC canonical successor"
  else
    failed "$canon_name does not use two distinct RPC endpoints"
  fi
done

# ── Results ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Results ==="
echo "Passed: $PASS / $TOTAL"
echo "Failed: $FAIL / $TOTAL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "Some tests failed. Review output above."
  exit 1
else
  echo "All offline tests passed."
  exit 0
fi
