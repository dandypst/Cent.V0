/**
 * ============================================================
 *  INCENTIV FARMING BOT v2
 *  Auto Send + Swap via UserOperation (ERC-4337)
 *  Signing dengan EOA private key (tanpa Portal UI)
 * ============================================================
 *
 *  SETUP:
 *    npm install ethers@5 dotenv
 *
 *  CONFIG:
 *    Buat file .env di folder yang sama:
 *      PRIVATE_KEY=0x...       <- private key EOA MetaMask kamu
 *      SMART_WALLET=0x6DA0...  <- smart wallet Incentiv kamu
 *      SEND_TO=0x...           <- alamat tujuan send token
 */

require("dotenv").config();
const { ethers } = require("ethers");

// ─────────────────────────────────────────
//  KONSTANTA JARINGAN & CONTRACT
// ─────────────────────────────────────────
const RPC_URL     = "https://rpc.incentiv.net";
const ENTRY_POINT = "0x3eC61c5633BBD7Afa9144C6610930489736a72d4";
const PAYMASTER   = "0x43000f785EB43BcB4961C5c70276eD00e088972c";
const SWAP_ROUTER = "0x4a66A8bA9704DD06fE52A027f2B16a3F5D11B048";
const CHAIN_ID    = 14082; // Incentiv Mainnet chain ID (akan di-fetch juga)

// Token mainnet — semua confirmed dari transaksi real on-chain
const TOKENS = {
  USDC:  { address: "0x16e43840d8D79896A389a3De85aB0B0210C05685", decimals: 6  }, // confirmed tx send+swap
  USDT:  { address: "0x39b076b5d23F588690D480af3Bf820edad31a4bB", decimals: 6  }, // confirmed tx swap USDC→USDT
  WETH:  { address: "0x3e425317dB7BaC8077093117081b40d9b46F29cb", decimals: 18 }, // dari docs contracts
  WBTC:  { address: "0x0292593D416Cb765E0e8FF77b32fA7e465958FEE", decimals: 8  }, // confirmed tx swap USDC→WBTC
  SOL:   { address: "0xfaC24134dbc4b00Ee11114eCDFE6397f389203E3", decimals: 9  }, // confirmed tx swap USDC→SOL
  WCENT: { address: "0xB0f0A14A50F14dc9e6476d61C00cF0375Dd4EB04", decimals: 18 }, // confirmed semua swap
};

// DEX Pools — semua confirmed dari transaksi real (fee 0.3%)
// USDC/WCENT: 0xf9884c2A1749b0a02ce780aDE437cBaDFA3a961D ✅ tx send+all swaps
// SOL/WCENT:  0x40D6b92323493adB118EFB945D26c8bf09d37B9A ✅ tx USDC→SOL
// WBTC/WCENT: 0x7b6C572888B19760461dF47452957766e51b0FB5 ✅ tx USDC→WBTC
// USDT/WCENT: 0xd1da5c73eB5b498Dea4224267FEeA3A3dE82BA4E ✅ tx USDC→USDT
// WETH/WCENT: 0xCC00489ECd4B60141DAb86c6aa44e7697c6923E6 ✅ tx USDC→WETH
// Semua swap multi-hop via WCENT sebagai intermediate

// Gas values — diambil langsung dari transaksi real on-chain
const GAS_SEND = {
  callGasLimit:         ethers.BigNumber.from("0x000186a0"),  // 100,000
  verificationGasLimit: ethers.BigNumber.from("0x000412e6"),  // 267,494
  preVerificationGas:   ethers.BigNumber.from("0x0000d728"),  // 55,080
  maxFeePerGas:         ethers.BigNumber.from("0x000bea14d8b80000"),
  maxPriorityFeePerGas: ethers.BigNumber.from("0x000175fbf5ee800"),
};

