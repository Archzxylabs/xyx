#!/usr/bin/env bash
# RETIRED LEGACY SCRIPT — intentionally non-functional.
#
# This was the single-RPC binding check runbook for the retired AgenticCommerce /
# XYXEvaluator path. It printed "PASS" per binding after reading ONE endpoint
# (MONAD_RPC_URL, defaulting to a hardcoded live URL). A single-node read cannot
# establish that two independent endpoints agree, so a "PASS" from this script
# was never dual-RPC-verified binding confirmation.
#
# The canonical deployment uses three contracts (MonadP256Verifier,
# XYXPasskeyRegistry, XYXDeliveryProtocol), a different binding layout, and an
# explicit two-node agreement gate. Use
# post-deploy-xyx-delivery-bindings.sh for XYXDeliveryProtocol.
#
# The historical file is preserved (not deleted) for review. It fails closed
# BEFORE any argument parsing, RPC call, or cast call, so it can never emit a
# binding "PASS" that looks canonical.
#
# Do not reference this as canonical proof; use post-deploy-xyx-delivery-bindings.sh.

set -u

printf 'LEGACY_SCRIPT_RETIRED: use post-deploy-xyx-delivery-bindings.sh for XYXDeliveryProtocol\n' >&2
printf 'post-deploy-bindings.sh is retired and never reports a binding result.\n' >&2
exit 2
