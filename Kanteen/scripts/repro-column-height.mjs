// Repro: column height collapse after create → view → edit → save.
// Drives the dev server app headlessly and measures board layout at each step.
import { chromium, webkit } from 'playwright';

const BASE = 'http://localhost:5174';
const ENGINE = process.env.ENGINE === 'webkit' ? webkit : chromium;
console.log('Engine:', process.env.ENGINE || 'chromium');

function fmt(r) {
  if (!r) return 'null';
  return `y=${Math.round(r.y)} h=${Math.round(r.height)}`;
}

async function measure(page, label) {
  const m = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { y: r.y, height: r.height };
    };
    const cols = [...document.querySelectorAll('.column')].map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return `${Math.round(r.height)}(${cs.height})`;
    });
    const colsEl = document.querySelector('.columns');
    const colsCS = colsEl ? getComputedStyle(colsEl) : null;
    return {
      viewport: window.innerHeight,
      app: pick('.app'),
      navWrapper: pick('.nav-wrapper'),
      screen: pick('.screen.board-screen'),
      board: pick('.board'),
      swimlane: pick('.swimlane'),
      columns: pick('.columns'),
      columnsComputed: colsCS ? { height: colsCS.height, minHeight: colsCS.minHeight, flex: colsCS.flexGrow } : null,
      columnHeights: cols,
      boardClass: document.querySelector('.board')?.className,
      bodyOverflow: document.body.style.overflow,
      htmlFontSize: document.documentElement.style.fontSize,
    };
  });
  console.log(`\n=== ${label} ===`);
  console.log(`viewport=${m.viewport} bodyOverflow='${m.bodyOverflow}' htmlFontSize='${m.htmlFontSize}'`);
  console.log(`app:        ${fmt(m.app)}`);
  console.log(`navWrapper: ${fmt(m.navWrapper)}`);
  console.log(`screen:     ${fmt(m.screen)}`);
  console.log(`board:      ${fmt(m.board)}  class='${m.boardClass}'`);
  console.log(`swimlane:   ${fmt(m.swimlane)}`);
  console.log(`columns:    ${fmt(m.columns)}  computed=${JSON.stringify(m.columnsComputed)}`);
  console.log(`column heights: [${m.columnHeights.join(', ')}]`);
  return m;
}

const browser = await ENGINE.launch({ headless: process.env.HEADED ? false : true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1300 }, deviceScaleFactor: Number(process.env.DSF || 1) });
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('PAGE ERROR:', msg.text().slice(0, 200));
});

await page.goto(BASE);
await page.waitForTimeout(1500);

// Setup screen if shown.
if (page.url().includes('/setup')) {
  console.log('Setup screen — logging in…');
  await page.locator('input[type="url"]').fill(BASE);
  await page.locator('input[type="text"]').fill('admin');
  await page.locator('input[type="password"]').fill('admin');
  await page.locator('button:has-text("Connect")').first().click();
  await page.waitForTimeout(4000);
  console.log('After login URL:', page.url());
}

// Create a fresh project → guarantees a single-swimlane board with the
// default Backlog/Ready/WIP/Done columns, matching the user's repro.
await page.goto(BASE + '/#/projects/new');
await page.waitForSelector('.app-sheet input', { timeout: 8000 });
await page.locator('.app-sheet input').first().fill('repro-board-' + Date.now());
await page.locator('.app-sheet-footer .btn-primary, .app-sheet button:has-text("Create project")').first().click();
await page.waitForTimeout(5000);
console.log('Project created, URL:', page.url());
const boardUrl = page.url();
// New project's columns arrive via a board pull — reload until they show.
for (let i = 0; i < 4 && (await page.locator('.column').count()) === 0; i++) {
  await page.reload();
  await page.waitForTimeout(3000);
}
await page.waitForSelector('.column', { timeout: 10000 });
await page.waitForTimeout(1000);

// Set a cover colour (matches the user's board, which has an orange cover —
// the only obvious difference from a plain board).
await page.goto(boardUrl.replace(/\/projects\/(\d+)/, '/projects/$1/cover'));
await page.waitForSelector('.cover-swatch', { timeout: 8000 });
await page.locator('.cover-swatch').nth(3).click();
await page.waitForTimeout(800);
const coverClose = page.locator('.app-sheet-close, .app-sheet [aria-label="Close"], .cover-sheet [aria-label="Close"]').first();
if (await coverClose.isVisible().catch(() => false)) await coverClose.click();
else await page.goto(boardUrl);
await page.waitForTimeout(1500);
await page.waitForSelector('.column', { timeout: 10000 });

// Seed several backlog cards so a column has real content (matches the
// user's board: ~8 backlog cards).
for (let i = 0; i < 7; i++) {
  await page.locator('.column').first().locator('.column-add, button:has-text("Add task")').first().click();
  await page.waitForSelector('.app-sheet input', { timeout: 5000 });
  await page.locator('.app-sheet input').first().fill(`seed-${i}`);
  await page.locator('.app-sheet-footer .btn-primary').click();
  await page.waitForTimeout(900);
}
await measure(page, 'STEP 0b: after seeding 7 cards');

// STEP 1: create a task via FAB.
await page.locator('.board-fab').click();
await page.waitForSelector('.app-sheet input', { timeout: 5000 });
const title = `repro-${Date.now()}`;
await page.locator('.app-sheet input').first().fill(title);
await page.locator('.app-sheet-footer .btn-primary').click();
await page.waitForTimeout(2500); // wait for scrollIntoView + sync
await measure(page, 'STEP 1: after create');

// STEP 2: open the new task.
await page.locator(`.card:has-text("${title}")`).first().click();
await page.waitForSelector('.app-sheet', { timeout: 5000 });
await page.waitForTimeout(1000);
await measure(page, 'STEP 2: task detail open');

// STEP 3: enter edit mode.
await page.locator('.app-sheet-footer .btn-primary:has-text("Edit")').click();
await page.waitForTimeout(800);

// STEP 4: change the title and save.
const editInput = page.locator('.app-sheet input').first();
await editInput.fill(title + '-edited');
await page.locator('.app-sheet-footer .btn-primary:has-text("Save")').click();
await page.waitForTimeout(1000);

// STEP 5: close the task detail (back to board).
const closeBtn = page.locator('.app-sheet .icon-btn[aria-label="Close"], .app-sheet-close').first();
if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
await page.waitForTimeout(1500);
const m1 = await measure(page, 'STEP 5: back on board after edit+save');
await page.screenshot({ path: '/tmp/repro-after-edit.png' });

// STEP 5b: nudge a reflow (resize) — exposes flex-percentage height bugs that
// only surface on a relayout after the async content settled.
await page.setViewportSize({ width: 1441, height: 1301 });
await page.waitForTimeout(300);
await page.setViewportSize({ width: 1440, height: 1300 });
await page.waitForTimeout(500);
await measure(page, 'STEP 5b: after resize nudge');

// STEP 6: hard reload.
await page.reload();
await page.waitForSelector('.column', { timeout: 10000 });
await page.waitForTimeout(2000);
const m2 = await measure(page, 'STEP 6: after page reload');
await page.screenshot({ path: '/tmp/repro-after-reload.png' });

const collapsed = (m) => m.columns && m.board && m.columns.height < m.board.height - 100;
console.log(`\nRESULT: after-edit collapsed=${collapsed(m1)} after-reload collapsed=${collapsed(m2)}`);

await browser.close();
