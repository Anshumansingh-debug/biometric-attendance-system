const ZKLib = require('node-zklib');

async function testDevice(ip, port, inport, label) {
  console.log(`\n=== Testing ${label} (${ip}) ===`);
  const zk = new ZKLib(ip, port, 30000, inport);
  try {
    await zk.createSocket();
    console.log(`[${label}] Connected!`);

    try {
      const info = await zk.getInfo();
      console.log(`[${label}] Device info:`, JSON.stringify(info, null, 2));
    } catch(e) {
      console.log(`[${label}] getInfo skipped: ${e.message}`);
    }

    console.log(`[${label}] Fetching attendances (standard)...`);
    const result = await zk.getAttendances((pct, total) => {
      process.stdout.write(`\r[${label}] Progress: ${pct.toFixed(1)}% of ${total}`);
    });
    const rows = Array.isArray(result) ? result : (result.data || []);
    console.log(`\n[${label}] Total records: ${rows.length}`);
    if (rows.length > 0) {
      console.log(`[${label}] Sample record:`, rows[0]);
    }

    // Try direct CMD_ATTLOG_RRQ (13) for older/F09 protocol
    console.log(`[${label}] Trying direct CMD_ATTLOG_RRQ...`);
    try {
      const raw = await zk.zklibTcp.executeCmd(13, '');
      console.log(`[${label}] ATTLOG_RRQ response (${raw ? raw.length : 0} bytes):`, raw ? raw.slice(0,32).toString('hex') : 'null');
    } catch(e2) {
      console.log(`[${label}] ATTLOG_RRQ failed:`, e2.message);
    }

    await zk.disconnect();
  } catch (err) {
    const msg = err?.message || err?.err?.message || JSON.stringify(err);
    console.error(`[${label}] FAILED: ${msg}`);
    try { await zk.disconnect(); } catch (_) {}
  }
}

(async () => {
  await testDevice('192.168.31.207', 4370, 5201, 'OUT Machine');
  await testDevice('192.168.31.85',  4370, 5200, 'IN Machine');
})();
