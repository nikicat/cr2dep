import { TronWeb, type Types as TronTypes } from "tronweb";
import { WalletSigner, type TronNetwork } from "browser-tron-signer";

type ContractAbiInterface = TronTypes.ContractAbiInterface;
type ContractFunctionParameter = TronTypes.ContractFunctionParameter;

import { env } from "./config.js";

/** Constructor argument: `type` is documentational (real type comes from ABI on deploy). */
export type Parameter = ContractFunctionParameter & { value: string };

export interface DeployArgs {
  name: string;
  abi: ContractAbiInterface;
  bytecode: string;
  parameters: Parameter[];
  feeLimit?: number;
  callValue?: number;
}

export interface TriggerArgs {
  contractAddress: string;
  functionSelector: string;
  parameters: Parameter[];
  feeLimit?: number;
  callValue?: number;
}

export interface Signer extends AsyncDisposable {
  /** TRON base58 address that will originate transactions. */
  getOwner(): Promise<string>;
  /** Deploy a new smart contract; returns the contract's TRON address and the broadcast tx ID. */
  deployContract(args: DeployArgs): Promise<{ tron: string; txID: string }>;
  /** Call a contract function and broadcast; returns the tx ID. */
  triggerContract(args: TriggerArgs): Promise<{ txID: string }>;
}

function fullHost(): string {
  return env("TRON_RPC") ?? "https://nile.trongrid.io";
}

function rpcHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = env("TRON_API_KEY");
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  return headers;
}

/** Best-effort inference of the TRON network from TRON_RPC. */
function inferNetwork(): TronNetwork {
  const explicit = env("TRON_NETWORK");
  if (explicit === "mainnet" || explicit === "shasta" || explicit === "nile") return explicit;
  const host = fullHost().toLowerCase();
  if (host.includes("nile")) return "nile";
  if (host.includes("shasta")) return "shasta";
  if (host.includes("api.trongrid.io") || host.includes("api.tron.network")) return "mainnet";
  return "nile";
}

class PrivateKeySigner implements Signer {
  private readonly tw: TronWeb;

  constructor(privateKey: string) {
    this.tw = new TronWeb({
      fullHost: fullHost(),
      headers: rpcHeaders(),
      privateKey: privateKey.replace(/^0x/, ""),
    });
  }

  async getOwner(): Promise<string> {
    const owner = this.tw.defaultAddress.base58;
    if (!owner) throw new Error("PRIVATE_KEY did not yield a default address");
    return owner;
  }

  async deployContract(args: DeployArgs): Promise<{ tron: string; txID: string }> {
    const owner = await this.getOwner();
    // tronweb.createSmartContract takes raw constructor values; types come from the ABI.
    // Our DeployArgs uses {type, value} pairs for symmetry with TriggerArgs — strip them here.
    const rawParameters = args.parameters.map((p) => p.value);
    const unsigned = await this.tw.transactionBuilder.createSmartContract(
      {
        abi: args.abi,
        bytecode: args.bytecode,
        feeLimit: args.feeLimit ?? 1_500_000_000,
        callValue: args.callValue ?? 0,
        userFeePercentage: 100,
        originEnergyLimit: 10_000_000,
        name: args.name,
        parameters: rawParameters,
      },
      owner,
    );
    const tron = TronWeb.address.fromHex(unsigned.contract_address);
    const signed = await this.tw.trx.sign(unsigned);
    const res = await this.tw.trx.sendRawTransaction(signed);
    if (!res.result) throw new Error(`broadcast failed: ${res.code} ${res.message ?? ""}`);
    return { tron, txID: signed.txID };
  }

  async triggerContract(args: TriggerArgs): Promise<{ txID: string }> {
    const owner = await this.getOwner();
    const built = await this.tw.transactionBuilder.triggerSmartContract(
      args.contractAddress,
      args.functionSelector,
      { feeLimit: args.feeLimit ?? 1_000_000_000, callValue: args.callValue ?? 0 },
      args.parameters,
      owner,
    );
    if (!built.result?.result) {
      throw new Error(`triggerSmartContract failed: ${JSON.stringify(built)}`);
    }
    const signed = await this.tw.trx.sign(built.transaction);
    const res = await this.tw.trx.sendRawTransaction(signed);
    if (!res.result) throw new Error(`broadcast failed: ${res.code} ${res.message ?? ""}`);
    return { txID: signed.txID };
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

class BrowserSigner implements Signer {
  private readonly signer: WalletSigner;
  private readonly network: TronNetwork;
  private cachedAddress: string | null = null;

  constructor() {
    this.network = inferNetwork();
    this.signer = new WalletSigner({ defaultNetwork: this.network });
  }

  async getOwner(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;
    console.log(`[browser-tron-signer] opening browser to connect TronLink on ${this.network}...`);
    const { address, approvalUrl } = await this.signer.connectWallet({ network: this.network });
    console.log(`[browser-tron-signer] connected: ${address}`);
    console.log(`  (approval URL: ${approvalUrl})`);
    this.cachedAddress = address;
    return address;
  }

  async deployContract(args: DeployArgs): Promise<{ tron: string; txID: string }> {
    const from = await this.getOwner();
    console.log("[browser-tron-signer] awaiting deploy approval in browser...");
    const { txHash, contractAddress, approvalUrl } = await this.signer.deployContract({
      from,
      contractName: args.name,
      abi: args.abi,
      bytecode: args.bytecode,
      parameters: args.parameters,
      feeLimit: (args.feeLimit ?? 1_500_000_000).toString(),
      callValue: (args.callValue ?? 0).toString(),
      network: this.network,
    });
    console.log(`  (approval URL: ${approvalUrl})`);
    return { tron: contractAddress, txID: txHash };
  }

  async triggerContract(args: TriggerArgs): Promise<{ txID: string }> {
    const from = await this.getOwner();
    console.log("[browser-tron-signer] awaiting tx approval in browser...");
    const { txHash, approvalUrl } = await this.signer.triggerContract({
      from,
      contractAddress: args.contractAddress,
      functionSelector: args.functionSelector,
      parameters: args.parameters,
      feeLimit: (args.feeLimit ?? 1_000_000_000).toString(),
      callValue: (args.callValue ?? 0).toString(),
      network: this.network,
    });
    console.log(`  (approval URL: ${approvalUrl})`);
    return { txID: txHash };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.signer.shutdown();
  }
}

/**
 * Construct a signer. PRIVATE_KEY in env wins (opt-in fallback for CI / automation);
 * otherwise we route signing to a browser wallet via browser-tron-signer.
 */
export function makeSigner(): Signer {
  const pk = env("PRIVATE_KEY");
  if (pk && pk.length > 0) {
    console.log("[signer] PRIVATE_KEY set — using local key signer");
    return new PrivateKeySigner(pk);
  }
  console.log("[signer] no PRIVATE_KEY — using browser-tron-signer (TronLink approval)");
  return new BrowserSigner();
}
