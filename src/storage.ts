import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { ListingDraft, RuntimeConfig } from "./types.js";

const DRAFT_ID_PATTERN = /^draft_\d{8}_\d{6}_[a-z0-9]{4}$/;

export async function ensureStorage(config: RuntimeConfig): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(config.dataDir, 0o700).catch(() => undefined);

  for (const dir of [
    config.draftsDir,
    config.photosDir,
    config.screenshotsDir,
    config.logsDir
  ]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => undefined);
  }
}

export function makeDraftId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "_");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `draft_${stamp}_${suffix}`;
}

export function draftPath(config: RuntimeConfig, draftId: string): string {
  assertSafeDraftId(draftId);
  return path.join(config.draftsDir, `${draftId}.json`);
}

export async function saveDraft(
  config: RuntimeConfig,
  draft: ListingDraft
): Promise<string> {
  await ensureStorage(config);
  const filePath = draftPath(config, draft.draft_id);
  const body = `${JSON.stringify(draft, null, 2)}\n`;
  await fs.writeFile(filePath, body, { mode: 0o600, flag: "wx" });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
  return filePath;
}

export async function updateDraft(
  config: RuntimeConfig,
  draft: ListingDraft
): Promise<string> {
  await ensureStorage(config);
  const filePath = draftPath(config, draft.draft_id);
  const body = `${JSON.stringify(draft, null, 2)}\n`;
  await fs.writeFile(filePath, body, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
  return filePath;
}

export async function loadDraft(
  config: RuntimeConfig,
  draftId: string
): Promise<ListingDraft> {
  const filePath = draftPath(config, draftId);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as ListingDraft;
  if (parsed.draft_id !== draftId) {
    throw new Error(`Draft id mismatch in ${filePath}`);
  }
  return parsed;
}

export async function assertReadableFiles(paths: string[]): Promise<void> {
  for (const filePath of paths) {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`Photo path must be absolute: ${filePath}`);
    }
    await fs.access(filePath, constants.R_OK);
  }
}

function assertSafeDraftId(draftId: string): void {
  if (!DRAFT_ID_PATTERN.test(draftId)) {
    throw new Error(`Invalid draft_id: ${draftId}`);
  }
}
