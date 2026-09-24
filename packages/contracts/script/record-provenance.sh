#!/usr/bin/env bash
# RETIRED LEGACY SCRIPT — intentionally non-functional.
#
# This was the single-RPC provenance recorder for the retired AgenticCommerce /
# XYXEvaluator path. It read chain state through ONE endpoint (MONAD_RPC_URL,
# defaulting to a hardcoded live URL) and wrote a provenance.json regardless.
# Canonical provenance requires observation from TWO configured, DISTINCT RPC
# endpoints that independently agree, finalized receipts, and verified immutable
# bindings; a single-node read can never establish that, so a record this script
# produced would look canonical while not being canonical.
#
# It also computed an EXPECTED_RP_HASH that it never compared to any on-chain
# value, so the RP-ID check it appeared to perform was never actually enforced.
#
# It is deliberately NOT repaired or modernized. Use
# record-xyx-delivery-provenance.sh for XYXDeliveryProtocol provenance.
#
# The historical file is preserved (not deleted) for review. It fails closed
# BEFORE any argument parsing, RPC call, cast call, jq call, git call, or file
# write, so it can never emit a provenance record that looks canonical.
#
# Do not reference this as canonical proof; use record-xyx-delivery-provenance.sh.

set -u

printf 'LEGACY_SCRIPT_RETIRED: use record-xyx-delivery-provenance.sh for XYXDeliveryProtocol\n' >&2
printf 'record-provenance.sh is retired and never records a provenance result.\n' >&2
exit 2
