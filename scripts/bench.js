#!/usr/bin/env node
/**
 * bench.js — the honest benchmark: compiled packet vs naive full-workspace load.
 *
 * Measures BYTES ON DISK ÷ 4 (the common ~4-bytes-per-token heuristic) for:
 *   (a) naive: every readable text file in the workspace concatenated — what an
 *       agent consumes when it "just reads everything" to orient,
 *   (b) compiled: the packet ECP emits for examples/workspace/work/intent.example.json.
 *
 * Numbers are MEASURED for this example workspace only. The ratio grows with
 * workspace size (the naive load scales with the corpus; the packet scales
 * with the task). Re-run: npm run bench
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePacket } from '../src/compile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(HERE, '..', 'examples', 'workspace');
const tok = (s) => Math.ceil(Buffer.byteLength(s, 'utf8') / 4);

let naive = '';
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else naive += fs.readFileSync(p, 'utf8');
  }
};
walk(WS);

const intent = JSON.parse(fs.readFileSync(path.join(WS, 'work/intent.example.json'), 'utf8'));
const r = compilePacket(intent, { root: WS });
if (r.refusals.length) throw new Error('benchmark intent refused: ' + r.refusals.join('; '));
const compiled = tok(r.prefix) + tok(r.task);

console.log('ECP benchmark (examples/workspace, MEASURED bytes÷4):');
console.log(`  naive full-workspace load : ${tok(naive)} tokens`);
console.log(`  compiled packet           : ${compiled} tokens (prefix ${tok(r.prefix)} cacheable + task ${tok(r.task)})`);
console.log(`  ratio                     : ${(tok(naive) / compiled).toFixed(2)}× — grows with workspace size; the packet scales with the task, not the corpus`);
