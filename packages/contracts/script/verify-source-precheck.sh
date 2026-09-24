#!/usr/bin/env bash
# RETIRED LEGACY SCRIPT — intentionally non-functional.
#
# This precheck reported explorer reachability (and, on some paths, a "PASS"
# from a `forge verify-contract` *submission*, which is not a verified source)
# as a verification result for the old two-contract (AgenticCommerce +
# evaluator) deployment. The XYXDeliveryProtocol deployment uses three
# contracts, a different verifier layout, and an explicit binding gate, so
# nothing this script could print would be a truthful source-verification
# result.
#
# It is deliberately NOT repaired or modernized: a script whose only historical
# output was a misleading success line is safer removed than rewritten. Use
# verify-xyx-delivery.sh for XYXDeliveryProtocol source verification.
#
# It fails closed BEFORE any argument parsing, RPC call, cast call, forge call,
# API-key handling, or explorer URL construction.

set -u

printf 'LEGACY_SCRIPT_RETIRED: use verify-xyx-delivery.sh for XYXDeliveryProtocol\n' >&2
printf 'verify-source-precheck.sh is retired and never reports a verification result.\n' >&2
exit 2
