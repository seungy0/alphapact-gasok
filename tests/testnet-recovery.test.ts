import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicClient } from 'viem';
import { readOwnerAccounts } from '../service/chain-account.ts';
import { deployment } from '../service/protocol.ts';
const owner='0x0000000000000000000000000000000000000011' as const;
const account='0x0000000000000000000000000000000000000022' as const;
const keeper='0x0000000000000000000000000000000000000033' as const;
const config={...deployment,ready:true,keeper};
function reader(overrides:Record<string,unknown>={}){
 const values:Record<string,unknown>={isAccount:true,owner,session:[keeper,BigInt(Math.floor(Date.now()/1000))+3600n,1000n,5000n,100,`0x${'1'.repeat(64)}`],sessionId:1n,nextNonce:2n,authorizationNonce:0n,rollingDaySpent:100n,lastTradeAt:1n,balanceOf:200n,strategyOf:0,...overrides};
 return {getChainId:async()=>91342,readContract:async({functionName,args}:{functionName:string;args?:unknown[]})=>functionName==='accounts'?(args?.[1]===0?account:'0x0000000000000000000000000000000000000000'):values[functionName]} as unknown as Pick<PublicClient,'readContract'|'getChainId'>;
}
test('cold-start recovery discovers an owner account from chain without an operator API',async()=>{
 const found=await readOwnerAccounts(reader(),owner,config);
 assert.equal(found.length,1);assert.equal(found[0].address,account);assert.equal(found[0].owner,owner);assert.equal(found[0].cash,200n);assert.equal(found[0].rpcFallback,true);
});
test('direct recovery discovery rejects a foreign owner',async()=>{await assert.rejects(()=>readOwnerAccounts(reader({owner:keeper}),owner,config),/소유자/)});
test('direct recovery discovery rejects an unregistered account',async()=>{await assert.rejects(()=>readOwnerAccounts(reader({isAccount:false}),owner,config),/등록된/)});
test('direct recovery discovery rejects the wrong chain',async()=>{await assert.rejects(()=>readOwnerAccounts({...reader(),getChainId:async()=>1},owner,config),/GIWA Sepolia/)});
test('an undeployed factory never becomes a fabricated recovery account',async()=>{assert.deepEqual(await readOwnerAccounts(reader(),owner,{...config,ready:false}),[])});
