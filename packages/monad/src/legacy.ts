/**
 * Retired payout/commerce API — explicitly namespaced.
 *
 * Everything re-exported here belongs to the retired `AgenticCommerce` /
 * `XYXEvaluator` payout flow. It is kept only so existing read-only tooling and
 * historical fixtures keep resolving; it is **not** canonical and must never be
 * used as evidence for XYXDeliveryProtocol settlement.
 *
 * Boundary rules:
 * - canonical modules (`delivery`, `delivery-chain`, `settlement`,
 *   `canonical-events`, `canonical-chain`, `manifest` canonical schema) must not
 *   import from this module;
 * - new code must not import from this module — use the canonical exports from
 *   `@xyx/monad`;
 * - the retired flow has no deployment on Monad Testnet, so nothing here can
 *   produce a live observation.
 *
 * @module @xyx/monad/legacy
 */

// Retired payout spec, description parser, and payout verifier.
export {
  payoutSpecSchema,
  payoutDescriptionSchema,
  payoutDescription,
  parsePayoutDescription,
  verifyPayout,
  type PayoutSpec,
  type PayoutBinding,
  type JobSnapshot,
} from './payout';

// Retired public manifest format (`xyx.monad.public-manifest.v1`), which names
// `commerce` and `evaluator` deployments.
export {
  publicManifestSchema,
  publicRunSchema,
  type PublicManifest,
  type PublicRun,
} from './manifest';

// Retired commerce/evaluator ABIs and payout snapshot reads.
export {
  commerceAbi,
  evaluatorAbi,
  readPayoutSnapshotAt,
  readPayoutSnapshot,
  matchedPayoutSnapshot,
  type ChainReader,
  type FinalizedBlock,
  type PayoutSnapshot,
} from './chain';
