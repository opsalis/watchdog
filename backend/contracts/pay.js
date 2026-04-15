// Purchase a PingDog tier via OpsalisBilling.pay
// Usage: node pay.js <tier>   (tier = pro | business)
const { ethers } = require('ethers');
const tier = process.argv[2] || 'pro';
const PRICE = { pro: '9.73', business: '47.21' };
if (!PRICE[tier]) { console.error('tier must be pro|business'); process.exit(1); }

const RPC = process.env.RPC || 'http://192.99.9.106:30846';
const CUST_PK = process.env.CUST_PK || '0x2fff0118791904d1f6ee9b29ef9a90abcc5aafd75febef2c5a40b1c1bafe5d95';
const BILLING = process.env.BILLING || '0xCEfD64724E6EAbD3372188d3b558b1e74dD27Bc6';
const USDC = process.env.USDC || '0xb081d16D40e4e4c27D6d8564d145Ab2933037111';
const SERVICE_ID = ethers.id('pingdog');
const PRODUCT_ID = ethers.id(tier + '-monthly');
const AMOUNT = ethers.parseUnits(PRICE[tier], 6);

const erc20Abi = ['function approve(address,uint256) returns (bool)','function allowance(address,address) view returns (uint256)','function balanceOf(address) view returns (uint256)'];
const billingAbi = ['function pay(bytes32,bytes32,uint256) external','event Paid(bytes32 indexed serviceId, bytes32 indexed productId, address indexed customer, uint256 amount, uint256 timestamp)'];

(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const w = new ethers.Wallet(CUST_PK, p);
  console.log('Customer:', w.address, 'tier:', tier, 'amount:', PRICE[tier], 'USDC');

  const usdc = new ethers.Contract(USDC, erc20Abi, w);
  const bal = await usdc.balanceOf(w.address);
  console.log('USDC balance:', ethers.formatUnits(bal, 6));

  const cur = await usdc.allowance(w.address, BILLING);
  if (cur < AMOUNT) {
    console.log('Approving...');
    const aTx = await usdc.approve(BILLING, AMOUNT);
    await aTx.wait();
    console.log('approve tx:', aTx.hash);
  } else {
    console.log('allowance OK:', cur.toString());
  }

  const billing = new ethers.Contract(BILLING, billingAbi, w);
  const tx = await billing.pay(SERVICE_ID, PRODUCT_ID, AMOUNT);
  console.log('pay tx:', tx.hash);
  const r = await tx.wait();
  console.log('mined in block', r.blockNumber, 'status', r.status);
  console.log('TX_HASH=' + tx.hash);
})().catch(e => { console.error(e); process.exit(1); });
