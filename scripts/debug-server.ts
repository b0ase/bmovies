import { createServer } from '../src/api/server.js';
import { Wallet } from '../src/payment/wallet.js';

const w = Wallet.random();
const s = await createServer({
  privateKeyWif: w.privateKey.toWif(),
  storagePath: './data',
  maxStorageBytes: 1e9,
  defaultSatsPerPiece: 1,
  port: 8403,
});

console.log('Registered routes:');
console.log(s.app.printRoutes());

// Inject a request directly (no network)
const catalogRes = await s.app.inject({ method: 'GET', url: '/api/catalog' });
console.log('Inject /api/catalog:', catalogRes.statusCode, catalogRes.body);

const statusRes = await s.app.inject({ method: 'GET', url: '/api/status' });
console.log('Inject /api/status:', statusRes.statusCode, statusRes.body);

const rootRes = await s.app.inject({ method: 'GET', url: '/' });
console.log('Inject /:', rootRes.statusCode, rootRes.body.substring(0, 100));

process.exit(0);
