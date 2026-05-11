import path from "node:path";
import { promises as fs } from "node:fs";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import type { FillListingResult, ListingDraft, RuntimeConfig } from "./types.js";
import { updateDraft } from "./storage.js";

const SHORT_TIMEOUT_MS = 3000;
const FIELD_TIMEOUT_MS = 8000;
let activeContext: BrowserContext | undefined;

export async function fillListingForm(
  config: RuntimeConfig,
  draft: ListingDraft
): Promise<FillListingResult> {
  const context = await getOrLaunchContext(config);
  const notes: string[] = [];

  try {
    const page = await getWorkingPage(context);
    await page.goto(config.marketplaceCreateUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
      notes.push("Facebook did not reach networkidle; continuing with visible form fields.");
    });

    await uploadPhotos(page, draft.photos, notes);
    await fillSimpleField(page, "title", draft.title, [
      'input[aria-label*="Title" i]',
      'input[placeholder*="Title" i]',
      '[role="textbox"][aria-label*="Title" i]'
    ]);
    await fillSimpleField(page, "price", String(draft.price), [
      'input[aria-label*="Price" i]',
      'input[placeholder*="Price" i]',
      'input[inputmode="decimal"]',
      'input[type="number"]'
    ]);
    await chooseDropdownValue(page, "category", draft.category, [
      '[aria-label*="Category" i]',
      '[role="combobox"]:has-text("Category")',
      'label:has-text("Category")'
    ], notes);
    await chooseDropdownValue(page, "condition", draft.condition, [
      '[aria-label*="Condition" i]',
      '[role="combobox"]:has-text("Condition")',
      'label:has-text("Condition")'
    ], notes);
    await fillDescription(page, draft.description, notes);
    await fillLocation(page, draft.location || config.defaultLocation, notes);

    const screenshotPath = await makeScreenshotPath(config, draft.draft_id);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    draft.status = "form_filled";
    draft.updated_at = new Date().toISOString();
    await updateDraft(config, draft);

    return {
      status: "ready_for_manual_publish",
      draft_id: draft.draft_id,
      screenshot_path: screenshotPath,
      browser_state: "waiting_on_publish_screen",
      notes
    };
  } catch (error) {
    const page = context.pages().at(-1);
    if (page) {
      const screenshotPath = await makeScreenshotPath(config, `${draft.draft_id}_error`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      notes.push(`Error screenshot saved at ${screenshotPath}`);
    }
    throw error;
  }
}

async function getOrLaunchContext(config: RuntimeConfig): Promise<BrowserContext> {
  if (activeContext) {
    return activeContext;
  }

  await fs.mkdir(config.browserUserDataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(config.browserUserDataDir, 0o700).catch(() => undefined);

  const args = config.chromeProfileName
    ? [`--profile-directory=${config.chromeProfileName}`]
    : [];

  activeContext = await chromium.launchPersistentContext(config.browserUserDataDir, {
    channel: config.browserChannel,
    headless: config.headless,
    slowMo: config.slowMoMs,
    viewport: { width: 1440, height: 1000 },
    args
  });
  activeContext.on("close", () => {
    activeContext = undefined;
  });
  return activeContext;
}

async function getWorkingPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}

async function uploadPhotos(
  page: Page,
  photos: string[],
  notes: string[]
): Promise<void> {
  if (photos.length === 0) {
    notes.push("No photos supplied.");
    return;
  }

  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: FIELD_TIMEOUT_MS });
  await input.setInputFiles(photos);
  notes.push(`Uploaded ${photos.length} photo(s).`);
}

async function fillSimpleField(
  page: Page,
  fieldName: string,
  value: string,
  selectors: string[]
): Promise<void> {
  const locator = await firstUsableLocator(page, selectors);
  if (!locator) {
    throw new Error(`Could not find Facebook Marketplace ${fieldName} field.`);
  }
  await locator.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await locator.fill(value, { timeout: FIELD_TIMEOUT_MS });
}

async function chooseDropdownValue(
  page: Page,
  fieldName: string,
  value: string,
  selectors: string[],
  notes: string[]
): Promise<void> {
  const trigger = await firstUsableLocator(page, selectors);
  if (!trigger) {
    notes.push(`Could not find ${fieldName} dropdown; leaving it for manual review.`);
    return;
  }

  await trigger.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await trigger.click({ timeout: FIELD_TIMEOUT_MS });
  await page.keyboard.type(value);
  await page.waitForTimeout(500);

  const exactOption = page.getByText(value, { exact: true }).last();
  if (await exactOption.isVisible({ timeout: SHORT_TIMEOUT_MS }).catch(() => false)) {
    await exactOption.click();
    return;
  }

  await page.keyboard.press("Enter");
  notes.push(`Selected ${fieldName} using keyboard fallback: ${value}`);
}

async function fillDescription(
  page: Page,
  description: string,
  notes: string[]
): Promise<void> {
  const selectors = [
    'textarea[aria-label*="Description" i]',
    'textarea[placeholder*="Description" i]',
    '[role="textbox"][aria-label*="Description" i]',
    '[contenteditable="true"][aria-label*="Description" i]'
  ];
  const locator = await firstUsableLocator(page, selectors);
  if (!locator) {
    notes.push("Could not find description field; leaving it for manual review.");
    return;
  }

  await locator.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await locator.fill(description, { timeout: FIELD_TIMEOUT_MS }).catch(async () => {
    await locator.click({ timeout: FIELD_TIMEOUT_MS });
    await page.keyboard.insertText(description);
  });
}

async function fillLocation(
  page: Page,
  location: string | undefined,
  notes: string[]
): Promise<void> {
  if (!location) {
    notes.push("No location supplied.");
    return;
  }

  const locator = await firstUsableLocator(page, [
    'input[aria-label*="Location" i]',
    'input[placeholder*="Location" i]',
    '[role="combobox"][aria-label*="Location" i]'
  ]);

  if (!locator) {
    notes.push("Could not find location field; leaving it for manual review.");
    return;
  }

  await locator.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await locator.fill(location, { timeout: FIELD_TIMEOUT_MS });
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter").catch(() => undefined);
}

async function firstUsableLocator(
  page: Page,
  selectors: string[]
): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: SHORT_TIMEOUT_MS }).catch(() => false)) {
      return locator;
    }
  }
  return undefined;
}

async function makeScreenshotPath(
  config: RuntimeConfig,
  basename: string
): Promise<string> {
  await fs.mkdir(config.screenshotsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "_").slice(0, 15);
  return path.join(config.screenshotsDir, `${basename}_${stamp}.png`);
}
