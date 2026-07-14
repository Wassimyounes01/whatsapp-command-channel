'use strict';
// scripts/whatsapp/wa-daemon.cjs — persistent SINGLE-SOCKET WhatsApp bridge (Agent <-> owner). $0.
// Holds ONE Baileys connection and does BOTH directions:
//   - inbound from owner -> appends memory/whatsapp-inbox.jsonl
//   - drains memory/whatsapp-outbox.jsonl -> sends each queued {text}
// Run as a daemon (background). To send: append {text} to whatsapp-outbox.jsonl (or ping-owner.cjs --wa).
// Requires a one-time pairing first (connect.cjs). One socket only — never run send.cjs alongside this.
// Reliability: a GENTLE keep-alive presence-ping (30s) keeps the connection warm so it doesn't idle-half-die.
//   (An earlier aggressive zombie-force-close caused a reconnect STORM — removed. If the socket truly drops,
//    Baileys emits 'close' and we reconnect; the keep-alive prevents the idle death in the first place.)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');

const AUTH = path.join(__dirname, 'auth');
const MEM = path.join(__dirname, 'memory');
try { fs.mkdirSync(MEM, { recursive: true }); } catch {}
const INBOX = path.join(MEM, 'whatsapp-inbox.jsonl');
const OUTBOX = path.join(MEM, 'whatsapp-outbox.jsonl');
const SENTLOG = path.join(MEM, 'whatsapp-sent.jsonl');
const OWNER_NUM = (process.env.WA_TO || '').replace(/[^0-9]/g, '');
const OWNER_JID = OWNER_NUM + '@s.whatsapp.net';
// Your WhatsApp privacy identifier (LID), optional. Inbound is scoped to YOU ONLY — other
// contacts' DMs are never captured. If you don't set WA_LID, matching falls back to your number.
// (On WhatsApp's multi-device protocol a self-chat message can arrive tagged with your LID
//  instead of your phone number, so both are checked.)
const OWNER_LID = (process.env.WA_LID || '').replace(/[^0-9]/g, '');
function isFromOwner(jid) {
  const j = String(jid || '');
  return (OWNER_NUM && j.includes(OWNER_NUM)) || (OWNER_LID && j.includes(OWNER_LID));
}

function appendJsonl(f, o) { try { fs.appendFileSync(f, JSON.stringify(o) + '\n'); } catch {} }
function readJsonl(f) { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }

let sock = null, ready = false, draining = false;
// WhatsApp message ids that Agent ITSELF sent (self-chat echoes) — so a fromMe echo is never captured as an inbound
// message from owner. Ids are pre-generated before send (avoids the echo-arrives-first race) + the returned id is added too.
const selfSentWaIds = new Set();

