const net = require('net');

const IN_DEVICE  = '192.168.31.85';
const OUT_DEVICE = '192.168.31.207';
const TARGET_PIN = '005';

function calcChecksum(buf) {
  let cs = 0;
  for (let i = 0; i < buf.length; i += 2)
    cs += (i + 1 < buf.length) ? buf.readUInt16LE(i) : buf[i];
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

function zkSession(ip) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let buf = Buffer.alloc(0);
    let sessionId = 0, replyId = 0;
    let step = 'connect';
    let freeDataSize = 0, dataReceived = Buffer.alloc(0);
    let templates = [];

    const CMD_CONNECT      = 1000;
    const CMD_ACK_OK       = 2000;
    const CMD_DISCONNECT   = 1001;
    const CMD_USERTEMP_RRQ = 9;
    const CMD_PREPARE_DATA = 1500;
    const CMD_DATA         = 1502;
    const CMD_FREE_DATA    = 1502;

    client.setTimeout(10000);

    client.connect(4370, ip, () => {
      console.log(`[${ip}] Connected`);
      client.write(buildPacket(CMD_CONNECT, 0, ++replyId, null));
    });

    client.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);

      while (buf.length >= 8) {
        const cmd        = buf.readUInt16LE(0);
        const sid        = buf.readUInt16LE(4);
        const payloadLen = buf.length - 8;

        if (cmd === CMD_ACK_OK && step === 'connect') {
          sessionId = sid;
          step = 'get_templates';
          buf = Buffer.alloc(0);
          console.log(`[${ip}] Session=${sessionId}, requesting templates...`);
          client.write(buildPacket(CMD_USERTEMP_RRQ, sessionId, ++replyId, null));
          return;
        }

        if (step === 'get_templates') {
          if (cmd === CMD_PREPARE_DATA || cmd === 1024) {
            freeDataSize = payloadLen >= 4 ? buf.readUInt32LE(8) : 0;
            dataReceived = Buffer.alloc(0);
            console.log(`[${ip}] Prepare data, size=${freeDataSize}`);
            buf = Buffer.alloc(0);
            return;
          }
          if (cmd === CMD_DATA || cmd === 2002) {
            dataReceived = Buffer.concat([dataReceived, buf.slice(8)]);
            buf = Buffer.alloc(0);
            console.log(`[${ip}] Data chunk received, total=${dataReceived.length}/${freeDataSize}`);
            if (freeDataSize > 0 && dataReceived.length >= freeDataSize) {
              templates = parseTemplates(dataReceived);
              console.log(`[${ip}] Parsed ${templates.length} templates`);
              client.write(buildPacket(CMD_DISCONNECT, sessionId, ++replyId, null));
              setTimeout(() => { client.destroy(); resolve(templates); }, 300);
            }
            return;
          }
          if (cmd === CMD_ACK_OK) {
            console.log(`[${ip}] ACK_OK — no template data`);
            buf = Buffer.alloc(0);
            client.destroy();
            resolve([]);
            return;
          }
          buf = Buffer.alloc(0);
          return;
        }

        buf = buf.slice(8 + payloadLen);
      }
    });

    client.on('timeout', () => {
      console.log(`[${ip}] Timeout at step=${step}`);
      client.destroy();
      resolve(templates.length ? templates : []);
    });
    client.on('error', e => {
      console.log(`[${ip}] Error: ${e.message}`);
      reject(e);
    });
  });
}

function parseTemplates(data) {
  const templates = [];
  let i = 0;
  console.log(`Parsing ${data.length} bytes of template data...`);
  // ZKTeco template record: size varies, try common formats
  while (i + 6 <= data.length) {
    try {
      // Try reading as: uid(2) + size(2) + type(1) + index(1) + template(size)
      const uid  = data.readUInt16LE(i);
      const size = data.readUInt16LE(i + 2);
      const type = data[i + 4]; // 0=fp, 1=fp, 2=face?
      const idx  = data[i + 5];
      if (uid === 0 || size === 0 || size > 10000 || i + 6 + size > data.length) {
        i++; continue;
      }
      const tpl = data.slice(i + 6, i + 6 + size);
      templates.push({ uid: String(uid), size, type, index: idx, template: tpl });
      console.log(`  Template: uid=${uid} type=${type} idx=${idx} size=${size}`);
      i += 6 + size;
    } catch { i++; }
  }
  return templates;
}

