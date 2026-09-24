/**
 * LEGACY_SCRIPT_RETIRED
 *
 * This script is intentionally non-functional. The legacy AgenticCommerce /
 * XYXEvaluator manifest flow has been retired. Manifests are no longer published
 * through this CLI.
 *
 * The canonical manifest flow uses XYXDeliveryProtocol on Monad Testnet with
 * the `canonicalManifestSchema` (`kind: 'xyx.monad.canonical-manifest.v1'`).
 *
 * To publish canonical evidence, build the manifest directly from on-chain
 * settlement verification and persist it via the canonical storage helpers.
 */
throw new Error('LEGACY_SCRIPT_RETIRED: use the canonical XYXDeliveryProtocol manifest flow instead');
