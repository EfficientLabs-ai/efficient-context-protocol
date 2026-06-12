# ECP — protocol specification (ecp/1)

ECP structures an agent workspace as fifteen conceptual layers. A conforming
workspace implements the **mechanical layers** (3, 6, 10, 14 and the lease
discipline of invariant 7) with the schemas below; the rest are conventions
that any tooling may build on. This reference implementation covers the
mechanical layers.

## Layers

| # | layer | what it holds | typical carrier |
|---|---|---|---|
| 1 | Identity | who the agent is, global limits | a root instruction file, boot injection |
| 2 | Routing | where to start, what's next | a state/resume file chain |
| 3 | **Stage Contract** | per-plane I/O rules, machine-readable | `CONTEXT.manifest.json` |
| 4 | Reference | stable doctrine, cache-safe | a docs/doctrine plane (`load_priority: cached`) |
| 5 | Working Artifact | mutable run-specific files | a work/status plane (`load_priority: task`) |
| 6 | **Ledger** | compaction-resistant session state | `.ecp/session-ledger.json` |
| 7 | Relational Memory | calibration and feedback across sessions | per-agent memory files |
| 8 | Semantic Substrate | indexes/graphs over the corpus | optional; add when retrieval misses are measured |
| 9 | Object Registry | named capabilities/objects with governance | a registry file with allow/deny semantics |
| 10 | **Context Compiler** | plan → materialized packet | `ecp compile` output |
| 11 | Evaluation | deterministic gates (tests, lint, budgets) | CI scripts, validators |
| 12 | Receipt / Proof | tamper-evident run evidence | append-only logs, signatures |
| 13 | World-State | current measured status | generated status files |
| 14 | **Visual Read Model** | render-ready world-state | `ecp read-model` output |
| 15 | Runtime Economics | budgets, session bounds, routing | policy files + telemetry |

## Invariants

1. **Manifests are for tools, never auto-loaded.** Zero token cost at runtime.
2. **Plan, then materialize.** Large model calls consume compiled packets, not
   ad-hoc reads. The cacheable prefix is byte-stable: no timestamps, no status,
   no bodies — pointers and rules only.
3. **Edit-source.** Fix generators and contracts, never their outputs.
4. **Compaction never owns state.** The ledger is written before any
   summarizer runs and re-injected after.
5. **Docs over outputs.** Reference material is the source of truth for *how*;
   prior outputs are never the template.
6. **Disclosure is fail-closed at the compiler.** Packets are scanned for
   secret shapes before emission.
7. **Write where the manifest says.** `open` / `lease` / `gated` per plane;
   stale leases are flagged, expired leases are taken over.
8. **Economics gate growth.** New substrate (indexes, dashboards) ships when a
   measured failure or a real consumer demands it, not speculatively.

## Schemas

### `ecp/1` — CONTEXT.manifest.json

Required: `schema` ("ecp/1") · `id` · `purpose` · `owner` · `lifecycle` ·
`load_priority` (`boot|cached|task|pointer|never`) · `token_budget` (number ≥ 0,
per-file clip applied by the compiler) · `read_policy` (`open|logged|gated`) ·
`write_policy` (`open|lease|gated`).

Optional: `allowed_agents` · `allowed_models` · `linked_objects` ·
`linked_skills` · `linked_receipts` · `verification_rules` · `promotion_rules` ·
`expose_files` (bool; surfaces the plane's files in the read model).

Governance invariants enforced by `ecp validate`:
- a `write_policy: "gated"` plane must name a human `owner` (not "system");
- enum fields must hold legal values;
- invalid JSON is an error, not a skip.

Plane resolution: the **deepest** manifest-bearing ancestor of a path governs
it. A root manifest (`.`) acts as the default for otherwise-ungoverned paths.

### `ecp.lease/1` — .lease.json

`schema` · `holder` · `objective` · `taken_at` · `expires_at` (ISO 8601).
Semantics: conflicting take refused while unexpired; same-holder take renews;
expired lease is taken over; release requires the holder (or explicit force,
which is an operator action).

### `ecp.read-model/1`

`{ schema, generated_at, summary: { counts, stale_leases }, objects: [...] }`
with object types `plane` (manifest fields + measured `files`,
`approx_tokens`), `file` (for `expose_files` planes; `title` = first markdown
heading), `lease` (scope, state `active|stale|corrupt`, holder, objective,
expiry). Implementations may add object types; consumers must ignore unknown
types.

### Ledger entry

`{ session_id, captured_at, compactions, files_written[], commands_errored[]
({command, error}), other_errors[], last_user_ask }` — rolling window (default
5 sessions), secret shapes redacted at write time. The injected block is
markdown headed `## SESSION LEDGER (ecp/1 …)` and instructs the model to trust
it over the compaction summary on conflict.

### Compiled packet

Directory of three files: `cacheable_prefix.md` (byte-stable),
`task_packet.md` (dynamic; slices clipped at plane `token_budget`),
`pointers.json` (`{pointer_only[], spent_tokens, budget_tokens}`).
Refusal conditions: content ref into a `pointer`/`never` plane · spent >
budget without `intent.justification` · disclosure-scan hit in either emitted
file.

## Token accounting

All token figures in this implementation are **bytes ÷ 4** — a deliberate,
cheap approximation that is consistent across measurements and therefore valid
for ratios and budgets. If you need exact provider tokenization, swap the
`tokens()` function; the protocol does not depend on the estimator.

## Versioning

Schemas carry their version in-band (`ecp/1`, `ecp.lease/1`, …). Breaking
changes bump the schema string; tools must refuse schemas they don't know
rather than guess.
