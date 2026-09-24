/**
 * LEGACY_SCRIPT_RETIRED
 *
 * This script is intentionally non-functional. The legacy AgenticCommerce /
 * XYXEvaluator demo CLI has been retired. It used the retired
 * AgenticCommerce/XYXEvaluator contract flow and MUST NOT be used as
 * canonical evidence for XYXDeliveryProtocol settlement verification.
 *
 * The canonical verification path is `verifySettlement(primary, secondary, input)`
 * against XYXDeliveryProtocol on Monad Testnet (chain ID 10143).
 *
 * This script cannot generate canonical evidence because it depends on
 * legacy commerce/evaluator contracts and their payout/settlement flow.
 */
throw new Error('LEGACY_SCRIPT_RETIRED: use the canonical XYXDeliveryProtocol settlement flow instead');
