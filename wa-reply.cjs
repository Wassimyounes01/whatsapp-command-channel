'use strict';
/*
 * wa-reply.cjs — the default inbound handler.
 *
 * wa-watch fires this the instant a new message lands. By default it hands the
 * message to the command center, which routes it to Claude via your own `claude`
 * CLI login (a real agent with tools — no API key), or falls back to a $0
 * acknowledgement if the CLI isn't installed.
 *
 * Want different behaviour? Replace the call below with your own logic. The only
 * contract is: read new lines from memory/whatsapp-inbox.jsonl and append your
 * replies as {text} lines to memory/whatsapp-outbox.jsonl. The command center
 * already handles cursors, batching, and a stale-aware lock so you don't have to.
 */
const { runOnce } = require('./command-center.cjs');
runOnce();
