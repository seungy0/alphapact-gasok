import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{runInNewContext}from'node:vm';
const code=await readFile(new URL('../service/public/operator/testnet-gas.js',import.meta.url),'utf8');
const from='0xff912f28bF5b6a9FBC25C5cFCBF6F87FA87CfEBA';
function page(options={}){
 const elements=new Map();const calls=[];let chain=options.wrongChain?1:91342;
 const document={getElementById:id=>{if(!elements.has(id))elements.set(id,{disabled:id==='send',textContent:'',hidden:true});return elements.get(id)}};
 const ethereum={on(){},async request({method,params}){calls.push({method,params});switch(method){case'eth_requestAccounts':case'eth_accounts':return[from];case'eth_chainId':return'0x'+chain.toString(16);case'wallet_switchEthereumChain':if(!options.refuseSwitch)chain=91342;return null;case'eth_getBalance':return'0x'+BigInt(options.balance??896632405870119n).toString(16);case'eth_gasPrice':return'0x'+BigInt(options.gasPrice??1000261n).toString(16);case'eth_estimateGas':return'0x5208';case'eth_sendTransaction':return'0x'+'1'.repeat(64);default:throw new Error(method)}}};
 runInNewContext(code,{document,window:{ethereum},BigInt,Number,String,Error});return{elements,calls};
}
test('funding helper pins GIWA, amount, recipient and bounded legacy gas',async()=>{
 const p=page();await p.elements.get('connect').onclick();assert.equal(p.elements.get('send').disabled,false);await p.elements.get('send').onclick();
 const tx=p.calls.find(c=>c.method==='eth_sendTransaction').params[0];assert.equal(tx.from,from);assert.equal(tx.to,'0x2b7FE3e2D4f97Ca49A5B9afeeBF1Eb34A3063ee6');assert.equal(BigInt(tx.value),500000000000000n);assert.equal(Number(tx.chainId),91342);assert.equal(BigInt(tx.gasPrice),1000261n);assert.equal(BigInt(tx.gas),25200n);
});
test('funding helper cannot send when the wallet stays on a different chain',async()=>{const p=page({wrongChain:true,refuseSwitch:true});await p.elements.get('connect').onclick();assert.equal(p.elements.get('send').disabled,true);assert.match(p.elements.get('status').textContent,/GIWA Sepolia/);assert.equal(p.calls.some(c=>c.method==='eth_sendTransaction'),false)});
test('funding helper leaves an unfunded account disabled',async()=>{const p=page({balance:0n});await p.elements.get('connect').onclick();assert.equal(p.elements.get('send').disabled,true);assert.match(p.elements.get('status').textContent,/잔액이 부족/)});
test('funding helper refuses an excessive fee estimate',async()=>{const p=page({gasPrice:1000000000n});await p.elements.get('connect').onclick();assert.equal(p.elements.get('send').disabled,true);assert.match(p.elements.get('status').textContent,/수수료가 허용 범위/)});
