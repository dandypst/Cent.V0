# Incentiv Farming Bot

Auto send + swap di Incentiv Mainnet via UserOperation (ERC-4337).

## Setup

### 1. Install dependencies
```bash
npm install ethers@5 axios dotenv
```

### 2. Buat file .env
Copy dari `.env.example` lalu isi:
```
PRIVATE_KEY=0x...private_key_metamask_kamu...
SMART_WALLET=0x6DA0E5e3757eD97F8F70dA3338df3d44A18F63b7
SEND_TO=0x...alamat_tujuan_send...
```

**Cara cek alamat Smart Wallet kamu:**
Lihat di portal.incentiv.io → Settings atau cek dari tx yang sudah ada
(dari tx kamu, smart wallet = `0x6DA0E5e3757eD97F8F70dA3338df3d44A18F63b7`)

### 3. Edit konfigurasi aktivitas
Di `incentiv_bot.js`, edit bagian `ACTIVITIES`:
```js
const ACTIVITIES = [
  { type: "swap", from: "USDC", to: "SOL",  amount: 0.1 },
  { type: "swap", from: "USDC", to: "WETH", amount: 0.1 },
  { type: "send", token: "SOL",             amount: 0.0001 },
  { type: "swap", from: "SOL",  to: "USDC", amount: 0.001 },
];

const REPEAT_TIMES = 3;      // Berapa kali loop
const DELAY_MIN_SEC = 30;    // Jeda minimum antar aksi
const DELAY_MAX_SEC = 120;   // Jeda maximum antar aksi
```

### 4. Jalankan
```bash
node incentiv_bot.js
```

## Token yang Tersedia
| Symbol | Alamat |
|--------|--------|
| USDC   | 0x16e4...5685 |
| USDT   | 0x39b0...4bB  |
| WETH   | 0x3e42...9cb  |
| SOL    | 0xfaC2...3E3  |
| WCENT  | 0xB0f0...B04  |

## Contoh Aktivitas Swap yang Didukung
- USDC → SOL
- USDC → WETH
- SOL → USDC
- WETH → USDC
- USDC → WCENT
- (semua kombinasi via WCENT sebagai intermediate)

## ⚠️ Catatan Penting
1. **Pastikan saldo USDC cukup** untuk bayar gas (estimasi ~0.02 USDC per transaksi)
2. **Jangan terlalu kecil amount** swap — minimum ~0.1 USDC agar tidak rugi slippage
3. Bot ini perlu di-test dulu dengan amount kecil sebelum dijalankan penuh
4. Kalau ada error nonce atau gas, coba jalankan ulang

## Bridge
Bridge belum diimplementasi karena butuh contoh transaksi bridge.
Share link tx bridge dari explorer untuk aku tambahkan.
