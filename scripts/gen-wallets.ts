import { Wallet } from '../src/payment/wallet.js';

const seeder = Wallet.random();
const leecher = Wallet.random();

console.log('=== BitCoinTorrent Wallets ===');
console.log('');
console.log('SEEDER (earns sats for serving video):');
console.log('  Address: ' + seeder.address);
console.log('');
console.log('LEECHER (pays sats to watch video):');
console.log('  Address: ' + leecher.address);
console.log('');
console.log('Fund each address with ~$1 BSV, then paste these into .env:');
console.log('');
console.log('BSV_PRIVATE_KEY=' + seeder.privateKey.toWif());
console.log('BSV_LEECHER_KEY=' + leecher.privateKey.toWif());
