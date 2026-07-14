'use strict';
// wa-watch.cjs — the CHEAP watcher. fs.watch on the inbox = event-driven, ZERO LLM, zero polling.
// The moment wa-daemon appends an inbound message, this fires and spawns wa-reply.cjs to generate
// the (high-quality, intelligently-routed) reply. Debounced so a burst of quick texts → one reply.
// Run 24/7 alongside wa-daemon (pm2). Watching costs nothing; only wa-reply spends a model.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MEM = path.join(__dirname, 'memory');
try { fs.mkdirSync(MEM, { recursive: true }); } catch {}
const INBOX = path.join(MEM, 'whatsapp-inbox.jsonl');
const REPLY = path.join(__dirname, 'wa-reply.cjs');

let timer = null;
function trigger() {
  if (timer) clearTimeout(timer);
  // 2.5s debounce: let a burst of quick messages settle, then reply to them together.
  timer = setTimeout(() => {
    timer = null;
    const child = spawn(process.execPath, [REPLY], { windowsHide: true, stdio: 'ignore', detached: false });
    child.on('error', e => console.error('wa-watch: spawn wa-reply failed:', e.message));
    console.log('[wa-watch] inbound detected -> wa-reply spawned @ ' + new Date().toISOString());
  }, 2500);
}

function ensureInbox() {
  try { if (!fs.existsSync(INBOX)) fs.writeFileSync(INBOX, ''); } catch {}
}

function startWatch() {
  ensureInbox();
  try {
    fs.watch(INBOX, { persistent: true }, (ev) => { if (ev === 'change' || ev === 'rename') trigger(); });
    console.log('[wa-watch] watching ' + INBOX + ' (event-driven, $0)');
  } catch (e) {
    // fs.watch can drop on some filesystems — fall back to a light 4s stat poll (still no LLM).
    console.error('[wa-watch] fs.watch failed (' + e.message + '), falling back to 4s stat poll');
    let lastSize = -1;
    setInterval(() => {
      try { const s = fs.statSync(INBOX).size; if (s !== lastSize) { lastSize = s; trigger(); } } catch {}
    }, 4000);
  }
}

// On boot, handle anything that arrived while the watcher was down (consistency).
trigger();
startWatch();
