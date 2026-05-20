import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  parseEther,
  size,
  type Address,
  type Hex,
} from "viem";

import {
  buildProxyInitCode,
  commitmentOf,
  EVM_PREFIX,
  predictProxyAddress,
} from "../src/create2.js";

const ZERO_SALT = ("0x" + "00".repeat(32)) as Hex;
const ALT_SALT = ("0x" + "11".repeat(32)) as Hex;

type Rig = Awaited<ReturnType<typeof setupRig>>;

async function setupRig() {
  const conn = await network.getOrCreate();
  const { viem } = conn;
  const publicClient = await viem.getPublicClient();
  const [walletClient] = await viem.getWalletClients();

  const factory = await viem.deployContract("ProxyFactory", [EVM_PREFIX]);
  const impl = await viem.deployContract("BoundCaller", [factory.address, EVM_PREFIX]);
  const target = await viem.deployContract("TestTarget", []);

  return { viem, publicClient, walletClient, factory, impl, target };
}

function encodeBump(target: Rig["target"], by: bigint): Hex {
  return encodeFunctionData({
    abi: target.abi,
    functionName: "bump",
    args: [by],
  });
}

function encodeBoom(target: Rig["target"], why: string): Hex {
  return encodeFunctionData({
    abi: target.abi,
    functionName: "boom",
    args: [why],
  });
}

