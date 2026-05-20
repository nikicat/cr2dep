import {
  concat,
  encodeAbiParameters,
  keccak256,
  padHex,
  slice,
  type Hex,
} from "viem";

/** Commitment hashed into the proxy's init code. Matches Solidity's
 * `keccak256(abi.encode(target, data))`. */
export function commitmentOf(target: Hex, data: Hex): Hex {
  const encoded = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }],
    [target, data],
  );
  return keccak256(encoded);
}

/**
 * Build the proxy's CREATE2 init code (87 bytes):
 *   constructor (10) ‖ EIP-1167 stub(impl) (45) ‖ commitment (32)
 * The constructor returns only the first 45 bytes as runtime — the commitment
 * is never deployed, but it binds the CREATE2 address via the init-code hash.
 */
export function buildProxyInitCode(implementation: Hex, commitment: Hex): Hex {
  return concat([
    "0x3d602d80600a3d3981f3",
    "0x363d3d373d3d3d363d73",
    implementation,
    "0x5af43d82803e903d91602b57fd5bf3",
    commitment,
  ]);
}

/**
 * TRON CREATE2 address derivation:
 *   keccak256(0x41 ‖ deployer[20] ‖ salt[32] ‖ keccak256(init_code))[12:32]
 *
 * The 0x41 prefix byte is the TRON-specific replacement for EVM's 0xff.
 */
export function computeCreate2Address(
  deployer: Hex,
  salt: Hex,
  initCode: Hex,
): Hex {
  const paddedSalt = padHex(salt, { size: 32 });
  const initCodeHash = keccak256(initCode);
  const pre = concat(["0x41", deployer, paddedSalt, initCodeHash]);
  return slice(keccak256(pre), 12) as Hex;
}

/** Convenience: full pipeline from (factory, impl, salt, target, data) → proxy address. */
export function predictProxyAddress(
  factory: Hex,
  implementation: Hex,
  salt: Hex,
  target: Hex,
  data: Hex,
): Hex {
  const commitment = commitmentOf(target, data);
  const initCode = buildProxyInitCode(implementation, commitment);
  return computeCreate2Address(factory, salt, initCode);
}
