/**
 * readmodel.js — ECP layer 14: the visual read model.
 *
 * One render-ready JSON of the workspace's world-state so directories become
 * first-class OBJECTS a dashboard can draw. The UI consumes this JSON and
 * never walks the filesystem itself — this file is the contract.
 *
 * Generic core objects: plane (measured), lease, file (per declared object
 * planes). Workspaces extend by declaring `linked_objects` collectors in a
 * plane's manifest: any plane listing `"expose_files": true` gets its files
 * surfaced as objects with their first markdown heading as title.
 *
 * Edit-source rule: the output is generated — fix this module, never the JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverManifests } from './manifest.js';
import { checkLeases } from './lease.js';

const tok = (bytes) => Math.ceil(bytes / 4);

function measurePlane(dir, maxDepth = 3) {
  let files = 0, bytes = 0;
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else { files++; try { bytes += fs.statSync(p).size; } catch { /* */ } }
    }
  };
  walk(dir, 0);
  return { files, approx_tokens: tok(bytes) };
}

const firstHeading = (f) => {
  try { return (fs.readFileSync(f, 'utf8').match(/^#\s*(.+)$/m) || [])[1]?.trim() || null; } catch { return null; }
};

export function buildReadModel(opts = {}) {
  const root = opts.root || process.cwd();
  const manifests = opts.manifests || discoverManifests(root);
  const objects = [];

  for (const [plane, m] of Object.entries(manifests)) {
    if (m.__parse_error) continue;
    objects.push({
      type: 'plane', id: m.id, path: plane, purpose: m.purpose, owner: m.owner,
      load_priority: m.load_priority, write_policy: m.write_policy, token_budget: m.token_budget,
      ...measurePlane(path.join(root, plane === '.' ? '' : plane)),
    });
    if (m.expose_files) {
      let entries = [];
      try { entries = fs.readdirSync(path.join(root, plane)); } catch { /* */ }
      for (const f of entries) {
        if (f.startsWith('.') || f === 'CONTEXT.manifest.json') continue;
        objects.push({ type: 'file', id: `${plane}/${f}`, plane: m.id, title: f.endsWith('.md') ? firstHeading(path.join(root, plane, f)) : null });
      }
    }
  }

  const lc = opts.leases || checkLeases({ root, manifests });
  for (const l of lc.leases) objects.push({ type: 'lease', id: l.scope, ...l });

  const counts = {};
  for (const o of objects) counts[o.type] = (counts[o.type] || 0) + 1;
  return {
    schema: 'ecp.read-model/1',
    generated_at: new Date().toISOString(),
    summary: { counts, stale_leases: lc.stale.length },
    objects,
  };
}
