#!/usr/bin/env node
import fs from 'node:fs';

const expected = fs.readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
const actual = process.version.replace(/^v/, '');

if (actual !== expected) {
  console.error(`ECP requires Node ${expected}; current runtime is ${actual}.`);
  console.error('Run: nvm use');
  process.exit(1);
}

console.log(`Node runtime OK: ${actual}`);
