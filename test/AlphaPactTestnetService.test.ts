/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { network } from "hardhat";
import { actionTypes, createTypes, sessionHash, strategyHash, ZERO_SESSION } from "../service/protocol.ts";
const { ethers, networkHelpers } = await network.create({network:"hardhatOp",chainType:"op"});
const A=1_000_000n;
async function fixture(published=false){
 const [deployer,owner,keeper,relayer,attacker]=await ethers.getSigners();
 const budget=await ethers.deployContract("AlphaPactPracticeAsset",["Practice USD","tUSD",6]);
 const position=await ethers.deployContract("AlphaPactPracticeAsset",["Practice Ether","tETH",18]);
 const pyth=await ethers.deployContract("ServiceTestPyth");
 const quote=published ? await ethers.deployContract("AlphaPactTestnetReferenceQuote",[await budget.getAddress(),await position.getAddress()]) : await ethers.deployContract("AlphaPactPythQuote",[await budget.getAddress(),await position.getAddress(),await pyth.getAddress(),ethers.id("test-feed")]);
 if(published){const publisher=await ethers.getContractAt("AlphaPactTestnetReferenceQuote",await quote.getAddress());await publisher.publish(2500e8,await networkHelpers.time.latest(),ethers.id("coinbase-kraken-test-observations"));}
 const router=await ethers.deployContract("AlphaPactPracticeRouter",[await quote.getAddress()]);
 const factory=await ethers.deployContract("AlphaPactTestnetFactory",[await budget.getAddress(),await position.getAddress(),await router.getAddress(),await quote.getAddress(),keeper.address]);
 await budget.setFactory(await factory.getAddress());await position.setFactory(await factory.getAddress());
 await budget.seedTestVenue(await router.getAddress());await position.seedTestVenue(await router.getAddress());
 return{deployer,owner,keeper,relayer,attacker,budget,position,pyth,quote,router,factory};
}
async function create(f:any,changes:Record<string,any>={}){
 const now=await networkHelpers.time.latest();const message={owner:f.owner.address,strategyId:0,maxTradeBudget:1_000n*A,maxRollingDayBudget:5_000n*A,expiresAt:now+86_400,deadline:now+600,...changes};
 const signature=await f.owner.signTypedData({name:"AlphaPactFactory",version:"1",chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:await f.factory.getAddress()},createTypes,message);
 await f.factory.connect(f.relayer).createAccount(message.owner,message.strategyId,message.maxTradeBudget,message.maxRollingDayBudget,message.expiresAt,message.deadline,signature);
 const addr=await f.factory.accounts(f.owner.address,message.strategyId);
 return ethers.getContractAt("AlphaPactTestnetAccount",addr);
}
async function authorize(f:any,account:any,action:number,requested=ZERO_SESSION){
 const message={action,sessionHash:sessionHash(requested),sessionId:await account.sessionId(),nonce:await account.authorizationNonce(),deadline:(await networkHelpers.time.latest())+600};
 const signature=await f.owner.signTypedData({name:"AlphaPactAccount",version:"1",chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:await account.getAddress()},actionTypes,message);
 return{message,signature,requested};
}
async function execute(f:any,account:any,auth:any){const m=auth.message;return account.connect(f.relayer).executeOwnerAction(m.action,auth.requested,m.sessionId,m.nonce,m.deadline,auth.signature)}
describe("AlphaPact testnet service signed flows",function(){
 it("creates an owner-approved account and issues valueless test capital with sponsored gas",async()=>{
  const f=await fixture();const account=await create(f);
  expect(await account.owner()).to.equal(f.owner.address);expect((await account.session()).strategist).to.equal(f.keeper.address);
  expect((await account.session()).strategyHash).to.equal(strategyHash(0));
  expect(await f.factory.isAccount(await account.getAddress())).to.equal(true);expect(await f.factory.accountCount()).to.equal(1);
  expect(await f.budget.balanceOf(await account.getAddress())).to.equal(10_000n*A);
 });
 it("does not allow a sponsor or factory administrator to withdraw the user's assets",async()=>{
  const f=await fixture();const account=await create(f);
  for(const actor of [f.deployer,f.keeper,f.relayer,f.attacker])await expect(account.connect(actor).withdrawToken(await f.budget.getAddress(),A)).to.be.revertedWithCustomError(account,"NotOwner");
 });
 it("rejects a create request with a forged owner or modified limits",async()=>{
  const f=await fixture();await expect(create(f,{owner:f.attacker.address})).to.be.revertedWith("OWNER_SIGNATURE_INVALID");
  await expect(create(f,{maxTradeBudget:3_000n*A})).to.be.revertedWith("LIMITS_INVALID");
 });
 it("cannot replay a successful account-creation signature",async()=>{
  const f=await fixture();await create(f);await expect(create(f)).to.be.revertedWith("ACCOUNT_EXISTS_OR_INVALID");
 });
 it("uses real token balance changes and the declared 0.30% simulated venue fee",async()=>{
  const f=await fixture(true);const account=await create(f);const now=await networkHelpers.time.latest();
  await account.connect(f.keeper).swap(true,1_000n*A,396_000_000_000_000_000n,1,0,now+60,ethers.id("signed-public-rule"));
  expect(await f.position.balanceOf(await account.getAddress())).to.equal(398_800_000_000_000_000n);
  expect(await f.budget.balanceOf(await account.getAddress())).to.equal(9_000n*A);
  expect(await f.budget.allowance(await account.getAddress(),await f.router.getAddress())).to.equal(0);
 });
 it("accepts an owner-signed revocation relayed by someone else and rejects its replay",async()=>{
  const f=await fixture();const account=await create(f);const auth=await authorize(f,account,1);
  await expect(execute(f,account,auth)).to.emit(account,"SessionRevoked");
  expect((await account.session()).strategist).to.equal(ethers.ZeroAddress);
  await expect(execute(f,account,auth)).to.be.revertedWith("AUTHORIZATION_EXPIRED");
 });
 it("invalidates a pending signed resume after direct owner revocation",async()=>{
  const f=await fixture();const account=await create(f);const current=await account.session();
  const session={strategist:current.strategist as `0x${string}`,expiresAt:current.expiresAt,maxTradeBudget:current.maxTradeBudget,maxRollingDayBudget:current.maxRollingDayBudget,maxSlippageBps:Number(current.maxSlippageBps),strategyHash:current.strategyHash as `0x${string}`};
  const auth=await authorize(f,account,0,session);await account.connect(f.owner).revokeSession();
  await expect(execute(f,account,auth)).to.be.revertedWith("AUTHORIZATION_EXPIRED");
 });
 it("binds signed controls to the account, action and requested session fields",async()=>{
  const f=await fixture();const first=await create(f);const second=await create(f,{strategyId:1});const auth=await authorize(f,first,1);
  await expect(execute(f,second,auth)).to.be.revertedWith("OWNER_SIGNATURE_INVALID");
  const modified={...auth,message:{...auth.message,action:2}};
  await expect(execute(f,first,modified)).to.be.revertedWith("OWNER_SIGNATURE_INVALID");
 });
 it("gas-sponsored recovery revokes authority and returns held assets to the owner",async()=>{
  const f=await fixture();const account=await create(f);const auth=await authorize(f,account,2);
  await execute(f,account,auth);expect(await f.budget.balanceOf(f.owner.address)).to.equal(10_000n*A);
  expect(await f.budget.balanceOf(await account.getAddress())).to.equal(0);expect((await account.session()).strategist).to.equal(ethers.ZeroAddress);
 });
 it("will not accept stale, future or overly uncertain Pyth prices",async()=>{
  const f=await fixture();const now=await networkHelpers.time.latest();
  for(const [time,confidence]of [[now-120,1000],[now+1000,1000],[now,100e8]]){
   await f.pyth.setPrice(2500e8,confidence,-8,time);
   await expect(f.quote.quote(await f.budget.getAddress(),await f.position.getAddress(),A)).to.be.revertedWith("PRICE_UNAVAILABLE");
  }
 });
 it("locks factory binding and venue seeding once, while wallet faucets stay rate-limited",async()=>{
  const f=await fixture();await expect(f.budget.setFactory(await f.router.getAddress())).to.be.revertedWith("FACTORY_LOCKED");
  await expect(f.budget.seedTestVenue(await f.router.getAddress())).to.be.revertedWith("VENUE_ALREADY_SEEDED");
  await expect(f.budget.connect(f.attacker).issueToAccount(f.attacker.address,A)).to.be.revertedWith("NOT_FACTORY");
  await f.budget.connect(f.owner).claim();await expect(f.budget.connect(f.owner).claim()).to.be.revertedWith("CLAIM_COOLDOWN");
 });
});

