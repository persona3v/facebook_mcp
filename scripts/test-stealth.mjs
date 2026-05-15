import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const FINGERPRINT_PROBE = () => ({
  webdriver: navigator.webdriver,
  userAgent: navigator.userAgent,
  languages: navigator.languages,
  pluginsLength: navigator.plugins?.length ?? 0,
  hasChrome: typeof window.chrome !== "undefined",
  chromeRuntime: typeof window.chrome?.runtime !== "undefined",
  platform: navigator.platform,
  vendor: navigator.vendor,
  permissionsQueryNotification: (async () => {
    try {
      const result = await navigator.permissions.query({ name: "notifications" });
      return { state: result.state, notificationPermission: Notification.permission };
    } catch (error) {
      return { error: String(error) };
    }
  })(),
  webgl: (() => {
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      if (!gl) return null;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
      };
    } catch (error) {
      return { error: String(error) };
    }
  })()
});

async function probe(useStealth) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `stealth-probe-${useStealth ? "on" : "off"}-`));
  const localChromium = chromium;
  if (useStealth) {
    localChromium.use(StealthPlugin());
  }

  const context = await localChromium.launchPersistentContext(tmpDir, {
    headless: true,
    viewport: { width: 1280, height: 800 }
  });
  try {
    const page = await context.newPage();
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    const raw = await page.evaluate(FINGERPRINT_PROBE);
    raw.permissionsQueryNotification = await raw.permissionsQueryNotification;
    return raw;
  } finally {
    await context.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function summarize(label, fp) {
  console.log(`\n=== ${label} ===`);
  console.log(`navigator.webdriver        : ${fp.webdriver}`);
  console.log(`navigator.languages        : ${JSON.stringify(fp.languages)}`);
  console.log(`navigator.plugins.length   : ${fp.pluginsLength}`);
  console.log(`window.chrome              : ${fp.hasChrome}`);
  console.log(`window.chrome.runtime      : ${fp.chromeRuntime}`);
  console.log(`navigator.platform         : ${fp.platform}`);
  console.log(`navigator.vendor           : ${fp.vendor}`);
  console.log(`permissions.notifications  : ${JSON.stringify(fp.permissionsQueryNotification)}`);
  console.log(`webgl.vendor / renderer    : ${JSON.stringify(fp.webgl)}`);
  console.log(`userAgent                  : ${fp.userAgent}`);
}

const stealthOff = await probe(false);
summarize("STEALTH OFF (baseline)", stealthOff);
const stealthOn = await probe(true);
summarize("STEALTH ON", stealthOn);

const diffs = [];
const fields = [
  "webdriver",
  "languages",
  "pluginsLength",
  "hasChrome",
  "chromeRuntime",
  "platform",
  "vendor",
  "userAgent"
];
for (const field of fields) {
  if (JSON.stringify(stealthOff[field]) !== JSON.stringify(stealthOn[field])) {
    diffs.push(`  ${field}: ${JSON.stringify(stealthOff[field])} -> ${JSON.stringify(stealthOn[field])}`);
  }
}
const webglOff = JSON.stringify(stealthOff.webgl);
const webglOn = JSON.stringify(stealthOn.webgl);
if (webglOff !== webglOn) {
  diffs.push(`  webgl: ${webglOff} -> ${webglOn}`);
}
const permOff = JSON.stringify(stealthOff.permissionsQueryNotification);
const permOn = JSON.stringify(stealthOn.permissionsQueryNotification);
if (permOff !== permOn) {
  diffs.push(`  permissions.notifications: ${permOff} -> ${permOn}`);
}

console.log("\n=== DIFF (off -> on) ===");
console.log(diffs.length === 0 ? "  (no observable differences)" : diffs.join("\n"));

const passes = [];
const fails = [];
if (stealthOn.webdriver === false || stealthOn.webdriver === undefined) {
  passes.push("navigator.webdriver suppressed");
} else {
  fails.push(`navigator.webdriver still ${stealthOn.webdriver}`);
}
if (stealthOn.pluginsLength > 0) {
  passes.push(`navigator.plugins populated (${stealthOn.pluginsLength})`);
} else {
  fails.push("navigator.plugins empty (real Chrome would expose >0)");
}
if (stealthOn.chromeRuntime) {
  passes.push("window.chrome.runtime present");
} else {
  fails.push("window.chrome.runtime missing");
}

console.log("\n=== VERDICT ===");
for (const p of passes) console.log(`  PASS  ${p}`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length === 0 ? 0 : 1);
