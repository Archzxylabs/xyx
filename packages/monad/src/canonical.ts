import { keccak256, toHex, type Hex } from 'viem';

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NON_JSON_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!(i in value)) throw new Error('SPARSE_ARRAY');
    return '[' + value.map(canonicalJSON).join(',') + ']';
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map(k => JSON.stringify(k) + ':' + canonicalJSON(record[k])).join(',') + '}';
  }
  throw new Error('NON_JSON_VALUE');
}
export const hashJSON = (value: unknown): Hex => keccak256(toHex(canonicalJSON(value)));
export const hashText = (value: string): Hex => keccak256(toHex(value));
export function atomicAmount(value: string, decimals: number): bigint {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value) || !Number.isInteger(decimals) || decimals<0 || decimals>36) throw new Error('INVALID_AMOUNT');
  const [whole,fraction='']=value.split('.');
  if(fraction.length>decimals)throw new Error('AMOUNT_PRECISION');
  return BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
}
