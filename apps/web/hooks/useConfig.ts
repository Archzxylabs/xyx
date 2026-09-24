'use client';

/**
 * Hook: reads XYX protocol configuration from environment,
 * validates addresses/syntax, and confirms on-chain readiness.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  readConfig,
  validateConfig,
  type XYXConfig,
} from '../../../packages/monad/src/config';
import {
  validateProtocolConfig,
  type ProtocolConfigStatus,
} from '../../../packages/monad/src/protocol';
import { MONAD_TESTNET_CHAIN_ID } from '../../../packages/monad/src/config';

export interface ResolvedConfig extends XYXConfig {
  configStatus: ProtocolConfigStatus;
}

export function useConfig() {
  const raw = useMemo(() => {
    try {
      return readConfig();
    } catch {
      return undefined;
    }
  }, []);

  const config = useMemo<XYXConfig | undefined>(() => {
    if (!raw) return undefined;
    const validation = validateConfig(raw);
    if (!validation.valid) return undefined;
    return raw;
  }, [raw]);

  const initialStatus = useMemo<ProtocolConfigStatus>(() => {
    if (!raw) {
      return {
        chainValid: false,
        observedChainId: null,
        protocolHasCode: false,
        registryHasCode: false,
        verifierHasCode: false,
        config: undefined,
        errors: ['NEXT_PUBLIC_XYX_CHAIN_ID, PROTOCOL_ADDRESS, REGISTRY_ADDRESS, P256_VERIFIER_ADDRESS, RP_ID, and RPC_URL are not set.'],
      };
    }
    if (!config) {
      const validation = validateConfig(raw);
      return {
        chainValid: false,
        observedChainId: null,
        protocolHasCode: false,
        registryHasCode: false,
        verifierHasCode: false,
        config: raw,
        errors: validation.errors,
      };
    }
    // config is present and syntactically valid; on-chain checks happen async
    return {
      chainValid: false,
      observedChainId: null,
      protocolHasCode: false,
      registryHasCode: false,
      verifierHasCode: false,
      config,
      errors: [],
    };
  }, [raw, config]);

  const [configStatus, setConfigStatus] = useState<ProtocolConfigStatus>(initialStatus);

  useEffect(() => {
    setConfigStatus(initialStatus);
    if (!config) return;
    let active = true;
    void validateProtocolConfig(config).then(
      result => { if (active) setConfigStatus(result); },
      () => { if (active) setConfigStatus({ ...initialStatus, errors: ['RPC_UNAVAILABLE'] }); },
    );
    return () => { active = false; };
  }, [config, initialStatus]);

  // Async on-chain verification
  const verifyOnChain = useCallback(async (): Promise<ProtocolConfigStatus> => {
    if (!raw) return configStatus;
    try {
      const result = await validateProtocolConfig(raw);
      setConfigStatus(result);
      return result;
    } catch {
      const result = { ...initialStatus, errors: ['RPC_UNAVAILABLE'] };
      setConfigStatus(result);
      return result;
    }
  }, [raw, configStatus, initialStatus]);

  const isReady = (): boolean => {
    if (!config) return false;
    return configStatus.errors.length === 0
      && configStatus.chainValid
      && configStatus.protocolHasCode
      && configStatus.registryHasCode
      && configStatus.verifierHasCode;
  };

  const paymentTokenConfigured = config?.paymentTokenAddress != null;

  return {
    config,
    raw,
    configStatus,
    verifyOnChain,
    isReady,
    paymentTokenConfigured,
    explorerUrl: 'https://testnet.monadvision.com',
    chainId: config?.chainId ?? MONAD_TESTNET_CHAIN_ID,
  };
}