describe('operator-published test reference price boundary',function(){
 it('only permits the fixed publisher and converts 6/18 decimal pairs',async()=>{
  const f=await fixture();const q=await ethers.deployContract('AlphaPactTestnetReferenceQuote',[await f.budget.getAddress(),await f.position.getAddress()]);
  const at=await networkHelpers.time.latest();
  await expect(q.connect(f.attacker).publish(2500e8,at,ethers.id('two-api-observations'))).to.be.revertedWith('NOT_PUBLISHER');
  await q.publish(2500e8,at,ethers.id('two-api-observations'));
  expect((await q.quote(await f.budget.getAddress(),await f.position.getAddress(),1000n*A))[0]).to.equal(400_000_000_000_000_000n);
  expect((await q.quote(await f.position.getAddress(),await f.budget.getAddress(),10n**18n))[0]).to.equal(2500n*A);
  await expect(q.publish(2500e8,at,ethers.id('replay'))).to.be.revertedWith('PRICE_UNAVAILABLE');
  await networkHelpers.time.increase(61);
  await expect(q.quote(await f.budget.getAddress(),await f.position.getAddress(),A)).to.be.revertedWith('PRICE_UNAVAILABLE');
 });
 it('rejects zero, future and stale test-price publications',async()=>{
  const f=await fixture();const q=await ethers.deployContract('AlphaPactTestnetReferenceQuote',[await f.budget.getAddress(),await f.position.getAddress()]);
  const at=await networkHelpers.time.latest();
  for(const [price,time]of [[0,at],[2500e8,at+1000],[2500e8,at-1000]])await expect(q.publish(price,time,ethers.id('source-hash-is-not-proof'))).to.be.revertedWith('PRICE_UNAVAILABLE');
 });
});
