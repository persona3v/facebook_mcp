import path from "node:path";
import { promises as fs } from "node:fs";
import type { Locator, Page } from "playwright";
import type { RuntimeConfig } from "./types.js";

export const SHORT_TIMEOUT_MS = 3000;
export const FIELD_TIMEOUT_MS = 8000;
export const PAGE_READY_TIMEOUT_MS = 10000;
const VISIBLE_PROBE_INTERVAL_MS = 150;

export async function firstUsableLocator(
  page: Page,
  selectors: string[],
  timeoutMs = SHORT_TIMEOUT_MS
): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await page.waitForTimeout(VISIBLE_PROBE_INTERVAL_MS);
  }
}

export async function waitForAnyVisible(
  page: Page,
  selectors: string[],
  timeoutMs: number
): Promise<boolean> {
  return (await firstUsableLocator(page, selectors, timeoutMs)) !== undefined;
}

export async function waitForLocatorVisible(
  locator: Locator,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await locator.isVisible().catch(() => false)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await locator.page().waitForTimeout(VISIBLE_PROBE_INTERVAL_MS);
  }
}

export async function waitForPageReady(
  page: Page,
  anchorSelectors: string[],
  surface: string,
  notes: string[]
): Promise<void> {
  const ready = await waitForAnyVisible(page, anchorSelectors, PAGE_READY_TIMEOUT_MS);
  if (!ready) {
    notes.push(`Timed out waiting for the ${surface} to render; continuing with visible content.`);
  }
}

export async function captureScreenshot(
  config: RuntimeConfig,
  page: Page,
  basename: string
): Promise<string> {
  const screenshotPath = await makeScreenshotPath(config, basename);
  await page.screenshot({ path: screenshotPath, fullPage: config.screenshotFullPage });
  return screenshotPath;
}

export async function scrollPage(page: Page, maxScrolls: number): Promise<void> {
  let previousTextLength = await visibleTextLength(page);
  for (let i = 0; i < maxScrolls; i += 1) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(800);
    const textLength = await visibleTextLength(page);
    if (textLength <= previousTextLength) {
      break;
    }
    previousTextLength = textLength;
  }
}

async function makeScreenshotPath(
  config: RuntimeConfig,
  basename: string
): Promise<string> {
  await fs.mkdir(config.screenshotsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "_").slice(0, 15);
  return path.join(config.screenshotsDir, `${basename}_${stamp}.png`);
}

async function visibleTextLength(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const doc = (globalThis as any).document;
      return String(doc?.body?.innerText || "").length;
    })
    .catch(() => 0);
}