const GAS_SWAP = {
  callGasLimit:         ethers.BigNumber.from("0x000437b2"),  // 276,402 — dari tx WBTC
  verificationGasLimit: ethers.BigNumber.from("0x000412e6"),
  preVerificationGas:   ethers.BigNumber.from("0x0000e4b4"),  // 58,548
  maxFeePerGas:         ethers.BigNumber.from("0x000bea14d8b80000"),
  maxPriorityFeePerGas: ethers.BigNumber.from("0x000175fbf5ee800"),
};

// Gas fee USDC untuk Paymaster (dari tx real: ~22,000-22,200 USDC units = ~$0.022)
const GAS_FEE_USDC = ethers.BigNumber.from("25000"); // sedikit lebih dari real agar tidak kurang

// ─────────────────────────────────────────
//  INISIALISASI
// ─────────────────────────────────────────
const provider     = new ethers.providers.StaticJsonRpcProvider(RPC_URL);
const signer       = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const SMART_WALLET = process.env.SMART_WALLET;
const SEND_TO      = process.env.SEND_TO;

// ─────────────────────────────────────────
//  ABI MINIMAL
// ─────────────────────────────────────────
const ERC20_IFACE = new ethers.utils.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

const ENTRY_POINT_IFACE = new ethers.utils.Interface([
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)",
]);

const ACCOUNT_IFACE = new ethers.utils.Interface([
  // function signature 0x47e1da2a — confirmed dari semua tx
  "function execute(address[] targets, uint256[] values, bytes[] calldatas)",
]);

const entryPoint = new ethers.Contract(ENTRY_POINT, ENTRY_POINT_IFACE, provider);

// ─────────────────────────────────────────
//  HELPER: Encode multi-call callData
//  Function selector: 0x47e1da2a (execute)
// ─────────────────────────────────────────
function encodeExecute(targets, values, calldatas) {
  return ACCOUNT_IFACE.encodeFunctionData("execute", [targets, values, calldatas]);
}

// ─────────────────────────────────────────
//  HELPER: Pack gas fields ke bytes32
// ─────────────────────────────────────────
function packAccountGasLimits(verificationGasLimit, callGasLimit) {
  // bytes32 = verificationGasLimit (16 bytes hi) + callGasLimit (16 bytes lo)
  return ethers.utils.hexConcat([
    ethers.utils.hexZeroPad(verificationGasLimit.toHexString(), 16),
    ethers.utils.hexZeroPad(callGasLimit.toHexString(), 16),
  ]);
}

function packGasFees(maxPriorityFeePerGas, maxFeePerGas) {
  return ethers.utils.hexConcat([
    ethers.utils.hexZeroPad(maxPriorityFeePerGas.toHexString(), 16),
    ethers.utils.hexZeroPad(maxFeePerGas.toHexString(), 16),
  ]);
}

// ─────────────────────────────────────────
//  HELPER: Encode paymasterAndData
//  Format: paymaster (20B) + maxCost (16B) + maxCost (16B)
//  Confirmed dari semua tx: 0x43000f...000f4240000f4240
// ─────────────────────────────────────────
function encodePaymasterData() {
  const maxCost = ethers.BigNumber.from("0x000f4240"); // 1,000,000 = 1 USDC
  return ethers.utils.hexConcat([
    PAYMASTER,
    ethers.utils.hexZeroPad(maxCost.toHexString(), 16),
    ethers.utils.hexZeroPad(maxCost.toHexString(), 16),
  ]);
}

// ─────────────────────────────────────────
//  HELPER: Hitung UserOp hash
//  Sesuai ERC-4337 v0.6 yang dipakai Incentiv
// ─────────────────────────────────────────
async function getUserOpHash(userOp) {
  const network = await provider.getNetwork();
  const chainId = network.chainId;

  // Hash inner struct
  const innerHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address","uint256","bytes32","bytes32","bytes32","uint256","bytes32","bytes32"],
      [
        userOp.sender,
        userOp.nonce,
        ethers.utils.keccak256(userOp.initCode),
        ethers.utils.keccak256(userOp.callData),
        userOp.accountGasLimits,
        userOp.preVerificationGas,
        userOp.gasFees,
        ethers.utils.keccak256(userOp.paymasterAndData),
      ]
    )
  );

  // Final hash = keccak256(innerHash + entryPoint + chainId)
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "address", "uint256"],
      [innerHash, ENTRY_POINT, chainId]
    )
  );
}

