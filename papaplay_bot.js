/**
 * ============================================================
 *  PAPAPLAY COINFLIP BOT
 *  Auto Coinflip via papaplay.io
 *  Bet: 0.1 USDC per flip, random heads/tails
 *  Submit via Bundler — EOA tidak perlu punya CENT
 * ============================================================
 *
 *  SETUP:
 *    npm install ethers@5 dotenv node-fetch@2
 *
 *  CONFIG (.env):
 *    PRIVATE_KEY=0x...
 *    SMART_WALLET=0x6DA0...
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fetch = require("node-fetch");

// ─────────────────────────────────────────
//  KONSTANTA
// ─────────────────────────────────────────
const RPC_URL      = "https://rpc.incentiv.io";
const BUNDLER_URL  = "https://bundler.incentiv.io";
const ENTRY_POINT  = "0x3eC61c5633BBD7Afa9144C6610930489736a72d4";
const PAYMASTER    = "0x43000f785EB43BcB4961C5c70276eD00e088972c";
const CHAIN_ID     = 24101;

// PapaPlay coinflip contract — confirmed dari tx real
const PAPAPLAY_CONTRACT = "0x7DC1AE4651ba2dFA90c56A9D4eB6FF7aEee7A438";

// USDC
const USDC_ADDRESS = "0x16e43840d8D79896A389a3De85aB0B0210C05685";
const USDC_DECIMALS = 6;

// Bet amount: 0.1 USDC = 100000 (6 decimals)
const BET_AMOUNT = ethers.BigNumber.from("100000");

// Gas fee untuk paymaster
const GAS_FEE_USDC = ethers.BigNumber.from("30000");

// Gas — dari tx real coinflip
const GAS_COINFLIP = {
  callGasLimit:                  ethers.BigNumber.from("0x0006872a"),
  verificationGasLimit:          ethers.BigNumber.from("0x000186a0"),
  preVerificationGas:            ethers.BigNumber.from("0x0000d968"),
  maxFeePerGas:                  ethers.BigNumber.from("0x000175fbf5ee800"),
  maxPriorityFeePerGas:          ethers.BigNumber.from("0x000bea14d8b80000"),
  paymasterVerificationGasLimit: ethers.BigNumber.from("0x000f4240"),
  paymasterPostOpGasLimit:       ethers.BigNumber.from("0x000f4240"),
};

// ─────────────────────────────────────────
//  INISIALISASI
// ─────────────────────────────────────────
const provider     = new ethers.providers.StaticJsonRpcProvider(RPC_URL);
const signer       = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const SMART_WALLET = process.env.SMART_WALLET;

// ─────────────────────────────────────────
//  ABI
// ─────────────────────────────────────────
const ERC20_IFACE = new ethers.utils.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

const ENTRY_POINT_IFACE = new ethers.utils.Interface([
  "function getNonce(address sender, uint192 key) view returns (uint256)",
]);

const ACCOUNT_IFACE = new ethers.utils.Interface([
  "function executeBatch(address[] targets, uint256[] values, bytes[] calldatas)",
]);

// PapaPlay coinflip function
// selector: 0x4e0d374f
// placeBet(uint256 betType, bytes32 clientSeed, uint256 referralCode, uint256 reservedParam, uint256 amount)
const PAPAPLAY_IFACE = new ethers.utils.Interface([
  "function placeBet(uint256 betType, bytes32 clientSeed, uint256 referralCode, uint256 reservedParam, uint256 amount)",
]);

const entryPoint = new ethers.Contract(ENTRY_POINT, ENTRY_POINT_IFACE, provider);

// ─────────────────────────────────────────
//  HELPER: Encode executeBatch
// ─────────────────────────────────────────
function encodeExecute(targets, values, calldatas) {
  return ACCOUNT_IFACE.encodeFunctionData("executeBatch", [targets, values, calldatas]);
}

// ─────────────────────────────────────────
//  HELPER: Encode paymasterAndData
// ─────────────────────────────────────────
function encodePaymasterData() {
  const maxCost = ethers.BigNumber.from("0x000f4240");
  return ethers.utils.hexConcat([
    PAYMASTER,
    ethers.utils.hexZeroPad(maxCost.toHexString(), 16),
    ethers.utils.hexZeroPad(maxCost.toHexString(), 16),
  ]);
}

// ─────────────────────────────────────────
//  HELPER: Hitung UserOp hash
// ─────────────────────────────────────────
async function getUserOpHash(userOp, gasConfig) {
  const accountGasLimits = ethers.utils.hexConcat([
    ethers.utils.hexZeroPad(gasConfig.verificationGasLimit.toHexString(), 16),
    ethers.utils.hexZeroPad(gasConfig.callGasLimit.toHexString(), 16),
  ]);
  const gasFees = ethers.utils.hexConcat([
    ethers.utils.hexZeroPad(gasConfig.maxPriorityFeePerGas.toHexString(), 16),
    ethers.utils.hexZeroPad(gasConfig.maxFeePerGas.toHexString(), 16),
  ]);
  const paymasterAndData = encodePaymasterData();

  const innerHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address","uint256","bytes32","bytes32","bytes32","uint256","bytes32","bytes32"],
      [
        userOp.sender, userOp.nonce,
        ethers.utils.keccak256("0x"),
        ethers.utils.keccak256(userOp.callData),
        accountGasLimits,
        gasConfig.preVerificationGas,
        gasFees,
        ethers.utils.keccak256(paymasterAndData),
      ]
    )
  );

  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32","address","uint256"],
      [innerHash, ENTRY_POINT, CHAIN_ID]
    )
  );
}

// ─────────────────────────────────────────
//  HELPER: Sign UserOp
// ─────────────────────────────────────────
async function signUserOp(userOp, gasConfig) {
  const hash = await getUserOpHash(userOp, gasConfig);
  const sig65 = await signer.signMessage(ethers.utils.arrayify(hash));
  return ethers.utils.hexConcat(["0x0000", "0x01", sig65]);
}

// ─────────────────────────────────────────
//  HELPER: Bundler RPC
// ─────────────────────────────────────────
async function bundlerRpc(method, params) {
  const maxRetry = 3;
  for (let i = 0; i < maxRetry; i++) {
    try {
      const res = await fetch(BUNDLER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://portal.incentiv.io",
          "Connection": "close",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        timeout: 30000,
      });
      const json = await res.json();
      if (json.error) throw new Error(`Bundler error: ${JSON.stringify(json.error)}`);
      return json.result;
    } catch (err) {
      if (i === maxRetry - 1) throw err;
      console.log(`   ⚠️  Retry ${i+1}/${maxRetry}: ${err.message}`);
      await sleep(3000);
    }
  }
}

// ─────────────────────────────────────────
//  HELPER: Format UserOp
// ─────────────────────────────────────────
function formatUserOpForBundler(userOp, gasConfig) {
  return {
    sender:                        userOp.sender,
    nonce:                         ethers.utils.hexlify(userOp.nonce),
    callData:                      userOp.callData,
    callGasLimit:                  ethers.utils.hexlify(gasConfig.callGasLimit),
    verificationGasLimit:          ethers.utils.hexlify(gasConfig.verificationGasLimit),
    preVerificationGas:            ethers.utils.hexlify(gasConfig.preVerificationGas),
    maxFeePerGas:                  ethers.utils.hexlify(gasConfig.maxFeePerGas),
    maxPriorityFeePerGas:          ethers.utils.hexlify(gasConfig.maxPriorityFeePerGas),
    paymaster:                     PAYMASTER,
    paymasterVerificationGasLimit: ethers.utils.hexlify(gasConfig.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit:       ethers.utils.hexlify(gasConfig.paymasterPostOpGasLimit),
    paymasterData:                 "0x",
    signature:                     userOp.signature,
  };
}

// ─────────────────────────────────────────
//  HELPER: Polling receipt
// ─────────────────────────────────────────
async function waitForReceipt(userOpHash, maxWaitMs = 60000) {
  const start = Date.now();
  console.log(`   ⏳ Menunggu konfirmasi...`);
  while (Date.now() - start < maxWaitMs) {
    await sleep(3000);
    try {
      const receipt = await bundlerRpc("eth_getUserOperationReceipt", [userOpHash]);
      if (receipt?.receipt?.transactionHash) return receipt.receipt.transactionHash;
    } catch (e) {}
  }
  console.log(`   ⚠️  Timeout — cek: https://explorer.incentiv.io/op/${userOpHash}`);
  return userOpHash;
}

// ─────────────────────────────────────────
//  CORE: Submit UserOp
// ─────────────────────────────────────────
async function submitUserOp(callData, gasConfig, label) {
  console.log(`\n📝 Building UserOp: ${label}`);
  const nonce = await entryPoint.getNonce(SMART_WALLET, 0);
  console.log(`   Nonce: ${nonce.toString()}`);

  const userOp = { sender: SMART_WALLET, nonce, callData, signature: "0x" };
  userOp.signature = await signUserOp(userOp, gasConfig);
  console.log(`   Signature: ${userOp.signature.slice(0, 20)}...`);

  const formatted = formatUserOpForBundler(userOp, gasConfig);

  const userOpHash = await bundlerRpc("eth_sendUserOperation", [formatted, ENTRY_POINT]);
  console.log(`   ✅ UserOp: ${userOpHash}`);
  console.log(`   🔗 https://explorer.incentiv.io/op/${userOpHash}`);

  const txHash = await waitForReceipt(userOpHash);
  if (txHash !== userOpHash) {
    console.log(`   ✅ TX: https://explorer.incentiv.io/tx/${txHash}`);
  }
  return txHash;
}

// ─────────────────────────────────────────
//  AKSI: Coinflip
//  betType: 0 = tails, 1 = heads (random)
//  clientSeed: random bytes32
//  amount: 0.1 USDC = 100000
// ─────────────────────────────────────────
async function coinflip() {
  // Random bet: 0 atau 1
  const betType = Math.random() < 0.5 ? 0 : 1;
  const betName = betType === 1 ? "HEADS" : "TAILS";

  // Random client seed
  const clientSeed = ethers.utils.hexlify(ethers.utils.randomBytes(32));

  console.log(`\n🎲 Coinflip → ${betName} | Bet: 0.1 USDC`);

  const flipCalldata = PAPAPLAY_IFACE.encodeFunctionData("placeBet", [
    betType,      // betType: 0=tails, 1=heads
    clientSeed,   // random client seed
    0,            // referralCode
    0,            // reservedParam
    BET_AMOUNT,   // 0.1 USDC
  ]);

  // Flow: transfer gas fee → approve → placeBet
  const targets   = [USDC_ADDRESS, USDC_ADDRESS, PAPAPLAY_CONTRACT];
  const values    = [0, 0, 0];
  const calldatas = [
    ERC20_IFACE.encodeFunctionData("transfer", [PAYMASTER, GAS_FEE_USDC]),
    ERC20_IFACE.encodeFunctionData("approve",  [PAPAPLAY_CONTRACT, BET_AMOUNT]),
    flipCalldata,
  ];

  return await submitUserOp(
    encodeExecute(targets, values, calldatas),
    GAS_COINFLIP,
    `Coinflip ${betName}`
  );
}

// ─────────────────────────────────────────
//  HELPER: Cek saldo
// ─────────────────────────────────────────
async function checkBalances() {
  console.log("\n💰 SALDO SMART WALLET");
  console.log("─".repeat(45));
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_IFACE, provider);
  const bal = await usdc.balanceOf(SMART_WALLET);
  console.log(`   USDC  : ${parseFloat(ethers.utils.formatUnits(bal, USDC_DECIMALS)).toFixed(6)}`);
  console.log("─".repeat(45));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function randomDelay(minSec, maxSec) {
  const ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
  console.log(`\n⏳ Jeda ${(ms/1000).toFixed(0)} detik...`);
  await sleep(ms);
}

// ─────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────
async function main() {
  console.log("═".repeat(50));
  console.log("  PAPAPLAY COINFLIP BOT");
  console.log("═".repeat(50));

  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY tidak ada di .env");
  if (!SMART_WALLET)            throw new Error("SMART_WALLET tidak ada di .env");

  console.log(`  EOA    : ${signer.address}`);
  console.log(`  Wallet : ${SMART_WALLET}`);

  await checkBalances();

  // ══════════════════════════════════════
  //  ⚙️  KONFIGURASI
  //  Total cost per flip: 0.1 USDC bet + ~0.03 USDC gas fee
  //  Pastikan saldo USDC cukup sebelum jalankan
  // ══════════════════════════════════════

  const TOTAL_FLIPS = 10;   // Total jumlah flip
  const DELAY_MIN   = 20;   // Detik minimum antar flip
  const DELAY_MAX   = 60;   // Detik maximum antar flip

  // ══════════════════════════════════════

  console.log(`\n🚀 Mulai ${TOTAL_FLIPS} coinflip`);
  console.log(`   Estimasi total: ${(TOTAL_FLIPS * 0.13).toFixed(2)} USDC (bet + gas)`);

  let successCount = 0;
  let failCount    = 0;

  for (let i = 1; i <= TOTAL_FLIPS; i++) {
    console.log(`\n━━━━━━ Flip ${i} / ${TOTAL_FLIPS} ━━━━━━`);
    try {
      await coinflip();
      successCount++;
      if (i < TOTAL_FLIPS) await randomDelay(DELAY_MIN, DELAY_MAX);
    } catch (err) {
      failCount++;
      console.error(`\n❌ Gagal: ${err.message}`);
      await randomDelay(15, 30);
    }
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  SELESAI: ✅ ${successCount} berhasil, ❌ ${failCount} gagal`);
  console.log(`${"═".repeat(50)}`);
  await checkBalances();
}

main().catch(err => {
  console.error("\n💥 Fatal error:", err.message);
  process.exit(1);
});
