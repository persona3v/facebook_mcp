import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const draftPath = '/Users/saber/.hermes/facebook-marketplace/drafts/draft_20260514_141057_o9p1.json';
const draft = JSON.parse(await fs.readFile(draftPath, 'utf8'));
const screenshotsDir = '/Users/saber/.hermes/facebook-marketplace/screenshots';
await fs.mkdir(screenshotsDir, { recursive: true });
const context = await chromium.launchPersistentContext('/Users/saber/.hermes/facebook-marketplace/browser-profile', {
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
    const scrolled = await scrollUntilLabelVisible(label, 10);
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
async function fillLocation(value) {
  let loc = page.locator('label:has-text("Location") input, label:has-text("Location") textarea').first();
  if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) {
    loc = await scrollUntilLabelVisible('Location', 4);
  }
  if (!loc || !(await loc.isVisible({ timeout: 1000 }).catch(() => false))) {
    const next = await buttonInfo('Next').catch(() => ({ found: false }));
    const invalid = await hasInvalidLocation().catch(() => false);
    if (next.found && next.ariaDisabled !== 'true' && !next.disabled && !invalid) {
      notes.push('Location field not visible; existing/default location accepted because Next is enabled and no location error is present');
      return;
    }
    throw new Error('field not visible: Location');
  }
  await loc.fill(String(value), { timeout: 10000 });
  await page.waitForTimeout(1500);
  if (await clickAnyOption([/^Minneapolis\b/i, /Minneapolis,?\s*MN/i, /Minneapolis,?\s*Minnesota/i])) {
    notes.push('selected location suggestion');
    return;
  }
  await loc.press('ArrowDown').catch(() => {});
  await page.waitForTimeout(300);
  await loc.press('Enter').catch(() => {});
  notes.push('location keyboard suggestion fallback');
  await page.waitForTimeout(1500);
}
async function clickPreference(name) {
  const target = page.getByText(new RegExp('^' + name + '$', 'i')).first();
  if (await target.isVisible({ timeout: 4000 }).catch(() => false)) {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 6000 });
    notes.push(`selected meetup preference: ${name}`);
    return true;
  }
  notes.push(`could not find meetup preference: ${name}`);
  return false;
}
async function buttonInfo(text) {
  return await page.evaluate((text) => {
    const btns = Array.from(document.querySelectorAll('[role="button"], button')).filter(el => (el.textContent || '').trim() === text);
    const b = btns[btns.length - 1];
    if (!b) return { found: false };
    const r = b.getBoundingClientRect();
    const st = getComputedStyle(b);
    return {
      found: true,
      ariaDisabled: b.getAttribute('aria-disabled'),
      disabled: b.hasAttribute('disabled') || b.getAttribute('disabled'),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      color: st.color,
      background: st.backgroundColor
    };
  }, text);
}
async function hasInvalidLocation() {
  return await page.evaluate(() => /Please enter a valid location/i.test(document.body.innerText || ''));
}
async function screenshot(tag) {
  const p = path.join(screenshotsDir, `${draft.draft_id}_${tag}_${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').slice(0, 15)}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}
async function clickButtonExact(text) {
  const loc = page.getByRole('button', { name: new RegExp(`^${text}$`, 'i') }).last();
  if (!(await loc.isVisible({ timeout: 8000 }).catch(() => false))) return false;
  const disabled = await loc.getAttribute('aria-disabled').catch(() => null);
  if (disabled === 'true') return false;
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ timeout: 8000 });
  return true;
}

try {
  await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => notes.push('networkidle timeout'));
  await page.waitForTimeout(2500);
  await page.locator('input[type="file"]').first().setInputFiles(draft.photos);
  notes.push(`uploaded ${draft.photos.length} photo(s)`);
  await page.waitForTimeout(1200);
  await fillLabelField('Title', draft.title);
  await fillLabelField('Price', String(draft.price));
  await chooseDropdown('Category', draft.category || 'Household', [/^Household\b/i]);
  await chooseDropdown('Condition', draft.condition || 'Used - Good', [/Used\s*[-–—]?\s*Good/i, /^Good\b/i]);
  await fillLabelField('Description', draft.description);
  await page.mouse.wheel(0, 900); await page.waitForTimeout(800);
  await chooseDropdown('Color', 'White', [/^White\b/i]);
  await page.mouse.wheel(0, 900); await page.waitForTimeout(800);
  await fillLocation(draft.location || 'Minneapolis, Minnesota');
  await page.mouse.wheel(0, 900); await page.waitForTimeout(800);
  await clickPreference('Public meetup');
  await page.waitForTimeout(2500);

  const beforePath = await screenshot('before_next');
  const next = await buttonInfo('Next');
  if (!next.found || next.ariaDisabled === 'true' || next.disabled || await hasInvalidLocation()) {
    console.log(JSON.stringify({ status: 'blocked_before_next', draft_id: draft.draft_id, screenshot_path: beforePath, next, invalidLocation: await hasInvalidLocation(), notes }, null, 2));
    process.exit(2);
  }

  const nextClicked = await clickButtonExact('Next');
  if (!nextClicked) {
    console.log(JSON.stringify({ status: 'next_click_failed', draft_id: draft.draft_id, screenshot_path: beforePath, next, notes }, null, 2));
    process.exit(3);
  }
  notes.push('clicked Next');
  await page.waitForTimeout(5000);
  const afterNextPath = await screenshot('after_next');

  let publishClicked = false;
  // After the listing details step, Facebook may show a Delivery method step.
  // If so, select Public meetup there and click Next once more before looking for Publish.
  let publish = await buttonInfo('Publish');
  if (!publish.found) {
    const meetupVisible = await page.getByText(/^Public meetup$/i).first().isVisible({ timeout: 3000 }).catch(() => false);
    if (meetupVisible) {
      await clickPreference('Public meetup');
      await page.waitForTimeout(1000);
      const secondNext = await buttonInfo('Next');
      if (secondNext.found && secondNext.ariaDisabled !== 'true' && !secondNext.disabled) {
        const secondNextClicked = await clickButtonExact('Next');
        if (secondNextClicked) {
          notes.push('clicked Next on delivery method step');
          await page.waitForTimeout(5000);
        }
      }
      publish = await buttonInfo('Publish');
    }
  }
  // Facebook commonly uses Publish on the final page. Try exact Publish only; do not click unrelated buttons.
  if (publish.found && publish.ariaDisabled !== 'true' && !publish.disabled) {
    publishClicked = await clickButtonExact('Publish');
  }
  if (!publishClicked) {
    const afterDeliveryPath = await screenshot('after_delivery_next');
    console.log(JSON.stringify({ status: 'ready_for_manual_publish', draft_id: draft.draft_id, before_next_screenshot: beforePath, after_next_screenshot: afterNextPath, after_delivery_screenshot: afterDeliveryPath, publish, notes }, null, 2));
    process.exit(4);
  }
  notes.push('clicked Publish');
  await page.waitForTimeout(9000);
  const afterPublishPath = await screenshot('after_publish');
  const bodyText = await page.evaluate(() => (document.body.innerText || '').slice(0, 3000));
  console.log(JSON.stringify({ status: 'publish_clicked', draft_id: draft.draft_id, before_next_screenshot: beforePath, after_next_screenshot: afterNextPath, after_publish_screenshot: afterPublishPath, url: page.url(), body_excerpt: bodyText, notes }, null, 2));
} catch (error) {
  let errorScreenshot = null;
  try { errorScreenshot = await screenshot('error'); } catch {}
  console.log(JSON.stringify({ status: 'error', draft_id: draft.draft_id, error: String(error?.stack || error), screenshot_path: errorScreenshot, notes }, null, 2));
  process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
}
