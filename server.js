const http = require('http');
const net  = require('net');
const fs   = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────
const API_PORT  = 4000;
const PUSH_PORT = 8000;
const DATA_FILE        = path.join(__dirname, 'attendance_data.json');
const DATA_BACKUP      = path.join(__dirname, 'attendance_data.backup.json');
const MANUAL_ATT_FILE  = path.join(__dirname, 'manual_attendance.json');
const MANUAL_BACKUP    = path.join(__dirname, 'manual_attendance.backup.json');
const EMPLOYEES_FILE   = path.join(__dirname, 'employees_data.json');
const ADVANCE_FILE     = path.join(__dirname, 'advance_data.json');

const DEVICE_TYPE = {
  'NYU7244800271': 'in',   // IN machine  — 192.168.31.85
  'NYU7244800106': 'out',  // OUT machine — 192.168.31.207
};

// ── Persistent storage ───────────────────────────────────
function loadLogs() {
  let mainData = [], backupData = [];
  try {
    if (fs.existsSync(DATA_FILE))
      mainData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.log('[INIT] Main file error:', e.message); }
  try {
    if (fs.existsSync(DATA_BACKUP))
      backupData = JSON.parse(fs.readFileSync(DATA_BACKUP, 'utf8'));
  } catch (e) { console.log('[INIT] Backup file error:', e.message); }

  // Use whichever has MORE records — never load less data
  if (backupData.length > mainData.length) {
    console.log(`[INIT] ⚠️  Backup has more records (${backupData.length} vs ${mainData.length}) — restoring from backup`);
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(backupData), 'utf8'); } catch {}
    console.log(`[INIT] Loaded ${backupData.length} records (from backup)`);
    return backupData;
  }
  console.log(`[INIT] Loaded ${mainData.length} records from disk`);
  return mainData;
}

function saveLogs() {
  try {
    // Integrity check: never overwrite with significantly fewer records
    if (fs.existsSync(DATA_FILE)) {
      try {
        const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (existing.length > logs.length + 20) {
          console.log(`[SAVE] ⚠️  Skipping — file has ${existing.length} records, memory has ${logs.length} (possible data loss)`);
          return;
        }
      } catch {}
    }
    // Save backup copy first, then main file
    if (fs.existsSync(DATA_FILE))
      fs.copyFileSync(DATA_FILE, DATA_BACKUP);
    fs.writeFileSync(DATA_FILE, JSON.stringify(logs), 'utf8');
  } catch (e) {
    console.log('[SAVE] Error saving data:', e.message);
  }
}

// In-memory log (loaded from disk on start)
const logs = loadLogs();

// Auto-save every 5 minutes (extra safety net)
setInterval(() => { saveLogs(); }, 5 * 60 * 1000);

// ── Manual Attendance helpers ────────────────────────────
function loadManualAtt() {
  let mainData = {}, backupData = {};
  try {
    if (fs.existsSync(MANUAL_ATT_FILE))
      mainData = JSON.parse(fs.readFileSync(MANUAL_ATT_FILE, 'utf8'));
  } catch {}
  try {
    if (fs.existsSync(MANUAL_BACKUP))
      backupData = JSON.parse(fs.readFileSync(MANUAL_BACKUP, 'utf8'));
  } catch {}
  // Use whichever has more dates
  const mainDates   = Object.keys(mainData).length;
  const backupDates = Object.keys(backupData).length;
  if (backupDates > mainDates) {
    console.log(`[INIT] ⚠️  Manual backup has more dates (${backupDates} vs ${mainDates}) — restoring`);
    try { fs.writeFileSync(MANUAL_ATT_FILE, JSON.stringify(backupData), 'utf8'); } catch {}
    return backupData;
  }
  return mainData;
}
function saveManualAtt(data) {
  // Save backup first, then main
  if (fs.existsSync(MANUAL_ATT_FILE))
    try { fs.copyFileSync(MANUAL_ATT_FILE, MANUAL_BACKUP); } catch {}
  fs.writeFileSync(MANUAL_ATT_FILE, JSON.stringify(data), 'utf8');
}
const manualAtt = loadManualAtt();

