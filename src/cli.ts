#!/usr/bin/env node
import { Command } from "commander";
import { TronWeb } from "tronweb";
import type { Hex } from "viem";

import { env, loadConfig, saveConfig } from "./config.js";
import {
  getPair,
  initDb,
  insertPair,
  listPairs,
  markDeployed,
  type Pair,
} from "./db.js";
import { toEvmAddress, toTronAddress } from "./tron.js";
import { commitmentOf, predictProxyAddress, TRON_PREFIX } from "./create2.js";
import { factoryArtifact, implArtifact } from "./artifacts.js";

const ZERO_SALT = ("0x" + "00".repeat(32)) as Hex;

function normaliseSalt(salt: string | undefined): Hex {
  if (!salt) return ZERO_SALT;
  const hex = (salt.startsWith("0x") ? salt.slice(2) : salt).toLowerCase();
  if (!/^[0-9a-f]*$/.test(hex)) throw new Error(`salt must be hex: ${salt}`);
  if (hex.length > 64) throw new Error("salt must fit in 32 bytes");
  return `0x${hex.padStart(64, "0")}` as Hex;
}

function normaliseHexBytes(data: string): Hex {
  const hex = (data.startsWith("0x") ? data.slice(2) : data).toLowerCase();
  if (!/^[0-9a-f]*$/.test(hex)) throw new Error(`data must be hex: ${data}`);
  if (hex.length % 2 !== 0) throw new Error("data must have even hex length");
  return `0x${hex}` as Hex;
}

function makeTronWeb(withKey: boolean) {
  const fullHost = env("TRON_RPC") ?? "https://nile.trongrid.io";
  const headers: Record<string, string> = {};
  const apiKey = env("TRON_API_KEY");
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const privateKey = withKey
    ? env("PRIVATE_KEY", true)!.replace(/^0x/, "")
    : undefined;
  return new TronWeb({ fullHost, headers, privateKey });
}

function requireAddresses(): { factory: string; impl: string } {
  const cfg = loadConfig();
  if (!cfg.factoryAddress) throw new Error("no factory configured — run `cli deploy-factory`");
  if (!cfg.implementationAddress) throw new Error("no implementation configured — run `cli deploy-impl`");
  return { factory: cfg.factoryAddress, impl: cfg.implementationAddress };
}

function predicted(pair: Pick<Pair, "target" | "calldata" | "salt">, factoryT: string, implT: string): Hex {
  return predictProxyAddress(
    toEvmAddress(factoryT),
    toEvmAddress(implT),
    pair.salt as Hex,
    pair.target as Hex,
    pair.calldata as Hex,
  );
}

async function deployContract(
  tw: ReturnType<typeof makeTronWeb>,
  name: string,
  abi: unknown[],
  bytecode: Hex,
  parameters: Array<{ type: string; value: string }>,
): Promise<{ tron: string; txID: string }> {
  const owner = tw.defaultAddress.base58;
  if (!owner) throw new Error("no default address — check PRIVATE_KEY");
  const unsigned = await tw.transactionBuilder.createSmartContract(
    {
      abi: abi as any,
      bytecode,
      feeLimit: 1_500_000_000,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 10_000_000,
      name,
      parameters: parameters as any,
    } as any,
    owner,
  );
  const contractAddrHex: string | undefined =
    (unsigned as any).contract_address ??
    (unsigned as any).raw_data?.contract?.[0]?.parameter?.value?.new_contract?.contract_address;
  if (!contractAddrHex) throw new Error("could not read contract_address from tx");
  const tron = TronWeb.address.fromHex(contractAddrHex);
  const signed = await tw.trx.sign(unsigned as any);
  const res: any = await tw.trx.sendRawTransaction(signed);
  if (res.code) throw new Error(`broadcast failed: ${res.code} ${res.message ?? ""}`);
  return { tron, txID: signed.txID };
}

const program = new Command();
program
  .name("cr2dep")
  .description("PoC: TRON CREATE2 calldata-bound proxy deployer")
  .version("0.1.0");

