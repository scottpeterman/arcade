// node test/browser.mjs — compiles and renders examples/flight.html in headless Chrome against each three.js build
// given as THREE_DIRS (colon-separated node_modules/three paths; default ./node_modules/three). Fails on any shader
// compile error, console error or page error. Screenshots land in shots/.
//   THREE_DIRS=/a/three:/b/three CHROME_PATH=... node test/browser.mjs
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = (process.env.THREE_DIRS || path.join(root, 'node_modules/three')).split(':');
const chrome = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const m = u.match(/^\/three(\d+)\/(.*)$/);
  const f = m ? path.join(dirs[+m[1]], m[2]) : path.join(root, u);
  fs.readFile(f, (e, d) => e ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }).end(d));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
let failed = 0;
for (let i = 0; i < dirs.length; i++) {
  const rev = JSON.parse(fs.readFileSync(path.join(dirs[i], 'package.json'))).version;
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push(m.text().slice(0, 300)); });
  await page.goto(`${base}/examples/flight.html?three=/three${i}/&q=low&still&e=50`, { waitUntil: 'commit' });
  try { await page.waitForFunction('window.__ready === true', null, { timeout: 180000 }); } catch { errs.push('never ready'); }
  const st = await page.evaluate('window.__app?.stats?.()').catch(() => null);
  await page.screenshot({ path: path.join(root, `shots/flight-r${rev}.png`), timeout: 180000 });
  const ok = !errs.length && st && st.drawn > 0 && st.shadow.shadowedPct > 1;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} three ${rev}: ${JSON.stringify(st)}${errs.length ? '\n       ' + errs.join('\n       ') : ''}`);
  await page.close();
  const sp = await browser.newPage();
  await sp.goto(`${base}/test/shadow.html?three=/three${i}/`);
  await sp.waitForFunction('window.__ready === true', null, { timeout: 60000 });
  const so = await sp.evaluate('window.__out');
  if (!so.ok) failed++;
  console.log(`  ${so.ok ? 'ok  ' : 'FAIL'} three ${rev}: cloud shadow lands down-sun, unmirrored, fades with the cloud ${JSON.stringify(so)}`);
  await sp.close();
  const cp = await browser.newPage();
  const cerr = []; cp.on('pageerror', e => cerr.push(e.message));
  await cp.goto(`${base}/test/compile.html?three=/three${i}/`);
  await cp.waitForFunction('window.__ready === true || window.__failed', null, { timeout: 120000 }).catch(() => cerr.push('never ready'));
  const co = await cp.evaluate('window.__out').catch(() => null);
  const cok = co && co.ok && !cerr.length;
  if (!cok) failed++;
  console.log(`  ${cok ? 'ok  ' : 'FAIL'} three ${rev}: every patch alone and stacked compiles and draws (${co?.programs} programs)${cok ? '' : '\n       ' + JSON.stringify(co) + ' ' + cerr.join(' | ')}`);
  await cp.close();
}
await browser.close(); server.close();
process.exitCode = failed ? 1 : 0;
