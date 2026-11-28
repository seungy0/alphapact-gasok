import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const chain = defineChain({ id: 91342, name: "GIWA Sepolia", nativeCurrency: { name: "Test ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } } });
const transport = http(chain.rpcUrls.default.http[0], { timeout: 15_000, retryCount: 1 });
const client = createPublicClient({ chain, transport });
const keeper = JSON.parse(await readFile("service/deployment.json", "utf8")).keeper;
const account = privateKeyToAccount((await readFile("outputs/testnet-secrets/giwa-sepolia-launch-20261031.key", "utf8")).trim());
if (await client.getChainId() !== chain.id || account.address.toLowerCase() !== keeper.toLowerCase()) throw Error("GIWA_TESTNET_KEEPER_REQUIRED");
const progressPath = "outputs/releases/copy-market-deploy.json";
const previous = await readFile(progressPath, "utf8").then(JSON.parse, failure => {
  if (failure.code !== "ENOENT") throw failure;
});
const artifact = JSON.parse(await readFile("artifacts/contracts/AlphaPactCopyMarket.sol/AlphaPactCopyMarket.json", "utf8"));
let hash = previous?.hash;
if (!hash) {
  const wallet = createWalletClient({ account, chain, transport });
  const gas = (await client.estimateGas({ account, data: artifact.bytecode })) * 115n / 100n;
  const gasPrice = await client.getGasPrice();
  if (await client.getBalance({ address: account.address }) < gas * gasPrice + 50_000_000_000_000n) throw Error("INSUFFICIENT_TEST_GAS");
  hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, gas, gasPrice, type: "legacy" });
  await mkdir("outputs/releases", { recursive: true });
  await writeFile(progressPath, JSON.stringify({ hash }, null, 2) + "\n", { flag: "wx" });
}
const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 90_000 });
if (receipt.status !== "success" || !receipt.contractAddress) throw Error("COPY_MARKET_DEPLOYMENT_FAILED");
const market = receipt.contractAddress;
const addresses = {};
for (const name of ["budget", "position", "referenceQuote", "router", "executor"]) {
  addresses[name] = await client.readContract({ address: market, abi: parseAbi([`function ${name}() view returns (address)`]), functionName: name });
}
const deployment = { ready: true, chainId: chain.id, market, ...addresses, keeper, hash,
  block: String(receipt.blockNumber), marketCodeHash: keccak256(await client.getCode({ address: market })),
  priceMode: "FIXED_TEST_QUOTE", testPrice: 2_000, venueMode: "SIMULATED_TEST_VENUE" };
await writeFile("service/copy-deployment.json", JSON.stringify(deployment, null, 2) + "\n");
console.log(deployment);
