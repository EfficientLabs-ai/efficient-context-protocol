/**
 * ledger.js — ECP layer 6: compaction never owns state.
 *
 * Agent harnesses compact long conversations by model-driven summarization,
 * which routinely drops parameter-level facts: exact file paths, error
 * strings, rejected approaches. The ledger extracts those DETERMINISTICALLY
 * from the transcript before compaction and re-injects them after.
 *
 * Core is harness-agnostic: `extract()` parses a JSONL transcript stream of
 * {type, message:{content}} entries (the de-facto shape used by Claude Code
 * and compatible harnesses; adapt the parser for others). `capture`/`inject`
 * are the hook entrypoints — see docs/SPEC.md §ledger for wiring examples.
 *
 * FAIL-OPEN by contract: a broken ledger must never block a session.
 * Everything stored passes shape-redaction; no secret values are written.
 */
import fs from 'node:fs';
import path from 'node:path';

export const KEEP_SESSIONS = 5;

export const redact = (s) => String(s)
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-key-block]')
  .replace(/\b(sk|ghp|gho|xoxb|xoxp|xoxa)[-_][A-Za-z0-9_-]{12,}/g, '[redacted-token]')
  .replace(/\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]');

const clip = (s, n) => {
  s = redact(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** Deterministically extract the working set from a JSONL transcript. */
export function extract(transcriptText) {
  const files = new Set(), erroredCmds = [], errors = [];
  let lastUserAsk = '';
  const cmdById = new Map();
  for (const line of transcriptText.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (e.type === 'user' && typeof content === 'string' && content.trim()
        && !content.startsWith('<') && !content.startsWith('This session is being continued')) {
      lastUserAsk = clip(content, 300);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use') {
        const inp = c.input || {};
        if (inp.file_path && /Edit|Write/.test(c.name || '')) files.add(inp.file_path);
        if (inp.command) cmdById.set(c.id, inp.command);
      }
      if (c.type === 'tool_result' && c.is_error) {
        const txt = typeof c.content === 'string' ? c.content
          : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : '';
        const cmd = cmdById.get(c.tool_use_id);
        if (cmd) erroredCmds.push({ command: clip(cmd, 160), error: clip(txt, 200) });
        else if (txt) errors.push(clip(txt, 200));
      }
      if (e.type === 'user' && c.type === 'text' && c.text && !c.text.startsWith('<')) lastUserAsk = clip(c.text, 300);
    }
  }
  return {
    files_written: [...files].slice(-40),
    commands_errored: erroredCmds.slice(-15),
    other_errors: errors.slice(-10),
    last_user_ask: lastUserAsk,
  };
}

const loadLedger = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
};

/** Pre-compaction hook: extract from the transcript and persist. */
export function capture({ session_id = 'unknown', transcript_path }, ledgerFile) {
  if (!transcript_path || !fs.existsSync(transcript_path)) return null;
  const prior = loadLedger(ledgerFile).find((x) => x.session_id === session_id);
  const entry = {
    session_id,
    captured_at: new Date().toISOString(),
    compactions: prior ? (prior.compactions || 1) + 1 : 1,
    ...extract(fs.readFileSync(transcript_path, 'utf8')),
  };
  const ledger = loadLedger(ledgerFile).filter((x) => x.session_id !== session_id);
  ledger.push(entry);
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger.slice(-KEEP_SESSIONS), null, 2) + '\n');
  return entry;
}

/** Post-compaction hook: render this session's entry for re-injection. */
export function inject({ session_id, source }, ledgerFile) {
  if (source !== 'compact') return null;
  const ledger = loadLedger(ledgerFile);
  const entry = ledger.find((x) => x.session_id === session_id) || ledger.at(-1);
  if (!entry) return null;
  return [
    '## SESSION LEDGER (ecp/1 — deterministic state preserved across compaction; trust over the summary on conflict)',
    entry.files_written.length ? `files written this session: ${entry.files_written.join(' · ')}` : '',
    ...entry.commands_errored.map((c) => `errored: \`${c.command}\` → ${c.error}`),
    ...entry.other_errors.map((e) => `error seen: ${e}`),
    entry.last_user_ask ? `last user ask (verbatim, clipped): ${entry.last_user_ask}` : '',
    `(compaction #${entry.compactions} of this session)`,
  ].filter(Boolean).join('\n');
}
