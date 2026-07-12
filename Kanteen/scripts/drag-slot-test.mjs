// Visual check: drive a real pointer drag and screenshot the drop slot.
import { chromium } from 'playwright';
const BASE = 'http://localhost:5174';

const browser = await chromium.launch({ headless: !process.env.HEADED });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.addInitScript(()=>{window.__DRAGDBG=1;});
page.on('console', (m) => { if (m.text().includes('[over=')) console.log('DBG', m.text()); });
await page.goto(BASE);
await page.waitForTimeout(1500);
if (page.url().includes('/setup')) {
  await page.locator('input[type="url"]').fill(BASE);
  await page.locator('input[type="text"]').fill('admin');
  await page.locator('input[type="password"]').fill('admin');
  await page.locator('button:has-text("Connect")').first().click();
  await page.waitForTimeout(4000);
}
// Fresh project for a clean column.
await page.goto(BASE + '/#/projects/new');
await page.waitForSelector('.app-sheet input', { timeout: 8000 });
await page.locator('.app-sheet input').first().fill('drag-test-' + Date.now());
await page.locator('.app-sheet-footer .btn-primary, .app-sheet button:has-text("Create project")').first().click();
await page.waitForTimeout(5000);
const boardUrl = page.url();
for (let i = 0; i < 4 && (await page.locator('.column').count()) === 0; i++) { await page.reload(); await page.waitForTimeout(3000); }
await page.waitForSelector('.column');

// Seed 4 cards in the first column.
for (let i = 0; i < 4; i++) {
  await page.locator('.column').first().locator('.column-add').click();
  await page.waitForSelector('.app-sheet input', { timeout: 5000 });
  await page.locator('.app-sheet input').first().fill(`card ${i + 1}`);
  await page.locator('.app-sheet-footer .btn-primary').click();
  await page.waitForTimeout(900);
}
await page.waitForTimeout(500);

const cards = page.locator('.column').first().locator('[data-task-id]');
const n = await cards.count();
console.log('cards:', n);
const first = await cards.nth(0).boundingBox();
const third = await cards.nth(2).boundingBox();
if (!first || !third) { console.log('no boxes'); await browser.close(); process.exit(1); }

// Real mouse drag: down on card 1, move past the 8px activation, then hover
// the gap between card 2 and 3, and hold to screenshot the slot.
const fourth = await cards.nth(3).boundingBox();
const bodyBox = await page.locator('.column').first().locator('.column-body').boundingBox();
await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
await page.mouse.down();
await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2 + 12, { steps: 4 });
// Drag DOWN past the last card into the empty area at the column bottom.
await page.mouse.move(first.x + first.width / 2, fourth.y + fourth.height + 40, { steps: 14 });
await page.mouse.move(first.x + first.width / 2, bodyBox.y + bodyBox.height - 30, { steps: 8 });
await page.waitForTimeout(900);
const slotBox = await page.locator('.drop-slot').boundingBox().catch(() => null);
console.log('end slot box:', slotBox ? `y=${Math.round(slotBox.y)} h=${Math.round(slotBox.height)}` : 'NONE', '| body bottom:', Math.round(bodyBox.y + bodyBox.height), '| pointerY:', Math.round(bodyBox.y + bodyBox.height - 30));
const slotCount = await page.locator('.drop-slot').count();
const overCount = await page.locator('.column-body.drop-over').count();
console.log('drop-slot visible:', slotCount, '| drop-over columns:', overCount);
await page.screenshot({ path: '/tmp/drag-slot.png' });
await page.mouse.up();
await page.waitForTimeout(500);
console.log('screenshot: /tmp/drag-slot.png');
await browser.close();
