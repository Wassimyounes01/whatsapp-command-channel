'use strict';
// wa-reply.cjs — THIS IS THE HANDLER YOU CUSTOMIZE.
// wa-watch fires it the moment a new message lands. It reads every message since the last
// handled cursor, then decides what to do: run a command, call your own logic, or hand the
// text to an LLM. Whatever you want to send back, queue with queueReply(text) and the daemon
// delivers it. A stale-aware lock prevents double-replies on rapid messages. Never throws.
//
// Out of the box it sends a simple acknowledgement so you can confirm the loop works end to
// end. Replace the queueReply(...) call below with your own command dispatch.
const fs = require('fs');
const path = require('path');

const MEM = path.join(__dirname, 'memory');
try { fs.mkdirSync(MEM, { recursive: true }); } catch {}
const INBOX = path.join(MEM, 'whatsapp-inbox.jsonl');
const OUTBOX = path.join(MEM, 'whatsapp-outbox.jsonl');
const CURSOR = path.join(MEM, 'wa-handled-cursor.json');
const LOCK = path.join(MEM, 'wa-reply.lock');

function readJsonl(f) {
  try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function lastHandledTs() {
  try { return JSON.parse(fs.readFileSync(CURSOR, 'utf8')).last_handled_ts || '1970-01-01T00:00:00.000Z'; }
  catch { return '1970-01-01T00:00:00.000Z'; }
}
function queueReply(text) {
  fs.appendFileSync(OUTBOX, JSON.stringify({ id: 'wa-reply-' + Date.now(), text: String(text) }) + '\n');
}

// Stale-lock aware (2 min): a crashed run never wedges the pipeline.
function acquireLock() {
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < 120000) return false;
    fs.unlinkSync(LOCK);
  } catch { /* no lock */ }
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch {} }

async function main() {
  if (!acquireLock()) return; // another wa-reply is already handling it
  try {
    const since = new Date(lastHandledTs()).getTime();
    const fresh = readJsonl(INBOX).filter(m => m && m.ts && new Date(m.ts).getTime() > since);
    if (!fresh.length) return;

    // Reply to the CONVERSATION, newest-first context: batch all fresh messages into one prompt
    // so several quick texts get ONE coherent reply (not N spammy ones).
    const latest = fresh[fresh.length - 1];
    const convo = fresh.map(m => m.text || m.caption || (m.media_path ? '[image: ' + path.basename(m.media_path) + ']' : '')).filter(Boolean).join('\n');
    if (!convo.trim()) { advance(latest.ts, 'no-text'); return; }

    // ── CUSTOMIZE HERE ──────────────────────────────────────────────────────────────────
    // `convo` holds every new message since the last handled cursor, newest last. Parse it as
    // a command, route it to your own code, or send it to an LLM — then queueReply(...) the
    // result. The default below just acknowledges receipt so you can verify the round-trip.
    void convo;
    queueReply('👀 Received. Wire up your own logic in wa-reply.cjs to act on this message.');
    advance(latest.ts, 'ack');
  } finally {
    releaseLock();
  }
}

function advance(ts, note) {
  try { fs.writeFileSync(CURSOR, JSON.stringify({ last_handled_ts: ts, note: 'wa-reply.cjs ' + note + ' @ ' + new Date().toISOString() })); } catch {}
}

main().catch(() => releaseLock());
