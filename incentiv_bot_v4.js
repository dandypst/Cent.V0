/**
 * ============================================================
 *  INCENTIV FARMING BOT v4
 *  Auto Send + Swap via UserOperation (ERC-4337 v0.7)
 *  Submit via Bundler — EOA tidak perlu punya CENT
 * ============================================================
 *
 *  SETUP:
 *    npm install ethers@5 dotenv node-fetch@2
 *
 *  CONFIG (.env):
 *    PRIVATE_KEY=0x...       <- private key EOA MetaMask kamu
 *    SMART_WALLET=0x6DA0...  <- smart wallet Incentiv kamu
 *    SEND_TO=0x...           <- alamat tujuan send token
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fetch = require("node-fetch");

// ─────────────────────────────────────────
//  KONSTANTA
// ─────────────────────────────────────────
const RPC_URL     = "https://rpc.incentiv.io";
const BUNDLER_URL = "https://bundler.incentiv.io";
const ENTRY_POINT = "0x3eC61c5633BBD7Afa9144C6610930489736a72d4";
const PAYMASTER   = "0x43000f785EB43BcB4961C5c70276eD00e088972c";
const SWAP_ROUTER = "0x4a66A8bA9704DD06fE52A027f2B16a3F5D11B048";
const CHAIN_ID    = 24101;

// Token mainnet — confirmed dari tx real
const TOKENS = {
  USDC:  { address: "0x16e43840d8D79896A389a3De85aB0B0210C05685", decimals: 6  },
  USDT:  { address: "0x39b076b5d23F588690D480af3Bf820edad31a4bB", decimals: 6  },
  WETH:  { address: "0x3e425317dB7BaC8077093117081b40d9b46F29cb", decimals: 18 },
  WBTC:  { address: "0x0292593D416Cb765E0e8FF77b32fA7e465958FEE", decimals: 8  },
  SOL:   { address: "0xfaC24134dbc4b00Ee11114eCDFE6397f389203E3", decimals: 9  },
  WCENT: { address: "0xB0f0A14A50F14dc9e6476d61C00cF0375Dd4EB04", decimals: 18 },
};

// Gas — confirmed dari eth_getUserOperationByHash (v0.7 format)
// PENTING: callGasLimit dan verificationGasLimit TERBALIK dari yang kita kira!
const GAS_SEND = {
  callGasLimit:                ethers.BigNumber.from("0x000186a0"), // verificationGasLimit di v0.6
  verificationGasLimit:        ethers.BigNumber.from("0x0000d728"), // callGasLimit di v0.6
  preVerificationGas:          ethers.BigNumber.from("0x0000d728"),
  maxFeePerGas:                ethers.BigNumber.from("0x000175fbf5ee800"),
  maxPriorityFeePerGas:        ethers.BigNumber.from("0x000bea14d8b80000"),
  paymasterVerificationGasLimit: ethers.BigNumber.from("0x000f4240"),
  paymasterPostOpGasLimit:       ethers.BigNumber.from("0x000f4240"),
};

const GAS_SWAP = {
  callGasLimit:                ethers.BigNumber.from("0x00043728"),
  verificationGasLimit:        ethers.BigNumber.from("0x000186a0"),
  preVerificationGas:          ethers.BigNumber.from("0x0000e4b4"),
  maxFeePerGas:                ethers.BigNumber.from("0x000175fbf5ee800"),
  maxPriorityFeePerGas:        ethers.BigNumber.from("0x000bea14d8b80000"),
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
const SEND_TO      = process.env.SEND_TO;

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

const ROUTER_IFACE = new ethers.utils.Interface([
  "function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) returns (uint256)",
]);

const entryPoint = new ethers.Contract(ENTRY_POINT, ENTRY_POINT_IFACE, provider);

// ─────────────────────────────────────────
//  HELPER: Encode multi-call
// ─────────────────────────────────────────
function encodeExecute(targets, values, calldatas) {
  return ACCOUNT_IFACE.encodeFunctionData("executeBatch", [targets, values, calldatas]);
}

// ─────────────────────────────────────────
//  HELPER: Hitung UserOp hash (ERC-4337 v0.7)
//  Sesuai format dari eth_getUserOperationByHash
// ─────────────────────────────────────────
async function getUserOpHash(userOp, gasConfig) {
  // Pack accountGasLimits: verificationGasLimit (16B) + callGasLimit (16B)
  const accountGasLimits = ethers.utils.hexConcat([
    ethers.utils.hexZeroPad(gasConfig.verificationGasLimit.toHexString(), 16),
    ethers.utils.hexZeroPad(gasConfig.callGasLimit.toHexString(), 16),
  ]);

  // Pack gasFees: maxPriorityFeePerGas (16B) + maxFeePerGas (16B)
  const gasFees = ethers.utils.hexConcat([
    ethers.utils.hexZeroPad(gasConfig.maxPriorityFeePerGas.toHexString(), 16),
    ethers.utils.hexZeroPad(gasConfig.maxFeePerGas.toHexString(), 16),
  ]);

  // Pack paymasterAndData: paymaster (20B) + paymasterVerificationGasLimit (16B) + paymasterPostOpGasLimit (16B) + paymasterData (0x)
  const paymasterAndData = ethers.utils.hexConcat([
    PAYMASTER,
    ethers.utils.hexZeroPad(gasConfig.paymasterVerificationGasLimit.toHexString(), 16),
    ethers.utils.hexZeroPad(gasConfig.paymasterPostOpGasLimit.toHexString(), 16),
  ]);

  const innerHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address","uint256","bytes32","bytes32","bytes32","uint256","bytes32","bytes32"],
      [
        userOp.sender,
        userOp.nonce,
        ethers.utils.keccak256("0x"),         // initCode
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
      ["bytes32", "address", "uint256"],
      [innerHash, ENTRY_POINT, CHAIN_ID]
    )
  );
}

// ─────────────────────────────────────────
//  HELPER: Sign UserOp
//  Incentiv pakai Ethereum signed message prefix
//  Format sig: 0x0000 (keyIndex) + 0x01 (sigType) + 65 bytes
// ─────────────────────────────────────────
async function signUserOp(userOp, gasConfig) {
  const hash = await getUserOpHash(userOp, gasConfig);
  // signMessage menambah Ethereum prefix secara otomatis
  const sig65 = await signer.signMessage(ethers.utils.arrayify(hash));
  return ethers.utils.hexConcat(["0x0000", "0x01", sig65]);
}

// ─────────────────────────────────────────
//  HELPER: Kirim JSON-RPC ke Bundler
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
//  HELPER: Format UserOp untuk bundler (ERC-4337 v0.7)
//  Field paymaster terpisah sesuai format bundler Incentiv
// ─────────────────────────────────────────
function formatUserOpForBundler(userOp, gasConfig) {
  return {
    sender:                       userOp.sender,
    nonce:                        ethers.utils.hexlify(userOp.nonce),
    callData:                     userOp.callData,
    callGasLimit:                 ethers.utils.hexlify(gasConfig.callGasLimit),
    verificationGasLimit:         ethers.utils.hexlify(gasConfig.verificationGasLimit),
    preVerificationGas:           ethers.utils.hexlify(gasConfig.preVerificationGas),
    maxFeePerGas:                 ethers.utils.hexlify(gasConfig.maxFeePerGas),
    maxPriorityFeePerGas:         ethers.utils.hexlify(gasConfig.maxPriorityFeePerGas),
    paymaster:                    PAYMASTER,
    paymasterVerificationGasLimit: ethers.utils.hexlify(gasConfig.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit:      ethers.utils.hexlify(gasConfig.paymasterPostOpGasLimit),
    paymasterData:                "0x",
    signature:                    userOp.signature,
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
      if (receipt && receipt.receipt && receipt.receipt.transactionHash) {
        return receipt.receipt.transactionHash;
      }
    } catch (e) { /* masih pending */ }
  }
  console.log(`   ⚠️  Timeout — cek: https://explorer.incentiv.io/op/${userOpHash}`);
  return userOpHash;
}

