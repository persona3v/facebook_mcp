import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const dataDir = expandHome(process.env.FB_MARKETPLACE_DATA_DIR) ?? path.join(os.homedir(), '.hermes', 'facebook-marketplace');
const profileDir = expandHome(process.env.FB_CHROME_USER_DATA_DIR) ?? path.join(dataDir, 'browser-profile');
const screenshotsDir = path.join(dataDir, 'screenshots');
const titleMatcher = process.env.FB_VERIFY_TITLE_REGEX ? new RegExp(process.env.FB_VERIFY_TITLE_REGEX, 'i') : /Digital Glass Bathroom Scale/i;
const priceMatcher = process.env.FB_VERIFY_PRICE_REGEX ? new RegExp(process.env.FB_VERIFY_PRICE_REGEX) : /\$\s*12\b/;

await fs.mkdir(screenshotsDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: { width: 1440, height: 1000 } });
const page = context.pages()[0] ?? await context.newPage();
try {
  await page.goto('https://www.facebook.com/marketplace/you/selling', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);
  const body = await page.evaluate(() => document.body.innerText || '');
  const links = await page.locator('a[href*="/marketplace/item/"]').evaluateAll((els) => els.slice(0, 20).map((a) => ({ href: a.href, text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300) }))).catch(() => []);
  const titleVisible = titleMatcher.test(body);
  const priceVisible = priceMatcher.test(body);
  const householdNotif = /You listed an item in Household/i.test(body);
  const screenshot = path.join(screenshotsDir, 'verify_selling_' + new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15) + '.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ url: page.url(), titleVisible, priceVisible, householdNotif, links, screenshot, excerpt: body.slice(0, 2000) }, null, 2));
} finally {
  await context.close().catch(() => { });
}
