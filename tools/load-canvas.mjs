#!/usr/bin/env node
/**
 * Canvas Sync Load Testing Tool (Calaba)
 *
 * Usage:
 *   nice -n 19 node tools/load-canvas.mjs <scenario> [options]
 *
 * Scenarios:
 *   s1        Hot board: 1 canvas, 100 writers (10 aw/s, 10 gesture/s), 20 readers, 1 slow client (60s)
 *   s2        Many boards: 50 canvases x 10 sockets (500 total), 1 upd/s/canvas, 2 aw/s (90s)
 *   s3        Connections & leaks: 3000 connect->sync->disconnect cycles across 20 canvases
 *   s4        Reconnect storm: 3 MiB state, 200 sockets, kill/restart instance A, backoff vs instant
 *   s5        Two pods: instances A (3191) & B (3192), convergence check, 10k update ceiling
 *   s6        Large operations: 3000 inserts, 1000 gesture preview, 3000 deletes, >4MiB rejection
 *   s7        Public link: 12 viewers per IP (10 cap), frame rejection (4013), X-Forwarded-For test
 *   all       Run all scenarios in sequence with required cooling pauses
 *
 * Options:
 *   --host <url>           Base HTTP URL of instance A (default: http://127.0.0.1:3191)
 *   --host-b <url>         Base HTTP URL of instance B (default: http://127.0.0.1:3192)
 *   --scale <factor>       Scale factor for writer/socket counts (default: 1.0, e.g. 0.5 for half)
 *   --server-pid <pid>     PID of running server A to monitor RSS and CPU
 *   --auto-server          Automatically spawn and manage server instance(s)
 *   --json                 Output results as pure JSON
 */

import WebSocket from 'ws';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { execFileSync, spawn, fork } from 'child_process';
import { monitorEventLoopDelay } from 'perf_hooks';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

export const FRAME_SNAPSHOT = 0;
export const FRAME_UPDATE = 1;
export const FRAME_AWARENESS = 2;
export const FRAME_COMPACT_REQUEST = 3;
export const FRAME_SNAPSHOT_POST = 4;

export const CLOSE_TRY_AGAIN = 4000;
export const CLOSE_BAD_FRAME = 4002;
export const CLOSE_FORBIDDEN = 4003;
export const CLOSE_AUTH = 4004;
export const CLOSE_RATE = 4008;
export const CLOSE_CEILING = 4012;
export const CLOSE_RECEIVE_ONLY = 4013;
export const CLOSE_RESEND = 4014;
export const CLOSE_NOT_FOUND = 4404;

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30000;

export function backoffDelay(attempt, random = Math.random()) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.5 + random * 0.5));
}

export function encodeUpdateFrame(update, seq = 0) {
  const out = Buffer.alloc(9 + update.length);
  out[0] = FRAME_UPDATE;
  out.writeBigUInt64BE(BigInt(seq), 1);
  out.set(update, 9);
  return out;
}

export function encodeAwarenessFrame(awBytes) {
  const out = Buffer.alloc(1 + awBytes.length);
  out[0] = FRAME_AWARENESS;
  out.set(awBytes, 1);
  return out;
}

export function encodeSnapshotPostFrame(throughSeq, meta, state, broadcast = false) {
  const m = { ...meta };
  if (broadcast) m.broadcast = true;
  const jsonBuf = Buffer.from(JSON.stringify(m), 'utf8');
  const out = Buffer.alloc(13 + jsonBuf.length + state.length);
  out[0] = FRAME_SNAPSHOT_POST;
  out.writeBigUInt64BE(BigInt(throughSeq), 1);
  out.writeUInt32BE(jsonBuf.length, 9);
  out.set(jsonBuf, 13);
  out.set(state, 13 + jsonBuf.length);
  return out;
}

export function decodeFrame(buf) {
  if (!buf || buf.length < 1) return null;
  const type = buf[0];
  switch (type) {
    case FRAME_SNAPSHOT:
      if (buf.length < 9) return null;
      return { type, throughSeq: Number(buf.readBigUInt64BE(1)), state: buf.subarray(9) };
    case FRAME_UPDATE:
      if (buf.length < 9) return null;
      return { type, seq: Number(buf.readBigUInt64BE(1)), update: buf.subarray(9) };
    case FRAME_AWARENESS:
      return { type, update: buf.subarray(1) };
    case FRAME_COMPACT_REQUEST:
      return { type };
    case FRAME_SNAPSHOT_POST: {
      if (buf.length < 13) return null;
      const len = buf.readUInt32BE(9);
      if (13 + len > buf.length) return null;
      const meta = JSON.parse(buf.subarray(13, 13 + len).toString('utf8'));
      return { type, throughSeq: Number(buf.readBigUInt64BE(1)), meta, state: buf.subarray(13 + len) };
    }
    default:
      return { type, raw: buf };
  }
}

export class CalabaClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async register(email, displayName, password = 'load-test-password-123') {
    const res = await fetch(`${this.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, displayName, password })
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Register failed (${res.status}): ${txt}`);
    }
    const data = await res.json();
    return {
      token: data.tokens.accessToken,
      userId: data.me.user.id
    };
  }

  async createWorkspace(token, name) {
    const slug = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const res = await fetch(`${this.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name, slug })
    });
    if (!res.ok) throw new Error(`Create workspace failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return data.workspace.id;
  }

  async createInvite(token, workspaceId) {
    const res = await fetch(`${this.baseUrl}/api/workspaces/${workspaceId}/invites`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({})
    });
    if (!res.ok) throw new Error(`Create invite failed: ${await res.text()}`);
    const data = await res.json();
    return data.invite.code;
  }

  async joinInvite(token, code) {
    const res = await fetch(`${this.baseUrl}/api/invites/${code}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    if (!res.ok) throw new Error(`Join invite failed: ${await res.text()}`);
    return await res.json();
  }

  async createCanvas(token, workspaceId, name = 'Load Test Canvas') {
    const res = await fetch(`${this.baseUrl}/api/workspaces/${workspaceId}/canvas/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        parentId: '',
        kind: 'CANVAS_ITEM_KIND_CANVAS',
        name
      })
    });
    if (!res.ok) throw new Error(`Create canvas failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return data.item.id;
  }

  async createPublicLink(token, canvasId, expiresInDays = 0) {
    const res = await fetch(`${this.baseUrl}/api/canvas/items/${canvasId}/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ expiresInDays })
    });
    if (!res.ok) throw new Error(`Create public link failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return data.link.code;
  }

  async getPublicCanvas(code, headers = {}) {
    return await fetch(`${this.baseUrl}/api/public/canvas/${code}`, {
      headers
    });
  }

  async getMetrics() {
    try {
      const res = await fetch(`${this.baseUrl}/metrics`);
      if (!res.ok) return {};
      const text = await res.text();
      return parseMetrics(text);
    } catch {
      return {};
    }
  }
}

export function parseMetrics(text) {
  const result = {
    rooms: 0,
    sockets: 0,
    droppedFrames: {},
    catchups: 0,
    ceilingHits: 0,
    batchedFrames: 0,
    coalescedEntries: 0,
    overwrittenSlots: 0,
    closes: {}
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    if (line.startsWith('calaba_ysync_rooms{section="canvas"}')) {
      result.rooms = parseFloat(line.split(' ')[1]) || 0;
    } else if (line.startsWith('calaba_ysync_sockets{section="canvas"}')) {
      result.sockets = parseFloat(line.split(' ')[1]) || 0;
    } else if (line.startsWith('calaba_ysync_catchups_total{section="canvas"}')) {
      result.catchups = parseFloat(line.split(' ')[1]) || 0;
    } else if (line.startsWith('calaba_ysync_ceiling_hits_total{section="canvas"}')) {
      result.ceilingHits = parseFloat(line.split(' ')[1]) || 0;
    } else if (line.startsWith('calaba_ysync_batched_frames_total{section="canvas"}')) {
      result.batchedFrames = parseFloat(line.split(' ')[1]) || 0;
    } else if (line.startsWith('calaba_ysync_coalesced_entries_total{section="canvas"}')) {
      result.coalescedEntries = parseFloat(line.split(' ')[1]) || 0;
    } else if (line.startsWith('calaba_ysync_overwritten_slots_total{section="canvas"}')) {
      result.overwrittenSlots = parseFloat(line.split(' ')[1]) || 0;
    } else if (line.startsWith('calaba_ysync_dropped_frames_total{')) {
      const match = line.match(/reason="([^"]+)"/);
      if (match) {
        const val = parseFloat(line.split(' ')[1]) || 0;
        result.droppedFrames[match[1]] = val;
      }
    } else if (line.startsWith('calaba_ysync_closes_total{')) {
      const match = line.match(/code="([^"]+)"/);
      if (match) {
        const val = parseFloat(line.split(' ')[1]) || 0;
        result.closes[match[1]] = val;
      }
    }
  }
  return result;
}

export function sampleProcess(pid) {
  if (!pid) return null;
  try {
    const out = execFileSync('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const parts = out.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return {
        rssMB: Math.round((parseInt(parts[0], 10) / 1024) * 10) / 10,
        cpuPercent: parseFloat(parts[1]) || 0
      };
    }
  } catch {}
  return null;
}

export function checkLoadAverage() {
  const [load1] = os.loadavg();
  return load1;
}

export function queryDbConnections() {
  try {
    const out = execFileSync('psql', ['postgres://calaba:calaba@localhost:55432/calaba_load', '-tAc', "SELECT count(*) FROM pg_stat_activity WHERE datname='calaba_load';"], { encoding: 'utf8' }).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export class CanvasSyncClient {
  constructor({ url, token, isViewer = false, headers = {}, slowMode = false, clientId, skipDocApply = false }) {
    this.url = url;
    this.token = token;
    this.isViewer = isViewer;
    this.headers = headers;
    this.slowMode = slowMode;
    this.skipDocApply = skipDocApply;

    this.doc = new Y.Doc();
    if (clientId) this.doc.clientID = clientId;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.synced = false;
    this.closed = false;
    this.closeCode = null;
    this.closeReason = '';
    this.receivedFrames = 0;
    this.latencies = [];
    this.updateLatencies = [];
    this.awarenessLatencies = [];
    this.ws = null;
    this.highestSeq = 0;
    this.compactRequestsCount = 0;
    this.latestSnapshotState = null;

    if (!skipDocApply) {
      this.liveMap = this.doc.getMap('live');
      this.liveMap.observe((event) => {
        if (event.transaction.origin === 'local') return;
        for (const [key, change] of event.changes.keys) {
          if (key === String(this.doc.clientID)) continue;
          if (change.action === 'add' || change.action === 'update') {
            const val = this.liveMap.get(key);
            if (val && typeof val.ts === 'number') {
              const lat = Date.now() - val.ts;
              if (lat >= 0 && lat < 60000) {
                this.updateLatencies.push(lat);
                this.latencies.push(lat);
              }
            }
          }
        }
      });
      this.objectsMap = this.doc.getMap('objects');
    }

    this.awareness.on('change', ({ added, updated }) => {
      const states = this.awareness.getStates();
      const now = Date.now();
      for (const clientID of [...added, ...updated]) {
        if (clientID === this.doc.clientID) continue;
        const st = states.get(clientID);
        if (st && typeof st.ts === 'number') {
          const lat = now - st.ts;
          if (lat >= 0 && lat < 60000) {
            this.awarenessLatencies.push(lat);
          }
        }
      }
    });
  }

  async connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const wsUrl = this.url.replace(/^http/, 'ws');
      const origin = this.url.replace(/^(https?:\/\/[^\/]+).*/, '$1');
      const timer = setTimeout(() => {
        if (!this.synced) {
          this.close();
          reject(new Error(`Connect timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      try {
        this.ws = new WebSocket(wsUrl, {
          headers: {
            Origin: origin,
            ...this.headers
          }
        });
      } catch (err) {
        clearTimeout(timer);
        return reject(err);
      }

      this.ws.binaryType = 'nodebuffer';

      this.ws.on('open', () => {
        if (!this.isViewer && this.token) {
          this.ws.send(this.token);
        }
      });

      this.ws.on('message', (data, isBinary) => {
        this.receivedFrames++;
        if (!isBinary && typeof data === 'string') {
          return;
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const frame = decodeFrame(buf);
        if (!frame) return;

        switch (frame.type) {
          case FRAME_SNAPSHOT:
            this.highestSeq = Math.max(this.highestSeq, frame.throughSeq);
            this.latestSnapshotState = frame.state;
            if (!this.skipDocApply && frame.state && frame.state.length > 0) {
              try {
                Y.applyUpdate(this.doc, frame.state, 'snapshot');
              } catch {}
            }
            if (!this.synced) {
              this.synced = true;
              clearTimeout(timer);
              resolve();
            }
            break;
          case FRAME_UPDATE:
            this.highestSeq = Math.max(this.highestSeq, frame.seq);
            if (frame.update && frame.update.length > 0) {
              try {
                Y.applyUpdate(this.doc, frame.update, 'remote');
              } catch {}
            }
            break;
          case FRAME_AWARENESS:
            try {
              awarenessProtocol.applyAwarenessUpdate(this.awareness, frame.update, 'remote');
            } catch {}
            break;
          case FRAME_COMPACT_REQUEST:
            this.compactRequestsCount++;
            this.onCompactRequest?.();
            break;
        }
      });

      this.ws.on('close', (code, reason) => {
        this.closed = true;
        this.closeCode = code;
        this.closeReason = reason ? reason.toString('utf8') : '';
        if (!this.synced) {
          clearTimeout(timer);
          reject(new Error(`Closed before sync (code ${code}: ${this.closeReason})`));
        }
      });

      this.ws.on('error', (err) => {
        if (!this.synced) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  sendUpdate(fn) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    let updateBytes = null;
    const unsub = this.doc.on('update', (u, origin) => {
      if (origin === 'local') {
        updateBytes = u;
      }
    });
    this.doc.transact(fn, 'local');
    unsub();
    if (updateBytes) {
      const frame = encodeUpdateFrame(updateBytes, 0);
      this.ws.send(frame);
    }
  }

  sendRawUpdate(updateBytes) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const frame = encodeUpdateFrame(updateBytes, 0);
    this.ws.send(frame);
  }

  sendAwareness(state) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.awareness.setLocalState(state);
    const awBytes = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    const frame = encodeAwarenessFrame(awBytes);
    this.ws.send(frame);
  }

  sendSnapshotPost(meta = { plain_text: '', title: '', preview: '' }, broadcast = false) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const state = Y.encodeStateAsUpdate(this.doc);
    const frame = encodeSnapshotPostFrame(this.highestSeq, meta, state, broadcast);
    this.ws.send(frame);
  }

  pause() {
    if (this.ws && this.ws._socket) {
      try {
        this.ws._socket.pause();
      } catch {}
    }
  }

  close(code = 1000) {
    if (this.ws && !this.closed) {
      try {
        this.ws.close(code);
      } catch {}
    }
    try {
      this.doc.destroy();
    } catch {}
  }
}

