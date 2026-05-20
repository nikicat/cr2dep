# cr2dep

PoC for one-shot, deterministic on-chain side-effects on TRON: every (target, calldata) pair gets its own CREATE2 address, and the contract at that address can only ever forward to *that* pair. Useful for use-cases like committing in advance to a future transfer/swap/contract interaction whose execution is then permissionless (anyone can pull the trigger, but only the bound action will fire).

## How it works

```
ProxyFactory.deploy(impl, salt, commitment)
        │
        ▼  CREATE2 with init code = [10-byte constructor] ‖ [45-byte EIP-1167 stub→impl] ‖ [32-byte commitment]
        │
        ▼
  proxy at address  A = keccak256(0x41 ‖ factory ‖ salt ‖ keccak256(initCode))[12:]
  runtime           = 45-byte EIP-1167 stub (commitment lives only in init code → binds A but isn't deployed)

  anyone calls  →   A.execute(salt, target, data)
                          │
                          ▼  delegatecall
                    BoundCaller.execute:
                      commitment = keccak256(abi.encode(target, data))
                      recompute A' = keccak256(0x41 ‖ FACTORY ‖ salt ‖ keccak256(initCode(SELF, commitment)))[12:]
                      require A' == address(this)
                      target.call{value: msg.value}(data)
```

Two contracts, deployed once per chain:

| Contract       | Role                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ProxyFactory` | Singleton. `deploy(impl, salt, commitment)` CREATE2s a 45-byte EIP-1167 proxy whose init code embeds `commitment`.                         |
| `BoundCaller`  | Impl behind every proxy. Re-derives the proxy's own CREATE2 address from `(FACTORY, salt, initCode(SELF, keccak256(abi.encode(target, data))))` and refuses unless it matches `address(this)`. |

The address binding — not access control — is what makes each proxy single-purpose. `execute` is fully public; only the originally-bound (target, data) will pass the check.

Both contracts take a `PREFIX` immutable in their constructors. TRON uses `0x41` (the CREATE2 prefix replacement for EVM's `0xff`); the CLI sets this automatically. The EDR tests pass `0xff` so the same contracts can be tested end-to-end on a stock EVM.

Pairs are stored in a small SQLite DB; addresses are recomputed on demand and never persisted.

## Prerequisites

- Node ≥ 20
- `pnpm` (the repo declares `packageManager: pnpm@9.15.0` — Corepack will fetch it)
- A TRON private key with TRX for fees (Nile testnet faucet: <https://nileex.io/join/getJoinPage>)

## Setup

```bash
pnpm install
pnpm compile
cp .env.example .env  # fill PRIVATE_KEY, TRON_RPC, optionally TRON_API_KEY
pnpm cli init         # creates cr2dep.db
```

Env vars:

| Var             | Default                      | Notes                                  |
| --------------- | ---------------------------- | -------------------------------------- |
| `PRIVATE_KEY`   | _(required for tx commands)_ | TRON private key, hex (with or without `0x`) |
| `TRON_RPC`      | `https://nile.trongrid.io`   | Full-node HTTP endpoint                |
| `TRON_API_KEY`  | unset                        | Trongrid API key (raises rate limits)  |

## Deploy the on-chain singletons

You only do this once per network. Addresses are persisted to `.cr2dep.json`.

```bash
pnpm cli deploy-factory    # ProxyFactory (no constructor args beyond PREFIX=0x41)
pnpm cli deploy-impl       # BoundCaller(factoryAddress, PREFIX=0x41)
```

If you've already deployed these (e.g. shared between team members), skip the deploys and just point the CLI at them:

```bash
pnpm cli set-factory  T...
pnpm cli set-impl     T...
```

## Day-to-day usage

```bash
# Store a binding. Prints the predicted CREATE2 address right away.
pnpm cli add --target T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb \
             --data 0xa9059cbb...                       \
             --salt 0x00...                  # optional, defaults to bytes32(0)

pnpm cli list              # all stored pairs with predicted addresses
pnpm cli address 1         # just the address for pair #1

pnpm cli deploy  1         # CREATE2-deploys the proxy bound to pair #1
pnpm cli execute 1         # call execute(salt, target, data) on the proxy — anyone can do this
```

`add` only writes to SQLite — no network call, no funds needed. `deploy` and `execute` are the only commands that broadcast transactions.

The same proxy address can be re-`execute`d as many times as you like; the address binding is what's enforced, not one-shot semantics. (If you want one-shot, gate it with a storage slot in `BoundCaller`.)

## Tests

EDR (Hardhat 3's in-process EVM) is used as a stand-in for the TVM. It uses Ethereum's `0xff` CREATE2 prefix instead of TRON's `0x41`, so the tests deploy both contracts with `PREFIX=0xff` and exercise the full deploy + execute path end-to-end:

```bash
pnpm test         # hardhat test nodejs
pnpm typecheck    # tsc --noEmit
```

Covers init-code shape, off-chain ↔ on-chain address parity, deploy at predicted address, calldata + value forwarding, binding-mismatch reverts (wrong data / target / salt), and bubbled target reverts.

## TRON-specific notes

- **CREATE2 prefix:** TRON's `CREATE2` opcode uses `0x41` where Ethereum uses `0xff`. The contracts take this as a deploy-time immutable; the CLI's `src/create2.ts` defaults to `0x41`. If you deploy with the wrong prefix the system silently stops working — every `execute` will fail `BindingMismatch`.
- **PUSH0:** disabled (`evmVersion: "paris"`) so the compiled bytecode runs on any TVM hardfork still in the wild.
- **Address format:** the CLI accepts and prints `T…` base58 addresses (canonical TRON form) and `0x…` 20-byte hex interchangeably. The 20-byte form is what gets stored in SQLite and hashed.

## Layout

```
contracts/
  ProxyFactory.sol         singleton; CREATE2-deploys the proxies
  BoundCaller.sol          impl behind every proxy; verifies address↔(target,data) binding
  test/TestTarget.sol      tiny counter target used by tests only
src/
  cli.ts                   commander CLI
  create2.ts               commitmentOf / buildProxyInitCode / predictProxyAddress
  artifacts.ts             loads Hardhat 3 artifacts
  tron.ts                  T-base58 ↔ 0x EVM hex (via TronWeb static utils)
  db.ts                    better-sqlite3 — pairs(id, target, calldata, salt, deployed, tx_hash)
  config.ts                .cr2dep.json: { factoryAddress, implementationAddress }
test/cr2dep.test.ts        EDR end-to-end tests (14 cases)
hardhat.config.ts          solc 0.8.28, evmVersion paris, hardhat-toolbox-viem plugin
```

## Status

PoC. Not audited. Don't ship to mainnet without a review — in particular, anything that relies on the binding-check assembly or the CREATE2 prefix is the kind of thing that breaks silently if something upstream changes.
