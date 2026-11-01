#!/usr/bin/env node
import { deskWalletQuery } from '../desk.mjs';

const ADDR = process.argv[2] || '0xDE243C0667f5c2536ABaC91e3204d6087cfc6254';
const RUNS = 5;

for (let i = 1; i <= RUNS; i++) {
  const start = performance.now();
  try {
    const res = await deskWalletQuery(ADDR, { apiCandidates: false });
    const ms = Math.round(performance.now() - start);
    const buildReady = res.discovery?.complete !== false && res.circuits >= 0;
    console.log(JSON.stringify({
      run: i,
      address: ADDR,
      head: res.head,
      circuits: res.circuits,
      measured: res.measured,
      discoveryComplete: res.discovery?.complete,
      verified: res.discovery?.verified,
      fabPerDay: res.fabPerDay,
      buildBaselineReady: buildReady,
      ms,
    }));
  } catch (error) {
    const ms = Math.round(performance.now() - start);
    console.log(JSON.stringify({ run: i, address: ADDR, error: error.message, ms }));
  }
}
