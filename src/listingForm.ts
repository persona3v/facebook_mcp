import type { Page } from "playwright";
import type {
  BrowserConnectionOptions,
  FillListingResult,
  ListingDraft,
  RuntimeConfig
} from "./types.js";
import { updateDraft } from "./storage.js";
import { getOrLaunchContext, getWorkingPage } from "./browser.js";
import {
  FIELD_TIMEOUT_MS,
  captureScreenshot,
  firstUsableLocator,
  waitForLocatorVisible,
  waitForPageReady
} from "./pageUtils.js";
import {
  CATEGORY_DROPDOWN_SELECTORS,
  CONDITION_DROPDOWN_SELECTORS,
  CREATE_FORM_ANCHORS,
  DESCRIPTION_FIELD_SELECTORS,
  LOCATION_FIELD_SELECTORS,
  LOCATION_SUGGESTION_SELECTOR,
  PHOTO_INPUT_SELECTOR,
  PRICE_FIELD_SELECTORS,
  TITLE_FIELD_SELECTORS
} from "./selectors.js";

export async function fillListingForm(
  config: RuntimeConfig,
  draft: ListingDraft,
  browserOptions?: BrowserConnectionOptions
): Promise<FillListingResult> {
  const context = await getOrLaunchContext(config, browserOptions);
  const notes: string[] = [];

  try {
    const page = await getWorkingPage(context);
    await page.goto(config.marketplaceCreateUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await waitForPageReady(page, CREATE_FORM_ANCHORS, "Marketplace create form", notes);

    await uploadPhotos(page, draft.photos, notes);
    await fillSimpleField(page, "title", draft.title, TITLE_FIELD_SELECTORS);
    await fillSimpleField(page, "price", String(draft.price), PRICE_FIELD_SELECTORS);
    await chooseDropdownValue(page, "category", draft.category, CATEGORY_DROPDOWN_SELECTORS, notes);
    await chooseDropdownValue(page, "condition", draft.condition, CONDITION_DROPDOWN_SELECTORS, notes);
    await fillDescription(page, draft.description, notes);
    await fillLocation(page, draft.location || config.defaultLocation, notes);

    const screenshotPath = await captureScreenshot(config, page, draft.draft_id);

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
      const screenshotPath = await captureScreenshot(
        config,
        page,
        `${draft.draft_id}_error`
      ).catch(() => undefined);
      if (screenshotPath) {
        notes.push(`Error screenshot saved at ${screenshotPath}`);
      }
    }
    throw error;
  }
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

  const input = page.locator(PHOTO_INPUT_SELECTOR).first();
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
  const locator = await firstUsableLocator(page, selectors, FIELD_TIMEOUT_MS);
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
  await page.keyboard.type(value, { delay: 30 });

  const exactOption = page.getByText(value, { exact: true }).last();
  if (await waitForLocatorVisible(exactOption, 1500)) {
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
  const locator = await firstUsableLocator(page, DESCRIPTION_FIELD_SELECTORS);
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

  const locator = await firstUsableLocator(page, LOCATION_FIELD_SELECTORS);

  if (!locator) {
    notes.push("Could not find location field; leaving it for manual review.");
    return;
  }

  await locator.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await locator.fill(location, { timeout: FIELD_TIMEOUT_MS });
  const suggestion = page.locator(LOCATION_SUGGESTION_SELECTOR).first();
  await waitForLocatorVisible(suggestion, 2000);
  await page.keyboard.press("Enter").catch(() => undefined);
}