async function drainOutbox() {
  if (!ready || draining || !sock) return;
  draining = true;
  try {
    const sentIds = new Set(readJsonl(SENTLOG).map(e => e.id).filter(Boolean));
    const pending = readJsonl(OUTBOX).filter(e => e && e.text && !(e.id && sentIds.has(e.id)));
    for (const e of pending) {
      try {
        const mid = crypto.randomBytes(16).toString('hex').toUpperCase();
        selfSentWaIds.add(mid);
        const sent = await sock.sendMessage(OWNER_JID, { text: String(e.text) }, { messageId: mid });
        if (sent && sent.key && sent.key.id) selfSentWaIds.add(sent.key.id);
        if (selfSentWaIds.size > 300) {
          const it = selfSentWaIds.values();
          for (let i = 0; i < 100; i++) { const v = it.next(); if (v.done) break; selfSentWaIds.delete(v.value); }
        }
        appendJsonl(SENTLOG, { id: e.id || null, ts: new Date().toISOString(), text: String(e.text).slice(0, 300) });
        console.log('WA OUT: ' + String(e.text).slice(0, 60));
      } catch (err) { console.error('send fail:', err.message); }
    }
    if (pending.length) { try { fs.writeFileSync(OUTBOX, ''); } catch {} } // drained (all logged in SENTLOG)
  } finally { draining = false; }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  if (!state.creds || !(state.creds.registered || (state.creds.me && state.creds.me.id))) { console.log('NOT PAIRED — run: node connect.cjs --pair=<your-number>'); process.exit(1); }
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: ['Agent', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    if (u.connection === 'open') { ready = true; console.log('WA DAEMON connected as ' + (state.creds && state.creds.me && state.creds.me.id)); drainOutbox(); }
    if (u.connection === 'close') {
      ready = false;
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) { console.log('LOGGED OUT — delete auth/ and re-pair.'); process.exit(1); }
      setTimeout(() => start().catch(e => console.error('reconnect:', e.message)), 3000);
    }
  });
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages || []) {
      try {
        if (!m || !m.key) continue;
        const jid = m.key.remoteJid || '';
        const jidAlt = m.key.remoteJidAlt || '';

        // Unwrap ephemeral / view-once containers (can nest, e.g. viewOnce inside ephemeral)
        let inner = m.message || {};
        for (let i = 0; i < 4; i++) {
          const wrap = inner.ephemeralMessage || inner.viewOnceMessage || inner.viewOnceMessageV2 || inner.viewOnceMessageV2Extension;
          if (wrap && wrap.message) inner = wrap.message;
          else break;
        }

        const text =
          inner.conversation ||
          (inner.extendedTextMessage && inner.extendedTextMessage.text) ||
          (inner.imageMessage && inner.imageMessage.caption) ||
          (inner.videoMessage && inner.videoMessage.caption) ||
          '';

        // Log EVERY message before any drop, so no drop is ever silent
        console.log('UPSERT type=' + type + ' jid=' + jid + (jidAlt ? ' alt=' + jidAlt : '') + ' fromMe=' + (m.key.fromMe ? 1 : 0) + ' hasText=' + (text ? 1 : 0));

        if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.startsWith('status@')) continue;
        // Scope to owner ONLY (by number OR LID, checking both remoteJid and remoteJidAlt for Baileys' LID/PN duality).
        const mine = isFromOwner(jid) || isFromOwner(jidAlt);
        if (!mine) { console.log('SKIP non-owner: ' + jid); continue; }
        // owner messages via self-chat (fromMe), so we do NOT blanket-skip fromMe — we only skip Agent's OWN echoes.
        if (m.key.fromMe && m.key.id && selfSentWaIds.has(m.key.id)) continue;

        const from = isFromOwner(jid) ? jid : jidAlt;

        // Media (screenshots/images/docs) from owner: download + save so Claude reads them natively (no OCR).
        // Fire-and-forget so the sync handler never blocks; logs the saved path (or a media_error) to the inbox.
        const mediaMsg = inner.imageMessage || inner.documentMessage;
        if (mediaMsg) {
          const mtype = inner.imageMessage ? 'image' : 'document';
          const ts0 = new Date().toISOString();
          (async () => {
            try {
              const buf = await downloadMediaMessage({ key: m.key, message: inner }, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
              const mime = mediaMsg.mimetype || '';
              const ext = mime.includes('png') ? 'png' : (mime.includes('jpeg') || mime.includes('jpg')) ? 'jpg' : mime.includes('pdf') ? 'pdf' : mtype === 'image' ? 'jpg' : 'bin';
              const dir = path.join(MEM, 'wa-inbox-media');
              fs.mkdirSync(dir, { recursive: true });
              const fpath = path.join(dir, ts0.replace(/[:.]/g, '-') + '.' + ext);
              fs.writeFileSync(fpath, buf);
              appendJsonl(INBOX, { ts: ts0, from, type: mtype, media_path: fpath, caption: String(text || '').slice(0, 2000) });
              console.log('WA IN media: ' + mtype + ' -> ' + fpath);
            } catch (err) {
              console.error('WA media dl error:', err.message);
              appendJsonl(INBOX, { ts: ts0, from, type: mtype, media_error: String(err.message || err).slice(0, 200), caption: String(text || '').slice(0, 2000) });
            }
          })();
          continue;
        }
        if (!text) continue;

        appendJsonl(INBOX, { ts: new Date().toISOString(), from, text: String(text).slice(0, 2000) });
        console.log('WA IN: ' + String(text).slice(0, 80));
      } catch (e) {
        console.error('WA upsert error:', e);
      }
    }
  });
}

setInterval(() => { drainOutbox().catch(() => {}); }, 5000);
// GENTLE keep-alive only: a presence ping every 30s keeps the WhatsApp Web connection warm (prevents the idle
// half-death). No zombie-force-close — that caused a reconnect storm. A genuine socket drop still fires 'close' -> reconnect.
setInterval(() => { try { if (ready && sock) sock.sendPresenceUpdate('available').catch(() => {}); } catch {} }, 30000);
start().catch(e => { console.error('daemon error:', e.message); process.exit(1); });