// ─────────────────────────────────────────
//  CORE: Build, sign, submit UserOp
// ─────────────────────────────────────────
async function submitUserOp(callData, gasConfig, label) {
  console.log(`\n📝 Building UserOp: ${label}`);

  const nonce = await entryPoint.getNonce(SMART_WALLET, 0);
  console.log(`   Nonce: ${nonce.toString()}`);

  const userOp = {
    sender:   SMART_WALLET,
    nonce:    nonce,
    callData: callData,
    signature: "0x",
  };

  userOp.signature = await signUserOp(userOp, gasConfig);
  console.log(`   Signature: ${userOp.signature.slice(0, 20)}...`);

  const formatted = formatUserOpForBundler(userOp, gasConfig);

  try {
    const userOpHash = await bundlerRpc("eth_sendUserOperation", [
      formatted,
      ENTRY_POINT,
    ]);
    console.log(`   ✅ UserOp: ${userOpHash}`);
    console.log(`   🔗 https://explorer.incentiv.io/op/${userOpHash}`);

    const txHash = await waitForReceipt(userOpHash);
    if (txHash !== userOpHash) {
      console.log(`   ✅ TX: https://explorer.incentiv.io/tx/${txHash}`);
    }
    return txHash;
  } catch (err) {
    throw err;
  }
}

