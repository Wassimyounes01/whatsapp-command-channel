'use strict';
// wa-watchdog.cjs — keeps the WhatsApp bridge (Agent <-> owner) alive 24/7.
//
// The daemon holds a single WhatsApp socket. Three things can silently break it and NOT self-heal:
//   1. the daemon process dies mid-session,
//   2. the process is alive but the event loop stalled (a stale heartbeat),
//   3. two daemons stacked (double-launch) and fight over the one socket,
//   4. the socket silently dropped — process + loop alive, but no messages flow ("works 1 min then dead sync").
// This reads the daemon's heartbeat beacon and, if the bridge is dead / stale / stacked / socket-down, kills any
// stragglers and relaunches exactly ONE daemon.
//
// It adds NO extra always-on process: wa-watch (already running 24/7) imports superviseOnce() and calls it on an
// interval, so supervision rides on the watcher you already run. Run standalone (node wa-watchdog.cjs) for a
// one-shot manual check. It never sends a WhatsApp message and never touches auth — purely process supervision.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HERE = __dirname;
const MEM = path.join(HERE, 'memory');
try { fs.mkdirSync(MEM, { recursive: true }); } catch {}
const DAEMON = path.join(HERE, 'wa-daemon.cjs');
const WATCH = path.join(HERE, 'wa-watch.cjs');
const HEARTBEAT = path.join(MEM, 'wa-daemon-heartbeat.json');
const STATUS = path.join(MEM, 'wa-watchdog-status.json');
const STALE_MS = 90 * 1000;       // beacon older than this => process dead or event loop stalled
const DISCONNECT_MS = 150 * 1000; // socket down (not connected) longer than this => restart for a fresh socket
const IS_WIN = process.platform === 'win32';

function log(msg) { console.log('[wa-watchdog] ' + msg); }

// List PIDs of node processes whose command line contains `needle`, cross-platform.
// Excludes THIS process so a watcher never counts/kills itself.
function listPids(needle) {
  try {
    let pids = [];
    if (IS_WIN) {
      const ps =
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        "Where-Object { $_.CommandLine -match '" + needle + "' } | " +
        'Select-Object -ExpandProperty ProcessId';
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
      pids = out.split(/\r?\n/).map(s => parseInt(s.trim(), 10));
    } else {
      // ps lists "<pid> <full command>"; match the needle in the command, node processes only.
      const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 30000 });
      pids = out.split(/\r?\n/)
        .filter(l => /node/.test(l) && new RegExp(needle).test(l))
        .map(l => parseInt(l.trim().split(/\s+/)[0], 10));
    }
    return pids.filter(n => Number.isInteger(n) && n !== process.pid);
  } catch {
    return [];
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function kill(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
  // Give it a beat, then hard-kill if still up (best effort).
  try { if (alive(pid)) process.kill(pid, 'SIGKILL'); } catch {}
}

function launchDetached(script) {
  const child = spawn(process.execPath, [script], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: HERE,
  });
  child.unref();
  return child.pid;
}

function readHeartbeat() {
  try { return JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8')); } catch { return null; }
}

function writeStatus(o) {
  try { fs.writeFileSync(STATUS, JSON.stringify({ ts: new Date().toISOString(), ...o }, null, 2)); } catch {}
}

// opts.manageWatch (default true): also trim/relaunch watchers. When wa-watch itself calls this it
// passes false — a watcher should not manage its own kind (it could kill itself in a race).
function superviseOnce(opts = {}) {
  const manageWatch = opts.manageWatch !== false;
  const daemonPids = listPids('wa-daemon');
  const hb = readHeartbeat();
  const hbAgeMs = hb && hb.ts ? (Date.now() - new Date(hb.ts).getTime()) : Infinity;
  const beaconFresh = Number.isFinite(hbAgeMs) && hbAgeMs < STALE_MS;
  const hbPidAlive = !!(hb && hb.pid && alive(hb.pid));
  const stacked = daemonPids.length > 1;

  // Socket liveness: a beacon can be "fresh" (process + loop alive) while the WhatsApp socket is DOWN —
  // that's the "works 1 min then dead sync" failure. `connected` is the live state; `last_connected_ts`
  // advances only while open; `started_at` gives a fresh daemon a grace window to make its FIRST connect.
  const nowConnected = !!(hb && hb.connected);
  const lastConnMs = (hb && hb.last_connected_ts) ? (Date.now() - new Date(hb.last_connected_ts).getTime()) : Infinity;
  const startedMs = (hb && hb.started_at) ? (Date.now() - new Date(hb.started_at).getTime()) : Infinity;
  const socketOk = nowConnected || lastConnMs < DISCONNECT_MS || startedMs < DISCONNECT_MS;

  // Healthy = fresh beacon from a live pid, NOT stacked, AND the socket is up (or acceptably reconnecting).
  // heartbeat + pid-liveness is authoritative for "process alive" (listPids can transiently return [] — never
  // false-restart on that); listPids is trusted only to DETECT stacking (>1).
  const daemonHealthy = beaconFresh && hbPidAlive && !stacked && socketOk;

  const actions = [];
  if (!daemonHealthy) {
    // Kill everything and start clean — covers dead (0 pids), stalled (stale beacon), stacked (>1 pid), socket-down.
    for (const pid of daemonPids) { kill(pid); actions.push('killed daemon ' + pid); }
    const newPid = launchDetached(DAEMON);
    actions.push('launched daemon ' + newPid);
    const why = !beaconFresh ? 'stale-beacon' : !hbPidAlive ? 'dead-pid' : stacked ? 'stacked' : !socketOk ? 'socket-down' : 'unknown';
    log(`daemon UNHEALTHY [${why}] (pids=[${daemonPids}] beaconAge=${Math.round(hbAgeMs / 1000)}s connected=${nowConnected} lastConn=${Number.isFinite(lastConnMs) ? Math.round(lastConnMs / 1000) + 's' : 'never'}) -> restarted`);
  } else {
    log(`daemon healthy (pid=${daemonPids[0]} beaconAge=${Math.round(hbAgeMs / 1000)}s connected=${nowConnected})`);
  }

  // Ensure exactly one watcher (standalone/manual path only — a watcher never manages watchers).
  let watchPids = listPids('wa-watch');
  if (manageWatch) {
    if (watchPids.length === 0) {
      const wp = launchDetached(WATCH);
      actions.push('launched watch ' + wp);
      log('watcher missing -> launched ' + wp);
    } else if (watchPids.length > 1) {
      for (const pid of watchPids.slice(1)) { kill(pid); actions.push('killed extra watch ' + pid); }
    }
  }

  writeStatus({
    daemon_healthy: daemonHealthy,
    daemon_pids: daemonPids,
    watch_pids: watchPids,
    beacon_age_s: Number.isFinite(hbAgeMs) ? Math.round(hbAgeMs / 1000) : null,
    beacon_connected: hb ? !!hb.connected : null,
    socket_ok: socketOk,
    last_connected_s: Number.isFinite(lastConnMs) ? Math.round(lastConnMs / 1000) : null,
    actions,
  });
  return { daemonHealthy, actions };
}

module.exports = { superviseOnce };

// Standalone one-shot check: node wa-watchdog.cjs
if (require.main === module) superviseOnce();
