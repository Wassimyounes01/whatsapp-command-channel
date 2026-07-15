'use strict';
/*
 * command-center.cjs — the reply handler that turns your WhatsApp into a
 * remote control for Claude.
 *
 * A file watcher spawns this whenever a new inbound message lands. It reads
 * your new WhatsApp messages, hands them to Claude, and queues Claude's answer
 * back to you over WhatsApp.
 *
 * TWO MODES, auto-detected (override with env CC_MODE = 'cli' | 'ack'):
 *   cli — the `claude` CLI is on PATH. Claude runs as a REAL AGENT with tools,
 *         using YOUR own Claude login. No API key, nothing metered here — the
 *         exact same Claude you already use at the terminal. This is the point
 *         of the project: text a request, Claude actually does the work.
 *   ack — no CLI installed. A $0 fallback that just acknowledges receipt so the
 *         loop stays verifiable and you're never left without a reply.
 *
 * No API keys. No third-party services. No external npm deps — Node builtins
 * only. Bring your own Claude auth (the `claude` CLI login); the bridge is $0.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── Paths (all local, inside ./memory) ──────────────────────────────────────
const MEM = path.join(__dirname, 'memory');
const INBOX = path.join(MEM, 'whatsapp-inbox.jsonl');   // {ts, from, text} per line — read only
const OUTBOX = path.join(MEM, 'whatsapp-outbox.jsonl'); // {text} per line — the daemon sends these
const CURSOR = path.join(MEM, 'cc-cursor.json');        // {handledTs} so we never reply twice
const LOCK = path.join(MEM, 'cc.lock');                 // stale-aware, stops double-spawns
const SESSION = path.join(MEM, 'cc-session.json');      // {sessionId} for Claude CLI continuity

const LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 240000;

function ensureMem() { try { fs.mkdirSync(MEM, { recursive: true }); } catch { /* exists */ } }

// ── Atomic JSON write (write .tmp then rename) ───────────────────────────────
function writeJson(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch { /* best-effort */ }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ── Stale-aware lock ─────────────────────────────────────────────────────────
function acquireLock() {
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return false; // fresh lock held
  } catch { /* no lock file — free to take it */ }
  try { fs.writeFileSync(LOCK, String(process.pid)); return true; } catch { return false; }
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch { /* already gone */ } }

// ── Inbox / outbox ───────────────────────────────────────────────────────────
function readNewMessages(sinceTs) {
  let raw = '';
  try { raw = fs.readFileSync(INBOX, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const m = JSON.parse(s);
      if (m && m.ts && (!sinceTs || m.ts > sinceTs) && (m.text || m.caption)) out.push(m);
    } catch { /* skip malformed line */ }
  }
  return out;
}
function queueReply(text) {
  ensureMem();
  try { fs.appendFileSync(OUTBOX, JSON.stringify({ text: String(text || '').trim() }) + '\n'); } catch { /* best-effort */ }
}

// ── Mode detection ───────────────────────────────────────────────────────────
function claudeBin() { return process.env.CLAUDE_BIN || 'claude'; }

function hasClaudeCli() {
  try {
    const r = spawnSync(claudeBin(), ['--version'], { stdio: 'ignore', timeout: 8000, shell: process.platform === 'win32' });
    return r.status === 0;
  } catch { return false; }
}

function detectMode() {
  const forced = (process.env.CC_MODE || '').trim().toLowerCase();
  if (forced === 'cli' || forced === 'ack') return forced;
  return hasClaudeCli() ? 'cli' : 'ack';
}

// ── cli mode — run the real Claude agent with your own login ─────────────────
function routeToClaude(prompt) {
  const bin = claudeBin();
  const sess = readJson(SESSION, {});
  const args = ['-p', prompt, '--output-format', 'text'];

  // Conversation continuity: resume the same session across messages.
  if (sess.sessionId) args.push('--resume', sess.sessionId);

  // Opt-in, trusted-machine-only: skip tool permission prompts.
  if (process.env.CC_YOLO === '1') args.push('--dangerously-skip-permissions');

  // Optional extra system-prompt text.
  if (process.env.CC_SYSTEM) args.push('--append-system-prompt', process.env.CC_SYSTEM);

  const timeout = parseInt(process.env.CC_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
  const cwd = process.env.CC_WORKDIR || process.cwd();

  const r = spawnSync(bin, args, {
    cwd, timeout, encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32',
  });

  const stdout = (r.stdout || '').trim();
  if (r.status === 0 && stdout) {
    // Persist a session id if we didn't have one, so the next message continues the thread.
    if (!sess.sessionId) {
      const id = (process.env.CC_SESSION_ID || '').trim();
      if (id) writeJson(SESSION, { sessionId: id });
    }
    return stdout;
  }
  const err = (r.stderr || '').trim();
  return stdout || (err ? `⚠️ Claude CLI error: ${err.slice(0, 300)}` : '⚠️ Claude CLI returned nothing.');
}

// ── Main ─────────────────────────────────────────────────────────────────────
function runOnce() {
  ensureMem();
  if (!acquireLock()) return; // another spawn is handling it

  try {
    const cur = readJson(CURSOR, {});
    const msgs = readNewMessages(cur.handledTs);
    if (!msgs.length) { releaseLock(); return; }

    // Join a debounce-window batch into one prompt so the reply addresses all of it.
    const prompt = msgs.map(m => m.text || m.caption).filter(Boolean).join('\n');
    const newestTs = msgs[msgs.length - 1].ts;

    const mode = detectMode();
    let reply;
    if (mode === 'cli') {
      reply = routeToClaude(prompt);
    } else {
      const first = prompt.slice(0, 60);
      reply = `✓ received: ${first}${prompt.length > 60 ? '…' : ''} (no Claude backend — install the \`claude\` CLI and log in to enable the full agent)`;
    }

    queueReply(reply);
    writeJson(CURSOR, { handledTs: newestTs });
    console.log(`[command-center] mode=${mode} replied ${String(reply).length} chars`);
  } catch (e) {
    // Fail open: still let the owner know the channel is alive.
    console.error('[command-center] error:', e && e.message);
    queueReply('⚠️ command center hit an error but is still running.');
  } finally {
    releaseLock();
  }
}

module.exports = { runOnce, detectMode, routeToClaude };

if (require.main === module) runOnce();
