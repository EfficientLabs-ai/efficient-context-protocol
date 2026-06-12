# Efficient Context Protocol (ECP)

A vendor-neutral file architecture protocol for AI agents. ECP makes a plain
directory tree behave like infrastructure: **manifests** make it machine-readable,
a **compiler** makes it loadable, **leases** make it safe for concurrent agents,
**ledgers** make it survive context compaction, and a **read model** makes it
renderable. Plain markdown and JSON throughout — no database, no daemon, no
SDK lock-in.

## Why

Agent workspaces converge on the same failure modes:

1. **Ad-hoc context assembly.** Every session re-decides what to read, so cost
   and quality vary run to run, and nothing is prompt-cache-stable.
2. **Compaction amnesia.** Long sessions get summarized by the model itself,
   which reliably drops the exact things you need later: file paths, error
   strings, approaches already tried and rejected.
3. **State races.** Two agent sessions writing the same status files silently
   overwrite each other.
4. **Folders stay folders.** Nothing can render the workspace's state without
   walking the filesystem and guessing.

ECP addresses each with a small, testable mechanism. The protocol is described
in [docs/SPEC.md](docs/SPEC.md); this package is the reference implementation
(Node ≥ 18, zero dependencies).

## Quickstart

```sh
git clone <this repo> && cd efficient-context-protocol
npm test                 # 16 hermetic tests
npm run bench            # measured packet-vs-naive numbers

# explore the example workspace
node bin/ecp.js validate   --root examples/workspace
node bin/ecp.js compile    examples/workspace/work/intent.example.json --root examples/workspace --out /tmp/packet
node bin/ecp.js read-model --root examples/workspace
```

## The mechanisms

### 1. Context manifests (`CONTEXT.manifest.json`, schema `ecp/1`)

Any directory becomes a governed **plane** by carrying a manifest:

```json
{
  "schema": "ecp/1",
  "id": "doctrine",
  "purpose": "Stable rules and reference (cache-safe; bodies load on demand).",
  "owner": "maintainer",
  "lifecycle": "promoted",
  "load_priority": "cached",
  "token_budget": 2000,
  "read_policy": "open",
  "write_policy": "gated"
}
```

Manifests are read by **tools, never by models** — they cost zero context
tokens. `load_priority` (`boot|cached|task|pointer|never`) governs what may
enter a prompt; `write_policy` (`open|lease|gated`) governs who may change the
plane. `ecp validate` enforces the schema plus governance invariants (e.g. a
gated plane must name a human owner).

### 2. Context compiler (`ecp compile`)

Plan, then materialize. An intent (task + refs + budget) compiles into a
packet on disk:

- `cacheable_prefix.md` — byte-stable role, rules, and doctrine **pointers**
  (never bodies, never timestamps): identical bytes across runs, so prompt
  caching actually works.
- `task_packet.md` — the dynamic part: task, acceptance, and file slices
  clipped to each plane's `token_budget`.
- `pointers.json` — everything excluded, with reasons.

Compilation is **fail-closed**: refs into `pointer`/`never` planes, budget
overruns without a written justification, and disclosure-scan hits (secret
*shapes* — private-key blocks, token formats — never real values) refuse the
packet instead of emitting a bad one.

### 3. Concurrency leases (`ecp lease`)

Planes with `write_policy: "lease"` accept `.lease.json` claims
(holder, objective, TTL — default 4h). Conflicting takes are refused; expired
leases are **taken over, never blocked on** (a dead lane must not deadlock the
workspace); `ecp lease check` exits non-zero on stale leases so health checks
can flag them.

### 4. Compaction ledger (`ecp ledger`)

Before compaction, `capture` deterministically extracts the session's working
set from the transcript — files written, commands that errored (with the
error), the last user ask — into a rolling ledger (secret shapes redacted at
write time). After compaction, `inject` re-emits it into the fresh context.
Both entrypoints are **fail-open**: a broken ledger never blocks a session.

Example wiring for a harness with pre-compaction and session-start hooks
(shown for Claude Code; adapt the JSON to your harness):

```json
{
  "hooks": {
    "PreCompact":   [{ "matcher": "", "hooks": [{ "type": "command", "command": "ecp ledger capture || true" }] }],
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "ecp ledger inject  || true" }] }]
  }
}
```

### 5. Visual read model (`ecp read-model`)

One render-ready JSON (`ecp.read-model/1`) of the workspace's world-state:
every plane (with measured file counts and approximate token mass), every
lease, and — for planes that opt in with `"expose_files": true` — their files
as titled objects. A dashboard consumes this JSON and **never walks the
filesystem**; the read model is the contract.

## Measured benchmark

From `npm run bench` on `examples/workspace` (bytes ÷ 4; MEASURED, not
estimated):

```
naive full-workspace load : 611 tokens
compiled packet           : 240 tokens (105 cacheable prefix + 135 task)
ratio                     : 2.55×
```

The example is deliberately tiny. The naive load scales with the **corpus**;
the packet scales with the **task** — on real workspaces the gap is what you'd
expect from that asymmetry, and you should measure your own: point `bench.js`
at your tree.

## Design rules the protocol bakes in

- **Edit-source:** a wrong output is fixed in its generator or contract and
  re-run — never hot-patched.
- **Docs over outputs:** agents learn how to build from reference material,
  never from prior outputs.
- **Pointer planes never load as content** — retrieval is explicit and loggable.
- **Compaction never owns state** — anything a session must not lose is on
  disk before the summarizer runs.
- **Fail-closed for context, fail-open for hooks** — a bad packet is refused;
  a broken ledger never blocks a session.

## Status

v0.1.0 — reference implementation extracted from a production agent operating
layer where each mechanism runs daily (the ledger's round-trip is verified
against real compaction events). Schemas are versioned (`ecp/1`); breaking
changes bump the version.

MIT © Efficient Labs
