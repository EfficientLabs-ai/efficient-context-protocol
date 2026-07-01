#!/usr/bin/env node
/**
 * preflight-node.js — validate the running Node against package.json engines.node.
 *
 * The engines range (">=X.Y.Z <N" shape) is the authority; .nvmrc is the
 * RECOMMENDED version surfaced in help text, not a hard equality gate.
 * Zero-dependency by design: the tiny range check below covers the
 * space-separated comparator shapes npm engines uses here.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) throw new Error(`unparseable version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a, b) {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** Space-separated comparators, e.g. ">=22.22.3 <23"; every clause must hold. */
export function satisfiesEngines(version, range) {
  return String(range).trim().split(/\s+/).every((clause) => {
    const m = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(clause);
    if (!m) throw new Error(`unsupported engines clause: ${clause}`);
    const op = m[1] || '=';
    // Partial bounds fill with zeros: "<23" means "<23.0.0".
    const bound = `${m[2]}.${m[3] || 0}.${m[4] || 0}`;
    const cmp = compareVersions(version, bound);
    if (op === '>=') return cmp >= 0;
    if (op === '<=') return cmp <= 0;
    if (op === '>') return cmp > 0;
    if (op === '<') return cmp < 0;
    return cmp === 0;
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const range = pkg.engines && pkg.engines.node;
  const recommended = fs.readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
  const actual = process.version.replace(/^v/, '');

  if (!range) {
    console.error('package.json declares no engines.node range; cannot preflight.');
    process.exit(1);
  }
  if (!satisfiesEngines(actual, range)) {
    console.error(`ECP requires Node ${range}; current runtime is ${actual}.`);
    console.error(`Recommended version: ${recommended} (.nvmrc). Run: nvm use`);
    process.exit(1);
  }
  console.log(`Node runtime OK: ${actual} (engines "${range}", recommended ${recommended})`);
}
