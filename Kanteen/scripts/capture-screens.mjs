// Captures app screenshots for the landing page / README.
// Drives the live Vite dev app with Playwright, completes Setup against the
// seeded local Kanboard, then snapshots each screen (light + dark).
//
// Prereqs (see CLAUDE.md): `npm run kanboard:up && npm run kanboard:seed`,
// and a Vite dev server running. Pass its base URL as BASE (default 5174).
//
//   BASE=http://localhost:5174 node scripts/capture-screens.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../docs/screenshots');
const BASE = process.env.BASE || 'http://localhost:5174';
const USER = 'admin';
const PAT = 'admin';

const VIEWPORT = { width: 402, height: 874 }; // iPhone 15-ish, PWA feel

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(250);
}

async function shot(page, name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  ✓', name);
}

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  console.log('Setup…');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // Setup form: server address (url), username, PAT.
  await page.fill('input[type="url"]', BASE);
  await page.fill('input[autocomplete="username"]', USER);
  await page.fill('input[type="password"]', PAT);
  await page.click('button[type="submit"]');
  // Wait for sync → projects.
  await page.waitForURL('**/#/projects', { timeout: 30000 });
  await page.waitForSelector('.project-card', { timeout: 30000 });
  console.log('Connected. Capturing…');

  for (const theme of ['light', 'dark']) {
    const suffix = theme === 'dark' ? '-dark' : '';

    // Projects grid
    await page.goto(`${BASE}/#/projects`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.project-card');
    await setTheme(page, theme);
    await shot(page, `projects${suffix}`);

    // Board (first project)
    await page.click('.project-card');
    await page.waitForSelector('.card', { timeout: 15000 });
    await setTheme(page, theme);
    await shot(page, `board${suffix}`);

    // Task detail (first card)
    await page.click('.card');
    await page.waitForURL('**/tasks/**', { timeout: 15000 });
    await page.waitForTimeout(600);
    await setTheme(page, theme);
    await shot(page, `task${suffix}`);

    // Settings
    await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
    await setTheme(page, theme);
    await shot(page, `settings${suffix}`);

    // Analytics
    await page.goto(`${BASE}/#/analytics`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await setTheme(page, theme);
    await shot(page, `analytics${suffix}`);
  }

  await browser.close();
  console.log('Done →', OUT);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