describe("cr2dep PoC (EDR with 0xff prefix)", () => {
  let rig: Rig;

  before(async () => {
    rig = await setupRig();
  });

  describe("init code shape", () => {
    it("is 87 bytes (10 constructor + 45 stub + 32 commitment)", () => {
      const commit = ("0x" + "ab".repeat(32)) as Hex;
      const init = buildProxyInitCode(rig.impl.address, commit);
      assert.equal(size(init), 87);
    });

    it("embeds the implementation address at offset 10..30", () => {
      const commit = ("0x" + "ab".repeat(32)) as Hex;
      const init = buildProxyInitCode(rig.impl.address, commit);
      const embedded = ("0x" + init.slice(2 + 2 * 20, 2 + 2 * 40)) as Hex;
      assert.equal(getAddress(embedded), getAddress(rig.impl.address));
    });

    it("appends the commitment as the final 32 bytes", () => {
      const commit = ("0x" + "ab".repeat(32)) as Hex;
      const init = buildProxyInitCode(rig.impl.address, commit);
      assert.equal(init.slice(-64), commit.slice(2));
    });
  });

  describe("address prediction parity", () => {
    it("off-chain matches factory.computeAddress", async () => {
      const target = ("0x" + "aa".repeat(20)) as Address;
      const data = "0xdeadbeef" as Hex;
      const commit = commitmentOf(target, data);

      const offChain = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        ZERO_SALT,
        target,
        data,
        EVM_PREFIX,
      );
      const onChain = await rig.factory.read.computeAddress([
        rig.impl.address,
        ZERO_SALT,
        commit,
      ]);
      assert.equal(getAddress(offChain), getAddress(onChain));
    });

    it("off-chain matches BoundCaller.proxyAddressFor (called as a view on the impl)", async () => {
      // proxyAddressFor uses `address(this)` only indirectly via FACTORY — calling it
      // on the impl itself returns the same prediction.
      const target = ("0x" + "bb".repeat(20)) as Address;
      const data = "0xcafebabe1234" as Hex;
      const commit = commitmentOf(target, data);

      const offChain = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        ALT_SALT,
        target,
        data,
        EVM_PREFIX,
      );
      const onChain = await rig.impl.read.proxyAddressFor([ALT_SALT, commit]);
      assert.equal(getAddress(offChain), getAddress(onChain));
    });

    it("different (target, data) yield different addresses with the same salt", () => {
      const a = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        ZERO_SALT,
        rig.target.address,
        encodeBump(rig.target, 1n),
        EVM_PREFIX,
      );
      const b = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        ZERO_SALT,
        rig.target.address,
        encodeBump(rig.target, 2n),
        EVM_PREFIX,
      );
      assert.notEqual(a, b);
    });
  });

  describe("deploy", () => {
    it("lands the proxy at the predicted address with the canonical 45-byte runtime", async () => {
      const data = encodeBump(rig.target, 7n);
      const commit = commitmentOf(rig.target.address, data);
      const predicted = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        ZERO_SALT,
        rig.target.address,
        data,
        EVM_PREFIX,
      );

      const hash = await rig.factory.write.deploy([rig.impl.address, ZERO_SALT, commit]);
      await rig.publicClient.waitForTransactionReceipt({ hash });

      const code = await rig.publicClient.getCode({ address: predicted });
      assert.ok(code, "proxy not deployed");
      assert.equal(size(code), 45, "proxy runtime should be the canonical EIP-1167 stub");
    });

    it("rejects a second deploy at the same address", async () => {
      const data = encodeBump(rig.target, 7n);
      const commit = commitmentOf(rig.target.address, data);

      await assert.rejects(
        rig.factory.simulate.deploy([rig.impl.address, ZERO_SALT, commit]),
        /DeployFailed|revert/,
      );
    });
  });

  describe("execute (happy path)", () => {
    it("forwards calldata to the bound target — count and lastCaller update", async () => {
      const data = encodeBump(rig.target, 5n);
      const commit = commitmentOf(rig.target.address, data);
      const predicted = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        ALT_SALT,
        rig.target.address,
        data,
        EVM_PREFIX,
      );

      let hash = await rig.factory.write.deploy([rig.impl.address, ALT_SALT, commit]);
      await rig.publicClient.waitForTransactionReceipt({ hash });

      const proxy = await rig.viem.getContractAt("BoundCaller", predicted);
      const countBefore = await rig.target.read.count();

      hash = await proxy.write.execute([ALT_SALT, rig.target.address, data]);
      await rig.publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await rig.target.read.count(), countBefore + 5n);
      assert.equal(
        getAddress(await rig.target.read.lastCaller()),
        getAddress(predicted),
        "target should see the proxy as msg.sender",
      );
    });

    it("forwards msg.value to the target", async () => {
      const data = encodeBump(rig.target, 1n);
      const commit = commitmentOf(rig.target.address, data);
      // Distinguish from other (data) by picking a unique salt.
      const salt = ("0x" + "22".repeat(32)) as Hex;
      const predicted = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        salt,
        rig.target.address,
        data,
        EVM_PREFIX,
      );

      let hash = await rig.factory.write.deploy([rig.impl.address, salt, commit]);
      await rig.publicClient.waitForTransactionReceipt({ hash });

      const proxy = await rig.viem.getContractAt("BoundCaller", predicted);
      const value = parseEther("0.5");
      hash = await proxy.write.execute([salt, rig.target.address, data], { value });
      await rig.publicClient.waitForTransactionReceipt({ hash });

      assert.equal(await rig.target.read.lastValue(), value);
    });
  });

  describe("binding enforcement", () => {
    it("rejects mismatched calldata at the same proxy (BindingMismatch)", async () => {
      const boundData = encodeBump(rig.target, 9n);
      const commit = commitmentOf(rig.target.address, boundData);
      const salt = ("0x" + "33".repeat(32)) as Hex;
      const predicted = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        salt,
        rig.target.address,
        boundData,
        EVM_PREFIX,
      );

      const hash = await rig.factory.write.deploy([rig.impl.address, salt, commit]);
      await rig.publicClient.waitForTransactionReceipt({ hash });

      const proxy = await rig.viem.getContractAt("BoundCaller", predicted);
      const wrong = encodeBump(rig.target, 999n);
      await assert.rejects(
        proxy.simulate.execute([salt, rig.target.address, wrong]),
        /BindingMismatch/,
      );
    });

    it("rejects a mismatched target at the same proxy", async () => {
      const boundData = encodeBump(rig.target, 9n);
      const commit = commitmentOf(rig.target.address, boundData);
      const salt = ("0x" + "44".repeat(32)) as Hex;
      const predicted = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        salt,
        rig.target.address,
        boundData,
        EVM_PREFIX,
      );

      const hash = await rig.factory.write.deploy([rig.impl.address, salt, commit]);
      await rig.publicClient.waitForTransactionReceipt({ hash });

      const proxy = await rig.viem.getContractAt("BoundCaller", predicted);
      const otherTarget = await rig.viem.deployContract("TestTarget", []);
      await assert.rejects(
        proxy.simulate.execute([salt, otherTarget.address, boundData]),
        /BindingMismatch/,
      );
    });

    it("rejects the right (target, data) at the wrong salt", async () => {
      const data = encodeBump(rig.target, 9n);
      const commit = commitmentOf(rig.target.address, data);
      const goodSalt = ("0x" + "55".repeat(32)) as Hex;
      const badSalt = ("0x" + "66".repeat(32)) as Hex;
      const predicted = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        goodSalt,
        rig.target.address,
        data,
        EVM_PREFIX,
      );

      const hash = await rig.factory.write.deploy([rig.impl.address, goodSalt, commit]);
      await rig.publicClient.waitForTransactionReceipt({ hash });

      const proxy = await rig.viem.getContractAt("BoundCaller", predicted);
      await assert.rejects(
        proxy.simulate.execute([badSalt, rig.target.address, data]),
        /BindingMismatch/,
      );
    });
  });

  describe("revert bubbling", () => {
    it("wraps a target revert as CallReverted", async () => {
      const data = encodeBoom(rig.target, "kaboom");
      const commit = commitmentOf(rig.target.address, data);
      const salt = ("0x" + "77".repeat(32)) as Hex;
      const predicted = predictProxyAddress(
        rig.factory.address,
        rig.impl.address,
        salt,
        rig.target.address,
        data,
        EVM_PREFIX,
      );

      const hash = await rig.factory.write.deploy([rig.impl.address, salt, commit]);
      await rig.publicClient.waitForTransactionReceipt({ hash });

      const proxy = await rig.viem.getContractAt("BoundCaller", predicted);
      await assert.rejects(
        proxy.simulate.execute([salt, rig.target.address, data]),
        /CallReverted/,
      );
    });
  });
});