// ─────────────────────────────────────────
//  HELPER: Sign UserOp
//
//  FORMAT SIGNATURE (68 bytes total) — confirmed dari semua tx:
//  [0x00 0x00] keyIndex=0 (2 bytes)
//  [0x01]      sigType=1 = ECDSA secp256k1 (1 byte)
//  [65 bytes]  r + s + v (standard ECDSA)
// ─────────────────────────────────────────
async function signUserOp(userOp) {
  const hash = await getUserOpHash(userOp);

  // Sign the hash (ethers otomatis menambah Ethereum prefix \x19Ethereum...)
  // Tapi dari trace, signing pakai raw hash tanpa prefix
  // Kita coba dua cara: dengan dan tanpa prefix
  const rawSig = await signer._signingKey().signDigest(ethers.utils.arrayify(hash));
  const sig65 = ethers.utils.joinSignature(rawSig); // r + s + v (65 bytes)

  // Encode: 00 00 (keyIndex=0) + 01 (sigType=1) + 65 bytes sig
  const signature = ethers.utils.hexConcat([
    "0x0000",   // keyIndex = 0
    "0x01",     // sigType = ECDSA
    sig65,      // 65 bytes: r(32) + s(32) + v(1)
  ]);

  return signature;
}

// ─────────────────────────────────────────
//  HELPER: Build dan submit UserOperation
// ─────────────────────────────────────────
async function submitUserOp(callData, gasConfig, label) {
  console.log(`\n📝 Building UserOp: ${label}`);

  const nonce = await entryPoint.getNonce(SMART_WALLET, 0);
  console.log(`   Nonce: ${nonce.toString()}`);

  const userOp = {
    sender:             SMART_WALLET,
    nonce:              nonce,
    initCode:           "0x",
    callData:           callData,
    accountGasLimits:   packAccountGasLimits(gasConfig.verificationGasLimit, gasConfig.callGasLimit),
    preVerificationGas: gasConfig.preVerificationGas,
    gasFees:            packGasFees(gasConfig.maxPriorityFeePerGas, gasConfig.maxFeePerGas),
    paymasterAndData:   encodePaymasterData(),
    signature:          "0x",
  };

  userOp.signature = await signUserOp(userOp);
  console.log(`   Signature (68 bytes): ${userOp.signature.slice(0, 20)}...`);

  // Submit via handleOps — EOA kita bertindak sebagai bundler
  const txData = ENTRY_POINT_IFACE.encodeFunctionData("handleOps", [
    [userOp],
    signer.address, // beneficiary = EOA kita
  ]);

  try {
    const tx = await signer.sendTransaction({
      to: ENTRY_POINT,
      data: txData,
      gasLimit: 3_000_000,
      maxFeePerGas: ethers.utils.parseUnits("16.502", "gwei"),
      maxPriorityFeePerGas: ethers.utils.parseUnits("0.5", "gwei"),
    });

    console.log(`   ✅ TX: https://explorer.incentiv.io/tx/${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed block ${receipt.blockNumber} | gas: ${receipt.gasUsed.toString()}`);
    return tx.hash;
  } catch (err) {
    // Jika error karena signature, coba metode signing alternatif
    if (err.message.includes("signature") || err.message.includes("AA24") || err.message.includes("AA23")) {
      console.log(`   ⚠️  Signature error, mencoba metode alternatif...`);
      return await submitWithEthSign(userOp, label);
    }
    throw err;
  }
}

