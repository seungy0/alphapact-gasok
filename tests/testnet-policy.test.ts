import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../service/protocol.ts";

const base={strategyId:0,cash:10_000_000_000n,position:0n,priceE8:250_000_000_000n,
 tradeCap:1_000_000_000n,dayCap:5_000_000_000n,spent:0n,lastTradeAt:0n,now:1_800_000_000n};
test("first rebalance buys within the actual cash and owner caps",()=>assert.deepEqual(decide(base),{buy:true,amount:1_000_000_000n,reason:"ETH 비중을 목표에 맞춰 매수"}));
test("balanced holdings HOLD instead of forcing visible activity",()=>assert.deepEqual(decide({...base,cash:5_000_000_000n,position:2_000_000_000_000_000_000n}),{hold:"목표 비중 유지 중"}));
test("sell quantities respect 6/18 decimals and gross budget",()=>assert.deepEqual(decide({...base,cash:0n,position:4_000_000_000_000_000_000n}),{buy:false,amount:400_000_000_000_000_000n,reason:"ETH 비중을 목표에 맞춰 매도"}));
test("rolling turnover is not reset by a round trip",()=>assert.deepEqual(decide({...base,spent:5_000_000_000n}),{hold:"24시간 집행 한도 도달"}));
test("strategy does not bypass the minimum onchain interval",()=>assert.deepEqual(decide({...base,lastTradeAt:base.now-899n}),{hold:"다음 매매 간격 대기"}));
test("DCA uses its longer interval and 500 unit ceiling",()=>{assert.deepEqual(decide({...base,strategyId:1}),{buy:true,amount:500_000_000n,reason:"4시간 정기 매수"});assert.deepEqual(decide({...base,strategyId:1,lastTradeAt:base.now-900n}),{hold:"다음 매매 간격 대기"});});
test("missing prices and empty accounts do not create trades",()=>{assert.ok("hold"in decide({...base,priceE8:0n}));assert.deepEqual(decide({...base,cash:0n}),{hold:"계정 잔액 없음"});});

// The test publisher must stop on stale/divergent data; it is not a cryptographic oracle.
import { compareQuotes } from '../service/market.ts';
test('test prices require two distinct fresh public sources', () => {
 const quotes = [{source:'Coinbase',price:'2500.00',at:1000},{source:'Kraken',price:'2502.00',at:1001}] as const;
 assert.equal(compareQuotes([...quotes],1002).priceE8,'250100000000');
 assert.equal(compareQuotes([...quotes],1002).trust,'OPERATOR_PUBLISHED_TEST_PRICE');
 assert.throws(()=>compareQuotes([quotes[0],quotes[0]],1002));
 assert.throws(()=>compareQuotes([...quotes],1100));
 assert.throws(()=>compareQuotes([...quotes],990));
 assert.throws(()=>compareQuotes([quotes[0],{...quotes[1],price:'2600'}],1002));
 assert.throws(()=>compareQuotes([quotes[0],{...quotes[1],price:'NaN'}],1002));
});
