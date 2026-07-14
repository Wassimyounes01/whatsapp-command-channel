'use strict';
// scripts/whatsapp/send.cjs "message" — send a WhatsApp message to owner using saved ./auth. $0.
// Requires a one-time pairing first (node scripts/whatsapp/connect.cjs). Short-lived: connect -> send -> exit.
const path = require('path');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const AUTH = path.join(__dirname, 'auth');
const TO = ((process.env.WA_TO || '15551234567').replace(/[^0-9]/g, '')) + '@s.whatsapp.net';

async function main() {
  const msg = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ').trim();
  if (!msg) { console.log('usage: node scripts/whatsapp/send.cjs "message"'); process.exit(0); }
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  if (!state.creds || !state.creds.registered) { console.log('NOT PAIRED — run: node scripts/whatsapp/connect.cjs'); process.exit(1); }
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: ['Agent', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);
  let sent = false;
  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'open' && !sent) {
      sent = true;
      try { await sock.sendMessage(TO, { text: msg }); console.log('WA SENT to ' + TO + ': ' + msg.slice(0, 80)); }
      catch (e) { console.error('WA send error:', e.message); }
      setTimeout(() => process.exit(0), 1500);
    }
    if (u.connection === 'close' && !sent) { console.error('WA closed before send'); process.exit(1); }
  });
  setTimeout(() => { if (!sent) { console.error('WA send timeout (30s)'); process.exit(1); } }, 30000);
}
main().catch(e => { console.error('send error:', e.message); process.exit(1); });
