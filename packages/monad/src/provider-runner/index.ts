/**
 * Canonical provider runner for XYXDeliveryProtocol.
 *
 * The public surface is the adapter contract plus the runner itself. It is
 * intentionally small: anything that lets the runner reach beyond the single
 * canonical `submitDelivery` request — chain reads, arbitrary signing, a default
 * wallet, a canned success — is deliberately absent.
 *
 * @module @xyx/monad/provider-runner
 */

export {
  ProviderRunner,
  RunnerError,
  validateTransferRequirement,
  type RunStatus,
  type RunStep,
  type RunFailureCode,
  type RunEvidence,
  type RunOutcome,
  type ProviderRunnerConfig,
  type PreparedDelivery,
  type ObservedTransfer,
  type ObservedSubmission,
  type TaskTransferPlan,
} from './runner';

export type {
  ProviderSigner,
  ProviderSendOutcome,
  TaskExecutionResult,
  TaskExecutor,
  ProviderJobView,
  PrivateDeliveryMaterial,
  PrivateInputProvider,
  TaskTransferRequirement,
  UnknownRecord,
} from './adapters';
