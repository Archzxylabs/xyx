'use client';

/**
 * Transaction lifecycle tracking with Monad finality awareness.
 *
 * States (matching PRD status table):
 *  idle -> draft -> submitted -> pending_finality -> finalized
 *                              -> conflict
 *                 -> failed (user cancelled / reverted)
 */

'use client';

import { useState, useCallback } from 'react';

export type TxLifecycleState =
  | 'idle'
  | 'draft'
  | 'browser_prompt'
  | 'submitted'
  | 'pending_finality'
  | 'finalized'
  | 'user_cancelled'
  | 'reverted'
  | 'conflict'
  | 'failed';

export interface TxState {
  state: TxLifecycleState;
  hash?: string;
  receipt?: { blockNumber: bigint; status: 'success' | 'reverted'; gasUsed?: bigint };
  error?: string;
  explorerUrl?: string;
}

export function useTx() {
  const [state, setState] = useState<TxState>({ state: 'idle' });

  const reset = useCallback(() => setState({ state: 'idle' }), []);
  const toDraft = useCallback(() => setState(s => ({ ...s, state: 'draft' })), []);
  const toPrompt = useCallback(() => setState(s => ({ ...s, state: 'browser_prompt' })), []);
  const toSubmitted = useCallback((hash: string) => setState({ state: 'submitted', hash }), []);
  const toPending = useCallback((receipt: { blockNumber: bigint; status: 'success' | 'reverted'; gasUsed?: bigint }) => setState(s => ({ ...s, state: 'pending_finality', receipt })), []);
  const toFinalized = useCallback((receipt: { blockNumber: bigint; status: 'success' | 'reverted'; gasUsed?: bigint }) => setState(s => ({ ...s, state: 'finalized', receipt, explorerUrl: s.hash ? `https://testnet.monadvision.com/tx/${s.hash}` : undefined })), []);
  const toCancelled = useCallback(() => setState(s => ({ ...s, state: 'user_cancelled', error: 'User rejected the transaction in their wallet.' })), []);
  const toReverted = useCallback((reason?: string) => setState(s => ({ ...s, state: 'reverted', error: reason ?? 'Transaction reverted on-chain.' })), []);
  const toConflict = useCallback((message: string) => setState(s => ({ ...s, state: 'conflict', error: message })), []);
  const toFailed = useCallback((message: string) => setState(s => ({ ...s, state: 'failed', error: message })), []);

  const getAriaMessage = useCallback((): string => {
    switch (state.state) {
      case 'idle': return 'No transaction in progress.';
      case 'draft': return 'Transaction prepared. Awaiting wallet confirmation.';
      case 'browser_prompt': return 'Browser is requesting wallet confirmation.';
      case 'submitted': return `Transaction submitted. Hash: ${state.hash}. Awaiting receipt.`;
      case 'pending_finality': return 'Receipt received. Waiting for finality confirmation.';
      case 'finalized': return 'Transaction finalized on Monad Testnet.';
      case 'user_cancelled': return 'Transaction was rejected in the wallet.';
      case 'reverted': return `Transaction reverted: ${state.error}`;
      case 'conflict': return `State conflict detected: ${state.error}`;
      case 'failed': return `Transaction failed: ${state.error}`;
    }
  }, [state]);

  return {
    state: state.state,
    hash: state.hash,
    error: state.error,
    explorerUrl: state.explorerUrl,
    receipt: state.receipt,
    reset,
    toDraft,
    toPrompt,
    toSubmitted,
    toPending,
    toFinalized,
    toCancelled,
    toReverted,
    toConflict,
    toFailed,
    getAriaMessage,
  };
}
