#!/usr/bin/env bash
# RETIRED LEGACY SCRIPT — intentionally non-functional.
#
# This script polled the explorer for a "verified" string inside a 300s /
# 10s poll loop and classified a PASS when the substring appeared. That is not
# a verification result: an explorer page, a submission receipt, or an
# unrelated substring can all satisfy it. The XYXDeliveryProtocol deployment
# uses three contracts, a different verifier layout, and an explicit binding
# gate, so nothing this script could print would be a truthful
# source-verification result.
#
# It is deliberately NOT repaired or modernized. Use verify-xyx-delivery.sh
# for XYXDeliveryProtocol source verification.
#
# It fails closed BEFORE any argument parsing, RPC call, cast call, forge call,
# API-key handling, or explorer URL construction.

set -u

printf 'LEGACY_SCRIPT_RETIRED: use verify-xyx-delivery.sh for XYXDeliveryProtocol\n' >&2
printf 'verify-source.sh is retired and never reports a verification result.\n' >&2
exit 2
