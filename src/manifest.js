/**
 * manifest.js — ECP layer 3: machine-readable stage contracts.
 *
 * A workspace is any directory tree. A "plane" is any directory carrying a
 * CONTEXT.manifest.json (schema "ecp/1"). Manifests are read by TOOLS, never
 * auto-loaded into a model's context — they cost zero tokens at runtime.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'ecp/1';
export const LOAD_PRIORITIES = ['boot', 'cached', 'task', 'pointer', 'never'];
export const READ_POLICIES = ['open', 'logged', 'gated'];
export const WRITE_POLICIES = ['open', 'lease', 'gated'];

const REQUIRED = ['id', 'purpose', 'owner', 'lifecycle', 'load_priority', 'read_policy', 'write_policy'];

/** Validate one manifest object. Returns an array of error strings (empty = valid). */
export function validateManifest(m, where = '?') {
  const errs = [];
  if (!m || typeof m !== 'object') return [`${where}: not an object`];
  if (m.schema !== SCHEMA) errs.push(`schema must be "${SCHEMA}"`);
  for (const f of REQUIRED) if (!m[f]) errs.push(`missing ${f}`);
  if (m.load_priority && !LOAD_PRIORITIES.includes(m.load_priority)) errs.push(`load_priority must be one of ${LOAD_PRIORITIES.join('|')}`);
  if (m.read_policy && !READ_POLICIES.includes(m.read_policy)) errs.push(`read_policy must be one of ${READ_POLICIES.join('|')}`);
  if (m.write_policy && !WRITE_POLICIES.includes(m.write_policy)) errs.push(`write_policy must be one of ${WRITE_POLICIES.join('|')}`);
  if (typeof m.token_budget !== 'number' || m.token_budget < 0) errs.push('token_budget must be a non-negative number');
  // governance invariant: a gated plane must name a human owner, not "system"
  if (m.write_policy === 'gated' && m.owner === 'system') errs.push('gated planes must have a human owner');
  return errs.map((e) => `${where}: ${e}`);
}

/**
 * Discover every plane under root (depth-limited scan for CONTEXT.manifest.json).
 * Returns { "<relative-dir>": manifest }. Hidden dirs and node_modules are skipped.
 */
export function discoverManifests(root, maxDepth = 3) {
  const out = {};
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === 'CONTEXT.manifest.json') {
        try { out[path.relative(root, dir) || '.'] = JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (err) { out[path.relative(root, dir) || '.'] = { __parse_error: err.message }; }
      } else if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** The plane a relative path belongs to (deepest manifest-bearing ancestor wins). */
export function planeOf(rel, manifests) {
  const norm = String(rel).replace(/^\.\//, '');
  let best = null;
  for (const p of Object.keys(manifests)) {
    if (p !== '.' && (norm === p || norm.startsWith(p + '/'))) {
      if (!best || p.length > best.length) best = p;
    }
  }
  return best ?? (manifests['.'] ? '.' : null);
}

/** Validate every discovered manifest. Returns { ok, errors } */
export function validateAll(root) {
  const manifests = discoverManifests(root);
  const errors = [];
  for (const [where, m] of Object.entries(manifests)) {
    if (m.__parse_error) { errors.push(`${where}: invalid JSON — ${m.__parse_error}`); continue; }
    errors.push(...validateManifest(m, where));
  }
  return { ok: errors.length === 0, planes: Object.keys(manifests).length, errors, manifests };
}
