import assert from "node:assert/strict";
import test from "node:test";
import { connect, createAccount, ensureChain, friendlyError, type Provider } from "../service/src/client";
import { chain, deployment } from "../service/protocol";

const owner = "0x1111111111111111111111111111111111111111";
const another = "0x2222222222222222222222222222222222222222";
const expectedChain = `0x${chain.id.toString(16)}`;

test("connect switches an existing wallet to GIWA before returning the owner", async () => {
 let network = "0x1";
 const methods: string[] = [];
 const provider: Provider = { async request({ method, params }) {
  methods.push(method);
  if (method === "eth_requestAccounts") return [owner];
  if (method === "eth_chainId") return network;
  if (method === "wallet_switchEthereumChain") {
   assert.deepEqual(params, [{ chainId: expectedChain }]); network = expectedChain; return null;
  }
  throw new Error(`Unexpected ${method}`);
 } };
 assert.equal(await connect(provider), owner);
 assert.deepEqual(methods, ["eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]);
});

test("an unknown network is added with pinned GIWA parameters and rechecked", async () => {
 let added = false;
 await ensureChain({ async request({ method, params }) {
  if (method === "eth_chainId") return added ? expectedChain : "0x1";
  if (method === "wallet_switchEthereumChain") throw { code: 4902 };
  assert.equal(method, "wallet_addEthereumChain");
  assert.deepEqual(params, [{ chainId: expectedChain, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: [chain.blockExplorers.default.url] }]);
  added = true; return null;
 } });
 assert.equal(added, true);
});

test("a rejected network switch does not add a network or request a signature", async () => {
 const methods: string[] = [];
 const rejection = { code: 4001, message: "User rejected" };
 await assert.rejects(() => ensureChain({ async request({ method }) {
  methods.push(method); if (method === "eth_chainId") return "0x1"; throw rejection;
 } }), error => error === rejection);
 assert.deepEqual(methods, ["eth_chainId", "wallet_switchEthereumChain"]);
 assert.match(friendlyError(rejection), /요청을 취소/);
});

test("a wallet that stays on another chain cannot proceed", async () => {
 await assert.rejects(() => ensureChain({ async request({ method }) {
  return method === "eth_chainId" ? "0x1" : null;
 } }), /GIWA Sepolia/);
});

test("an account change before signing prevents authorization and relay", async () => {
 const methods: string[] = [];
 await assert.rejects(() => createAccount({ async request({ method }) {
  methods.push(method); if (method === "eth_chainId") return expectedChain; if (method === "eth_accounts") return [another]; throw new Error("No signature allowed");
 } }, owner, 0, 1000, 5000, 1, () => {}), /계정이 바뀌었습니다/);
 assert.deepEqual(methods, ["eth_chainId", "eth_accounts"]);
});

test("create binds the chosen strategy, limits and GIWA domain to one signed relay", async () => {
 const previous = globalThis.fetch;
 let typed: Record<string, unknown> | undefined;
 let relays = 0;
 const signature = `0x${"ab".repeat(65)}`;
 globalThis.fetch = async (input, init) => {
  relays++; assert.equal(input, "/api/relay");
  const body = JSON.parse(String(init?.body));
  assert.equal(body.kind, "create"); assert.equal(body.strategyId, 1);
  assert.equal(body.maxTradeBudget, "500000000"); assert.equal(body.maxRollingDayBudget, "2500000000");
  assert.equal(body.signature, signature);
  return Response.json({ account: another, hash: `0x${"cd".repeat(32)}` });
 };
 try {
  const before = Math.floor(Date.now() / 1000);
  await createAccount({ async request({ method, params }) {
   if (method === "eth_chainId") return expectedChain;
   if (method === "eth_accounts") return [owner];
   assert.equal(method, "eth_signTypedData_v4"); assert.equal(params?.[0], owner);
   typed = JSON.parse(String(params?.[1])); return signature;
  } }, owner, 1, 500, 2500, 3, () => {});
  assert.equal(relays, 1);
  assert.deepEqual(typed?.domain, { name: "AlphaPactFactory", version: "1", chainId: chain.id, verifyingContract: deployment.factory });
  const message = typed?.message as Record<string, string>;
  assert.ok(Number(message.expiresAt) >= before + 3 * 86400);
 } finally { globalThis.fetch = previous; }
});

test("a rejected signature sends no create request", async () => {
 const previous = globalThis.fetch; let relays = 0;
 globalThis.fetch = async () => { relays++; throw new Error("No relay allowed"); };
 try {
  await assert.rejects(() => createAccount({ async request({ method }) {
   if (method === "eth_chainId") return expectedChain; if (method === "eth_accounts") return [owner]; throw { code: 4001, message: "User rejected" };
  } }, owner, 0, 1000, 5000, 1, () => {}), error => (error as { code: number }).code === 4001);
  assert.equal(relays, 0);
 } finally { globalThis.fetch = previous; }
});