// ─────────────────────────────────────────
//  AKSI 1: SEND TOKEN
// ─────────────────────────────────────────
async function sendToken(tokenSymbol, amount) {
  const token = TOKENS[tokenSymbol];
  if (!token) throw new Error(`Token ${tokenSymbol} tidak dikenal`);

  const amountBN  = ethers.utils.parseUnits(String(amount), token.decimals);
  const targets   = [TOKENS.USDC.address, token.address];
  const values    = [0, 0];
  const calldatas = [
    ERC20_IFACE.encodeFunctionData("transfer", [PAYMASTER, GAS_FEE_USDC]),
    ERC20_IFACE.encodeFunctionData("transfer", [SEND_TO, amountBN]),
  ];

  console.log(`\n💸 Send ${amount} ${tokenSymbol} → ${SEND_TO.slice(0,10)}...`);
  return await submitUserOp(encodeExecute(targets, values, calldatas), GAS_SEND, `Send ${amount} ${tokenSymbol}`);
}

// ─────────────────────────────────────────
//  AKSI 2: SWAP TOKEN
// ─────────────────────────────────────────
async function swapToken(tokenInSymbol, tokenOutSymbol, amountIn) {
  const tokenIn  = TOKENS[tokenInSymbol];
  const tokenOut = TOKENS[tokenOutSymbol];
  if (!tokenIn || !tokenOut) throw new Error(`Token tidak dikenal`);

  const amountInBN = ethers.utils.parseUnits(String(amountIn), tokenIn.decimals);
  const deadline   = Math.floor(Date.now() / 1000) + 600;

  let path;
  if (tokenInSymbol === "WCENT" || tokenOutSymbol === "WCENT") {
    path = buildPath([tokenIn.address, tokenOut.address], [3000]);
  } else {
    path = buildPath([tokenIn.address, TOKENS.WCENT.address, tokenOut.address], [3000, 3000]);
  }

  const swapCalldata = ROUTER_IFACE.encodeFunctionData("exactInput", [{
    path,
    recipient:        SMART_WALLET,
    deadline,
    amountIn:         amountInBN,
    amountOutMinimum: 0,
  }]);

  const targets   = [TOKENS.USDC.address, tokenIn.address, SWAP_ROUTER];
  const values    = [0, 0, 0];
  const calldatas = [
    ERC20_IFACE.encodeFunctionData("transfer", [PAYMASTER, GAS_FEE_USDC]),
    ERC20_IFACE.encodeFunctionData("approve",  [SWAP_ROUTER, amountInBN]),
    swapCalldata,
  ];

  console.log(`\n🔄 Swap ${amountIn} ${tokenInSymbol} → ${tokenOutSymbol}`);
  return await submitUserOp(encodeExecute(targets, values, calldatas), GAS_SWAP, `Swap ${amountIn} ${tokenInSymbol}→${tokenOutSymbol}`);
}

// ─────────────────────────────────────────
//  HELPER: Build UniswapV3 path bytes
// ─────────────────────────────────────────
function buildPath(addresses, fees) {
  let path = addresses[0].slice(2).toLowerCase();
  for (let i = 0; i < fees.length; i++) {
    path += fees[i].toString(16).padStart(6, "0");
    path += addresses[i + 1].slice(2).toLowerCase();
  }
  return "0x" + path;
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
    const fmt = parseFloat(ethers.utils.formatUnits(bal, token.decimals)).toFixed(6);
    console.log(`   ${symbol.padEnd(6)}: ${fmt}`);
  }
  const centBal = await provider.getBalance(SMART_WALLET);
  console.log(`   ${"CENT".padEnd(6)}: ${parseFloat(ethers.utils.formatEther(centBal)).toFixed(6)}`);
  console.log("─".repeat(45));
}