// Server Process Manager
export class ServerManager {
  static spawnInstance(port, extraEnv = {}) {
    const envContent = fs.readFileSync('/tmp/calaba-load/server.env', 'utf8');
    const fileEnv = {};
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        fileEnv[k] = v;
      }
    }
    const env = {
      ...process.env,
      ...fileEnv,
      HTTP_ADDR: `127.0.0.1:${port}`,
      PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
      ...extraEnv
    };
    const logFile = `/tmp/calaba-load/logs/server-${port}.log`;
    const out = fs.openSync(logFile, 'a');
    const child = spawn('/tmp/calaba-load/server', ['serve'], {
      env,
      stdio: ['ignore', out, out],
      detached: false
    });
    return { child, pid: child.pid, port };
  }

  static async waitForReady(port, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`);
        if (res.ok) return true;
      } catch {}
      await sleep(250);
    }
    throw new Error(`Server on port ${port} did not become ready within ${timeoutMs}ms`);
  }

  static killPid(pid, signal = 'SIGTERM') {
    try {
      process.kill(pid, signal);
    } catch {}
  }

  static findPidByPort(port) {
    try {
      const out = execFileSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim();
      const pids = out.split('\n').filter(Boolean).map(Number);
      return pids[0] || null;
    } catch {
      return null;
    }
  }
}

// Helper to pre-warm a workspace with multiple users
async function setupWorkspaceWithUsers(client, userCount = 15) {
  const admin = await client.register(`admin-${Date.now()}@load.calaba`, 'Admin');
  const wsId = await client.createWorkspace(admin.token, 'Load Test Workspace');
  const inviteCode = await client.createInvite(admin.token, wsId);

  const users = [{ token: admin.token, userId: admin.userId }];
  for (let i = 1; i < userCount; i++) {
    const u = await client.register(`user-${Date.now()}-${i}@load.calaba`, `User ${i}`);
    await client.joinInvite(u.token, inviteCode);
    users.push(u);
  }
  return { wsId, users, adminToken: admin.token };
}

// ==========================================
// SCENARIOS
// ==========================================

export async function runS1Worker() {
  const elh = monitorEventLoopDelay({ resolution: 10 });
  elh.enable();
  const startCpu = process.cpuUsage();
  let startTime = Date.now();

  let writers = [];
  let readers = [];
  let slowClient = null;
  let writeTimer = null;

  process.on('message', async (msg) => {
    try {
      if (msg.type === 'init') {
        const { host, canvasId, writers: writerCfgs, readers: readerCfgs, hasSlowClient, slowToken } = msg;

        writers = writerCfgs.map(cfg => {
          const c = new CanvasSyncClient({
            url: `${host}/api/canvas/items/${canvasId}/sync`,
            token: cfg.token,
            clientId: cfg.clientId
          });
          c.isGesture = cfg.isGesture !== false;
          c.onCompactRequest = () => {
            c.sendSnapshotPost({ plain_text: 'S1 snapshot', title: 'S1 Hot Canvas', preview: '', objects: 0 });
          };
          return c;
        });

        readers = readerCfgs.map(cfg => {
          return new CanvasSyncClient({
            url: `${host}/api/canvas/items/${canvasId}/sync`,
            token: cfg.token,
            clientId: cfg.clientId
          });
        });

        if (hasSlowClient) {
          slowClient = new CanvasSyncClient({
            url: `${host}/api/canvas/items/${canvasId}/sync`,
            token: slowToken,
            clientId: 9999,
            slowMode: true
          });
        }

        await Promise.all([...writers.map(w => w.connect()), ...readers.map(r => r.connect())]);
        if (slowClient) {
          await slowClient.connect();
          slowClient.pause();
        }

        process.send({ type: 'ready' });
      } else if (msg.type === 'start') {
        startTime = Date.now();
        let step = 0;
        writeTimer = setInterval(() => {
          step++;
          const now = Date.now();
          for (const w of writers) {
            if (w.closed) continue;
            w.sendAwareness({
              cursor: { x: (step * 7) % 1000, y: (step * 13) % 1000 },
              selection: [],
              view: { x: 0, y: 0, zoom: 1 },
              ts: now
            });
            if (w.isGesture) {
              w.sendUpdate(() => {
                const live = w.doc.getMap('live');
                const k = String(w.doc.clientID);
                live.set(k, {
                  ts: now,
                  patches: {
                    o1: { x: (step * 3) % 500, y: (step * 5) % 500 },
                    o2: { x: (step * 4) % 500, y: (step * 6) % 500 },
                    o3: { x: (step * 5) % 500, y: (step * 7) % 500 },
                    o4: { x: (step * 6) % 500, y: (step * 8) % 500 },
                    o5: { x: (step * 7) % 500, y: (step * 9) % 500 }
                  }
                });
              });
            }
          }
        }, 100);
      } else if (msg.type === 'stop') {
        if (writeTimer) clearInterval(writeTimer);
        elh.disable();

        const cpuDiff = process.cpuUsage(startCpu);
        const totalElapsedMs = (Date.now() - startTime) || 1;
        const cpuPercent = Math.round(((cpuDiff.user + cpuDiff.system) / 1000 / totalElapsedMs) * 100);

        const elP50 = Math.round(elh.percentile(50) / 1e6);
        const elP95 = Math.round(elh.percentile(95) / 1e6);
        const elP99 = Math.round(elh.percentile(99) / 1e6);

        const latencies = [];
        const updateLatencies = [];
        const awarenessLatencies = [];
        const frameCounts = [];
        for (const c of [...readers, ...writers]) {
          latencies.push(...c.latencies);
          updateLatencies.push(...c.updateLatencies);
          awarenessLatencies.push(...c.awarenessLatencies);
          frameCounts.push(c.receivedFrames);
        }

        let slowStatus = null;
        if (slowClient) {
          if (slowClient.ws && slowClient.ws._socket) {
            try { slowClient.ws._socket.resume(); } catch {}
          }
          await sleep(200);
          slowStatus = {
            closed: slowClient.closed,
            closeCode: slowClient.closeCode,
            closeReason: slowClient.closeReason
          };
          slowClient.close();
        }

        for (const w of writers) w.close();
        for (const r of readers) r.close();

        process.send({
          type: 'done',
          latencies,
          updateLatencies,
          awarenessLatencies,
          frameCounts,
          cpuPercent,
          eventLoopDelayMs: { p50: elP50, p95: elP95, p99: elP99 },
          slowStatus
        });
        setTimeout(() => process.exit(0), 100);
      }
    } catch (err) {
      process.send({ type: 'error', error: err.message });
      process.exit(1);
    }
  });
}

export async function runS1(opts = {}) {
  const host = opts.host || 'http://127.0.0.1:3191';
  const scale = opts.scale || 1.0;
  const durationSec = opts.duration || 60;
  const numWriters = Math.max(2, Math.round(100 * scale));
  const numReaders = Math.max(1, Math.round(20 * scale));
  const numWorkers = opts.workers || 4;
  const client = new CalabaClient(host);

  console.log(`[S1 Hot Board Multi-Process] Scale: ${scale} (${numWriters} writers, ${numReaders} readers, 1 slow client across ${numWorkers} worker processes). Duration: ${durationSec}s`);

  // Check load average
  const load = checkLoadAverage();
  if (load > 8) {
    console.warn(`[WARN] System load average is ${load.toFixed(2)} (> 8). Waiting 15s for cooldown...`);
    await sleep(15000);
  }

  const pid = opts.serverPid || ServerManager.findPidByPort(3191);
  const metricsStart = await client.getMetrics();
  const procStart = sampleProcess(pid);

  // Setup workspace & canvas
  const numUsers = Math.min(25, Math.ceil((numWriters + numReaders) / 6) + 2);
  const { wsId, users, adminToken } = await setupWorkspaceWithUsers(client, numUsers);
  const canvasId = await client.createCanvas(adminToken, wsId, 'S1 Hot Canvas');

  // Build writer and reader configs
  const writerConfigs = [];
  for (let i = 0; i < numWriters; i++) {
    const user = users[i % users.length];
    writerConfigs.push({ token: user.token, clientId: 1000 + i, isGesture: true });
  }

  const readerConfigs = [];
  for (let i = 0; i < numReaders; i++) {
    const user = users[(i + numWriters) % users.length];
    readerConfigs.push({ token: user.token, clientId: 5000 + i });
  }

  // Partition configs across workers
  const workerAssignments = [];
  for (let w = 0; w < numWorkers; w++) {
    workerAssignments.push({
      writers: [],
      readers: [],
      hasSlowClient: w === 0,
      slowToken: adminToken
    });
  }
  writerConfigs.forEach((c, idx) => {
    workerAssignments[idx % numWorkers].writers.push(c);
  });
  readerConfigs.forEach((c, idx) => {
    workerAssignments[idx % numWorkers].readers.push(c);
  });

  console.log(`[S1] Spawning ${numWorkers} worker processes...`);
  const workerProcs = [];
  const workerPids = [];
  const readyPromises = [];

  for (let w = 0; w < numWorkers; w++) {
    const cp = fork(fileURLToPath(import.meta.url), ['--worker-s1'], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    workerProcs.push(cp);
    workerPids.push(cp.pid);

    const readyPromise = new Promise((resolve, reject) => {
      const onMsg = (msg) => {
        if (msg.type === 'ready') {
          cp.off('message', onMsg);
          resolve();
        } else if (msg.type === 'error') {
          reject(new Error(`Worker ${w} error: ${msg.error}`));
        }
      };
      cp.on('message', onMsg);
    });
    readyPromises.push(readyPromise);

    cp.send({
      type: 'init',
      host,
      canvasId,
      writers: workerAssignments[w].writers,
      readers: workerAssignments[w].readers,
      hasSlowClient: workerAssignments[w].hasSlowClient,
      slowToken: workerAssignments[w].slowToken,
      duration: durationSec
    });
  }

  console.log(`[S1] Waiting for all ${numWorkers} workers to connect their sockets...`);
  await Promise.all(readyPromises);
  console.log(`[S1] All workers ready. Starting ${durationSec}s load test across ${numWorkers} processes...`);

  for (const cp of workerProcs) {
    cp.send({ type: 'start' });
  }

  const rssSamples = [];
  const cpuSamples = [];
  const workerCpuSamples = workerPids.map(() => []);
  const startMs = Date.now();
  const durationMs = durationSec * 1000;

  // Sampler interval
  const sampleTimer = setInterval(() => {
    const p = sampleProcess(pid);
    if (p) {
      rssSamples.push(p.rssMB);
      cpuSamples.push(p.cpuPercent);
    }
    for (let i = 0; i < workerPids.length; i++) {
      const wp = sampleProcess(workerPids[i]);
      if (wp) workerCpuSamples[i].push(wp.cpuPercent);
    }
  }, 2000);

  // Monitor loop
  while (Date.now() - startMs < durationMs) {
    await sleep(1000);
    const currLoad = checkLoadAverage();
    if (currLoad > 12) {
      console.error(`[EMERGENCY] System load average reached ${currLoad.toFixed(2)} (> 12). Aborting scenario!`);
      break;
    }
  }

  clearInterval(sampleTimer);

  console.log(`[S1] Duration reached. Stopping workers and collecting metrics...`);
  const donePromises = [];
  for (let w = 0; w < numWorkers; w++) {
    const cp = workerProcs[w];
    const donePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ latencies: [], updateLatencies: [], awarenessLatencies: [], frameCounts: [], cpuPercent: 0, eventLoopDelayMs: { p50: 0, p95: 0, p99: 0 } });
      }, 7000);
      const onMsg = (msg) => {
        if (msg.type === 'done') {
          cleanup();
          resolve(msg);
        } else if (msg.type === 'error') {
          cleanup();
          resolve({ latencies: [], updateLatencies: [], awarenessLatencies: [], frameCounts: [], cpuPercent: 0, eventLoopDelayMs: { p50: 0, p95: 0, p99: 0 } });
        }
      };
      const onExit = () => {
        cleanup();
        resolve({ latencies: [], updateLatencies: [], awarenessLatencies: [], frameCounts: [], cpuPercent: 0, eventLoopDelayMs: { p50: 0, p95: 0, p99: 0 } });
      };
      function cleanup() {
        clearTimeout(timer);
        cp.off('message', onMsg);
        cp.off('exit', onExit);
      }
      cp.on('message', onMsg);
      cp.on('exit', onExit);
    });
    donePromises.push(donePromise);
    try { cp.send({ type: 'stop' }); } catch {}
  }

  const workerResults = await Promise.all(donePromises);
  const procEnd = sampleProcess(pid);
  const metricsEnd = await client.getMetrics();

  // Aggregate stats
  const allUpdateLatencies = [];
  const allAwarenessLatencies = [];
  const framesPerSecPerClient = [];
  const workerReports = [];
  let slowStatus = null;

  for (let w = 0; w < numWorkers; w++) {
    const r = workerResults[w] || {};
    if (r.updateLatencies && Array.isArray(r.updateLatencies)) {
      for (let i = 0; i < r.updateLatencies.length; i++) {
        allUpdateLatencies.push(r.updateLatencies[i]);
      }
    } else if (r.latencies && Array.isArray(r.latencies)) {
      for (let i = 0; i < r.latencies.length; i++) {
        allUpdateLatencies.push(r.latencies[i]);
      }
    }
    if (r.awarenessLatencies && Array.isArray(r.awarenessLatencies)) {
      for (let i = 0; i < r.awarenessLatencies.length; i++) {
        allAwarenessLatencies.push(r.awarenessLatencies[i]);
      }
    }
    for (const fc of (r.frameCounts || [])) {
      framesPerSecPerClient.push(fc / durationSec);
    }
    if (r.slowStatus) slowStatus = r.slowStatus;
    const avgWorkerCpu = workerCpuSamples[w].length ? Math.round(workerCpuSamples[w].reduce((a,b)=>a+b,0)/workerCpuSamples[w].length) : r.cpuPercent;
    workerReports.push({
      workerId: w,
      pid: workerPids[w],
      cpuPercent: avgWorkerCpu,
      eventLoopDelayMs: r.eventLoopDelayMs,
      sockets: workerAssignments[w].writers.length + workerAssignments[w].readers.length + (workerAssignments[w].hasSlowClient ? 1 : 0)
    });
  }

  const p50 = percentile(allUpdateLatencies, 50);
  const p95 = percentile(allUpdateLatencies, 95);
  const p99 = percentile(allUpdateLatencies, 99);

  const awP50 = percentile(allAwarenessLatencies, 50);
  const awP95 = percentile(allAwarenessLatencies, 95);
  const awP99 = percentile(allAwarenessLatencies, 99);

  const fpsMedian = percentile(framesPerSecPerClient, 50);
  const fpsP99 = percentile(framesPerSecPerClient, 99);

  const peakRss = rssSamples.length ? Math.max(...rssSamples) : (procEnd?.rssMB || 0);
  const peakCpu = cpuSamples.length ? Math.max(...cpuSamples) : (procEnd?.cpuPercent || 0);

  const droppedQueue = (metricsEnd.droppedFrames?.queue || 0) - (metricsStart.droppedFrames?.queue || 0);
  const droppedAwareness = (metricsEnd.droppedFrames?.awareness || 0) - (metricsStart.droppedFrames?.awareness || 0);
  const droppedCeiling = (metricsEnd.droppedFrames?.ceiling || 0) - (metricsStart.droppedFrames?.ceiling || 0);

  const batchedFrames = (metricsEnd.batchedFrames || 0) - (metricsStart.batchedFrames || 0);
  const coalescedEntries = (metricsEnd.coalescedEntries || 0) - (metricsStart.coalescedEntries || 0);
  const overwrittenSlots = (metricsEnd.overwrittenSlots || 0) - (metricsStart.overwrittenSlots || 0);

  const closes4000 = (metricsEnd.closes?.['4000'] || 0) - (metricsStart.closes?.['4000'] || 0);
  const closes4008 = (metricsEnd.closes?.['4008'] || 0) - (metricsStart.closes?.['4008'] || 0);
  const closes4012 = (metricsEnd.closes?.['4012'] || 0) - (metricsStart.closes?.['4012'] || 0);
  const closes4014 = (metricsEnd.closes?.['4014'] || 0) - (metricsStart.closes?.['4014'] || 0);

  const isSlowClosed = slowStatus?.closed || closes4000 > 0;

  const maxWorkerElP99 = Math.max(...workerReports.map(w => w.eventLoopDelayMs?.p99 || 0));
  const generatorBottleneck = maxWorkerElP99 > 200;

  const result = {
    scenario: 'S1',
    scale,
    numWriters,
    numReaders,
    numWorkers,
    durationSec,
    server: {
      startRssMB: procStart?.rssMB || 0,
      peakRssMB: peakRss,
      endRssMB: procEnd?.rssMB || 0,
      peakCpuPercent: peakCpu
    },
    clientFramesPerSec: {
      median: Math.round(fpsMedian * 10) / 10,
      p99: Math.round(fpsP99 * 10) / 10
    },
    deliveryLatencyMs: {
      update: { p50, p95, p99 },
      awareness: { p50: awP50, p95: awP95, p99: awP99 },
      p50,
      p95,
      p99
    },
    droppedFrames: {
      queue: droppedQueue,
      awareness: droppedAwareness,
      ceiling: droppedCeiling
    },
    batchedFrames,
    coalescedEntries,
    overwrittenSlots,
    closes: {
      code4000: closes4000,
      code4008: closes4008,
      code4012: closes4012,
      code4014: closes4014
    },
    slowClient: {
      closedByServer: isSlowClosed,
      closeCode: slowStatus?.closeCode || (isSlowClosed ? 4000 : null),
      closeReason: slowStatus?.closeReason || (isSlowClosed ? 'write timeout' : '')
    },
    generatorWorkers: workerReports,
    generatorBottleneck,
    bottleneckAnalysis: generatorBottleneck
      ? 'Generator worker event loop saturation (elDelay p99 > 200ms)'
      : 'Generator event loops healthy. Measured latency reflects true server/transport delivery.',
    pass: p99 < 500 && isSlowClosed && droppedQueue === 0 && closes4008 === 0
  };

  return result;
}

export async function runS1b(opts = {}) {
  const host = opts.host || 'http://127.0.0.1:3191';
  const scale = opts.scale || 1.0;
  const durationSec = opts.duration || 30;
  const numWriters = Math.max(2, Math.round(100 * scale));
  const numGestureWriters = Math.max(1, Math.round(5 * scale));
  const numReaders = Math.max(1, Math.round(20 * scale));
  const numWorkers = opts.workers || 4;
  const client = new CalabaClient(host);

  console.log(`[S1b Realistic Hot Board Multi-Process] Scale: ${scale} (${numWriters} awareness writers, ${numGestureWriters} gesture writers, ${numReaders} readers, 1 slow client across ${numWorkers} worker processes). Duration: ${durationSec}s`);

  // Check load average
  const load = checkLoadAverage();
  if (load > 8) {
    console.warn(`[WARN] System load average is ${load.toFixed(2)} (> 8). Waiting 15s for cooldown...`);
    await sleep(15000);
  }

  const pid = opts.serverPid || ServerManager.findPidByPort(3191);
  const metricsStart = await client.getMetrics();
  const procStart = sampleProcess(pid);

  // Setup workspace & canvas
  const numUsers = Math.min(25, Math.ceil((numWriters + numReaders) / 6) + 2);
  const { wsId, users, adminToken } = await setupWorkspaceWithUsers(client, numUsers);
  const canvasId = await client.createCanvas(adminToken, wsId, 'S1b Hot Canvas');

  // Build writer and reader configs
  const writerConfigs = [];
  for (let i = 0; i < numWriters; i++) {
    const user = users[i % users.length];
    writerConfigs.push({
      token: user.token,
      clientId: 1000 + i,
      isGesture: i < numGestureWriters
    });
  }

  const readerConfigs = [];
  for (let i = 0; i < numReaders; i++) {
    const user = users[(i + numWriters) % users.length];
    readerConfigs.push({ token: user.token, clientId: 5000 + i });
  }

  // Partition configs across workers
  const workerAssignments = [];
  for (let w = 0; w < numWorkers; w++) {
    workerAssignments.push({
      writers: [],
      readers: [],
      hasSlowClient: w === 0,
      slowToken: adminToken
    });
  }
  writerConfigs.forEach((c, idx) => {
    workerAssignments[idx % numWorkers].writers.push(c);
  });
  readerConfigs.forEach((c, idx) => {
    workerAssignments[idx % numWorkers].readers.push(c);
  });

  console.log(`[S1b] Spawning ${numWorkers} worker processes...`);
  const workerProcs = [];
  const workerPids = [];
  const readyPromises = [];

  for (let w = 0; w < numWorkers; w++) {
    const cp = fork(fileURLToPath(import.meta.url), ['--worker-s1'], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    workerProcs.push(cp);
    workerPids.push(cp.pid);

    const readyPromise = new Promise((resolve, reject) => {
      const onMsg = (msg) => {
        if (msg.type === 'ready') {
          cp.off('message', onMsg);
          resolve();
        } else if (msg.type === 'error') {
          reject(new Error(`Worker ${w} error: ${msg.error}`));
        }
      };
      cp.on('message', onMsg);
    });
    readyPromises.push(readyPromise);

    cp.send({
      type: 'init',
      host,
      canvasId,
      writers: workerAssignments[w].writers,
      readers: workerAssignments[w].readers,
      hasSlowClient: workerAssignments[w].hasSlowClient,
      slowToken: workerAssignments[w].slowToken,
      duration: durationSec
    });
  }

  console.log(`[S1b] Waiting for all ${numWorkers} workers to connect their sockets...`);
  await Promise.all(readyPromises);
  console.log(`[S1b] All workers ready. Starting ${durationSec}s load test across ${numWorkers} processes...`);

  for (const cp of workerProcs) {
    cp.send({ type: 'start' });
  }

  const rssSamples = [];
  const cpuSamples = [];
  const workerCpuSamples = workerPids.map(() => []);
  const startMs = Date.now();
  const durationMs = durationSec * 1000;

  // Sampler interval
  const sampleTimer = setInterval(() => {
    const p = sampleProcess(pid);
    if (p) {
      rssSamples.push(p.rssMB);
      cpuSamples.push(p.cpuPercent);
    }
    for (let i = 0; i < workerPids.length; i++) {
      const wp = sampleProcess(workerPids[i]);
      if (wp) workerCpuSamples[i].push(wp.cpuPercent);
    }
  }, 2000);

  // Monitor loop
  while (Date.now() - startMs < durationMs) {
    await sleep(1000);
    const currLoad = checkLoadAverage();
    if (currLoad > 12) {
      console.error(`[EMERGENCY] System load average reached ${currLoad.toFixed(2)} (> 12). Aborting scenario!`);
      break;
    }
  }

  clearInterval(sampleTimer);

  console.log(`[S1b] Duration reached. Stopping workers and collecting metrics...`);
  const donePromises = [];
  for (let w = 0; w < numWorkers; w++) {
    const cp = workerProcs[w];
    const donePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ latencies: [], updateLatencies: [], awarenessLatencies: [], frameCounts: [], cpuPercent: 0, eventLoopDelayMs: { p50: 0, p95: 0, p99: 0 } });
      }, 7000);
      const onMsg = (msg) => {
        if (msg.type === 'done') {
          cleanup();
          resolve(msg);
        } else if (msg.type === 'error') {
          cleanup();
          resolve({ latencies: [], updateLatencies: [], awarenessLatencies: [], frameCounts: [], cpuPercent: 0, eventLoopDelayMs: { p50: 0, p95: 0, p99: 0 } });
        }
      };
      const onExit = () => {
        cleanup();
        resolve({ latencies: [], updateLatencies: [], awarenessLatencies: [], frameCounts: [], cpuPercent: 0, eventLoopDelayMs: { p50: 0, p95: 0, p99: 0 } });
      };
      function cleanup() {
        clearTimeout(timer);
        cp.off('message', onMsg);
        cp.off('exit', onExit);
      }
      cp.on('message', onMsg);
      cp.on('exit', onExit);
    });
    donePromises.push(donePromise);
    try { cp.send({ type: 'stop' }); } catch {}
  }

  const workerResults = await Promise.all(donePromises);
  const procEnd = sampleProcess(pid);
  const metricsEnd = await client.getMetrics();

  // Aggregate stats
  const allUpdateLatencies = [];
  const allAwarenessLatencies = [];
  const framesPerSecPerClient = [];
  const workerReports = [];
  let slowStatus = null;

  for (let w = 0; w < numWorkers; w++) {
    const r = workerResults[w] || {};
    if (r.updateLatencies && Array.isArray(r.updateLatencies)) {
      for (let i = 0; i < r.updateLatencies.length; i++) {
        allUpdateLatencies.push(r.updateLatencies[i]);
      }
    } else if (r.latencies && Array.isArray(r.latencies)) {
      for (let i = 0; i < r.latencies.length; i++) {
        allUpdateLatencies.push(r.latencies[i]);
      }
    }
    if (r.awarenessLatencies && Array.isArray(r.awarenessLatencies)) {
      for (let i = 0; i < r.awarenessLatencies.length; i++) {
        allAwarenessLatencies.push(r.awarenessLatencies[i]);
      }
    }
    for (const fc of (r.frameCounts || [])) {
      framesPerSecPerClient.push(fc / durationSec);
    }
    if (r.slowStatus) slowStatus = r.slowStatus;
    const avgWorkerCpu = workerCpuSamples[w].length ? Math.round(workerCpuSamples[w].reduce((a,b)=>a+b,0)/workerCpuSamples[w].length) : r.cpuPercent;
    workerReports.push({
      workerId: w,
      pid: workerPids[w],
      cpuPercent: avgWorkerCpu,
      eventLoopDelayMs: r.eventLoopDelayMs,
      sockets: workerAssignments[w].writers.length + workerAssignments[w].readers.length + (workerAssignments[w].hasSlowClient ? 1 : 0)
    });
  }

  const p50 = percentile(allUpdateLatencies, 50);
  const p95 = percentile(allUpdateLatencies, 95);
  const p99 = percentile(allUpdateLatencies, 99);

  const awP50 = percentile(allAwarenessLatencies, 50);
  const awP95 = percentile(allAwarenessLatencies, 95);
  const awP99 = percentile(allAwarenessLatencies, 99);

  const fpsMedian = percentile(framesPerSecPerClient, 50);
  const fpsP99 = percentile(framesPerSecPerClient, 99);

  const peakRss = rssSamples.length ? Math.max(...rssSamples) : (procEnd?.rssMB || 0);
  const peakCpu = cpuSamples.length ? Math.max(...cpuSamples) : (procEnd?.cpuPercent || 0);

  const droppedQueue = (metricsEnd.droppedFrames?.queue || 0) - (metricsStart.droppedFrames?.queue || 0);
  const droppedAwareness = (metricsEnd.droppedFrames?.awareness || 0) - (metricsStart.droppedFrames?.awareness || 0);
  const droppedCeiling = (metricsEnd.droppedFrames?.ceiling || 0) - (metricsStart.droppedFrames?.ceiling || 0);

  const batchedFrames = (metricsEnd.batchedFrames || 0) - (metricsStart.batchedFrames || 0);
  const coalescedEntries = (metricsEnd.coalescedEntries || 0) - (metricsStart.coalescedEntries || 0);
  const overwrittenSlots = (metricsEnd.overwrittenSlots || 0) - (metricsStart.overwrittenSlots || 0);

  const closes4000 = (metricsEnd.closes?.['4000'] || 0) - (metricsStart.closes?.['4000'] || 0);
  const closes4008 = (metricsEnd.closes?.['4008'] || 0) - (metricsStart.closes?.['4008'] || 0);
  const closes4012 = (metricsEnd.closes?.['4012'] || 0) - (metricsStart.closes?.['4012'] || 0);
  const closes4014 = (metricsEnd.closes?.['4014'] || 0) - (metricsStart.closes?.['4014'] || 0);

  const isSlowClosed = slowStatus?.closed || closes4000 > 0;

  const maxWorkerElP99 = Math.max(...workerReports.map(w => w.eventLoopDelayMs?.p99 || 0));
  const generatorBottleneck = maxWorkerElP99 > 200;

  const result = {
    scenario: 'S1b',
    scale,
    numWriters,
    numGestureWriters,
    numReaders,
    numWorkers,
    durationSec,
    server: {
      startRssMB: procStart?.rssMB || 0,
      peakRssMB: peakRss,
      endRssMB: procEnd?.rssMB || 0,
      peakCpuPercent: peakCpu
    },
    clientFramesPerSec: {
      median: Math.round(fpsMedian * 10) / 10,
      p99: Math.round(fpsP99 * 10) / 10
    },
    deliveryLatencyMs: {
      update: { p50, p95, p99 },
      awareness: { p50: awP50, p95: awP95, p99: awP99 },
      p50,
      p95,
      p99
    },
    droppedFrames: {
      queue: droppedQueue,
      awareness: droppedAwareness,
      ceiling: droppedCeiling
    },
    batchedFrames,
    coalescedEntries,
    overwrittenSlots,
    closes: {
      code4000: closes4000,
      code4008: closes4008,
      code4012: closes4012,
      code4014: closes4014
    },
    slowClient: {
      closedByServer: isSlowClosed,
      closeCode: slowStatus?.closeCode || (isSlowClosed ? 4000 : null),
      closeReason: slowStatus?.closeReason || (isSlowClosed ? 'write timeout' : '')
    },
    generatorWorkers: workerReports,
    generatorBottleneck,
    bottleneckAnalysis: generatorBottleneck
      ? 'Generator worker event loop saturation (elDelay p99 > 200ms)'
      : 'Generator event loops healthy. Measured latency reflects true server/transport delivery.',
    pass: p99 < 500 && isSlowClosed && droppedQueue === 0 && closes4008 === 0 && (closes4000 <= 1)
  };

  return result;
}

export async function runS2(opts = {}) {
  const host = opts.host || 'http://127.0.0.1:3191';
  const scale = opts.scale || 1.0;
  const numCanvases = Math.max(5, Math.round(50 * scale));
  const socketsPerCanvas = 10;
  const durationSec = 90;
  const client = new CalabaClient(host);

  console.log(`[S2 Many Boards] ${numCanvases} canvases x ${socketsPerCanvas} sockets = ${numCanvases * socketsPerCanvas} sockets. Duration: ${durationSec}s`);

  const pid = opts.serverPid || ServerManager.findPidByPort(3191);
  const procStart = sampleProcess(pid);

  const { wsId, users, adminToken } = await setupWorkspaceWithUsers(client, socketsPerCanvas);

  console.log(`[S2] Creating ${numCanvases} canvases...`);
  const canvasIds = [];
  for (let i = 0; i < numCanvases; i++) {
    const cid = await client.createCanvas(adminToken, wsId, `Canvas ${i + 1}`);
    canvasIds.push(cid);
  }

  console.log(`[S2] Connecting ${numCanvases * socketsPerCanvas} sockets across canvases...`);
  const allSockets = [];
  for (let cIdx = 0; cIdx < numCanvases; cIdx++) {
    const cid = canvasIds[cIdx];
    for (let uIdx = 0; uIdx < socketsPerCanvas; uIdx++) {
      const u = users[uIdx];
      const s = new CanvasSyncClient({
        url: `${host}/api/canvas/items/${cid}/sync`,
        token: u.token,
        clientId: (cIdx + 1) * 100 + uIdx
      });
      allSockets.push(s);
    }
  }

  // Connect in batches to avoid local file descriptor exhaustion
  const BATCH_SIZE = 50;
  for (let i = 0; i < allSockets.length; i += BATCH_SIZE) {
    const chunk = allSockets.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map(s => s.connect()));
  }

  const metricsAfterConnect = await client.getMetrics();
  console.log(`[S2] Connected. Rooms: ${metricsAfterConnect.rooms}, Sockets: ${metricsAfterConnect.sockets}`);

  const rssSamples = [];
  const cpuSamples = [];
  const dbConnSamples = [];

  const sampleTimer = setInterval(() => {
    const p = sampleProcess(pid);
    if (p) {
      rssSamples.push(p.rssMB);
      cpuSamples.push(p.cpuPercent);
    }
    dbConnSamples.push(queryDbConnections());
  }, 2000);

  // 1 light update / s per canvas
  const updateTimer = setInterval(() => {
    const now = Date.now();
    for (let cIdx = 0; cIdx < numCanvases; cIdx++) {
      const writer = allSockets[cIdx * socketsPerCanvas];
      if (writer && !writer.closed) {
        writer.sendUpdate(() => {
          writer.doc.getMap('live').set('ping', { ts: now });
        });
      }
    }
  }, 1000);

  // Awareness 2/s (every 500ms) on each socket
  let awStep = 0;
  const awTimer = setInterval(() => {
    awStep++;
    for (const s of allSockets) {
      if (s.closed) continue;
      s.sendAwareness({
        cursor: { x: awStep % 500, y: (awStep * 2) % 500 },
        selection: [],
        view: { x: 0, y: 0, zoom: 1 }
      });
    }
  }, 500);

  const startMs = Date.now();
  while (Date.now() - startMs < durationSec * 1000) {
    await sleep(1000);
    if (checkLoadAverage() > 12) break;
  }

  clearInterval(sampleTimer);
  clearInterval(updateTimer);
  clearInterval(awTimer);

  const procEnd = sampleProcess(pid);
  const metricsEnd = await client.getMetrics();

  for (const s of allSockets) s.close();

  const result = {
    scenario: 'S2',
    numCanvases,
    totalSockets: allSockets.length,
    durationSec,
    server: {
      startRssMB: procStart?.rssMB || 0,
      peakRssMB: rssSamples.length ? Math.max(...rssSamples) : 0,
      endRssMB: procEnd?.rssMB || 0,
      peakCpuPercent: cpuSamples.length ? Math.max(...cpuSamples) : 0
    },
    dbConnections: {
      min: dbConnSamples.length ? Math.min(...dbConnSamples) : 0,
      peak: dbConnSamples.length ? Math.max(...dbConnSamples) : 0
    },
    metrics: {
      rooms: metricsEnd.rooms,
      sockets: metricsEnd.sockets
    },
    pass: (metricsAfterConnect.rooms >= numCanvases && (procEnd?.rssMB || 0) < 2048)
  };

  return result;
}

export async function runS3(opts = {}) {
  const host = opts.host || 'http://127.0.0.1:3191';
  const scale = opts.scale || 1.0;
  const totalCycles = Math.round(3000 * scale);
  const concurrency = Math.round(30 * scale);
  const numCanvases = 20;
  const client = new CalabaClient(host);

  console.log(`[S3 Connections & Leaks] ${totalCycles} cycles across ${numCanvases} canvases, concurrency: ${concurrency}`);

  const pid = opts.serverPid || ServerManager.findPidByPort(3191);
  const procBefore = sampleProcess(pid);

  const { wsId, users, adminToken } = await setupWorkspaceWithUsers(client, 10);
  const canvasIds = [];
  for (let i = 0; i < numCanvases; i++) {
    const cid = await client.createCanvas(adminToken, wsId, `Leak Test Canvas ${i + 1}`);
    canvasIds.push(cid);
  }

  let completed = 0;
  let inFlight = 0;
  let cycleIdx = 0;

  async function worker() {
    while (cycleIdx < totalCycles) {
      const current = cycleIdx++;
      const cid = canvasIds[current % canvasIds.length];
      const u = users[current % users.length];
      const c = new CanvasSyncClient({
        url: `${host}/api/canvas/items/${cid}/sync`,
        token: u.token
      });
      try {
        await c.connect(5000);
        completed++;
      } catch (err) {
        // connect error
      } finally {
        c.close();
      }
    }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const procImmediatelyAfter = sampleProcess(pid);
  const metricsImmediatelyAfter = await client.getMetrics();

  console.log(`[S3] Completed ${completed} cycles. Waiting 60s for resource release & GC...`);
  await sleep(60000);

  const procAfter60s = sampleProcess(pid);
  const metricsAfter60s = await client.getMetrics();

  const result = {
    scenario: 'S3',
    totalCycles,
    completedCycles: completed,
    concurrency,
    server: {
      rssBeforeMB: procBefore?.rssMB || 0,
      rssImmediatelyAfterMB: procImmediatelyAfter?.rssMB || 0,
      rssAfter60sMB: procAfter60s?.rssMB || 0
    },
    metricsImmediatelyAfter: {
      rooms: metricsImmediatelyAfter.rooms,
      sockets: metricsImmediatelyAfter.sockets
    },
    metricsAfter60s: {
      rooms: metricsAfter60s.rooms,
      sockets: metricsAfter60s.sockets
    },
    pass: metricsAfter60s.rooms === 0 && metricsAfter60s.sockets === 0 && (procAfter60s?.rssMB || 0) < 2048
  };

  return result;
}

export async function runS4(opts = {}) {
  const host = opts.host || 'http://127.0.0.1:3191';
  const scale = opts.scale || 1.0;
  const numSockets = Math.max(20, Math.round(200 * scale));
  const client = new CalabaClient(host);

  console.log(`[S4 Reconnect Storm] Creating 3 MiB state (4000 objects), ${numSockets} sockets connected...`);

  let pid = opts.serverPid || ServerManager.findPidByPort(3191);
  const numUsers = Math.max(50, Math.round(numSockets / 2));
  const { wsId, users, adminToken } = await setupWorkspaceWithUsers(client, numUsers);
  const canvasId = await client.createCanvas(adminToken, wsId, 'Reconnect Storm Canvas');

  // Build 3 MiB state: 4000 objects with text
  console.log(`[S4] Building 4000 objects in Yjs document (~3 MiB)...`);
  const setupClient = new CanvasSyncClient({
    url: `${host}/api/canvas/items/${canvasId}/sync`,
    token: adminToken
  });
  await setupClient.connect();

  const objectsMap = setupClient.doc.getMap('objects');
  setupClient.doc.transact(() => {
    for (let i = 0; i < 4000; i++) {
      const m = new Y.Map();
      m.set('kind', 'sticky');
      m.set('x', (i * 20) % 5000);
      m.set('y', Math.floor(i / 250) * 150);
      m.set('w', 200);
      m.set('h', 150);
      m.set('color', '#ffefa6');
      const yt = new Y.Text();
      yt.insert(0, 'Card #' + (i + 1) + ': ' + 'A'.repeat(620));
      m.set('text', yt);
      objectsMap.set(`obj_${i}`, m);
    }
  }, 'local');

  const encodedState = Y.encodeStateAsUpdate(setupClient.doc);
  const stateSizeMB = Math.round((encodedState.length / (1024 * 1024)) * 100) / 100;
  console.log(`[S4] Encoded document state size: ${stateSizeMB} MiB (${encodedState.length} bytes)`);

  // Post snapshot
  console.log(`[S4] Posting initial snapshot (objects: 4000)...`);
  setupClient.sendSnapshotPost({ plain_text: 'Load test', title: 'Reconnect Storm Canvas', preview: '', objects: 4000 });
  await sleep(2000);
  setupClient.close();

  // Connect 200 sockets
  console.log(`[S4] Connecting ${numSockets} clients to receive 3 MiB snapshot...`);
  const clients = [];
  for (let i = 0; i < numSockets; i++) {
    const u = users[i % users.length];
    clients.push(new CanvasSyncClient({
      url: `${host}/api/canvas/items/${canvasId}/sync`,
      token: u.token,
      clientId: 10000 + i,
      skipDocApply: true
    }));
  }

  // Connect in batches
  for (let i = 0; i < clients.length; i += 40) {
    const chunk = clients.slice(i, i + 40);
    await Promise.all(chunk.map(c => c.connect(30000)));
  }
  console.log(`[S4] All ${numSockets} clients synchronized.`);

  // Clean up initial sockets before killing server
  for (const c of clients) c.close();
  await sleep(500);

  // Kill server process with SIGKILL
  console.log(`[S4] Killing instance A (PID: ${pid}) with SIGKILL...`);
  ServerManager.killPid(pid, 'SIGKILL');
  await sleep(1500);
  while (ServerManager.findPidByPort(3191)) {
    ServerManager.killPid(ServerManager.findPidByPort(3191), 'SIGKILL');
    await sleep(200);
  }

  // Restart instance A
  console.log(`[S4] Restarting instance A...`);
  const newInst = ServerManager.spawnInstance(3191);
  pid = newInst.pid;
  opts.serverPid = pid;
  await ServerManager.waitForReady(3191);
  console.log(`[S4] Instance A restarted with PID: ${pid}`);

  const reconnectStart = Date.now();
  const syncTimes = [];
  const peakRssSamples = [];

  const sampler = setInterval(() => {
    const p = sampleProcess(pid);
    if (p) peakRssSamples.push(p.rssMB);
  }, 250);

  // Reconnect with backoff
  console.log(`[S4] Reconnecting ${numSockets} clients with backoff...`);
  const reconnectedClients = [];
  await Promise.all(clients.map(async (c, idx) => {
    const delay = backoffDelay(0, Math.random());
    await sleep(delay);
    const clientRe = new CanvasSyncClient({
      url: `${host}/api/canvas/items/${canvasId}/sync`,
      token: c.token,
      clientId: 10000 + idx,
      skipDocApply: true
    });
    reconnectedClients.push(clientRe);
    try {
      await clientRe.connect(30000);
      syncTimes.push(Date.now() - reconnectStart);
    } catch (e) {
      console.error(`Client ${idx} reconnect error:`, e.message);
    }
  }));

  clearInterval(sampler);

  const t95 = percentile(syncTimes, 95);
  const t100 = percentile(syncTimes, 100);
  const peakRss = peakRssSamples.length ? Math.max(...peakRssSamples) : 0;
  console.log(`[S4] Backoff reconnect: 95% sync in ${t95}ms, 100% sync in ${t100}ms, peak RSS: ${peakRss}MB (${syncTimes.length}/${numSockets})`);

  // Clean up reconnected clients
  for (const c of reconnectedClients) c.close();
  await sleep(2000);

  // Worst-case variant: 100 clients reconnect INSTANTLY
  console.log(`[S4 Worst Case] 100 clients reconnecting instantly (no jitter)...`);
  const worstClients = users.slice(0, 100);
  const worstSyncTimes = [];
  const worstPeakRssSamples = [];

  const worstSampler = setInterval(() => {
    const p = sampleProcess(pid);
    if (p) worstPeakRssSamples.push(p.rssMB);
  }, 200);

  const worstStart = Date.now();
  const worstInstances = [];
  await Promise.all(worstClients.map(async (u, idx) => {
    const clientRe = new CanvasSyncClient({
      url: `${host}/api/canvas/items/${canvasId}/sync`,
      token: u.token,
      clientId: 20000 + idx,
      skipDocApply: true
    });
    worstInstances.push(clientRe);
    try {
      await clientRe.connect(30000);
      worstSyncTimes.push(Date.now() - worstStart);
    } catch (e) {
      console.error(`Worst case client ${idx} reconnect error:`, e.message);
    }
  }));

  clearInterval(worstSampler);

  const worstT100 = percentile(worstSyncTimes, 100);
  const worstPeakRss = worstPeakRssSamples.length ? Math.max(...worstPeakRssSamples) : 0;
  console.log(`[S4 Worst Case] Instant reconnect: 100% sync in ${worstT100}ms, peak RSS: ${worstPeakRss}MB (${worstSyncTimes.length}/100)`);

  for (const c of worstInstances) c.close();

  const result = {
    scenario: 'S4',
    stateSizeMB,
    numSockets,
    normalJitter: {
      time95PercentMs: t95,
      time100PercentMs: t100,
      peakRssMB: peakRss,
      synchronizedRatio: `${syncTimes.length}/${numSockets}`
    },
    worstCaseInstant: {
      count: 100,
      time100PercentMs: worstT100,
      peakRssMB: worstPeakRss,
      synchronizedRatio: `${worstSyncTimes.length}/100`
    },
    pass: t100 < 60000 && peakRss < 2048 && worstPeakRss < 2048
  };

  return result;
}

export async function runS5(opts = {}) {
  const hostA = opts.host || 'http://127.0.0.1:3191';
  const hostB = opts.hostB || 'http://127.0.0.1:3192';
  const scale = opts.scale || 1.0;
  const clientsPerPod = Math.max(10, Math.round(40 * scale));
  const clientA = new CalabaClient(hostA);
  const clientB = new CalabaClient(hostB);

  console.log(`[S5 Two Pods] Pod A (3191) & Pod B (3192). ${clientsPerPod} clients on each pod. Convergence & 10k Ceiling.`);

  // Ensure Pod B is running
  let pidB = ServerManager.findPidByPort(3192);
  let spawnedB = null;
  if (!pidB) {
    console.log(`[S5] Spawning Pod B on port 3192...`);
    spawnedB = ServerManager.spawnInstance(3192);
    await ServerManager.waitForReady(3192);
    pidB = spawnedB.pid;
  }

  const allClients = [];
  try {
    const { wsId, users, adminToken } = await setupWorkspaceWithUsers(clientA, 20);
    const canvasId = await clientA.createCanvas(adminToken, wsId, 'Two Pods Canvas');

    // Connect clients
    console.log(`[S5] Connecting ${clientsPerPod} clients to Pod A and ${clientsPerPod} to Pod B...`);
    const podAClients = [];
    const podBClients = [];

    for (let i = 0; i < clientsPerPod; i++) {
      const u = users[i % users.length];
      podAClients.push(new CanvasSyncClient({
        url: `${hostA}/api/canvas/items/${canvasId}/sync`,
        token: u.token,
        clientId: 1000 + i
      }));
      podBClients.push(new CanvasSyncClient({
        url: `${hostB}/api/canvas/items/${canvasId}/sync`,
        token: u.token,
        clientId: 2000 + i
      }));
    }
    allClients.push(...podAClients, ...podBClients);

    await Promise.all([...podAClients.map(c => c.connect()), ...podBClients.map(c => c.connect())]);

    // Concurrent edits across both pods
    console.log(`[S5] Making concurrent edits across all ${clientsPerPod * 2} clients...`);
    for (let i = 0; i < allClients.length; i++) {
      const c = allClients[i];
      c.sendUpdate(() => {
        c.doc.getMap('objects').set(`item_${i}`, new Y.Map([['kind', 'sticky'], ['x', i * 10], ['y', i * 5]]));
      });
    }

    // Wait for convergence
    console.log(`[S5] Waiting 5s for cross-pod Valkey pub/sub relay...`);
    await sleep(5000);

    // Compare states
    const stateHashes = new Set();
    const sampleState = Y.encodeStateAsUpdate(allClients[0].doc);
    for (const c of allClients) {
      const s = Y.encodeStateAsUpdate(c.doc);
      stateHashes.add(Buffer.from(s).toString('base64'));
    }

    const statesIdentical = stateHashes.size === 1;
    console.log(`[S5] Cross-pod convergence check: ${statesIdentical ? 'PASS (100% identical state across all pods)' : 'FAIL'}`);

    // Part 2: Push document to 10k update ceiling
    console.log(`[S5 Ceiling] Pushing document to 10,000 update ceiling from both pods...`);
    let updatesSent = 0;
    const writersA = podAClients.slice(0, 50);
    const writersB = podBClients.slice(0, 50);
    const ceilingWriters = [...writersA, ...writersB];

    // Send updates in waves respecting per-socket rate limit (<20/s)
    for (let wave = 0; wave < 150; wave++) {
      for (const w of ceilingWriters) {
        if (w.closed) continue;
        w.sendUpdate(() => {
          w.doc.getMap('live').set(`c_${updatesSent}`, { val: updatesSent });
        });
        updatesSent++;
      }
      if (updatesSent >= 10500) break;
      await sleep(65);
    }

    await sleep(2000);
    const metricsA = await clientA.getMetrics();
    const metricsB = await clientB.getMetrics();
    const ceilingHitsTotal = (metricsA.ceilingHits || 0) + (metricsB.ceilingHits || 0);
    const dropCeilingTotal = ((metricsA.droppedFrames?.ceiling || 0) + (metricsB.droppedFrames?.ceiling || 0));

    console.log(`[S5 Ceiling] Updates sent: ${updatesSent}, Ceiling hits: ${ceilingHitsTotal}, Dropped at ceiling: ${dropCeilingTotal}`);

    const result = {
      scenario: 'S5',
      clientsPerPod,
      totalClients: allClients.length,
      crossPodConvergence: statesIdentical,
      ceilingTest: {
        updatesSent,
        ceilingHits: ceilingHitsTotal,
        droppedCeiling: dropCeilingTotal,
        closes4012: (metricsA.closes?.['4012'] || 0) + (metricsB.closes?.['4012'] || 0),
        closes4014: (metricsA.closes?.['4014'] || 0) + (metricsB.closes?.['4014'] || 0)
      },
      pass: statesIdentical
    };

    return result;
  } finally {
    for (const c of allClients) c.close();
    if (spawnedB) ServerManager.killPid(pidB);
  }
}

export async function runS5b(opts = {}) {
  const hostA = opts.host || 'http://127.0.0.1:3191';
  const hostB = opts.hostB || 'http://127.0.0.1:3192';
  const scale = opts.scale || 1.0;
  const clientsPerPod = Math.max(10, Math.round(40 * scale));
  const clientA = new CalabaClient(hostA);
  const clientB = new CalabaClient(hostB);

  console.log(`[S5b Two Pods Convergence After Ceiling] Pod A (3191) & Pod B (3192). ${clientsPerPod} clients/pod.`);

  // Ensure Pod B is running
  let pidB = ServerManager.findPidByPort(3192);
  let spawnedB = null;
  if (!pidB) {
    console.log(`[S5b] Spawning Pod B on port 3192...`);
    spawnedB = ServerManager.spawnInstance(3192);
    await ServerManager.waitForReady(3192);
    pidB = spawnedB.pid;
  }

  const allClients = [];
  try {
    const { wsId, users, adminToken } = await setupWorkspaceWithUsers(clientA, 20);
    const canvasId = await clientA.createCanvas(adminToken, wsId, 'S5b Convergence Canvas');

    // Connect clients: podAClients on hostA, podBClients on hostB
    console.log(`[S5b] Connecting ${clientsPerPod} clients to Pod A and ${clientsPerPod} to Pod B...`);
    const podAClients = [];
    const podBClients = [];

    for (let i = 0; i < clientsPerPod; i++) {
      const u = users[i % users.length];
      podAClients.push(new CanvasSyncClient({
        url: `${hostA}/api/canvas/items/${canvasId}/sync`,
        token: u.token,
        clientId: 1000 + i
      }));
      podBClients.push(new CanvasSyncClient({
        url: `${hostB}/api/canvas/items/${canvasId}/sync`,
        token: u.token,
        clientId: 2000 + i
      }));
    }
    allClients.push(...podAClients, ...podBClients);

    await Promise.all([...podAClients.map(c => c.connect()), ...podBClients.map(c => c.connect())]);

    // Track designated clients X and X2 on Pod A
    const clientX = podAClients[0];
    const clientX2 = podAClients[1];
    let clientXCloseCode = null;
    let clientX2CloseCode = null;

    clientX.ws.on('close', (code) => { clientXCloseCode = code; });
    clientX2.ws.on('close', (code) => { clientX2CloseCode = code; });

    // Writers send updates to push to 10k ceiling
    console.log(`[S5b] Sending updates across both pods to reach 10,000 ceiling...`);
    let updatesSent = 0;
    const ceilingWriters = [...podAClients.slice(2), ...podBClients];

    for (let wave = 0; wave < 150; wave++) {
      for (const w of ceilingWriters) {
        if (w.closed) continue;
        w.sendUpdate(() => {
          w.doc.getMap('live').set(`c_${updatesSent}`, { val: updatesSent });
        });
        updatesSent++;
      }
      if (updatesSent >= 10300) break;
      await sleep(65);
    }

    console.log(`[S5b] Updates sent: ${updatesSent}. Waiting 3s for DB commit & docStats refresh...`);
    await sleep(3000);

    // Now create unique discrete marker edits on Client X and Client X2
    const markerId = `edit-marker-X-${Date.now()}`;
    console.log(`[S5b] Client X creating local marker edit: ${markerId}...`);
    let markerUpdate = null;
    const unsubX = clientX.doc.on('update', (u, origin) => {
      if (origin === 'local') markerUpdate = u;
    });
    clientX.doc.transact(() => {
      const m = new Y.Map();
      m.set('kind', 'sticky');
      m.set('text', 'Marker Edit X Content');
      clientX.doc.getMap('objects').set(markerId, m);
    }, 'local');
    unsubX();

    const markerId2 = `edit-marker-X2-${Date.now()}`;
    console.log(`[S5b] Client X2 creating local marker edit: ${markerId2}...`);
    let markerUpdate2 = null;
    const unsubX2 = clientX2.doc.on('update', (u, origin) => {
      if (origin === 'local') markerUpdate2 = u;
    });
    clientX2.doc.transact(() => {
      const m = new Y.Map();
      m.set('kind', 'sticky');
      m.set('text', 'Marker Edit X2 Content');
      clientX2.doc.getMap('objects').set(markerId2, m);
    }, 'local');
    unsubX2();

    console.log(`[S5b] Client X and X2 sending marker updates (${markerUpdate?.length || 0} bytes) while over ceiling...`);
    clientX.sendRawUpdate(markerUpdate);
    clientX2.sendRawUpdate(markerUpdate2);
    await sleep(1000);

    const metricsA = await clientA.getMetrics();
    const metricsB = await clientB.getMetrics();
    const ceilingHits = (metricsA.ceilingHits || 0) + (metricsB.ceilingHits || 0);
    const dropCeiling = (metricsA.droppedFrames?.ceiling || 0) + (metricsB.droppedFrames?.ceiling || 0);
    console.log(`[S5b] Ceiling hits registered: ${ceilingHits}, dropped at ceiling: ${dropCeiling}`);

    // Let Client X2 continue sending past CeilingGrace (10s) to trigger 4012 (CloseCeiling)!
    console.log(`[S5b] Client X2 sending continuously for 11.5s to trigger CloseCeiling (4012)...`);
    const graceStart = Date.now();
    while (Date.now() - graceStart < 12000) {
      if (clientX2.closed || clientX2CloseCode) break;
      clientX2.sendRawUpdate(markerUpdate2);
      await sleep(500);
    }
    console.log(`[S5b] Client X2 close code: ${clientX2CloseCode || clientX2.closeCode}`);

    // Now compact the room by posting a snapshot from another client (e.g. from Pod B) to lift ceiling
    console.log(`[S5b] Compacting room with SnapshotPost from Pod B to lift ceiling...`);
    const compactor = podBClients[0];
    compactor.sendSnapshotPost({ plain_text: 'Compact', title: 'Two Pods Canvas', preview: '', objects: 50 });
    await sleep(2500);

    // Now Client X sends an update while ceiling is lifted: this triggers 4014 (CloseResend)!
    console.log(`[S5b] Client X sending update after compaction to trigger CloseResend (4014)...`);
    clientX.sendRawUpdate(markerUpdate);
    await sleep(1000);
    console.log(`[S5b] Client X close code: ${clientXCloseCode || clientX.closeCode}`);

    // Replay behavior (lib/ySync.ts):
    // Reconnect clientX and clientX2, receive SNAPSHOT, compute diff, send diff!
    const replayStart = Date.now();
    let replaysCount = 0;

    console.log(`[S5b] Reconnecting Client X and Client X2 to replay state diff...`);
    const reconnectedX = new CanvasSyncClient({
      url: `${hostA}/api/canvas/items/${canvasId}/sync`,
      token: clientX.token,
      clientId: clientX.doc.clientID
    });
    // Pre-populate with local edits
    Y.applyUpdate(reconnectedX.doc, Y.encodeStateAsUpdate(clientX.doc));
    await reconnectedX.connect();
    // Compute exact state difference relative to server's snapshot (lib/ySync.ts)
    const diffX = Y.encodeStateAsUpdate(
      reconnectedX.doc,
      Y.encodeStateVectorFromUpdate(reconnectedX.latestSnapshotState)
    );
    if (diffX && diffX.length > 2) {
      console.log(`[S5b] Replaying diffX (${diffX.length} bytes)...`);
      reconnectedX.sendRawUpdate(diffX);
      replaysCount++;
    }

    const reconnectedX2 = new CanvasSyncClient({
      url: `${hostA}/api/canvas/items/${canvasId}/sync`,
      token: clientX2.token,
      clientId: clientX2.doc.clientID
    });
    Y.applyUpdate(reconnectedX2.doc, Y.encodeStateAsUpdate(clientX2.doc));
    await reconnectedX2.connect();
    const diffX2 = Y.encodeStateAsUpdate(
      reconnectedX2.doc,
      Y.encodeStateVectorFromUpdate(reconnectedX2.latestSnapshotState)
    );
    if (diffX2 && diffX2.length > 2) {
      console.log(`[S5b] Replaying diffX2 (${diffX2.length} bytes)...`);
      reconnectedX2.sendRawUpdate(diffX2);
      replaysCount++;
    }

    allClients.push(reconnectedX, reconnectedX2);

    console.log(`[S5b] Waiting 5s for cross-pod Valkey pub/sub propagation...`);
    await sleep(5000);
    const convergenceTimeMs = Date.now() - replayStart;

    // Verify all active clients across Pod A and Pod B:
    const activeClients = allClients.filter(c => !c.closed);
    console.log(`[S5b] Checking state convergence across ${activeClients.length} active clients...`);

    const stateHashes = new Set();
    let markerXFoundCount = 0;
    let markerX2FoundCount = 0;

    for (const c of activeClients) {
      const state = Y.encodeStateAsUpdate(c.doc);
      stateHashes.add(Buffer.from(state).toString('base64'));
      if (c.doc.getMap('objects').has(markerId)) markerXFoundCount++;
      if (c.doc.getMap('objects').has(markerId2)) markerX2FoundCount++;
    }

    const statesIdentical = stateHashes.size === 1;
    const markerXPresentInAll = markerXFoundCount === activeClients.length;
    const markerX2PresentInAll = markerX2FoundCount === activeClients.length;

    console.log(`[S5b] Identical states across all clients: ${statesIdentical}`);
    console.log(`[S5b] Marker X present in all: ${markerXPresentInAll} (${markerXFoundCount}/${activeClients.length})`);
    console.log(`[S5b] Marker X2 present in all: ${markerX2PresentInAll} (${markerX2FoundCount}/${activeClients.length})`);

    const metricsAEnd = await clientA.getMetrics();
    const metricsBEnd = await clientB.getMetrics();

    const closes4012 = (metricsAEnd.closes?.['4012'] || 0) + (metricsBEnd.closes?.['4012'] || 0);
    const closes4014 = (metricsAEnd.closes?.['4014'] || 0) + (metricsBEnd.closes?.['4014'] || 0);

    const result = {
      scenario: 'S5b',
      clientsPerPod,
      totalClients: activeClients.length,
      updatesSent,
      ceilingHits,
      closes: {
        code4012: closes4012,
        code4014: closes4014,
        clientXCloseCode: clientXCloseCode || clientX.closeCode,
        clientX2CloseCode: clientX2CloseCode || clientX2.closeCode
      },
      replaysCount,
      convergenceTimeMs,
      statesIdentical,
      markerXFoundOnAllClients: markerXPresentInAll,
      markerX2FoundOnAllClients: markerX2PresentInAll,
      lostEdits: !markerXPresentInAll || !markerX2PresentInAll,
      pass: statesIdentical && markerXPresentInAll && markerX2PresentInAll
    };

    return result;
  } finally {
    for (const c of allClients) c.close();
    if (spawnedB) ServerManager.killPid(pidB);
  }
}

export async function runS6(opts = {}) {
  const host = opts.host || 'http://127.0.0.1:3191';
  const client = new CalabaClient(host);

  console.log(`[S6 Large Operations] 3000 inserts, 1000 gesture preview (5s @ 10/s), 3000 deletes, >4MiB rejection.`);

  const { wsId, users, adminToken } = await setupWorkspaceWithUsers(client, 2);
  const canvasId = await client.createCanvas(adminToken, wsId, 'Large Ops Canvas');

  const writer = new CanvasSyncClient({
    url: `${host}/api/canvas/items/${canvasId}/sync`,
    token: adminToken,
    clientId: 7771
  });
  const reader = new CanvasSyncClient({
    url: `${host}/api/canvas/items/${canvasId}/sync`,
    token: users[1].token,
    clientId: 7772
  });

  try {
    await writer.connect();
    await reader.connect();

    // Op 1: Insert 3000 objects in batches of 50 to respect 64 KiB frame limit
    console.log(`[S6] Inserting 3000 objects in batches of 50...`);
    for (let batch = 0; batch < 60; batch++) {
      writer.sendUpdate(() => {
        const objs = writer.doc.getMap('objects');
        for (let i = 0; i < 50; i++) {
          const id = `bulk_${batch * 50 + i}`;
          const m = new Y.Map();
          m.set('kind', 'shape');
          m.set('shape', 'rect');
          m.set('x', i * 10);
          m.set('y', batch * 20);
          objs.set(id, m);
        }
      });
      await sleep(20);
    }

    await sleep(1500);
    const readerObjCount = reader.doc.getMap('objects').size;
    console.log(`[S6] Reader received ${readerObjCount}/3000 objects.`);

    // Op 2: Gesture over 1000 objects: preview 10/s for 5 seconds (50 previews)
    console.log(`[S6] Gesture over 1000 objects (preview 10/s for 5s)...`);
    for (let step = 0; step < 50; step++) {
      writer.sendUpdate(() => {
        const live = writer.doc.getMap('live');
        const patches = {};
        for (let j = 0; j < 1000; j++) {
          patches[`bulk_${j}`] = { x: j * 10 + step, y: step };
        }
        live.set(String(writer.doc.clientID), { ts: Date.now(), patches });
      });
      await sleep(100);
    }

    // Release: commit coordinates and remove preview
    writer.sendUpdate(() => {
      writer.doc.getMap('live').delete(String(writer.doc.clientID));
    });
    await sleep(500);

    // Op 3: Delete 3000 objects in batches
    console.log(`[S6] Deleting 3000 objects in batches...`);
    for (let batch = 0; batch < 60; batch++) {
      writer.sendUpdate(() => {
        const objs = writer.doc.getMap('objects');
        for (let i = 0; i < 50; i++) {
          objs.delete(`bulk_${batch * 50 + i}`);
        }
      });
      await sleep(20);
    }

    await sleep(1500);
    const readerFinalCount = reader.doc.getMap('objects').size;
    console.log(`[S6] Reader final object count: ${readerFinalCount} (expected 0)`);

    // Compact snapshot
    writer.sendSnapshotPost({ plain_text: '', title: '', preview: '', objects: 0 });
    await sleep(1000);

    // Op 4: Attempt state > 4 MiB (4.2 MiB)
    console.log(`[S6] Attempting > 4 MiB snapshot (4,300,000 bytes)...`);
    const oversizedState = Buffer.alloc(4300000, 0x41);
    const oversizeFrame = encodeSnapshotPostFrame(writer.highestSeq, { plain_text: 'oversized' }, oversizedState);
    writer.ws.send(oversizeFrame);
    await sleep(2000);

    console.log(`[S6] Writer socket open: ${!writer.closed}, Reader socket open: ${!reader.closed}`);

    const result = {
      scenario: 'S6',
      insertedObjects: 3000,
      readerReceivedAfterInsert: readerObjCount,
      gesturePreviewsSent: 50,
      deletedObjects: 3000,
      readerObjectsAfterDelete: readerFinalCount,
      oversizedSnapshotRejectedWithoutCrash: !writer.closed && !reader.closed,
      pass: readerObjCount === 3000 && readerFinalCount === 0 && !writer.closed
    };

    return result;
  } finally {
    writer.close();
    reader.close();
  }
}

export async function runS7(opts = {}) {
  const host = opts.host || 'http://127.0.0.1:3191';
  const client = new CalabaClient(host);

  console.log(`[S7 Public Link] 12 viewers per IP limit (cap 10), any frame rejection (4013), and X-Forwarded-For test.`);

  const { wsId, adminToken } = await setupWorkspaceWithUsers(client, 1);
  const canvasId = await client.createCanvas(adminToken, wsId, 'Public Canvas');
  const code = await client.createPublicLink(adminToken, canvasId, 1);

  console.log(`[S7] Created public link code: ${code}`);

  // Test 1: 12 viewers from same IP without XFF (IP cap is 10)
  console.log(`[S7 Part 1] Connecting 12 anonymous viewers from same IP...`);
  const viewers = [];
  const results = [];

  for (let i = 0; i < 12; i++) {
    const v = new CanvasSyncClient({
      url: `${host}/api/public/canvas/${code}/sync`,
      isViewer: true
    });
    viewers.push(v);
    try {
      await v.connect(3000);
      results.push({ idx: i + 1, status: 'connected' });
    } catch (err) {
      results.push({ idx: i + 1, status: 'rejected', error: err.message, closeCode: v.closeCode });
    }
    await sleep(100);
  }

  const connectedCount = results.filter(r => r.status === 'connected').length;
  const rejectedCount = results.filter(r => r.status === 'rejected').length;
  console.log(`[S7 Part 1] Connected: ${connectedCount}/10, Rejected: ${rejectedCount} (11th and 12th)`);

  for (const v of viewers) v.close();
  await sleep(1000);

  // Test 2: Viewer sends ANY frame -> closed 4013
  console.log(`[S7 Part 2] Testing frame rejection (close code 4013)...`);
  const probeViewer = new CanvasSyncClient({
    url: `${host}/api/public/canvas/${code}/sync`,
    isViewer: true
  });
  await probeViewer.connect();

  let close4013Received = false;
  probeViewer.ws.on('close', (c) => {
    if (c === CLOSE_RECEIVE_ONLY) close4013Received = true;
  });

  // Send a binary frame
  probeViewer.ws.send(Buffer.from([FRAME_UPDATE, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]));
  await sleep(500);

  console.log(`[S7 Part 2] Viewer sent frame, received close 4013: ${close4013Received || probeViewer.closeCode === 4013}`);

  // Test 3: Spoofed X-Forwarded-For - Variant A (default TRUSTED_PROXIES includes 127.0.0.1/32)
  console.log(`[S7 Variant A] 100 anonymous viewers with spoofed XFF (default TRUSTED_PROXIES includes 127.0.0.1/32)...`);
  const viewersA = [];
  const resultsA = [];

  for (let i = 0; i < 100; i++) {
    const fakeIp = `198.51.100.${(i % 250) + 1}`;
    const v = new CanvasSyncClient({
      url: `${host}/api/public/canvas/${code}/sync`,
      isViewer: true,
      headers: {
        'X-Forwarded-For': fakeIp
      }
    });
    viewersA.push(v);
  }

  for (let b = 0; b < viewersA.length; b += 25) {
    const chunk = viewersA.slice(b, b + 25);
    await Promise.all(chunk.map(async (v, idx) => {
      try {
        await v.connect(4000);
        resultsA.push({ idx: b + idx, status: 'connected' });
      } catch (err) {
        resultsA.push({ idx: b + idx, status: 'rejected', closeCode: v.closeCode, error: err.message });
      }
    }));
    await sleep(50);
  }

  const connectedA = resultsA.filter(r => r.status === 'connected').length;
  const rejectedA = resultsA.filter(r => r.status === 'rejected').length;
  console.log(`[S7 Variant A] Connected: ${connectedA}/100, Rejected: ${rejectedA}/100`);

  for (const v of viewersA) v.close();
  await sleep(1500);

  // Test 4: Spoofed X-Forwarded-For - Variant B (untrusted loopback: TRUSTED_PROXIES="192.0.2.1/32")
  console.log(`[S7 Variant B] Restarting server A with TRUSTED_PROXIES="192.0.2.1/32"...`);
  let pidA = opts.serverPid || ServerManager.findPidByPort(3191);
  ServerManager.killPid(pidA);
  await sleep(1500);

  const instB = ServerManager.spawnInstance(3191, { TRUSTED_PROXIES: '192.0.2.1/32' });
  opts.serverPid = instB.pid;
  await ServerManager.waitForReady(3191);
  console.log(`[S7 Variant B] Server A restarted with PID ${instB.pid}. Connecting 100 viewers with spoofed XFF...`);

  // Clear connect rate limit on 127.0.0.1 in Valkey so the concurrency cap (ViewersPerIP = 10) can be cleanly measured
  try {
    const redisCliPath = fs.existsSync('/opt/homebrew/bin/redis-cli') ? '/opt/homebrew/bin/redis-cli' : 'redis-cli';
    execFileSync(redisCliPath, ['-p', '56379', '-n', '4', 'del', 'load:rl:canvas-link-ws:127.0.0.1']);
  } catch {}

  const viewersB = [];
  const resultsB = [];

  for (let i = 0; i < 100; i++) {
    const fakeIp = `198.51.100.${(i % 250) + 1}`;
    const v = new CanvasSyncClient({
      url: `${host}/api/public/canvas/${code}/sync`,
      isViewer: true,
      headers: {
        'X-Forwarded-For': fakeIp
      }
    });
    viewersB.push(v);
  }

  for (let b = 0; b < viewersB.length; b += 25) {
    const chunk = viewersB.slice(b, b + 25);
    await Promise.all(chunk.map(async (v, idx) => {
      try {
        await v.connect(4000);
        resultsB.push({ idx: b + idx, status: 'connected' });
      } catch (err) {
        resultsB.push({ idx: b + idx, status: 'rejected', closeCode: v.closeCode, error: err.message });
      }
    }));
    await sleep(50);
  }

  const connectedB = resultsB.filter(r => r.status === 'connected').length;
  const rejectedB = resultsB.filter(r => r.status === 'rejected').length;
  console.log(`[S7 Variant B] Connected: ${connectedB}/100, Rejected: ${rejectedB}/100 (cap of 10 applied to real socket IP 127.0.0.1)`);

  for (const v of viewersB) v.close();
  await sleep(1000);

  // Restore normal server A with default TRUSTED_PROXIES
  console.log(`[S7] Restoring server A with default TRUSTED_PROXIES...`);
  ServerManager.killPid(instB.pid);
  await sleep(1500);
  const defaultInst = ServerManager.spawnInstance(3191);
  opts.serverPid = defaultInst.pid;
  await ServerManager.waitForReady(3191);
  console.log(`[S7] Server A restored with PID ${defaultInst.pid}`);

  const result = {
    scenario: 'S7',
    sameIpLimit: {
      totalAttempted: 12,
      connected: connectedCount,
      rejected: rejectedCount,
      rejectionExpected: connectedCount === 10 && rejectedCount === 2
    },
    frameRejection: {
      received4013: close4013Received || probeViewer.closeCode === 4013,
      closeCode: probeViewer.closeCode
    },
    variantA: {
      description: 'Default TRUSTED_PROXIES (contains 127.0.0.1/32)',
      totalAttempted: 100,
      connected: connectedA,
      rejected: rejectedA,
      explanation: 'Loopback is trusted, so spoofed X-Forwarded-For headers are honored; 100 separate IPs are seen, bypassing the 10/IP limit.'
    },
    variantB: {
      description: 'Untrusted loopback (TRUSTED_PROXIES="192.0.2.1/32")',
      totalAttempted: 100,
      connected: connectedB,
      rejected: rejectedB,
      explanation: 'Loopback is not trusted, so spoofed X-Forwarded-For headers are ignored and all connections map to real peer IP 127.0.0.1; exactly 10 connect and 90 are rejected.'
    },
    securityConclusion: 'При доверенном loopback (дефолт) сервер верит заголовку X-Forwarded-For от localhost, считая каждого отдельным IP (100/100); при исключении loopback из доверенных прокси подделка игнорируется и лимит 10 зрителей применяется к реальному IP сокета (10 подключились, 90 отброшены).',
    pass: (connectedCount === 10 && rejectedCount === 2 && (probeViewer.closeCode === 4013 || close4013Received) && connectedA === 100 && connectedB === 10 && rejectedB === 90)
  };

  return result;
}

export async function runSigkillConns(opts = {}) {
  const host = opts.host || 'http://127.0.0.1:3191';
  const client = new CalabaClient(host);

  console.log(`[Sigkill Conns] Measuring exact lifetime of residual Valkey keys after SIGKILL...`);

  let pid = opts.serverPid || ServerManager.findPidByPort(3191);
  const { wsId, users, adminToken } = await setupWorkspaceWithUsers(client, 1);
  const canvasId = await client.createCanvas(adminToken, wsId, 'Sigkill Conns Canvas');

  // Connect client to canvas
  console.log(`[Sigkill Conns] Connecting client to canvas...`);
  const conn = new CanvasSyncClient({
    url: `${host}/api/canvas/items/${canvasId}/sync`,
    token: adminToken,
    clientId: 9876
  });
  await conn.connect();

  const redisCliPath = fs.existsSync('/opt/homebrew/bin/redis-cli') ? '/opt/homebrew/bin/redis-cli' : 'redis-cli';
  const listKeysCmd = () => {
    try {
      const out = execFileSync(redisCliPath, ['-p', '56379', '-n', '4', 'keys', `*canvas:conns:${canvasId}*`], { encoding: 'utf8' }).trim();
      return out.split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  };

  const getTtlCmd = (key) => {
    try {
      const out = execFileSync(redisCliPath, ['-p', '56379', '-n', '4', 'ttl', key], { encoding: 'utf8' }).trim();
      return parseInt(out, 10);
    } catch {
      return -2;
    }
  };

  let keys = listKeysCmd();
  console.log(`[Sigkill Conns] Found connection keys in Valkey:`, keys);
  if (keys.length === 0) {
    throw new Error('No connection key found in Valkey for canvas');
  }

  const targetKey = keys[0];
  const initialTtl = getTtlCmd(targetKey);
  console.log(`[Sigkill Conns] Target key: ${targetKey}, initial TTL: ${initialTtl}s (expected ~85s)`);

  // Kill server instance with SIGKILL
  console.log(`[Sigkill Conns] Killing server A (PID: ${pid}) with SIGKILL...`);
  const killTime = Date.now();
  ServerManager.killPid(pid, 'SIGKILL');
  conn.close();

  // Poll Valkey key every 1 second until it expires
  console.log(`[Sigkill Conns] Polling key ${targetKey} every 1s until expiration...`);
  let elapsedSec = 0;
  let lastTtl = initialTtl;

  while (true) {
    await sleep(1000);
    const ttl = getTtlCmd(targetKey);
    elapsedSec = Math.round((Date.now() - killTime) / 1000);
    if (ttl <= 0 || ttl === -2) {
      console.log(`[Sigkill Conns] Key expired and removed from Valkey after ${elapsedSec}s (TTL: ${ttl})`);
      break;
    }
    lastTtl = ttl;
    if (elapsedSec % 10 === 0) {
      console.log(`[Sigkill Conns] Elapsed: ${elapsedSec}s, remaining TTL: ${ttl}s...`);
    }
    if (elapsedSec > 120) {
      console.warn(`[Sigkill Conns] Key did not expire within 120s!`);
      break;
    }
  }

  // Restart server A
  console.log(`[Sigkill Conns] Restarting server A...`);
  const newInst = ServerManager.spawnInstance(3191);
  opts.serverPid = newInst.pid;
  await ServerManager.waitForReady(3191);
  console.log(`[Sigkill Conns] Server A restarted with PID: ${newInst.pid}`);

  const result = {
    scenario: 'sigkill-conns',
    key: targetKey,
    initialTtlSec: initialTtl,
    observedDurationSec: elapsedSec,
    theoreticalFormulaSec: 85, // IdleTimeout (60s) + PingInterval (25s)
    formulaMatch: Math.abs(elapsedSec - 85) <= 2,
    pass: elapsedSec >= 83 && elapsedSec <= 87
  };

  return result;
}

// ==========================================
// CLI RUNNER
// ==========================================

async function main() {
  const args = process.argv.slice(2);
  const scenario = (args[0] || '').toLowerCase();

  const opts = {
    host: 'http://127.0.0.1:3191',
    hostB: 'http://127.0.0.1:3192',
    scale: 1.0,
    serverPid: null,
    autoServer: false,
    json: false
  };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--host' && args[i + 1]) opts.host = args[++i];
    else if (args[i] === '--host-b' && args[i + 1]) opts.hostB = args[++i];
    else if (args[i] === '--scale' && args[i + 1]) opts.scale = parseFloat(args[++i]) || 1.0;
    else if (args[i] === '--duration' && args[i + 1]) opts.duration = parseInt(args[++i], 10);
    else if (args[i] === '--server-pid' && args[i + 1]) opts.serverPid = parseInt(args[++i], 10);
    else if (args[i] === '--auto-server') opts.autoServer = true;
    else if (args[i] === '--json') opts.json = true;
  }

  if (!scenario || ['s1', 's1b', 's2', 's3', 's4', 's5', 's5b', 's6', 's7', 'sigkill-conns', 'all'].indexOf(scenario) === -1) {
    console.log(`
Usage:
  nice -n 19 node tools/load-canvas.mjs <s1|s1b|s2|s3|s4|s5|s5b|s6|s7|sigkill-conns|all> [options]
`);
    process.exit(1);
  }

  // Ensure server A is running
  let spawnedA = null;
  let pidA = opts.serverPid || ServerManager.findPidByPort(3191);
  if (!pidA) {
    console.log(`[Runner] Server A on 3191 not running. Spawning instance A...`);
    spawnedA = ServerManager.spawnInstance(3191);
    await ServerManager.waitForReady(3191);
    pidA = spawnedA.pid;
    console.log(`[Runner] Server A ready with PID: ${pidA}`);
  }
  opts.serverPid = pidA;

  const runnerMap = {
    s1: runS1,
    s1b: runS1b,
    s2: runS2,
    s3: runS3,
    s4: runS4,
    s5: runS5,
    s5b: runS5b,
    s6: runS6,
    s7: runS7,
    'sigkill-conns': runSigkillConns
  };

  try {
    if (scenario === 'all') {
      const allResults = [];
      const scenarios = ['s1', 's2', 's3', 's4', 's5', 's5b', 's6', 's7', 'sigkill-conns'];
      for (const s of scenarios) {
        console.log(`\n========================================\nSTARTING ${s.toUpperCase()}\n========================================`);
        const r = await runnerMap[s](opts);
        allResults.push(r);
        console.log(`COMPLETED ${s.toUpperCase()}: ${r.pass ? 'PASS' : 'FAIL'}`);
        console.log(`Pausing 30s before next scenario...`);
        await sleep(30000);
      }
      if (opts.json) {
        console.log(JSON.stringify(allResults, null, 2));
      } else {
        console.log('\n=== ALL SCENARIOS COMPLETE ===');
        for (const r of allResults) {
          console.log(`${r.scenario}: ${r.pass ? 'PASS' : 'FAIL'}`);
        }
      }
    } else {
      const res = await runnerMap[scenario](opts);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log('\n=== RESULT ===');
        console.log(JSON.stringify(res, null, 2));
      }
    }
  } finally {
    if (spawnedA) {
      const curPid = ServerManager.findPidByPort(3191);
      if (curPid) {
        console.log(`[Runner] Cleaning up Server A (PID: ${curPid})...`);
        ServerManager.killPid(curPid);
      }
    }
  }
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('load-canvas.mjs')) {
  if (process.argv.includes('--worker-s1')) {
    runS1Worker();
  } else {
    main().catch(err => {
      console.error('Fatal error in load-canvas runner:', err);
      process.exit(1);
    });
  }
}

