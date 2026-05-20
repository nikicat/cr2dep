import { TronWeb } from "tronweb";

/**
 * Normalise any TRON-ish address (base58 "T...", 0x41-prefixed 21-byte hex,
 * or plain 0x-prefixed 20-byte hex) into the 0x-prefixed 20-byte EVM-style
 * hex used internally by the TVM for CREATE2 hashing.
 */
export function toEvmAddress(addr: string): `0x${string}` {
  if (addr.startsWith("T")) {
    const hex = TronWeb.address.toHex(addr); // "41" + 40 hex chars
    if (!hex.startsWith("41") || hex.length !== 42) {
      throw new Error(`bad TRON address: ${addr}`);
    }
    return `0x${hex.slice(2)}` as `0x${string}`;
  }
  if (addr.startsWith("0x41") && addr.length === 44) {
    return `0x${addr.slice(4)}` as `0x${string}`;
  }
  if (addr.startsWith("41") && addr.length === 42) {
    return `0x${addr.slice(2)}` as `0x${string}`;
  }
  if (addr.startsWith("0x") && addr.length === 42) {
    return addr.toLowerCase() as `0x${string}`;
  }
  throw new Error(`unrecognised address: ${addr}`);
}

/** 0x-prefixed 20-byte EVM hex → TRON base58 ("T...") address. */
export function toTronAddress(evmHex: string): string {
  const hex = (evmHex.startsWith("0x") ? evmHex.slice(2) : evmHex).toLowerCase();
  if (hex.length !== 40) throw new Error(`bad EVM address: ${evmHex}`);
  return TronWeb.address.fromHex(`41${hex}`);
}
