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
const draftPath = process.argv[2] ?? expandHome(process.env.FB_DRAFT_PATH);
if (!draftPath) {
  console.error('Usage: node fill_ikea_stools_preview.mjs <draft.json>   (or set FB_DRAFT_PATH)');
  process.exit(64);
}
const draft = JSON.parse(await fs.readFile(draftPath, 'utf8'));
await fs.mkdir(screenshotsDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1440, height: 1000 }
});
const page = context.pages()[0] ?? await context.newPage();
const notes = [];

async function scrollLeftPaneDown() {
  await page.mouse.move(190, 820).catch(() => {});
  await page.mouse.wheel(0, 750).catch(() => {});
  await page.waitForTimeout(500);
}

async function scrollUntilLabelVisible(label, maxScrolls = 8) {
  for (let i = 0; i <= maxScrolls; i++) {
    const loc = page.locator(`label:has-text("${label}") input, label:has-text("${label}") textarea`).first();
    if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) return loc;
    const combo = page.locator(`label[role="combobox"]:has-text("${label}")`).first();
    if (await combo.isVisible({ timeout: 500 }).catch(() => false)) return combo;
    await scrollLeftPaneDown();
  }
  return null;
}

async function fillLabelField(label, value) {
  let loc = page.locator(`label:has-text("${label}") input, label:has-text("${label}") textarea`).first();
  if (!(await loc.isVisible({ timeout: 2000 }).catch(() => false))) {
    loc = await scrollUntilLabelVisible(label, 10);
  }
  if (!loc || !(await loc.isVisible({ timeout: 2000 }).catch(() => false))) throw new Error(`field not visible: ${label}`);
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.fill(String(value), { timeout: 10000 });
  return loc;
}

async function clickAnyOption(patterns) {
  for (const pattern of patterns) {
    for (const role of ['button', 'option', 'menuitem']) {
      const loc = page.getByRole(role, { name: pattern }).first();
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await loc.click({ timeout: 6000 });
        await page.waitForTimeout(900);
        return true;
      }
    }
    const txt = page.getByText(pattern).first();
    if (await txt.isVisible({ timeout: 1500 }).catch(() => false)) {
      await txt.click({ timeout: 6000 });
      await page.waitForTimeout(900);
      return true;
    }
  }
  return false;
}

async function chooseDropdown(label, value, extraPatterns = []) {
  let trigger = page.locator(`label[role="combobox"]:has-text("${label}")`).first();
  if (!(await trigger.isVisible({ timeout: 2500 }).catch(() => false))) {
    await scrollUntilLabelVisible(label, 10);
    trigger = page.locator(`label[role="combobox"]:has-text("${label}")`).first();
    if (!(await trigger.isVisible({ timeout: 1000 }).catch(() => false))) {
      notes.push(`missing dropdown ${label}`);
      return false;
    }
  }
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 6000 });
  await page.waitForTimeout(1000);
  const base = String(value).replace(/\s*[-–—]\s*/g, '\\s*[-–—]?\\s*');
  const patterns = [...extraPatterns, new RegExp('^' + base + '\\b', 'i'), new RegExp(base, 'i')];
  if (await clickAnyOption(patterns)) return true;
  await page.keyboard.type(String(value));
  await page.waitForTimeout(800);
  if (await clickAnyOption(patterns)) return true;
  await page.keyboard.press('Enter');
  notes.push(`keyboard fallback for ${label}=${value}`);
  await page.waitForTimeout(900);
  return true;
}

async function buttonInfo(text) {
  return await page.evaluate((text) => {
    const btns = Array.from(document.querySelectorAll('[role="button"], button')).filter(el => (el.textContent || '').trim() === text);
    const b = btns[btns.length - 1];
    if (!b) return { found: false };
    const r = b.getBoundingClientRect();
    return {
      found: true,
      ariaDisabled: b.getAttribute('aria-disabled'),
      disabled: b.hasAttribute('disabled') || b.getAttribute('disabled'),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
    };
  }, text);
}

async function hasText(pattern) {
  return await page.evaluate((source) => new RegExp(source, 'i').test(document.body.innerText || ''), pattern.source);
}

async function screenshot(tag) {
  const p = path.join(screenshotsDir, `${draft.draft_id}_${tag}_${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15)}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

try {
  await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => notes.push('networkidle timeout'));
  await page.waitForTimeout(2500);

  await page.locator('input[type="file"]').first().setInputFiles(draft.photos);
  notes.push(`uploaded ${draft.photos.length} photo(s)`);
  await page.waitForTimeout(1500);

  await fillLabelField('Title', draft.title);
  await fillLabelField('Price', String(draft.price));
  await chooseDropdown('Category', draft.category || 'Furniture', [/^Furniture\b/i, /^Household\b/i]);
  await chooseDropdown('Condition', draft.condition || 'Used - Good', [/Used\s*[-–—]?\s*Good/i, /^Good\b/i]);
  await fillLabelField('Description', draft.description);

  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(700);
  await chooseDropdown('Color', 'White', [/^White\b/i]);

  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(700);
  const loc = page.locator('label:has-text("Location") input, label:has-text("Location") textarea').first();
  if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
    await loc.fill(draft.location || 'Minneapolis, Minnesota');
    await page.waitForTimeout(1500);
    await clickAnyOption([/^Minneapolis\b/i, /Minneapolis,?\s*MN/i, /Minneapolis,?\s*Minnesota/i]).catch(() => false);
  } else {
    notes.push('location field not visible; keeping existing/default location if accepted by Facebook');
  }

  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(1000);
  await clickAnyOption([/^Public meetup$/i]).catch(() => false);

  await page.waitForTimeout(2500);
  const previewPath = await screenshot('filled_preview_before_next');
  const next = await buttonInfo('Next');
  const publish = await buttonInfo('Publish');
  const invalidLocation = await hasText(/Please enter a valid location/).catch(() => false);
  const bodyExcerpt = await page.evaluate(() => (document.body.innerText || '').slice(0, 2000));

  console.log(JSON.stringify({
    status: 'filled_preview_not_published',
    draft_id: draft.draft_id,
    draft_path: draftPath,
    screenshot_path: previewPath,
    url: page.url(),
    next,
    publish,
    invalidLocation,
    notes,
    body_excerpt: bodyExcerpt
  }, null, 2));
} catch (error) {
  let errorScreenshot = null;
  try { errorScreenshot = await screenshot('error'); } catch {}
  console.log(JSON.stringify({ status: 'error', draft_id: draft.draft_id, error: String(error?.stack || error), screenshot_path: errorScreenshot, notes }, null, 2));
  process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
}