program
  .command("init")
  .description("create the sqlite schema")
  .action(() => {
    initDb();
    console.log("initialised cr2dep.db");
  });

program
  .command("deploy-factory")
  .description("deploy the ProxyFactory singleton and remember its address")
  .action(async () => {
    initDb();
    const tw = makeTronWeb(true);
    const { abi, bytecode } = factoryArtifact();
    const { tron, txID } = await deployContract(tw, "ProxyFactory", abi, bytecode, [
      { type: "bytes1", value: TRON_PREFIX.replace(/^0x/, "") },
    ]);
    saveConfig({ ...loadConfig(), factoryAddress: tron });
    console.log(`factory deployed: ${tron}`);
    console.log(`tx: ${txID}`);
  });

program
  .command("deploy-impl")
  .description("deploy the BoundCaller bound to the configured factory")
  .action(async () => {
    initDb();
    const cfg = loadConfig();
    if (!cfg.factoryAddress) throw new Error("no factory configured — run `deploy-factory` first");
    const tw = makeTronWeb(true);
    const { abi, bytecode } = implArtifact();
    const factoryEvm = toEvmAddress(cfg.factoryAddress);
    const { tron, txID } = await deployContract(tw, "BoundCaller", abi, bytecode, [
      { type: "address", value: factoryEvm },
      { type: "bytes1", value: TRON_PREFIX.replace(/^0x/, "") },
    ]);
    saveConfig({ ...cfg, implementationAddress: tron });
    console.log(`implementation deployed: ${tron}`);
    console.log(`tx: ${txID}`);
  });

program
  .command("set-factory")
  .description("manually set the factory address")
  .argument("<address>", "TRON base58 address")
  .action((address: string) => {
    const tron = toTronAddress(toEvmAddress(address));
    saveConfig({ ...loadConfig(), factoryAddress: tron });
    console.log(`factory set to ${tron}`);
  });

program
  .command("set-impl")
  .description("manually set the implementation address")
  .argument("<address>", "TRON base58 address")
  .action((address: string) => {
    const tron = toTronAddress(toEvmAddress(address));
    saveConfig({ ...loadConfig(), implementationAddress: tron });
    console.log(`implementation set to ${tron}`);
  });

program
  .command("add")
  .description("store a (target, calldata) pair and print its predicted proxy address")
  .requiredOption("--target <address>", "TRON or 0x address to call")
  .requiredOption("--data <hex>", "calldata bytes (hex)")
  .option("--salt <hex>", "32-byte CREATE2 salt (default zero)")
  .action((opts) => {
    initDb();
    const targetEvm = toEvmAddress(opts.target);
    const data = normaliseHexBytes(opts.data);
    const salt = normaliseSalt(opts.salt);
    const id = insertPair(targetEvm, data, salt);
    console.log(`stored pair #${id}`);
    console.log(`commitment = ${commitmentOf(targetEvm, data)}`);
    const cfg = loadConfig();
    if (cfg.factoryAddress && cfg.implementationAddress) {
      const addr = predicted({ target: targetEvm, calldata: data, salt }, cfg.factoryAddress, cfg.implementationAddress);
      console.log(`predicted proxy: ${toTronAddress(addr)}`);
      console.log(`         (hex): ${addr}`);
    } else {
      console.log("(set factory + impl first to see predicted address)");
    }
  });

program
  .command("list")
  .description("list stored pairs with predicted addresses")
  .action(() => {
    initDb();
    const cfg = loadConfig();
    const ready = cfg.factoryAddress && cfg.implementationAddress;
    const rows = listPairs();
    if (rows.length === 0) {
      console.log("(no pairs)");
      return;
    }
    for (const p of rows) {
      const addr = ready
        ? toTronAddress(predicted(p, cfg.factoryAddress!, cfg.implementationAddress!))
        : "(configure factory + impl)";
      const flag = p.deployed ? " [deployed]" : "";
      console.log(`#${p.id}  -> ${addr}${flag}`);
      console.log(`     target = ${toTronAddress(p.target)}`);
      console.log(`     salt   = ${p.salt}`);
      console.log(`     data   = ${p.calldata}`);
      if (p.tx_hash) console.log(`     tx     = ${p.tx_hash}`);
    }
  });