function zkSetTemplate(ip, uid, type, index, templateBuf) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let buf = Buffer.alloc(0);
    let sessionId = 0, replyId = 0;
    let step = 'connect';

    const CMD_CONNECT    = 1000;
    const CMD_ACK_OK     = 2000;
    const CMD_DISCONNECT = 1001;
    const CMD_USERTEMP_WRQ = 10;

    client.setTimeout(10000);
    client.connect(4370, ip, () => {
      console.log(`[${ip}] Connected for SET`);
      client.write(buildPacket(CMD_CONNECT, 0, ++replyId, null));
    });

    client.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const cmd = buf.readUInt16LE(0);
        const sid = buf.readUInt16LE(4);

        if (cmd === CMD_ACK_OK && step === 'connect') {
          sessionId = sid;
          step = 'set_template';
          buf = Buffer.alloc(0);
          // Build template write packet: uid(2)+size(2)+type(1)+index(1)+data
          const payload = Buffer.alloc(6 + templateBuf.length);
          payload.writeUInt16LE(parseInt(uid), 0);
          payload.writeUInt16LE(templateBuf.length, 2);
          payload[4] = type;
          payload[5] = index;
          templateBuf.copy(payload, 6);
          console.log(`[${ip}] Sending template uid=${uid} type=${type} size=${templateBuf.length}`);
          client.write(buildPacket(CMD_USERTEMP_WRQ, sessionId, ++replyId, payload));
          return;
        }

        if (step === 'set_template') {
          if (cmd === CMD_ACK_OK) {
            console.log(`[${ip}] Template SET successful!`);
            buf = Buffer.alloc(0);
            client.write(buildPacket(CMD_DISCONNECT, sessionId, ++replyId, null));
            setTimeout(() => { client.destroy(); resolve(true); }, 300);
            return;
          }
          console.log(`[${ip}] SET response cmd=${cmd}`);
          buf = Buffer.alloc(0);
          client.destroy();
          resolve(false);
          return;
        }

        buf = buf.slice(8 + (buf.length - 8));
      }
    });

    client.on('timeout', () => { client.destroy(); reject(new Error('timeout')); });
    client.on('error', e => { reject(e); });
  });
}

async function main() {
  console.log('=== ZKTeco Face Sync: IN → OUT ===');
  console.log(`Reading templates from IN device (${IN_DEVICE})...`);

  let templates;
  try {
    templates = await zkSession(IN_DEVICE);
  } catch(e) {
    console.log('Failed to connect to IN device:', e.message);
    process.exit(1);
  }

  const userTemplates = templates.filter(t => t.uid === TARGET_PIN || parseInt(t.uid) === parseInt(TARGET_PIN));
  console.log(`\nTemplates found for user ${TARGET_PIN}: ${userTemplates.length}`);

  if (!userTemplates.length) {
    console.log('No templates found for this user. The device may use a different protocol for face data.');
    console.log('Raw template data dump (first 200 bytes of all templates):');
    if (templates.length) {
      templates.slice(0,3).forEach(t => console.log(`  uid=${t.uid} type=${t.type} size=${t.size}`));
    } else {
      console.log('  No templates received at all.');
    }
    process.exit(0);
  }

  console.log(`\nPushing ${userTemplates.length} template(s) to OUT device (${OUT_DEVICE})...`);
  for (const t of userTemplates) {
    try {
      const ok = await zkSetTemplate(OUT_DEVICE, t.uid, t.type, t.index, t.template);
      console.log(`  Template type=${t.type} idx=${t.index}: ${ok ? 'SUCCESS' : 'FAILED'}`);
    } catch(e) {
      console.log(`  Template type=${t.type} idx=${t.index}: ERROR - ${e.message}`);
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
