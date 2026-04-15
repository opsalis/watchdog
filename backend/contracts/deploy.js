// Deploys OpsalisBilling + registers PingDog revenue wallet on Demo L2 (845312).
// Usage: node deploy.js
// Requires: solc (global), ethers v6 (local or global)
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'http://192.99.9.106:30846';
const DEPLOYER_PK = process.env.DEPLOYER_PK || '0x2ff4dfaff9b15374550dada4b630441246b0598de18a8b771ef8e8ad3054a5f4';
const USDC = process.env.USDC || '0xb081d16D40e4e4c27D6d8564d145Ab2933037111';
const PINGDOG_REV_WALLET = process.env.PINGDOG_REV_WALLET || '0x1939E5a03f2d023b26aC54f0F66AAD536031aFCc';

const SERVICE_ID_PINGDOG = ethers.id('pingdog'); // keccak256("pingdog")

async function main() {
  const source = fs.readFileSync(path.join(__dirname, 'OpsalisBilling.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'OpsalisBilling.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors) {
    const fatals = out.errors.filter(e => e.severity === 'error');
    if (fatals.length) { console.error(JSON.stringify(fatals, null, 2)); process.exit(1); }
  }
  const c = out.contracts['OpsalisBilling.sol']['OpsalisBilling'];
  const abi = c.abi;
  const bytecode = '0x' + c.evm.bytecode.object;

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(DEPLOYER_PK, provider);
  console.log('Deployer:', wallet.address);
  console.log('Network chainId:', (await provider.getNetwork()).chainId.toString());
  console.log('Deployer balance:', ethers.formatEther(await provider.getBalance(wallet.address)), 'native');

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(USDC);
  const deployTx = contract.deploymentTransaction();
  console.log('Deploy tx:', deployTx.hash);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log('OpsalisBilling deployed at:', addr);

  // Register PingDog revenue wallet
  const tx = await contract.setServiceRevenueWallet(SERVICE_ID_PINGDOG, PINGDOG_REV_WALLET);
  console.log('setServiceRevenueWallet tx:', tx.hash);
  await tx.wait();
  console.log('Registered serviceId=pingdog (', SERVICE_ID_PINGDOG, ') -> wallet=', PINGDOG_REV_WALLET);

  // Persist addresses + ABI
  fs.writeFileSync(path.join(__dirname, 'OpsalisBilling.addr.json'), JSON.stringify({
    chainId: 845312,
    rpcUrl: RPC_URL,
    address: addr,
    deployTx: deployTx.hash,
    usdc: USDC,
    serviceIdPingDog: SERVICE_ID_PINGDOG,
    pingdogRevenueWallet: PINGDOG_REV_WALLET,
    deployedAt: new Date().toISOString(),
  }, null, 2));
  fs.writeFileSync(path.join(__dirname, 'OpsalisBilling.abi.json'), JSON.stringify(abi, null, 2));
  console.log('Wrote OpsalisBilling.addr.json + OpsalisBilling.abi.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
