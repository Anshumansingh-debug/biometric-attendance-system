const net = require('net');

// ZKTeco Protocol helpers
function createHeader(cmd, sessionId, replyId, data = Buffer.alloc(0)) {
  const payload = Buffer.concat([data]);
  const size = 8 + payload.length;
  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(cmd, 0);
  buf.writeUInt16LE(0, 2);        // checksum placeholder
  buf.writeUInt16LE(sessionId, 4);
  buf.writeUInt16LE(replyId, 6);
  payload.copy(buf, 8);
  return createTcpHeader(buf);
}

function createTcpHeader(data) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x20000000, 0);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

const CMD_CONNECT   = 1000;
const CMD_GET_TIME  = 201;
const CMD_INFO      = 11;

const client = new net.Socket();
let sessionId = 0;
let replyId = 0;

client.connect(4370, '192.168.31.207', () => {
  console.log('TCP Connected to OUT device');
  replyId = 0; sessionId = 0;
  client.write(createHeader(CMD_CONNECT, 0, 0));
});

client.on('data', (raw) => {
  console.log(`Raw response (${raw.length} bytes):`, raw.slice(0,32).toString('hex'));
  if (raw.length >= 16) {
    const cmdId = raw.readUInt16LE(8);
    sessionId = raw.readUInt16LE(12);
    console.log(`CMD ID: ${cmdId}, Session: ${sessionId}`);
    if (cmdId === 2000) { // CMD_ACK_OK
      console.log('Connected OK, session:', sessionId);
      // try getTime
      replyId++;
      client.write(createHeader(CMD_GET_TIME, sessionId, replyId));
    } else if (cmdId === 2005) {
      console.log('ACK_ERROR - device rejected command');
      client.destroy();
    } else {
      console.log(`Other response: cmdId=${cmdId}, data:`, raw.slice(16).toString('hex'));
      client.destroy();
    }
  }
});

client.on('close', () => console.log('Connection closed'));
client.on('error', (err) => console.error('Error:', err.message));
setTimeout(() => client.destroy(), 15000);
