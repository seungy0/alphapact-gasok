const recipient='0x2b7FE3e2D4f97Ca49A5B9afeeBF1Eb34A3063ee6';
const value=500000000000000n, reserve=10000000000000n, chain=91342;
const $=id=>document.getElementById(id);let owner,quote,busy=false;
const hex=n=>'0x'+n.toString(16);
const eth=n=>{const whole=n/10n**18n;const fraction=String(n%10n**18n).padStart(18,'0').replace(/0+$/,'');return String(whole)+(fraction?'.'+fraction:'')};
const request=(method,params=[])=>window.ethereum.request({method,params});
async function network(){
 if(Number(await request('eth_chainId'))!==chain){try{await request('wallet_switchEthereumChain',[{chainId:hex(chain)}])}catch(e){if(e.code!==4902)throw e;await request('wallet_addEthereumChain',[{chainId:hex(chain),chainName:'GIWA Sepolia',nativeCurrency:{name:'Test ETH',symbol:'ETH',decimals:18},rpcUrls:['https://sepolia-rpc.giwa.io'],blockExplorerUrls:['https://sepolia-explorer.giwa.io']}])}}
 if(Number(await request('eth_chainId'))!==chain)throw new Error('GIWA Sepolia 네트워크로 바꿔 주세요.');
}
async function inspect(){
 $('send').disabled=true;quote=undefined;
 await network();const accounts=await request('eth_accounts');owner=accounts[0];if(!owner)throw new Error('지갑을 먼저 연결해 주세요.');
 $('owner').textContent=owner;
 const balance=BigInt(await request('eth_getBalance',[owner,'latest']));$('balance').textContent=eth(balance)+' 테스트 ETH';
 if(balance<value+reserve)throw new Error('현재 계정의 GIWA 테스트 ETH 잔액이 부족합니다. MetaMask에서 테스트 ETH가 있는 다른 계정을 선택해 주세요.');
 const gasPrice=BigInt(await request('eth_gasPrice'));
 const gas=BigInt(await request('eth_estimateGas',[{from:owner,to:recipient,value:hex(value)}]))*12n/10n;
 if(gasPrice>20000000n||gas>50000n)throw new Error('예상 수수료가 허용 범위보다 큽니다. 현재 요청은 전송하지 않습니다.');
 const fee=gas*gasPrice;$('fee').textContent=eth(fee)+' 테스트 ETH';
 if(balance<value+fee+reserve)throw new Error('전송 수량과 수수료를 합한 테스트 ETH가 부족합니다.');
 quote={from:owner,to:recipient,value:hex(value),gas:hex(gas),gasPrice:hex(gasPrice),chainId:hex(chain)};
 $('send').disabled=busy;$('status').textContent='GIWA Sepolia와 잔액·수수료를 확인했습니다. 전송 요청을 누르면 MetaMask 확인 화면이 열립니다.';
}
function error(e){$('status').textContent=e.code===4001?'MetaMask에서 요청을 취소했습니다.':e.message||'지갑 연결을 확인해 주세요.';}
$('connect').onclick=async()=>{if(!window.ethereum){$('status').textContent='휴대폰 MetaMask에서 열기 버튼을 이용해 MetaMask 앱 안에서 이 페이지를 열어 주세요.';return}try{await request('eth_requestAccounts');await inspect()}catch(e){error(e)}};
$('send').onclick=async()=>{if(busy)return;busy=true;$('send').disabled=true;try{await inspect();const accounts=await request('eth_accounts');if(accounts[0]?.toLowerCase()!==owner.toLowerCase())throw new Error('계정이 바뀌었습니다. 다시 확인해 주세요.');$('status').textContent='MetaMask에서 GIWA Sepolia · 0.0005 테스트 ETH · 받는 주소를 확인하고 승인해 주세요.';const hash=await request('eth_sendTransaction',[quote]);$('status').textContent='전송 요청을 보냈습니다. GIWA에서 확정 상태를 확인하세요.';$('receipt').href='https://sepolia-explorer.giwa.io/tx/'+hash;$('receipt').hidden=false}catch(e){error(e)}finally{busy=false;$('send').disabled=true}};
if(window.ethereum?.on){window.ethereum.on('accountsChanged',()=>{quote=undefined;$('send').disabled=true;$('status').textContent='계정이 바뀌었습니다. 지갑 연결하고 수수료 확인을 다시 눌러 주세요.'});window.ethereum.on('chainChanged',()=>{$('send').disabled=true;quote=undefined})}
