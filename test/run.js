#!/usr/bin/env node
/** Hermetic test suite — no network, temp dirs only, exit 1 on any failure. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateAll, discoverManifests, planeOf } from '../src/manifest.js';
import { compilePacket, writePacket, disclosureScan } from '../src/compile.js';
import { takeLease, releaseLease, checkLeases } from '../src/lease.js';
import { buildReadModel } from '../src/readmodel.js';
import { extract, capture, inject } from '../src/ledger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(HERE, '..', 'examples', 'workspace');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`✓ ${name}`); };

// ── manifests ──
t('valid manifest passes', () => {
  assert.equal(validateManifest({ schema: 'ecp/1', id: 'x', purpose: 'p', owner: 'o', lifecycle: 'active', load_priority: 'task', read_policy: 'open', write_policy: 'open', token_budget: 100 }, 'x').length, 0);
});
t('bad enum + missing field rejected', () => {
  const errs = validateManifest({ schema: 'ecp/1', id: 'x', load_priority: 'sometimes', token_budget: -1 }, 'x');
  assert.ok(errs.some((e) => /load_priority/.test(e)) && errs.some((e) => /missing purpose/.test(e)) && errs.some((e) => /token_budget/.test(e)));
});
t('gated plane requires a human owner', () => {
  const errs = validateManifest({ schema: 'ecp/1', id: 'x', purpose: 'p', owner: 'system', lifecycle: 'a', load_priority: 'cached', read_policy: 'open', write_policy: 'gated', token_budget: 0 }, 'x');
  assert.ok(errs.some((e) => /human owner/.test(e)));
});
t('example workspace validates', () => {
  const r = validateAll(EXAMPLE);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.planes, 4);
});
t('planeOf resolves deepest ancestor', () => {
  const ms = { a: {}, 'a/b': {} };
  assert.equal(planeOf('a/b/file.md', ms), 'a/b');
  assert.equal(planeOf('a/file.md', ms), 'a');
  assert.equal(planeOf('elsewhere.md', ms), null);
});

// ── compiler ──
t('compile loads task refs, rejects pointer-plane refs', () => {
  const r = compilePacket({ task: 't', refs: ['work/TASK.md', 'archive/OLD_AUDIT.md'] }, { root: EXAMPLE });
  assert.ok(r.task.includes('Refactor the greeting module'));
  assert.ok(r.refusals.some((x) => /pointer-only/.test(x)));
});
t('prefix is byte-stable across runs', () => {
  const a = compilePacket({ task: 't', refs: ['doctrine/STYLE.md'] }, { root: EXAMPLE });
  const b = compilePacket({ task: 't', refs: ['doctrine/STYLE.md'] }, { root: EXAMPLE });
  assert.equal(a.prefix, b.prefix);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(a.prefix), 'no timestamps in prefix');
});
t('budget overrun without justification refuses; with justification passes', () => {
  const fat = { readFile: () => 'x'.repeat(40000) };
  const over = compilePacket({ task: 't', refs: ['work/TASK.md'], budget: 100 }, { root: EXAMPLE, ...fat });
  assert.ok(over.refusals.some((x) => /overrun/.test(x)));
  const justified = compilePacket({ task: 't', refs: ['work/TASK.md'], budget: 100, justification: 'full file required' }, { root: EXAMPLE, ...fat });
  assert.ok(!justified.refusals.some((x) => /overrun/.test(x)));
});
t('disclosure scan refuses secret shapes, passes clean text', () => {
  assert.equal(disclosureScan('plain text').length, 0);
  const leak = compilePacket({ task: 't', refs: ['work/TASK.md'] }, { root: EXAMPLE, readFile: () => 'token ghp_' + 'x'.repeat(24) });
  assert.ok(leak.refusals.some((x) => /disclosure/.test(x)));
});
t('plane token_budget clips oversized slices', () => {
  const r = compilePacket({ task: 't', refs: ['status/STATE.md'] }, { root: EXAMPLE, readFile: () => 'y'.repeat(40000) });
  assert.ok(r.task.includes('clipped at plane budget 800'));
});
t('writePacket emits three files; throws on refusals', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecp-'));
  const good = compilePacket({ task: 't', refs: ['work/TASK.md'] }, { root: EXAMPLE });
  writePacket(good, tmp);
  for (const f of ['cacheable_prefix.md', 'task_packet.md', 'pointers.json']) assert.ok(fs.existsSync(path.join(tmp, f)));
  assert.throws(() => writePacket({ ...good, refusals: ['x'] }, tmp));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── leases ──
t('lease lifecycle: take, conflict, renew, expire-takeover, release, check', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecp-lease-'));
  fs.cpSync(EXAMPLE, tmp, { recursive: true });
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  assert.ok(takeLease('status', 'lane-A', 'obj', { root: tmp, now: t0 }).ok);
  assert.equal(takeLease('status', 'lane-B', 'obj2', { root: tmp, now: t0 + 36e5 }).ok, false, 'conflict refused');
  assert.ok(takeLease('status', 'lane-A', 'obj', { root: tmp, now: t0 + 36e5 }).renewed, 'same holder renews');
  assert.equal(takeLease('doctrine', 'lane-A', 'x', { root: tmp, now: t0 }).ok, false, 'gated plane refuses leases');
  assert.ok(takeLease('status', 'lane-B', 'obj2', { root: tmp, now: t0 + 9 * 36e5 }).ok, 'expired lease taken over');
  assert.equal(releaseLease('status', 'lane-A', { root: tmp }).ok, false, 'wrong holder cannot release');
  const chk = checkLeases({ root: tmp, now: t0 + 20 * 36e5 });
  assert.equal(chk.stale.length, 1, 'stale flagged');
  assert.ok(releaseLease('status', 'lane-B', { root: tmp }).ok);
  assert.equal(checkLeases({ root: tmp, now: t0 }).leases.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── read model ──
t('read model: planes measured, exposed files titled, leases included', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecp-rm-'));
  fs.cpSync(EXAMPLE, tmp, { recursive: true });
  takeLease('work', 'lane-A', 'demo', { root: tmp });
  const rm = buildReadModel({ root: tmp });
  assert.equal(rm.schema, 'ecp.read-model/1');
  assert.equal(rm.objects.filter((o) => o.type === 'plane').length, 4);
  assert.ok(rm.objects.every((o) => o.type !== 'plane' || typeof o.approx_tokens === 'number'));
  assert.ok(rm.objects.some((o) => o.type === 'file' && o.id === 'doctrine/STYLE.md' && o.title === 'Style rules'));
  assert.ok(rm.objects.some((o) => o.type === 'lease' && o.holder === 'lane-A'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ledger ──
t('ledger extract: files, paired errors, redaction, string + array prompts, continuation filtered', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/w/a.md' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'make build' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'exit 2: token ghp_' + 'x'.repeat(20) }] } },
    { type: 'user', message: { content: 'fix the build please' } },
    { type: 'user', message: { content: 'This session is being continued from a previous conversation…' } },
  ].map((x) => JSON.stringify(x)).join('\n');
  const r = extract(lines);
  assert.deepEqual(r.files_written, ['/w/a.md']);
  assert.equal(r.commands_errored.length, 1);
  assert.ok(r.commands_errored[0].error.includes('[redacted-token]'));
  assert.equal(r.last_user_ask, 'fix the build please', 'continuation summary never becomes the last ask');
});
t('ledger capture/inject round-trip; inject silent off-compact; fail-open on junk', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecp-led-'));
  const transcript = path.join(tmp, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Write', input: { file_path: '/w/x.md' } }] } }) + '\n');
  const ledger = path.join(tmp, 'ledger.json');
  const e1 = capture({ session_id: 's1', transcript_path: transcript }, ledger);
  assert.equal(e1.compactions, 1);
  assert.equal(capture({ session_id: 's1', transcript_path: transcript }, ledger).compactions, 2, 'recapture increments');
  const block = inject({ session_id: 's1', source: 'compact' }, ledger);
  assert.ok(block.includes('/w/x.md') && block.includes('compaction #2'));
  assert.equal(inject({ session_id: 's1', source: 'startup' }, ledger), null, 'silent on normal startup');
  assert.equal(capture({ session_id: 's2', transcript_path: '/nonexistent' }, ledger), null, 'missing transcript tolerated');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── plane discovery ignores noise ──
t('discovery skips hidden dirs and node_modules', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecp-disc-'));
  fs.mkdirSync(path.join(tmp, 'node_modules/pkg'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.hidden'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'real'), { recursive: true });
  const m = { schema: 'ecp/1', id: 'r', purpose: 'p', owner: 'o', lifecycle: 'a', load_priority: 'task', read_policy: 'open', write_policy: 'open', token_budget: 1 };
  for (const d of ['node_modules/pkg', '.hidden', 'real']) fs.writeFileSync(path.join(tmp, d, 'CONTEXT.manifest.json'), JSON.stringify(m));
  assert.deepEqual(Object.keys(discoverManifests(tmp)), ['real']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\nall ${passed} tests passed`);
