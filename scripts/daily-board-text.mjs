#!/usr/bin/env node
// Print one Chinese paragraph. Stdout only — does not send.
import { pathToFileURL } from 'node:url';
import { boardUrl, buildDailyBoardText } from '../board.mjs';

export { buildDailyBoardText };

export async function main() {
  const url = process.env.BOARD_URL || boardUrl();
  process.stdout.write(`${await buildDailyBoardText({ url })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
