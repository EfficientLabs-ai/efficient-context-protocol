/**
 * lease.js — ECP invariant 7: concurrency leases for shared-state planes.
 *
 * Two agent sessions working the same workspace race on shared state files.
 * A lease is advisory-but-checked: cheap to take, visible to every lane, and
 * health checks flag stale ones. Only planes whose manifest declares
 * write_policy "lease" accept leases (subdirectories inherit the policy).
 *
 * Expired leases are TAKEN OVER, never blocked on — a dead lane must not
 * deadlock the workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverManifests, planeOf } from './manifest.js';

export const DEFAULT_TTL_HOURS = 4;
const LEASE_FILE = '.lease.json';

const leasePath = (root, rel) => path.join(root, rel, LEASE_FILE);
const readLease = (root, rel) => {
  try { return JSON.parse(fs.readFileSync(leasePath(root, rel), 'utf8')); } catch { return null; }
};

export function takeLease(rel, holder, objective, opts = {}) {
  const root = opts.root || process.cwd();
  const manifests = opts.manifests || discoverManifests(root);
  const now = opts.now || Date.now();
  const ttlHours = opts.ttlHours || DEFAULT_TTL_HOURS;
  const plane = planeOf(rel, manifests);
  const m = plane != null ? manifests[plane] : null;
  if (!m) return { ok: false, why: `no manifest governs "${rel}"` };
  if (m.write_policy !== 'lease') return { ok: false, why: `plane "${plane}" is write_policy:${m.write_policy} — leases only apply to "lease" planes` };
  if (!holder || !objective) return { ok: false, why: 'holder and objective are required' };
  const existing = readLease(root, rel);
  if (existing && Date.parse(existing.expires_at) > now && existing.holder !== holder) {
    return { ok: false, why: `held by "${existing.holder}" (${existing.objective}) until ${existing.expires_at}`, existing };
  }
  const lease = {
    schema: 'ecp.lease/1', holder, objective,
    taken_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlHours * 36e5).toISOString(),
  };
  fs.mkdirSync(path.join(root, rel), { recursive: true });
  fs.writeFileSync(leasePath(root, rel), JSON.stringify(lease, null, 2) + '\n');
  return { ok: true, lease, renewed: !!existing };
}

export function releaseLease(rel, holder, opts = {}) {
  const root = opts.root || process.cwd();
  const existing = readLease(root, rel);
  if (!existing) return { ok: true, why: 'no lease to release' };
  if (existing.holder !== holder && !opts.force) {
    return { ok: false, why: `lease held by "${existing.holder}", not "${holder}"` };
  }
  fs.rmSync(leasePath(root, rel), { force: true });
  return { ok: true, released: existing };
}

/** Scan every lease-policy plane recursively; classify active/stale/corrupt. */
export function checkLeases(opts = {}) {
  const root = opts.root || process.cwd();
  const manifests = opts.manifests || discoverManifests(root);
  const now = opts.now || Date.now();
  const planes = Object.entries(manifests).filter(([, m]) => m.write_policy === 'lease').map(([p]) => p);
  const leases = [];
  for (const p of planes) {
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isFile() && e.name === LEASE_FILE) {
          const rel = path.relative(root, dir) || '.';
          const lease = readLease(root, rel);
          if (!lease) { leases.push({ scope: rel, state: 'corrupt' }); continue; }
          const stale = Date.parse(lease.expires_at) <= now;
          leases.push({ scope: rel, state: stale ? 'stale' : 'active', holder: lease.holder, objective: lease.objective, expires_at: lease.expires_at });
        } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name));
      }
    };
    walk(path.join(root, p === '.' ? '' : p));
  }
  return { schema: 'ecp.lease-check/1', planes_scanned: planes, leases, stale: leases.filter((l) => l.state !== 'active') };
}