// Metode signing alternatif: pakai eth_sign (dengan Ethereum prefix)
async function submitWithEthSign(userOp, label) {
  const hash = await getUserOpHash(userOp);
  const sig65 = await signer.signMessage(ethers.utils.arrayify(hash));

  userOp.signature = ethers.utils.hexConcat(["0x0000", "0x01", sig65]);
  console.log(`   Trying eth_sign signature...`);

  const txData = ENTRY_POINT_IFACE.encodeFunctionData("handleOps", [
    [userOp],
    signer.address,
  ]);

  const tx = await signer.sendTransaction({
    to: ENTRY_POINT,
    data: txData,
    gasLimit: 3_000_000,
    maxFeePerGas: ethers.utils.parseUnits("16.502", "gwei"),
    maxPriorityFeePerGas: ethers.utils.parseUnits("0.5", "gwei"),
  });

  console.log(`   ✅ TX: https://explorer.incentiv.io/tx/${tx.hash}`);
  await tx.wait();
  return tx.hash;
}

// ─────────────────────────────────────────
//  AKSI 1: SEND TOKEN
// ─────────────────────────────────────────
async function sendToken(tokenSymbol, amount) {
  const token = TOKENS[tokenSymbol];
  if (!token) throw new Error(`Token ${tokenSymbol} tidak dikenal`);

  const amountBN = ethers.utils.parseUnits(String(amount), token.decimals);

  // Multi-call: [bayar gas ke Paymaster] + [transfer token ke tujuan]
  const targets   = [TOKENS.USDC.address, token.address];
  const values    = [0, 0];
  const calldatas = [
    ERC20_IFACE.encodeFunctionData("transfer", [PAYMASTER, GAS_FEE_USDC]),
    ERC20_IFACE.encodeFunctionData("transfer", [SEND_TO, amountBN]),
  ];

  const callData = encodeExecute(targets, values, calldatas);
  console.log(`\n💸 Send ${amount} ${tokenSymbol} → ${SEND_TO.slice(0,10)}...`);
  return await submitUserOp(callData, GAS_SEND, `Send ${amount} ${tokenSymbol}`);
}

// ─────────────────────────────────────────
//  AKSI 2: SWAP TOKEN (UniswapV3 exactInput)
//  Path selalu via WCENT sebagai intermediate
//  Confirmed dari semua tx swap (USDC→SOL, USDC→WBTC)
// ─────────────────────────────────────────
async function swapToken(tokenInSymbol, tokenOutSymbol, amountIn) {
  const tokenIn  = TOKENS[tokenInSymbol];
  const tokenOut = TOKENS[tokenOutSymbol];
  if (!tokenIn || !tokenOut) throw new Error(`Token tidak dikenal`);

  const amountInBN = ethers.utils.parseUnits(String(amountIn), tokenIn.decimals);
  const deadline   = Math.floor(Date.now() / 1000) + 600; // 10 menit

  // Encode swap path
  // Direct jika salah satu WCENT, multi-hop jika tidak
  let path;
  if (tokenInSymbol === "WCENT") {
    path = buildPath([tokenIn.address, tokenOut.address], [3000]);
  } else if (tokenOutSymbol === "WCENT") {
    path = buildPath([tokenIn.address, tokenOut.address], [3000]);
  } else {
    // Multi-hop: tokenIn → WCENT → tokenOut
    path = buildPath(
      [tokenIn.address, TOKENS.WCENT.address, tokenOut.address],
      [3000, 3000]
    );
  }

  const ROUTER_IFACE = new ethers.utils.Interface([
    "function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) returns (uint256)",
  ]);

  const swapCalldata = ROUTER_IFACE.encodeFunctionData("exactInput", [{
    path:             path,
    recipient:        SMART_WALLET,
    deadline:         deadline,
    amountIn:         amountInBN,
    amountOutMinimum: 0, // no slippage protection untuk simplicity
  }]);

  // Multi-call: [bayar gas] + [approve router] + [swap]
  const targets = [
    TOKENS.USDC.address,  // bayar gas
    tokenIn.address,      // approve router
    SWAP_ROUTER,          // execute swap
  ];
  const values = [0, 0, 0];
  const calldatas = [
    ERC20_IFACE.encodeFunctionData("transfer", [PAYMASTER, GAS_FEE_USDC]),
    ERC20_IFACE.encodeFunctionData("approve",  [SWAP_ROUTER, amountInBN]),
    swapCalldata,
  ];

  const callData = encodeExecute(targets, values, calldatas);
  console.log(`\n🔄 Swap ${amountIn} ${tokenInSymbol} → ${tokenOutSymbol}`);
  return await submitUserOp(callData, GAS_SWAP, `Swap ${amountIn} ${tokenInSymbol}→${tokenOutSymbol}`);
}

