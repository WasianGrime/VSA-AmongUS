// Run the game on your own computer instead of Vercel: `npm run local`.
// Players must be on the same Wi-Fi as this computer.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
  }
  return urls;
}
process.env.LOCAL_KEEPER_EXTRAS = JSON.stringify({ joinUrls: lanUrls(), local: true });

const handle = require('../lib/api');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/api/')) return handle(req, res);
  let p = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(p)) p += '.html'; // /keeper -> keeper.html, like Vercel's clean URLs
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`\n  VSA Among Us is running on this computer.\n`);
  console.log(`  This computer:     http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  Players on Wi-Fi:  ${u}`);
  console.log('');
});
