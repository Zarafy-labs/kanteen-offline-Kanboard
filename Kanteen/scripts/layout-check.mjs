// Self-contained layout regression check for the board-screen fill fix.
// Inlines the REAL built CSS + a faithful copy of the board DOM, then measures
// whether .board / .columns / .column fill the viewport (no Kanboard/dev server).
// This can't reproduce the standalone-PWA collapse (that's display-mode specific),
// but it proves the absolute-positioning change still fills in a normal render.
import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(__dirname, '../Asset/app/assets');
const cssFile = readdirSync(assetsDir).find((f) => f.endsWith('.css'));
const css = readFileSync(resolve(assetsDir, cssFile), 'utf8');

const card = (t) => `<div class="card" data-task-id="${t}"><div class="card-title">${t}</div></div>`;
const column = (name, n) => `
  <div class="column">
    <div class="column-header"><span>${name}</span><span class="column-count">${n}</span></div>
    <div class="column-body">${Array.from({ length: n }, (_, i) => card(name + '-' + i)).join('')}</div>
  </div>`;

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style></head>
<body><div id="root"><div class="app">
  <div class="nav-wrapper" data-nav="none">
    <div class="screen board-screen" style="--project-accent:#6d28d9">
      <div class="board-cover-bg" style="background-color:#6d28d9"></div>
      <header class="topbar board-topbar"><h1>Board</h1></header>
      <main class="board board-single">
        <section class="swimlane">
          <div class="columns">
            ${column('TODO', 4)}
            ${column('WORK', 1)}
            ${column('DONE', 0)}
          </div>
        </section>
      </main>
    </div>
  </div>
</div></div></body></html>`;

const browser = await chromium.launch();
const results = [];
for (const vp of [{ width: 402, height: 874, label: 'mobile' }, { width: 1440, height: 900, label: 'desktop' }]) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(150);
  const m = await page.evaluate(() => {
    const h = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().height) : null; };
    const top = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().top) : null; };
    const bottom = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().bottom) : null; };
    return {
      viewport: window.innerHeight,
      navWrapper: h('.nav-wrapper'),
      screen: h('.board-screen'),
      topbarBottom: bottom('.topbar'),
      board: h('.board'),
      columns: h('.columns'),
      firstColumn: h('.column'),
      firstColumnBottom: bottom('.column'),
    };
  });
  results.push({ vp: vp.label, ...m });
  await page.close();
}
await browser.close();

let ok = true;
for (const r of results) {
  // The board/columns should fill from below the topbar to (near) the viewport bottom.
  // Collapse bug signature: column bottom sits far above the viewport bottom.
  const fillsToBottom = r.firstColumnBottom >= r.viewport - 40;
  const screenFull = r.screen >= r.viewport - 2;
  const pass = fillsToBottom && screenFull;
  ok = ok && pass;
  console.log(`\n[${r.vp}] viewport=${r.viewport}`);
  console.log(`  nav-wrapper=${r.navWrapper}  screen=${r.screen}  topbarBottom=${r.topbarBottom}`);
  console.log(`  board=${r.board}  columns=${r.columns}  column=${r.firstColumn}  columnBottom=${r.firstColumnBottom}`);
  console.log(`  screen fills viewport: ${screenFull ? 'YES' : 'NO'}   column reaches bottom: ${fillsToBottom ? 'YES' : 'NO'}  => ${pass ? 'PASS' : 'FAIL'}`);
}
console.log(`\nRESULT: ${ok ? 'PASS — board fills the viewport on both layouts' : 'FAIL — board collapsed'}`);
process.exit(ok ? 0 : 1);
