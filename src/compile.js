/**
 * compile.js — ECP layer 10: the context compiler.
 *
 * Plan, then materialize: no large model call should assemble its own context
 * ad hoc. The compiler turns an intent + the workspace's manifests into a
 * packet on disk:
 *
 *   cacheable_prefix.md  — byte-stable role + rules + doctrine POINTERS
 *                          (never bodies, never timestamps): the prompt-cache contract
 *   task_packet.md       — the dynamic part: task, budgeted file slices, acceptance
 *   pointers.json        — everything excluded, with reasons
 *
 * Refusals are fail-closed: disclosure-scan hits, refs into pointer/never
 * planes, and budget overruns without a written justification all refuse
 * compilation rather than emit a bad packet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverManifests, planeOf } from './manifest.js';

export const tokens = (s) => Math.ceil(Buffer.byteLength(s, 'utf8') / 4);

/** Secret SHAPES only — never real values. Extend per deployment. */
export const DENY_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'provider secret key shape'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'github token shape'],
  [/\bxox[bap]-[A-Za-z0-9-]{10,}/, 'slack token shape'],
  [/\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'JWT shape'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key shape'],
  [/\.env(?:\.[a-z]+)?\b/, '.env reference'],
];

export function disclosureScan(text, extra = []) {
  const hits = [];
  for (const [re, label] of [...DENY_PATTERNS, ...extra]) if (re.test(text)) hits.push(label);
  return hits;
}

/**
 * Compile a context packet.
 * @param {object} intent  {task, role?, refs:[{ref,kind?}], acceptance?, budget?, justification?, rules?:string[], doctrine_pointers?:string[]}
 * @param {object} opts    {root, manifests?, readFile?, denyPatterns?}
 * @returns {{prefix, task, pointers, refusals}}
 */
export function compilePacket(intent, opts = {}) {
  const root = opts.root || process.cwd();
  const manifests = opts.manifests || discoverManifests(root);
  const readFile = opts.readFile || ((rel) => {
    const f = path.join(root, rel);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  });
  const budget = intent.budget || 4000;
  const refusals = [];

  // ── cacheable prefix: byte-stable, pointers + rules only ──
  const prefix = [
    '# CACHEABLE PREFIX — ecp/1 (byte-stable; pointers, never bodies; no timestamps)',
    `role: ${intent.role || 'bounded-session worker'}`,
    '## doctrine pointers (load on demand only)',
    ...[...(intent.doctrine_pointers || [])].sort().map((d) => `- ${d}`),
    '## stable rules',
    ...(intent.rules || [
      'edit-source: fix generators and contracts, never their outputs',
      'docs over outputs: learn how to build from reference material, never prior outputs',
      'pointer planes never load as content — retrieve explicitly and log it',
    ]).map((r) => `- ${r}`),
    '',
  ].join('\n');

  // ── task packet: budgeted slices, manifest-governed ──
  let spent = 0;
  const slices = [];
  const pointers = [];
  for (const r of intent.refs || []) {
    const ref = typeof r === 'string' ? { ref: r } : r;
    const plane = planeOf(ref.ref, manifests);
    const m = plane != null ? manifests[plane] : null;
    if (m && (m.load_priority === 'pointer' || m.load_priority === 'never')) {
      refusals.push(`${ref.ref}: plane "${plane}" is ${m.load_priority}-only — pass it as a pointer, not a content ref`);
      continue;
    }
    const body = readFile(ref.ref);
    if (body == null) { pointers.push({ ref: ref.ref, reason: 'not found on disk' }); continue; }
    const cap = m ? m.token_budget : Infinity;
    const t = tokens(body);
    const clipped = t > cap ? body.slice(0, cap * 4) + `\n…[clipped at plane budget ${cap} tok of ${t}]` : body;
    spent += Math.min(t, cap);
    slices.push(`### ${ref.ref}\n${clipped}`);
  }
  if (spent > budget && !intent.justification) {
    refusals.push(`budget overrun ${spent} > ${budget} tokens with no intent.justification`);
  }

  const task = [
    '# TASK PACKET — dynamic (always after the cache breakpoint)',
    intent.task ? `## task\n${intent.task}` : '',
    intent.acceptance ? `## acceptance\n${intent.acceptance}` : '',
    '## loaded slices',
    ...slices,
    '',
  ].filter(Boolean).join('\n');

  // ── disclosure scan, fail-closed ──
  for (const [name, text] of [['prefix', prefix], ['task_packet', task]]) {
    const hits = disclosureScan(text, opts.denyPatterns || []);
    if (hits.length) refusals.push(`disclosure scan HIT in ${name}: ${hits.join(', ')}`);
  }

  return {
    prefix, task,
    pointers: { pointer_only: pointers, spent_tokens: spent, budget_tokens: budget },
    refusals,
  };
}

/** Write a compiled packet to a directory. Throws on refusals. */
export function writePacket(result, dir) {
  if (result.refusals.length) throw new Error('REFUSED:\n- ' + result.refusals.join('\n- '));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cacheable_prefix.md'), result.prefix);
  fs.writeFileSync(path.join(dir, 'task_packet.md'), result.task);
  fs.writeFileSync(path.join(dir, 'pointers.json'), JSON.stringify(result.pointers, null, 2) + '\n');
  return dir;
}
