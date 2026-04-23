/**
 * ============================================================
 *  MAKECENTS SWAP BOT
 *  Auto Swap via app.makecents.xyz
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

// MakeCents router — confirmed dari tx real
const MAKECENTS_ROUTER = "0x78e96dd6a0a4b9a523718f716b4dba6010c083ca";

// Token
const TOKENS = {
  USDC: { address: "0x16e43840d8D79896A389a3De85aB0B0210C05685", decimals: 6  },
  USDT: { address: "0x39b076b5d23F588690D480af3Bf820edad31a4bB", decimals: 6  },
  WETH: { address: "0x3e425317dB7BaC8077093117081b40d9b46F29cb", decimals: 18 },
  WBTC: { address: "0x0292593D416Cb765E0e8FF77b32fA7e465958FEE", decimals: 8  },
  SOL:  { address: "0xfaC24134dbc4b00Ee11114eCDFE6397f389203E3", decimals: 9  },
};

// Gas — dari tx real makecents
const GAS_SWAP = {
  callGasLimit:                  ethers.BigNumber.from("0x0003f59b"),
  verificationGasLimit:          ethers.BigNumber.from("0x000186a0"),
  preVerificationGas:            ethers.BigNumber.from("0x0000e520"),
  maxFeePerGas:                  ethers.BigNumber.from("0x000175fbf5ee800"),
  maxPriorityFeePerGas:          ethers.BigNumber.from("0x000bea14d8b80000"),
  paymasterVerificationGasLimit: ethers.BigNumber.from("0x000f4240"),
  paymasterPostOpGasLimit:       ethers.BigNumber.from("0x000f4240"),
};

const GAS_FEE_USDC = ethers.BigNumber.from("25000");

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

// MakeCents router — selector 0xbc651188
// urutan parameter confirmed dari TX manual:
// exactInputSingle(tokenIn, tokenOut, recipient, deadline, amountIn, amountOutMin, sqrtPriceLimit)
const MAKECENTS_IFACE = new ethers.utils.Interface([
  "function exactInputSingle(address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint256 sqrtPriceLimitX96) returns (uint256)",
]);

const entryPoint = new ethers.Contract(ENTRY_POINT, ENTRY_POINT_IFACE, provider);

// ─────────────────────────────────────────
//  HELPER: Encode executeBatch
// ─────────────────────────────────────────
function encodeExecute(targets, values, calldatas) {
  return ACCOUNT_IFACE.encodeFunctionData("executeBatch", [targets, values, calldatas]);
}

// ─────────────────────────────────────────
//  HELPER: Encode paymasterAndData untuk hash
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
  const res = await fetch(BUNDLER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://portal.incentiv.io",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Bundler error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// ─────────────────────────────────────────
//  HELPER: Format UserOp untuk bundler
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
//  SWAP via MakeCents
//  Flow: transfer gas fee → approve → multicall(exactInputSingle)
// ─────────────────────────────────────────
async function swapMakeCents(tokenInSymbol, tokenOutSymbol, amountIn) {
  const tokenIn  = TOKENS[tokenInSymbol];
  const tokenOut = TOKENS[tokenOutSymbol];
  if (!tokenIn || !tokenOut) throw new Error(`Token tidak dikenal`);

  const amountInBN = ethers.utils.parseUnits(String(amountIn), tokenIn.decimals);
  const deadline   = Math.floor(Date.now() / 1000) + 600;

  // Encode exactInputSingle langsung — confirmed dari TX manual
  // urutan: tokenIn, tokenOut, recipient, deadline, amountIn, amountOutMin, sqrtPriceLimit
  const exactInputData = MAKECENTS_IFACE.encodeFunctionData("exactInputSingle", [
    tokenIn.address,
    tokenOut.address,
    SMART_WALLET,  // recipient
    deadline,      // deadline (posisi ke-4, sesuai TX manual)
    amountInBN,    // amountIn
    0,             // amountOutMinimum
    0,             // sqrtPriceLimitX96
  ]);

  const targets   = [TOKENS.USDC.address, tokenIn.address, MAKECENTS_ROUTER];
  const values    = [0, 0, 0];
  const calldatas = [
    ERC20_IFACE.encodeFunctionData("transfer", [PAYMASTER, GAS_FEE_USDC]),
    ERC20_IFACE.encodeFunctionData("approve",  [MAKECENTS_ROUTER, amountInBN]),
    exactInputData,
  ];

  console.log(`\n🔄 MakeCents Swap ${amountIn} ${tokenInSymbol} → ${tokenOutSymbol}`);
  return await submitUserOp(encodeExecute(targets, values, calldatas), GAS_SWAP, `MakeCents ${tokenInSymbol}→${tokenOutSymbol}`);
}

// ─────────────────────────────────────────
//  HELPER: Cek saldo
// ─────────────────────────────────────────
async function checkBalances() {
  console.log("\n💰 SALDO SMART WALLET");
  console.log("─".repeat(45));
  for (const [symbol, token] of Object.entries(TOKENS)) {
    const contract = new ethers.Contract(token.address, ERC20_IFACE, provider);
    const bal = await contract.balanceOf(SMART_WALLET);
    console.log(`   ${symbol.padEnd(6)}: ${parseFloat(ethers.utils.formatUnits(bal, token.decimals)).toFixed(6)}`);
  }
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
  console.log("  MAKECENTS SWAP BOT");
  console.log("═".repeat(50));

  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY tidak ada di .env");
  if (!SMART_WALLET)            throw new Error("SMART_WALLET tidak ada di .env");

  console.log(`  EOA    : ${signer.address}`);
  console.log(`  Wallet : ${SMART_WALLET}`);

  await checkBalances();

  // ══════════════════════════════════════
  //  ⚙️  KONFIGURASI
  // ══════════════════════════════════════

  const ACTIVITIES = [
    // Swap USDC ke semua token
    { from: "USDC", to: "WETH", amount: 0.01 },
    { from: "USDC", to: "WBTC", amount: 0.01 },
    { from: "USDC", to: "SOL",  amount: 0.01 },
    { from: "USDC", to: "USDT", amount: 0.01 },

    // Swap balik ke USDC
    { from: "WETH", to: "USDC", amount: 0.000001 },
    { from: "WBTC", to: "USDC", amount: 0.000001 },
    { from: "SOL",  to: "USDC", amount: 0.0001   },
    { from: "USDT", to: "USDC", amount: 0.009    },
  ];

  const REPEAT_TIMES = 3;
  const DELAY_MIN    = 30;
  const DELAY_MAX    = 90;
  const LOOP_DELAY   = 180;

  // ══════════════════════════════════════

  console.log(`\n🚀 Mulai ${REPEAT_TIMES} loop × ${ACTIVITIES.length} swap`);

  let successCount = 0;
  let failCount    = 0;

  for (let loop = 1; loop <= REPEAT_TIMES; loop++) {
    console.log(`\n${"═".repeat(50)}`);
    console.log(`  LOOP ${loop} / ${REPEAT_TIMES}`);
    console.log(`${"═".repeat(50)}`);

    for (const act of ACTIVITIES) {
      try {
        await swapMakeCents(act.from, act.to, act.amount);
        successCount++;
        await randomDelay(DELAY_MIN, DELAY_MAX);
      } catch (err) {
        failCount++;
        console.error(`\n❌ Gagal: ${err.message}`);
        await randomDelay(15, 30);
      }
    }

    if (loop < REPEAT_TIMES) {
      console.log(`\n⏸️  Loop ${loop} selesai. Jeda ${LOOP_DELAY}s...`);
      await sleep(LOOP_DELAY * 1000);
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
