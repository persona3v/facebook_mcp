import type { Page } from "playwright";
import type {
  FillListingOptions,
  FillListingResult,
  FillListingStatus,
  ListingDraft,
  RuntimeConfig
} from "./types.js";
import { normalizeApprovalToken } from "./parse.js";
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
const ITEM_URL_PATTERN = /\/marketplace\/item\/\d+/i;
const SELLING_URL_PATTERN = /\/marketplace\/you\/selling/i;
// Posting the same item across accounts is what trips Facebook's risk review,
// so a checkpoint or a bounce back to login is a likely destination after the
// click and must never be mistaken for a successful publish.
const BLOCKED_URL_PATTERN = /\/(checkpoint|login|recover|confirmemail|disabled)/i;

interface PublishConfirmation {
  outcome: "published" | "blocked" | "unconfirmed";
  url: string;
  listingUrl: string | null;
}

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

    let status: FillListingStatus = "ready_for_manual_publish";
    let listingUrl: string | null = null;

    if (options?.publish) {
      // Re-validate here rather than trusting the caller's gate, so no future
      // path can reach a Publish click without a real approval token.
      normalizeApprovalToken(options.publish.approvalToken, "publishing a listing");
      const runExclusive = options.publish.runExclusive ?? ((fn) => fn());
      const confirmation = await runExclusive(() => publishListing(page, notes));
      listingUrl = confirmation.listingUrl;
      status = confirmation.outcome === "published" ? "published" : "publish_unconfirmed";
      notes.push(
        status === "published"
          ? "Published automatically because an explicit human approval token was supplied."
          : "Clicked Publish with an explicit human approval token, but could not confirm the result. Check this account manually before retrying so the item is not posted twice."
      );
    }

    const attemptedPublish = options?.publish !== undefined;
    const screenshotPath = await captureScreenshot(
      config,
      page,
      attemptedPublish ? `${draft.draft_id}_${status}` : draft.draft_id
    );

    if (options?.persistStatus !== false) {
      draft.status = status === "published" ? "published" : "form_filled";
      draft.updated_at = new Date().toISOString();
      await updateDraft(config, draft);
    }

    return {
      status,
      draft_id: draft.draft_id,
      profile: config.profileId,
      screenshot_path: screenshotPath,
      browser_state:
        status === "ready_for_manual_publish"
          ? "waiting_on_publish_screen"
          : "published_screen",
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
        // Attach it to the error too: `notes` dies with the throw, and a
        // broadcast's per-account catch has no other way to surface the one
        // screenshot that explains why this account failed.
        if (error instanceof Error) {
          (error as ScreenshotBearingError).screenshotPath = screenshotPath;
        }
      }
    }
    throw error;
  }
}

interface ScreenshotBearingError extends Error {
  screenshotPath?: string;
}

export function screenshotPathFromError(error: unknown): string | null {
  return error instanceof Error
    ? ((error as ScreenshotBearingError).screenshotPath ?? null)
    : null;
}

/**
 * Clicks through to a published listing. Only reached when the caller supplied a
 * human approval token; the default path still stops at the review screen.
 * Returns the listing URL when Facebook lands on the item page, otherwise null.
 */
async function publishListing(
  page: Page,
  notes: string[]
): Promise<PublishConfirmation> {
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

  const confirmation = await waitForPublishConfirmed(page);

  if (confirmation.outcome === "blocked") {
    throw new Error(
      `Clicked Publish but Facebook redirected to ${confirmation.url}. The listing was not published; this account needs manual attention (login, 2FA, or a security checkpoint) before retrying.`
    );
  }

  if (confirmation.outcome === "unconfirmed") {
    notes.push(
      `Could not confirm the publish. The browser ended on ${confirmation.url}, which is neither a listing page nor the seller listings page.`
    );
  }

  return confirmation;
}

/**
 * Requires a positive destination. Merely leaving the create flow is not proof
 * of success: a rejected or risk-checked publish also navigates away, and
 * reporting that as published would tell the operator an item is live when it
 * is not.
 */
async function waitForPublishConfirmed(page: Page): Promise<PublishConfirmation> {
  const deadline = Date.now() + PUBLISH_CONFIRM_TIMEOUT_MS;
  for (;;) {
    const url = page.url();

    if (BLOCKED_URL_PATTERN.test(url)) {
      return { outcome: "blocked", url, listingUrl: null };
    }

    const item = url.match(ITEM_URL_PATTERN);
    if (item) {
      return {
        outcome: "published",
        url,
        listingUrl: `https://www.facebook.com${item[0]}`
      };
    }

    if (SELLING_URL_PATTERN.test(url)) {
      return { outcome: "published", url, listingUrl: null };
    }

    if (Date.now() >= deadline) {
      return { outcome: "unconfirmed", url, listingUrl: null };
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
