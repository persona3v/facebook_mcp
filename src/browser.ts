import { promises as fs } from "node:fs";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page } from "playwright";
import type {
  BrowserConnectionOptions,
  BrowserMode,
  RuntimeConfig
} from "./types.js";

interface BrowserSession {
  profileId: string;
  mode: BrowserMode;
  cdpUrl?: string;
  context: BrowserContext;
  browser?: Browser;
  closed: boolean;
  detach: () => void;
}

/**
 * One live session per profile, so several accounts can be logged in and driven
 * at the same time. The map holds the in-flight launch promise rather than the
 * resolved session: concurrent callers for one profile then share a single
 * launch instead of racing to open Chrome twice against a locked user data dir.
 */
const sessions = new Map<string, Promise<BrowserSession>>();
let stealthRegistered = false;

function ensureStealthRegistered(): void {
  if (stealthRegistered) {
    return;
  }
  chromium.use(StealthPlugin());
  stealthRegistered = true;
}

export async function getOrLaunchContext(
  config: RuntimeConfig,
  browserOptions?: BrowserConnectionOptions
): Promise<BrowserContext> {
  const { profileId } = config;
  const mode = browserOptions?.browserMode ?? config.browserMode;
  const cdpUrl = browserOptions?.browserCdpUrl ?? config.browserCdpUrl;

  const pending = sessions.get(profileId);
  if (pending) {
    const existing = await pending.catch(() => undefined);
    if (existing && isReusable(existing, mode, cdpUrl)) {
      return existing.context;
    }
    await closeBrowserContext(profileId);
  }

  const launch = createSession(config, mode, cdpUrl);
  sessions.set(profileId, launch);

  try {
    const session = await launch;
    return session.context;
  } catch (error) {
    if (sessions.get(profileId) === launch) {
      sessions.delete(profileId);
    }
    throw error;
  }
}

export async function closeBrowserContext(profileId: string): Promise<void> {
  const pending = sessions.get(profileId);
  if (!pending) {
    return;
  }
  sessions.delete(profileId);
  await disposeSession(pending);
}

export async function closeAllBrowserContexts(): Promise<void> {
  const pending = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(pending.map((entry) => disposeSession(entry)));
}

function isReusable(
  session: BrowserSession,
  mode: BrowserMode,
  cdpUrl: string
): boolean {
  if (session.closed || session.mode !== mode) {
    return false;
  }
  if (mode === "existing_cdp") {
    return session.cdpUrl === cdpUrl && session.browser?.isConnected() === true;
  }
  return true;
}

async function createSession(
  config: RuntimeConfig,
  mode: BrowserMode,
  cdpUrl: string
): Promise<BrowserSession> {
  if (mode === "existing_cdp") {
    return connectExistingBrowserContext(config.profileId, cdpUrl);
  }
  return launchPersistentBrowserContext(config);
}

async function launchPersistentBrowserContext(
  config: RuntimeConfig
): Promise<BrowserSession> {
  await fs.mkdir(config.browserUserDataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(config.browserUserDataDir, 0o700).catch(() => undefined);

  if (config.stealth) {
    ensureStealthRegistered();
  }

  const args = config.chromeProfileName
    ? [`--profile-directory=${config.chromeProfileName}`]
    : [];

  const context = (await chromium.launchPersistentContext(config.browserUserDataDir, {
    channel: config.browserChannel,
    headless: config.headless,
    slowMo: config.slowMoMs,
    viewport: { width: 1440, height: 1000 },
    args
  })) as unknown as BrowserContext;

  const session: BrowserSession = {
    profileId: config.profileId,
    mode: "managed_profile",
    context,
    closed: false,
    detach: () => context.off("close", onClose)
  };

  function onClose(): void {
    session.closed = true;
    void forgetSession(session);
  }

  context.on("close", onClose);
  return session;
}

async function connectExistingBrowserContext(
  profileId: string,
  cdpUrl: string
): Promise<BrowserSession> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not connect to an existing Chrome browser over CDP at ${cdpUrl}. ` +
        "Start Chrome with --remote-debugging-port=9222 and log in to Facebook there, " +
        "or use browser_mode=\"managed_profile\". " +
        `Original error: ${detail}`
    );
  }

  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new Error(
      `Connected to Chrome over CDP at ${cdpUrl}, but no default browser context was available.`
    );
  }

  const session: BrowserSession = {
    profileId,
    mode: "existing_cdp",
    cdpUrl,
    context,
    browser,
    closed: false,
    detach: () => browser.off("disconnected", onDisconnected)
  };

  function onDisconnected(): void {
    session.closed = true;
    void forgetSession(session);
  }

  browser.on("disconnected", onDisconnected);
  return session;
}

async function disposeSession(pending: Promise<BrowserSession>): Promise<void> {
  const session = await pending.catch(() => undefined);
  if (!session) {
    return;
  }

  session.closed = true;
  session.detach();

  if (session.mode === "existing_cdp") {
    // The Chrome behind a CDP endpoint belongs to the user, not to this server.
    // Drop the reference instead of closing so their logged-in window survives;
    // the socket goes away with the process.
    return;
  }

  await session.context.close().catch(() => undefined);
}

/**
 * Drop a session that died on its own, but only if the map still points at that
 * exact session — otherwise a late close event would evict a fresh replacement.
 */
async function forgetSession(session: BrowserSession): Promise<void> {
  const pending = sessions.get(session.profileId);
  if (!pending) {
    return;
  }
  const current = await pending.catch(() => undefined);
  if (current === session && sessions.get(session.profileId) === pending) {
    sessions.delete(session.profileId);
  }
}

export async function getWorkingPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages().filter((page) => !page.isClosed());
  const existing =
    pages.find((page) => {
      try {
        return new URL(page.url()).hostname.endsWith("facebook.com");
      } catch {
        return false;
      }
    }) ?? pages[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}
