#!/usr/bin/env node
/**
 * ecp — CLI for the Efficient Context Protocol reference implementation.
 *
 *   ecp validate [--root dir]                          manifests vs ecp/1 + governance
 *   ecp compile <intent.json> --out <dir> [--root dir] intent → packet (fail-closed)
 *   ecp lease take <dir> <holder> <objective> [ttl-h]
 *   ecp lease release <dir> <holder> [--force]
 *   ecp lease check
 *   ecp read-model [--out file]                        world-state JSON
 *   ecp ledger capture                                 stdin: {session_id, transcript_path}
 *   ecp ledger inject                                  stdin: {session_id, source}
 *
 * Root resolution: --root flag, else ECP_ROOT env, else cwd.
 * Ledger file: ECP_LEDGER env, else <root>/.ecp/session-ledger.json.
 * Ledger commands are FAIL-OPEN (always exit 0) — hooks must never block a session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateAll } from '../src/manifest.js';
import { compilePacket, writePacket } from '../src/compile.js';
import { takeLease, releaseLease, checkLeases } from '../src/lease.js';
import { buildReadModel } from '../src/readmodel.js';
import { capture, inject } from '../src/ledger.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const root = path.resolve(flag('--root') || process.env.ECP_ROOT || process.cwd());
const ledgerFile = process.env.ECP_LEDGER || path.join(root, '.ecp', 'session-ledger.json');
const readStdin = () => { try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; } };

const [cmd, sub] = args;

if (cmd === 'validate') {
  const r = validateAll(root);
  console.log(r.ok ? `✓ ${r.planes} plane manifest(s) valid` : r.errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'compile') {
  const intent = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  const result = compilePacket(intent, { root });
  if (result.refusals.length) { console.error('REFUSED:\n- ' + result.refusals.join('\n- ')); process.exit(1); }
  const out = flag('--out') || path.join(root, '.ecp', 'packets', 'latest');
  writePacket(result, out);
  console.log(`packet → ${out} (${result.pointers.spent_tokens}/${result.pointers.budget_tokens} tokens)`);
} else if (cmd === 'lease') {
  if (sub === 'take') {
    const r = takeLease(args[2], args[3], args[4], { root, ttlHours: args[5] ? Number(args[5]) : undefined });
    console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1);
  } else if (sub === 'release') {
    const r = releaseLease(args[2], args[3], { root, force: args.includes('--force') });
    console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1);
  } else if (sub === 'check') {
    const r = checkLeases({ root });
    console.log(JSON.stringify(r, null, 2)); process.exit(r.stale.length ? 1 : 0);
  } else usage();
} else if (cmd === 'read-model') {
  const rm = buildReadModel({ root });
  const out = flag('--out');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rm, null, 2) + '\n'); console.log(`read-model → ${out} (${rm.objects.length} objects)`); }
  else console.log(JSON.stringify(rm, null, 2));
} else if (cmd === 'ledger') {
  // fail-open: hook commands never block a session
  try {
    if (sub === 'capture') capture(readStdin(), ledgerFile);
    else if (sub === 'inject') { const block = inject(readStdin(), ledgerFile); if (block) console.log(block); }
    else usage();
  } catch { /* fail-open */ }
  process.exit(0);
} else usage();

function usage() {
  console.error('usage: ecp validate | compile <intent.json> [--out dir] | lease take|release|check … | read-model [--out file] | ledger capture|inject   (--root dir / ECP_ROOT)');
  process.exit(2);
}
