import type { Page } from "playwright";
import type {
  FillListingOptions,
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
  LISTING_NEXT_BUTTON_SELECTORS,
  LOCATION_FIELD_SELECTORS,
  LOCATION_SUGGESTION_SELECTOR,
  PHOTO_INPUT_SELECTOR,
  PRICE_FIELD_SELECTORS,
  PUBLISH_BUTTON_SELECTORS,
  TITLE_FIELD_SELECTORS
} from "./selectors.js";

const PUBLISH_CONFIRM_TIMEOUT_MS = 30000;
const CREATE_URL_PATTERN = /\/marketplace\/create\//i;
const ITEM_URL_PATTERN = /\/marketplace\/item\/\d+/i;

export async function fillListingForm(
  config: RuntimeConfig,
  draft: ListingDraft,
  options?: FillListingOptions
): Promise<FillListingResult> {
  const context = await getOrLaunchContext(config, options);
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

    let listingUrl: string | null = null;
    if (options?.publish) {
      const runExclusive = options.publish.runExclusive ?? ((fn) => fn());
      listingUrl = await runExclusive(() => publishListing(page, notes));
      notes.push(
        "Published automatically because an explicit human approval token was supplied."
      );
    }

    const published = options?.publish !== undefined;
    const screenshotPath = await captureScreenshot(
      config,
      page,
      published ? `${draft.draft_id}_published` : draft.draft_id
    );

    if (options?.persistStatus !== false) {
      draft.status = "form_filled";
      draft.updated_at = new Date().toISOString();
      await updateDraft(config, draft);
    }

    return {
      status: published ? "published" : "ready_for_manual_publish",
      draft_id: draft.draft_id,
      profile: config.profileId,
      screenshot_path: screenshotPath,
      browser_state: published ? "published_screen" : "waiting_on_publish_screen",
      listing_url: listingUrl,
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

/**
 * Clicks through to a published listing. Only reached when the caller supplied a
 * human approval token; the default path still stops at the review screen.
 * Returns the listing URL when Facebook lands on the item page, otherwise null.
 */
async function publishListing(page: Page, notes: string[]): Promise<string | null> {
  let publishButton = await firstUsableLocator(
    page,
    PUBLISH_BUTTON_SELECTORS,
    FIELD_TIMEOUT_MS
  );

  if (!publishButton) {
    const nextButton = await firstUsableLocator(page, LISTING_NEXT_BUTTON_SELECTORS);
    if (nextButton) {
      await nextButton.click({ timeout: FIELD_TIMEOUT_MS });
      notes.push("Advanced past the Next step before publishing.");
      publishButton = await firstUsableLocator(
        page,
        PUBLISH_BUTTON_SELECTORS,
        FIELD_TIMEOUT_MS
      );
    }
  }

  if (!publishButton) {
    throw new Error(
      "Could not find the Facebook Marketplace Publish button. The form is filled and left open for manual review."
    );
  }

  await publishButton
    .scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS })
    .catch(() => undefined);
  await publishButton.click({ timeout: FIELD_TIMEOUT_MS });

  const finalUrl = await waitForPublishConfirmed(page);
  if (!finalUrl) {
    throw new Error(
      "Clicked Publish but could not confirm that Facebook accepted the listing. Review the open browser before retrying so the item is not posted twice."
    );
  }

  const itemMatch = finalUrl.match(ITEM_URL_PATTERN);
  return itemMatch ? `https://www.facebook.com${itemMatch[0]}` : null;
}

/**
 * Facebook navigates away from the create flow once a listing is accepted, so
 * leaving that URL is the confirmation signal.
 */
async function waitForPublishConfirmed(page: Page): Promise<string | undefined> {
  const deadline = Date.now() + PUBLISH_CONFIRM_TIMEOUT_MS;
  for (;;) {
    const url = page.url();
    if (!CREATE_URL_PATTERN.test(url)) {
      return url;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await page.waitForTimeout(500);
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
