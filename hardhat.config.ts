import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin, hardhatVerify],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 500 },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    giwaSepolia: {
      type: "http",
      chainType: "op",
      url: configVariable("GIWA_RPC_URL"),
      accounts: [configVariable("GIWA_DEPLOYER_PRIVATE_KEY")],
    },
  },
  chainDescriptors: {
    91_342: {
      name: "GIWA Sepolia",
      blockExplorers: {
        blockscout: {
          name: "GIWA Sepolia Explorer",
          url: "https://sepolia-explorer.giwa.io",
          apiUrl: "https://sepolia-explorer.giwa.io/api",
        },
      },
    },
  },
});