// ─────────────────────────────────────────
//  HELPER: Delay
// ─────────────────────────────────────────
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
  console.log("  INCENTIV FARMING BOT v4");
  console.log("═".repeat(50));

  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY tidak ada di .env");
  if (!SMART_WALLET)            throw new Error("SMART_WALLET tidak ada di .env");
  if (!SEND_TO)                 throw new Error("SEND_TO tidak ada di .env");

  console.log(`  EOA      : ${signer.address}`);
  console.log(`  Wallet   : ${SMART_WALLET}`);
  console.log(`  Send To  : ${SEND_TO}`);
  console.log(`  Bundler  : ${BUNDLER_URL}`);

  try {
    const supported = await bundlerRpc("eth_supportedEntryPoints", []);
    console.log(`  EntryPoint: ${supported[0]}`);
  } catch (e) {
    console.log(`  ⚠️  Bundler: ${e.message}`);
  }

  await checkBalances();

  // ══════════════════════════════════════
  //  ⚙️  KONFIGURASI AKTIVITAS
  // ══════════════════════════════════════

  const ACTIVITIES = [
    // ── SWAP dari USDC ──
    { type: "swap", from: "USDC", to: "SOL",  amount: 0.1 },
    { type: "swap", from: "USDC", to: "WBTC", amount: 0.1 },
    { type: "swap", from: "USDC", to: "WETH", amount: 0.1 },
    { type: "swap", from: "USDC", to: "USDT", amount: 0.1 },

    // ── SWAP dari USDT ──
    { type: "swap", from: "USDT", to: "USDC", amount: 0.09 },
    { type: "swap", from: "USDT", to: "SOL",  amount: 0.09 },
    { type: "swap", from: "USDT", to: "WBTC", amount: 0.09 },
    { type: "swap", from: "USDT", to: "WETH", amount: 0.09 },

    // ── SWAP dari SOL ──
    { type: "swap", from: "SOL", to: "USDC", amount: 0.001 },
    { type: "swap", from: "SOL", to: "USDT", amount: 0.001 },
    { type: "swap", from: "SOL", to: "WBTC", amount: 0.001 },
    { type: "swap", from: "SOL", to: "WETH", amount: 0.001 },

    // ── SWAP dari WETH ──
    { type: "swap", from: "WETH", to: "USDC", amount: 0.000001 },
    { type: "swap", from: "WETH", to: "USDT", amount: 0.000001 },
    { type: "swap", from: "WETH", to: "SOL",  amount: 0.000001 },
    { type: "swap", from: "WETH", to: "WBTC", amount: 0.000001 },

    // ── SWAP dari WBTC ──
    { type: "swap", from: "WBTC", to: "USDC", amount: 0.000001 },
    { type: "swap", from: "WBTC", to: "USDT", amount: 0.000001 },
    { type: "swap", from: "WBTC", to: "SOL",  amount: 0.000001 },
    { type: "swap", from: "WBTC", to: "WETH", amount: 0.000001 },

    // ── SEND semua token ──
    { type: "send", token: "USDC",  amount: 0.01     },
    { type: "send", token: "USDT",  amount: 0.01     },
    { type: "send", token: "SOL",   amount: 0.0001   },
    { type: "send", token: "WETH",  amount: 0.000001 },
    { type: "send", token: "WBTC",  amount: 0.000001 },
  ];

  const REPEAT_TIMES = 3;
  const DELAY_MIN    = 30;
  const DELAY_MAX    = 90;
  const LOOP_DELAY   = 180;

  console.log(`\n🚀 Mulai ${REPEAT_TIMES} loop × ${ACTIVITIES.length} aksi`);

  let successCount = 0;
  let failCount    = 0;

  for (let loop = 1; loop <= REPEAT_TIMES; loop++) {
    console.log(`\n${"═".repeat(50)}`);
    console.log(`  LOOP ${loop} / ${REPEAT_TIMES}`);
    console.log(`${"═".repeat(50)}`);

    for (const act of ACTIVITIES) {
      try {
        if (act.type === "send") {
          await sendToken(act.token, act.amount);
        } else if (act.type === "swap") {
          await swapToken(act.from, act.to, act.amount);
        }
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