program
  .command("address")
  .description("show predicted proxy address for a stored pair")
  .argument("<id>", "pair id", Number)
  .action((id: number) => {
    const { factory, impl } = requireAddresses();
    const p = getPair(id);
    if (!p) throw new Error(`no pair #${id}`);
    const addr = predicted(p, factory, impl);
    console.log(`pair #${id}: ${toTronAddress(addr)}`);
    console.log(`     (hex): ${addr}`);
  });

program
  .command("deploy")
  .description("deploy the bound CREATE2 proxy for a stored pair")
  .argument("<id>", "pair id", Number)
  .option("--fee-limit <sun>", "fee limit in SUN", String(1_000_000_000))
  .action(async (id: number, opts: { feeLimit: string }) => {
    const { factory, impl } = requireAddresses();
    const p = getPair(id);
    if (!p) throw new Error(`no pair #${id}`);
    if (p.deployed) console.log(`pair #${id} already marked deployed (tx ${p.tx_hash}). Continuing anyway.`);
    const tw = makeTronWeb(true);
    const owner = tw.defaultAddress.base58;
    if (!owner) throw new Error("no default address — check PRIVATE_KEY");

    const commitment = commitmentOf(p.target as Hex, p.calldata as Hex);
    const proxy = predicted(p, factory, impl);
    console.log(`predicted proxy: ${toTronAddress(proxy)}`);

    const built: any = await tw.transactionBuilder.triggerSmartContract(
      factory,
      "deploy(address,bytes32,bytes32)",
      { feeLimit: Number(opts.feeLimit), callValue: 0 },
      [
        { type: "address", value: toEvmAddress(impl) },
        { type: "bytes32", value: p.salt.replace(/^0x/, "") },
        { type: "bytes32", value: commitment.replace(/^0x/, "") },
      ],
      owner,
    );
    if (!built.result?.result) {
      throw new Error(`triggerSmartContract failed: ${JSON.stringify(built)}`);
    }
    const signed = await tw.trx.sign(built.transaction);
    const res: any = await tw.trx.sendRawTransaction(signed);
    if (res.code) throw new Error(`broadcast failed: ${res.code} ${res.message ?? ""}`);
    markDeployed(id, signed.txID);
    console.log(`deploy tx: ${signed.txID}`);
  });

program
  .command("execute")
  .description("call execute(salt, target, data) on a deployed proxy (anyone can run this)")
  .argument("<id>", "pair id", Number)
  .option("--value <sun>", "TRX (in SUN) to forward", "0")
  .option("--fee-limit <sun>", "fee limit in SUN", String(1_000_000_000))
  .action(async (id: number, opts: { value: string; feeLimit: string }) => {
    const { factory, impl } = requireAddresses();
    const p = getPair(id);
    if (!p) throw new Error(`no pair #${id}`);
    const proxyHex = predicted(p, factory, impl);
    const proxyT = toTronAddress(proxyHex);
    console.log(`proxy: ${proxyT}`);

    const tw = makeTronWeb(true);
    const owner = tw.defaultAddress.base58;
    if (!owner) throw new Error("no default address — check PRIVATE_KEY");

    const built: any = await tw.transactionBuilder.triggerSmartContract(
      proxyT,
      "execute(bytes32,address,bytes)",
      { feeLimit: Number(opts.feeLimit), callValue: Number(opts.value) },
      [
        { type: "bytes32", value: p.salt.replace(/^0x/, "") },
        { type: "address", value: toEvmAddress(p.target) },
        { type: "bytes", value: p.calldata.replace(/^0x/, "") },
      ],
      owner,
    );
    if (!built.result?.result) {
      throw new Error(`triggerSmartContract failed: ${JSON.stringify(built)}`);
    }
    const signed = await tw.trx.sign(built.transaction);
    const res: any = await tw.trx.sendRawTransaction(signed);
    if (res.code) throw new Error(`broadcast failed: ${res.code} ${res.message ?? ""}`);
    console.log(`execute tx: ${signed.txID}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
