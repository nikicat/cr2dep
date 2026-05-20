import HardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import type { HardhatUserConfig } from "hardhat/config";

const config: HardhatUserConfig = {
  plugins: [HardhatToolboxViem],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          // TRON: avoid PUSH0 for broad TVM compatibility.
          evmVersion: "paris",
        },
      },
    },
  },
};

export default config;
