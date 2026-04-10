/**
 * One-shot rescue helper: transfer BSV from a named agent in
 * config/agents.json to another named agent, in a single on-chain
 * transaction.
 *
 * Used to hand the streaming viewer a fresh shallow-chain UTXO
 * when its own spendable outputs are deep inside an unconfirmed
 * chain that BSV relay policy rejects.
 *
 * Usage:
 *   pnpm tsx scripts/fund-viewer.ts <from-id> <to-id> <sats>
 *
 * Example:
 *   pnpm tsx scripts/fund-viewer.ts capitalk clawnode-a 40000000
 */

import { Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from '../src/payment/wallet.js';
import { loadAgentConfig } from '../src/agents/config.js';

async function main() {
  const [, , fromId, toId, satsArg] = process.argv;
  if (!fromId || !toId || !satsArg) {
    console.error('Usage: pnpm tsx scripts/fund-viewer.ts <from-id> <to-id> <sats>');
    process.exit(1);
  }
  const sats = Number(satsArg);
  if (!Number.isFinite(sats) || sats <= 0) {
    console.error(`Invalid sats: ${satsArg}`);
    process.exit(1);
  }

  const config = await loadAgentConfig();
  if (!config) {
    console.error('No config/agents.json found. Run `pnpm agents:setup` first.');
    process.exit(1);
  }

  const fromRec = config.agents.find((a) => a.id === fromId);
  const toRec = config.agents.find((a) => a.id === toId);
  if (!fromRec) throw new Error(`from agent "${fromId}" not in config`);
  if (!toRec) throw new Error(`to agent "${toId}" not in config`);

  const fromWallet = new Wallet(fromRec.wif);
  const toAddress = toRec.address;

  console.log(`Transferring ${sats.toLocaleString()} sats`);
  console.log(`  from ${fromRec.name.padEnd(12)} ${fromWallet.address}`);
  console.log(`  to   ${toRec.name.padEnd(12)} ${toAddress}`);

  const utxos = await fromWallet.fetchUtxos();
  if (utxos.length === 0) throw new Error(`${fromRec.name} has no UTXOs`);

  const needed = sats + 500;
  const utxo = utxos
    .filter((u) => u.satoshis >= needed)
    .sort((a, b) => b.satoshis - a.satoshis)[0];
  if (!utxo) {
    throw new Error(
      `${fromRec.name} has no UTXO large enough. Need ${needed}, largest is ${utxos[0]?.satoshis ?? 0}`,
    );
  }
  console.log(`  using UTXO ${utxo.txid}:${utxo.vout} = ${utxo.satoshis.toLocaleString()} sats`);

  const sourceTx = await fromWallet.fetchTransaction(utxo.txid);

  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: utxo.vout,
    unlockingScriptTemplate: new P2PKH().unlock(fromWallet.privateKey),
    sequence: 0xffffffff,
  });
  tx.addP2PKHOutput(toAddress, sats);
  tx.addP2PKHOutput(fromWallet.address);
  await tx.fee(new SatoshisPerKilobyte(1));
  await tx.sign();

  const result = await fromWallet.broadcast(tx);
  if (!result.success) {
    throw new Error(`Broadcast failed: ${result.error}`);
  }

  console.log(`  broadcast ✓  txid ${result.txid}`);
}

main().catch((err) => {
  console.error('fund-viewer failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
