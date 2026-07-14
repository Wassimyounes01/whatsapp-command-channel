'use strict';
// scripts/whatsapp/connect.cjs — one-time PAIRING + keep-alive for the $0 Baileys WhatsApp bridge (Agent <-> owner).
// Run: node scripts/whatsapp/connect.cjs [--pair=15551234567]
// It prints a PAIRING CODE. On the phone: WhatsApp -> Settings -> Linked Devices -> Link a Device ->
// "Link with phone number instead" -> type the code. Once "WA CONNECTED", creds persist in ./auth (send.cjs reuses them).
const path = require('path');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');

const AUTH = path.join(__dirname, 'auth');
const PAIR_ARG = (process.argv.find(a => a.startsWith('--pair=')) || '').slice(7);
const PAIR_NUMBER = PAIR_ARG ? PAIR_ARG.replace(/[^0-9]/g, '') : ''; // no --pair => QR mode (scan, more reliable)

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: ['Agent', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered && PAIR_NUMBER) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIR_NUMBER);
        const pretty = code && code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
        console.log('\n=============== WHATSAPP PAIRING CODE ===============');
        console.log('   >>>  ' + pretty + '  <<<');
        console.log('   Phone: WhatsApp > Settings > Linked Devices > Link a Device');
        console.log('   > "Link with phone number instead" > enter the code above.');
        console.log('====================================================\n');
      } catch (e) { console.error('pairing code error:', e.message); }
    }, 3000);
  } else if (sock.authState.creds.registered) {
    console.log('already paired — creds present in ./auth');
  }

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      try {
        const out = path.join(__dirname, 'wa-qr.png');
        await require('qrcode').toFile(out, qr, { width: 420, margin: 2 });
        console.log('QR_SAVED: ' + out);
        try { require('child_process').spawn('cmd', ['/c', 'start', '', out], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
      } catch (e) { console.error('qr png error:', e.message); }
    }
    if (connection === 'open') console.log('WA CONNECTED — creds saved. Safe to Ctrl-C; send.cjs reconnects using ./auth.');
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      console.log('WA connection closed (' + code + ')');
      if (code === DisconnectReason.loggedOut) { console.log('LOGGED OUT — delete ./auth and re-pair.'); process.exit(1); }
      setTimeout(() => start().catch(e => console.error('reconnect error:', e.message)), 3000);
    }
  });
}
start().catch(e => { console.error('connect error:', e.message); process.exit(1); });