// ─────────────────────────────────────────
//  HELPER: Build UniswapV3 path bytes
//  Format: addr0 + fee0 (3 bytes) + addr1 + fee1 (3 bytes) + addr2
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
//  HELPER: Cek saldo smart wallet
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
  // CENT native
  const centBal = await provider.getBalance(SMART_WALLET);
  console.log(`   ${"CENT".padEnd(6)}: ${ethers.utils.formatEther(centBal)}`);
  console.log("─".repeat(45));
}

// ─────────────────────────────────────────
//  HELPER: Delay random
// ─────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function randomDelay(minSec, maxSec) {
  const ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
  console.log(`\n⏳ Jeda ${(ms/1000).toFixed(0)} detik...`);
  await sleep(ms);
}

// ─────────────────────────────────────────
//  MAIN — FARMING LOOP
// ─────────────────────────────────────────
async function main() {
  console.log("═".repeat(50));
  console.log("  INCENTIV FARMING BOT v2");
  console.log("═".repeat(50));

  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY tidak ada di .env");
  if (!SMART_WALLET)            throw new Error("SMART_WALLET tidak ada di .env");
  if (!SEND_TO)                 throw new Error("SEND_TO tidak ada di .env");

  const network = await provider.getNetwork();
  console.log(`  Network  : Incentiv Mainnet (chainId: ${network.chainId})`);
  console.log(`  EOA      : ${signer.address}`);
  console.log(`  Wallet   : ${SMART_WALLET}`);
  console.log(`  Send To  : ${SEND_TO}`);

  await checkBalances();

  // ══════════════════════════════════════
  //  ⚙️  EDIT KONFIGURASI AKTIVITAS DI BAWAH
  // ══════════════════════════════════════

  const ACTIVITIES = [
    // ── Swap USDC ke semua token (semua confirmed dari tx real) ──
    { type: "swap", from: "USDC", to: "SOL",  amount: 0.1 }, // USDC→WCENT→SOL  ✅
    { type: "swap", from: "USDC", to: "WBTC", amount: 0.1 }, // USDC→WCENT→WBTC ✅
    { type: "swap", from: "USDC", to: "WETH", amount: 0.1 }, // USDC→WCENT→WETH ✅
    { type: "swap", from: "USDC", to: "USDT", amount: 0.1 }, // USDC→WCENT→USDT ✅

    // ── Send token ke akun lain ──
    { type: "send", token: "SOL",  amount: 0.0001 },

    // ── Swap balik ke USDC ──
    { type: "swap", from: "SOL",  to: "USDC", amount: 0.001    },
    { type: "swap", from: "USDT", to: "USDC", amount: 0.09     },
    { type: "swap", from: "WETH", to: "USDC", amount: 0.000001 },
  ];

  const REPEAT_TIMES  = 3;    // Jumlah loop
  const DELAY_MIN     = 30;   // Detik minimum antar aksi
  const DELAY_MAX     = 90;   // Detik maximum antar aksi
  const LOOP_DELAY    = 180;  // Jeda antar loop (detik)

  // ══════════════════════════════════════

  console.log(`\n🚀 Mulai ${REPEAT_TIMES} loop × ${ACTIVITIES.length} aksi`);

  let successCount = 0;
  let failCount = 0;

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
