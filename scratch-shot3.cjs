const http = require('http');
const crypto = require('crypto');
const net = require('net');
const PORT = 9356;

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(u.port || 80, u.hostname, () => {
      const req = `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
      socket.write(req);
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let onMessage = null;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        upgraded = true;
        buf = buf.slice(headerEnd + 4);
        resolve({
          send(obj) {
            const payload = Buffer.from(JSON.stringify(obj));
            const len = payload.length;
            let header;
            if (len < 126) {
              header = Buffer.alloc(2);
              header[0] = 0x81;
              header[1] = 0x80 | len;
            } else {
              header = Buffer.alloc(4);
              header[0] = 0x81;
              header[1] = 0x80 | 126;
              header.writeUInt16BE(len, 2);
            }
            const mask = crypto.randomBytes(4);
            const masked = Buffer.alloc(len);
            for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
            socket.write(Buffer.concat([header, mask, masked]));
          },
          onMessage(fn) {
            onMessage = fn;
          },
          close() {
            socket.end();
          },
        });
      }
      if (upgraded) {
        while (buf.length >= 2) {
          const b0 = buf[0];
          const b1 = buf[1];
          const opcode = b0 & 0x0f;
          let len = b1 & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }
          if (buf.length < offset + len) return;
          const payload = buf.slice(offset, offset + len);
          buf = buf.slice(offset + len);
          if (opcode === 1 && onMessage) onMessage(payload.toString('utf8'));
        }
      }
    });
    socket.on('error', reject);
  });
}
async function main() {
  const targets = await getTargets();
  const t = targets.find((x) => x.title === 'Pet');
  const ws = await connectWs(t.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  ws.onMessage((raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const myId = id++;
      pending.set(myId, resolve);
      ws.send({ id: myId, method, params });
    });
  }
  function evaluate(expression) {
    return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  }
  const cmd = process.argv[2];
  if (cmd === 'open') {
    const r = await evaluate('window.pet.openToolbar()');
    console.error('openToolbar result:', JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 600));
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(process.argv[3], Buffer.from(shot.result.data, 'base64'));
  console.log('saved');
  ws.close();
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