// ── Employees helpers ────────────────────────────────────
function loadEmployeesData() {
  try {
    if (fs.existsSync(EMPLOYEES_FILE))
      return JSON.parse(fs.readFileSync(EMPLOYEES_FILE, 'utf8'));
  } catch {}
  return null;
}
function saveEmployeesData(data) {
  fs.writeFileSync(EMPLOYEES_FILE, JSON.stringify(data), 'utf8');
}
let employeesData = loadEmployeesData();

// ── Advance helpers ──────────────────────────────────────
function loadAdvanceData() {
  try {
    if (fs.existsSync(ADVANCE_FILE))
      return JSON.parse(fs.readFileSync(ADVANCE_FILE, 'utf8'));
  } catch {}
  return {};
}
function saveAdvanceData(data) {
  fs.writeFileSync(ADVANCE_FILE, JSON.stringify(data), 'utf8');
}
let advanceData = loadAdvanceData();

// Track which devices have been told to sync (reset on server start)
const syncSent = {};

// Pending commands queue per device SN
const pendingCmds = {};

// ── Helpers ─────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c.toString());
    req.on('end',  () => resolve(data));
  });
}

function deviceType(sn) {
  return DEVICE_TYPE[sn] || 'unknown';
}

function localIST(isoStr) {
  const d = new Date(isoStr);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth()+1).padStart(2,'0')}-${String(ist.getUTCDate()).padStart(2,'0')}`;
}

// ── ZKTeco ADMS Push Server (port 8000) ─────────────────
const pushServer = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PUSH_PORT}`);
  const reqPath = urlObj.pathname;
  const sn      = urlObj.searchParams.get('SN') || 'unknown';
  const table   = urlObj.searchParams.get('table') || '';

  res.setHeader('Content-Type', 'text/plain');

  // Log every incoming request
  console.log(`[REQ] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

  // ── Device heartbeat / init ──
  if (reqPath === '/iclock/cdata' && req.method === 'GET') {
    console.log(`[PUSH] Heartbeat from SN=${sn} (${deviceType(sn)})`);
    res.writeHead(200);
    // ATTStamp=0 tells device to resend all attendance records
    res.end(
      `GET OPTION FROM: ${sn}\r\n` +
      `ATTStamp=0\r\n` +
      `OPERStamp=0\r\n` +
      `ErrorDelay=30\r\n` +
      `Delay=10\r\n` +
      `TransTimes=00:00;14:05\r\n` +
      `TransInterval=1\r\n` +
      `TransFlag=1111000000\r\n` +
      `Realtime=1\r\n` +
      `Encrypt=None\r\n`
    );
    return;
  }

  // ── Device pushing attendance data ──
  if (reqPath === '/iclock/cdata' && req.method === 'POST') {
    const body = await parseBody(req);
    console.log(`[PUSH] POST from SN=${sn} table=${table} body-length=${body.length}`);

    if (table === 'ATTLOG') {
      const lines = body.trim().split('\n');
      let count = 0;
      for (const line of lines) {
        const parts = line.trim().split('\t');
        if (parts.length < 2) continue;
        const userId    = parts[0].trim();
        const timeStr   = parts[1].trim();
        const statusRaw = parseInt(parts[2] || '0');
        const ts        = new Date(timeStr.replace(' ', 'T') + '+05:30').toISOString();

        // Deduplicate by userId + timestamp + sn
        const key = `${sn}|${userId}|${ts}`;
        if (!logs.find(r => `${r.sn}|${r.userId}|${r.timestamp}` === key)) {
          let type = deviceType(sn);
          if (type === 'unknown') type = statusRaw === 0 ? 'in' : 'out';
          logs.push({ userId, type, timestamp: ts, sn });
          count++;
        }
      }
      if (count > 0) {
        saveLogs();
        console.log(`[PUSH] SN=${sn} (${deviceType(sn)}) saved ${count} new records (total=${logs.length})`);
      }
    }

    res.writeHead(200);
    res.end('OK');
    return;
  }

  // ── Device asking for commands ──
  if (reqPath === '/iclock/getrequest') {
    // First time after server start: send DATA UPDATE to trigger full sync
    if (!syncSent[sn]) {
      syncSent[sn] = true;
      const cmdId = Date.now();
      console.log(`[PUSH] getrequest SN=${sn} — sending DATA UPDATE command id=${cmdId}`);
      res.writeHead(200);
      res.end(`C:${cmdId}:DATA UPDATE\r\n`);
      return;
    }
    // Send any pending commands queued via API
    if (pendingCmds[sn] && pendingCmds[sn].length > 0) {
      const cmd = pendingCmds[sn].shift();
      console.log(`[PUSH] getrequest SN=${sn} — sending queued cmd: ${cmd.cmd}`);
      res.writeHead(200);
      res.end(`C:${cmd.id}:${cmd.cmd}\r\n`);
      return;
    }
    res.writeHead(200);
    res.end('OK');
    return;
  }

  // ── Device acknowledging a command ──
  if (reqPath === '/iclock/devicecmd') {
    const cmdId = urlObj.searchParams.get('CMD') || '';
    const result = urlObj.searchParams.get('result') || '';
    console.log(`[PUSH] devicecmd SN=${sn} CMD=${cmdId} result=${result}`);
    res.writeHead(200);
    res.end('OK');
    return;
  }

  res.writeHead(200);
  res.end('OK');
});

// ── ZKTeco Pull SDK — read users + attlogs from device ───
function zkPull(deviceIp) {
  return new Promise((resolve) => {
    const result = { users: [], attlogs: [], error: null };
    const client = new net.Socket();
    let sessionId = 0, replyId = 0;
    let buf = Buffer.alloc(0);
    let step = 'connect';
    let freeDataSize = 0, dataReceived = Buffer.alloc(0);

    const CMD_CONNECT    = 1000;
    const CMD_ACK_OK     = 2000;
    const CMD_DISCONNECT = 1001;
    const CMD_GET_FREE_SIZES = 50;
    const CMD_USERTEMP_RRQ   = 9;
    const CMD_ATTLOG_RRQ     = 1501;
    const CMD_PREPARE_DATA   = 1500;
    const CMD_DATA           = 1502;
    const CMD_FREE_DATA      = 1502;
    const CMD_ACK_OK_DATA    = 2002;

    client.setTimeout(8000);

    function calcChecksum(buf) {
      let cs = 0;
      for (let i = 0; i < buf.length; i += 2) {
        cs += (i + 1 < buf.length) ? buf.readUInt16LE(i) : buf[i];
      }
      while (cs > 0xFFFF) cs = (cs >> 16) + (cs & 0xFFFF);
      return (~cs) & 0xFFFF;
    }

    function buildPacket(cmd, sid, rid, data) {
      const d = data || Buffer.alloc(0);
      const p = Buffer.alloc(8 + d.length);
      p.writeUInt16LE(cmd, 0);
      p.writeUInt16LE(0,   2);
      p.writeUInt16LE(sid, 4);
      p.writeUInt16LE(rid, 6);
      if (d.length) d.copy(p, 8);
      p.writeUInt16LE(calcChecksum(p), 2);
      return p;
    }

    function parseUsers(data) {
      const users = [];
      let i = 0;
      while (i + 28 <= data.length) {
        const uid  = data.readUInt16LE(i);
        const name = data.slice(i + 8, i + 24).toString('ascii').replace(/\0/g,'').trim();
        if (uid > 0) users.push({ uid: String(uid), name: name || '' });
        i += 28;
      }
      return users;
    }

    function parseAttlogs(data) {
      const recs = [];
      let i = 0;
      while (i + 16 <= data.length) {
        const uid  = data.readUInt16LE(i);
        const sec  = data.readUInt32LE(i + 4);
        const type = data[i + 8] || 0;
        if (uid > 0 && sec > 0) {
          const ts = new Date(sec * 1000).toISOString();
          recs.push({ userId: String(uid), type: type === 0 ? 'in' : 'out', timestamp: ts });
        }
        i += 16;
      }
      return recs;
    }

    client.connect(4370, deviceIp, () => {
      client.write(buildPacket(CMD_CONNECT, 0, ++replyId, null));
    });

    client.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const cmd = buf.readUInt16LE(0);
        const sid = buf.readUInt16LE(4);
        const payloadLen = buf.length - 8;

        if (cmd === CMD_ACK_OK && step === 'connect') {
          sessionId = sid;
          step = 'get_users';
          buf = Buffer.alloc(0);
          // Request user list
          client.write(buildPacket(CMD_USERTEMP_RRQ, sessionId, ++replyId, null));
          return;
        }

        if (step === 'get_users') {
          if (cmd === CMD_PREPARE_DATA || cmd === 1024) {
            freeDataSize = payloadLen > 0 ? buf.readUInt32LE(8) : 0;
            dataReceived = Buffer.alloc(0);
            buf = Buffer.alloc(0);
            return;
          }
          if (cmd === CMD_DATA || cmd === 2002) {
            dataReceived = Buffer.concat([dataReceived, buf.slice(8)]);
            buf = Buffer.alloc(0);
            if (dataReceived.length >= freeDataSize && freeDataSize > 0) {
              result.users = parseUsers(dataReceived);
              step = 'get_attlogs';
              freeDataSize = 0; dataReceived = Buffer.alloc(0);
              client.write(buildPacket(CMD_ATTLOG_RRQ, sessionId, ++replyId, null));
            }
            return;
          }
          if (cmd === CMD_ACK_OK) {
            // Device sent ACK but no data — try attlogs anyway
            step = 'get_attlogs';
            buf = Buffer.alloc(0);
            client.write(buildPacket(CMD_ATTLOG_RRQ, sessionId, ++replyId, null));
            return;
          }
          buf = Buffer.alloc(0);
          return;
        }

        if (step === 'get_attlogs') {
          if (cmd === CMD_PREPARE_DATA || cmd === 1024) {
            freeDataSize = payloadLen > 0 ? buf.readUInt32LE(8) : 0;
            dataReceived = Buffer.alloc(0);
            buf = Buffer.alloc(0);
            return;
          }
          if (cmd === CMD_DATA || cmd === 2002) {
            dataReceived = Buffer.concat([dataReceived, buf.slice(8)]);
            buf = Buffer.alloc(0);
            if (dataReceived.length >= freeDataSize && freeDataSize > 0) {
              result.attlogs = parseAttlogs(dataReceived);
              step = 'done';
              client.write(buildPacket(CMD_DISCONNECT, sessionId, ++replyId, null));
              setTimeout(() => { client.destroy(); resolve(result); }, 300);
            }
            return;
          }
          if (cmd === CMD_ACK_OK) {
            step = 'done';
            buf = Buffer.alloc(0);
            client.destroy();
            resolve(result);
            return;
          }
          buf = Buffer.alloc(0);
          return;
        }

        buf = buf.slice(8 + payloadLen);
      }
    });

    client.on('timeout', () => {
      result.error = 'timeout at step=' + step;
      client.destroy();
      resolve(result);
    });
    client.on('error', (e) => {
      result.error = e.message;
      resolve(result);
    });
  });
}

// ── Attendance API Server (port 4000) ────────────────────
const apiServer = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${API_PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (urlObj.pathname === '/api/attendance') {
    const date  = urlObj.searchParams.get('date');
    const smart = urlObj.searchParams.get('smart') === '1';
    let records = [...logs];
    if (date) records = records.filter(r => localIST(r.timestamp) === date);

    if (smart) {
      const byUser = {};
      for (const r of records) {
        if (!byUser[r.userId]) byUser[r.userId] = { in: null, out: null };
        if (r.type === 'in') {
          if (!byUser[r.userId].in || r.timestamp < byUser[r.userId].in)
            byUser[r.userId].in = r.timestamp;
        } else {
          if (!byUser[r.userId].out || r.timestamp > byUser[r.userId].out)
            byUser[r.userId].out = r.timestamp;
        }
      }
      const summary = Object.entries(byUser).map(([userId, t]) => ({ userId, ...t }));
      res.writeHead(200);
      res.end(JSON.stringify({ records: summary }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({ records }));
    return;
  }

  // All records grouped by date (for backfill)
  if (urlObj.pathname === '/api/all-records') {
    const byDate = {};
    for (const r of logs) {
      const d = localIST(r.timestamp);
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(r);
    }
    res.writeHead(200);
    res.end(JSON.stringify({ byDate, total: logs.length }));
    return;
  }

  // Get distinct device user IDs seen in ATTLOG
  if (urlObj.pathname === '/api/device-users') {
    const distinctIds = [...new Set(logs.map(r => r.userId))];
    const users = distinctIds.map(uid => ({ uid, name: '' }));
    res.writeHead(200);
    res.end(JSON.stringify({ users }));
    return;
  }

  // Queue a command to a device — POST /api/queue-command body: {sn, cmd}
  if (urlObj.pathname === '/api/queue-command' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { sn: targetSn, cmd } = JSON.parse(body);
      if (!targetSn || !cmd) { res.writeHead(400); res.end(JSON.stringify({ error: 'sn and cmd required' })); return; }
      if (!pendingCmds[targetSn]) pendingCmds[targetSn] = [];
      pendingCmds[targetSn].push({ id: Date.now(), cmd });
      console.log(`[API] Queued cmd for SN=${targetSn}: ${cmd}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, queued: cmd }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // Manual attendance: GET /api/manual-attendance?date=YYYY-MM-DD
  if (urlObj.pathname === '/api/manual-attendance' && req.method === 'GET') {
    const date = urlObj.searchParams.get('date');
    res.writeHead(200);
    res.end(JSON.stringify(date ? (manualAtt[date] || {}) : manualAtt));
    return;
  }

  // Manual attendance: POST /api/manual-attendance?date=YYYY-MM-DD  body: {EM001:{inTime,outTime},...}
  if (urlObj.pathname === '/api/manual-attendance' && req.method === 'POST') {
    const date = urlObj.searchParams.get('date');
    if (!date) { res.writeHead(400); res.end(JSON.stringify({ error: 'date required' })); return; }
    const body = await parseBody(req);
    try {
      manualAtt[date] = JSON.parse(body);
      saveManualAtt(manualAtt);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // Advance: GET /api/advance?period=2026-05_16-31
  if (urlObj.pathname === '/api/advance' && req.method === 'GET') {
    const period = urlObj.searchParams.get('period');
    res.writeHead(200);
    res.end(JSON.stringify(period ? (advanceData[period] || {}) : advanceData));
    return;
  }

  // Advance: POST /api/advance?period=2026-05_16-31  body: {EM001:500,...}
  if (urlObj.pathname === '/api/advance' && req.method === 'POST') {
    const period = urlObj.searchParams.get('period');
    if (!period) { res.writeHead(400); res.end(JSON.stringify({ error: 'period required' })); return; }
    const body = await parseBody(req);
    try {
      const incoming = JSON.parse(body);
      advanceData[period] = Object.assign(advanceData[period] || {}, incoming);
      saveAdvanceData(advanceData);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // Employees: GET /api/employees
  if (urlObj.pathname === '/api/employees' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ list: employeesData }));
    return;
  }

  // Employees: POST /api/employees  body: {list:[...]}
  if (urlObj.pathname === '/api/employees' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      employeesData = JSON.parse(body).list;
      saveEmployeesData(employeesData);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (urlObj.pathname === '/health') {
    const deviceList = Object.entries(DEVICE_TYPE).map(([sn, type]) => ({ sn, type }));
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', devices: deviceList, total: logs.length }));
    return;
  }

  // Serve index.html so the app runs on http://localhost:4000 (same origin = no CORS issues)
  if (urlObj.pathname === '/' || urlObj.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200);
      res.end(html);
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'index.html not found' }));
    }
    return;
  }

  res.writeHead(404);
  res.end('{}');
});

// ── Start ────────────────────────────────────────────────
pushServer.listen(PUSH_PORT, () => {
  console.log(`ZKTeco Push server  : http://0.0.0.0:${PUSH_PORT}`);
  console.log(`Attendance API      : http://localhost:${API_PORT}/api/attendance`);
});

apiServer.listen(API_PORT, () => {
  console.log(`API server started on port ${API_PORT}`);
});
