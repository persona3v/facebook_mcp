import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_PROFILE_ID,
  expandHome,
  loadBaseSettings,
  loadConfig,
  makeConfig
} from "./config.js";
import type { BaseSettings } from "./config.js";
import type { ProfileSummary, RuntimeConfig } from "./types.js";

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const profileEntrySchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .regex(
        PROFILE_ID_PATTERN,
        "profile id may only contain letters, numbers, hyphens, and underscores"
      ),
    label: z.string().trim().min(1).optional(),
    data_dir: z.string().trim().min(1).optional(),
    browser_user_data_dir: z.string().trim().min(1).optional(),
    browser_mode: z.enum(["managed_profile", "existing_cdp"]).optional(),
    browser_cdp_url: z.string().trim().min(1).optional(),
    browser_channel: z.string().trim().min(1).optional(),
    chrome_profile_name: z.string().trim().min(1).optional(),
    home_location: z.string().trim().min(1).optional(),
    headless: z.boolean().optional()
  })
  .strict();

const profilesFileSchema = z
  .object({
    version: z.literal(1),
    default_profile: z.string().trim().min(1).optional(),
    profiles: z.array(profileEntrySchema).min(1)
  })
  .strict();

export interface ProfileRegistry {
  profiles: Map<string, RuntimeConfig>;
  defaultProfileId: string;
  source: "profiles_file" | "environment";
  profilesFile: string;
}

export function loadProfiles(base: BaseSettings = loadBaseSettings()): ProfileRegistry {
  const raw = readProfilesFile(base.profilesFile);

  if (raw === undefined && base.profilesFileIsExplicit) {
    // Falling back to single-account mode here would be silent and dangerous: a
    // typo'd path makes broadcast_listing_draft report success on one account
    // while the operator believes it posted to several.
    throw new Error(
      `FB_PROFILES_FILE points at ${base.profilesFile}, which does not exist. Create it, or unset FB_PROFILES_FILE to run as a single account.`
    );
  }

  if (raw === undefined) {
    const config = loadConfig(base);
    return {
      profiles: new Map([[config.profileId, config]]),
      defaultProfileId: config.profileId,
      source: "environment",
      profilesFile: base.profilesFile
    };
  }

  const parsed = profilesFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${base.profilesFile} is not a valid profiles file. ${issues}`);
  }

  const profiles = new Map<string, RuntimeConfig>();
  for (const entry of parsed.data.profiles) {
    if (profiles.has(entry.id)) {
      throw new Error(
        `${base.profilesFile} defines the profile id "${entry.id}" more than once.`
      );
    }

    const dataDir = entry.data_dir
      ? expandHome(entry.data_dir)
      : path.join(base.rootDataDir, "profiles", entry.id);

    profiles.set(
      entry.id,
      makeConfig(base, {
        profileId: entry.id,
        label: entry.label,
        dataDir,
        // Drafts and photos stay at the shared root so one authored listing can
        // be broadcast to every account.
        draftsDir: path.join(base.rootDataDir, "drafts"),
        photosDir: path.join(base.rootDataDir, "photos"),
        browserUserDataDir: entry.browser_user_data_dir
          ? expandHome(entry.browser_user_data_dir)
          : path.join(dataDir, "browser-profile"),
        browserMode: entry.browser_mode,
        browserCdpUrl: entry.browser_cdp_url,
        browserChannel: entry.browser_channel,
        chromeProfileName: entry.chrome_profile_name,
        defaultLocation: entry.home_location,
        headless: entry.headless
      })
    );
  }

  const defaultProfileId = parsed.data.default_profile ?? parsed.data.profiles[0].id;
  if (!profiles.has(defaultProfileId)) {
    throw new Error(
      `${base.profilesFile} sets default_profile to "${defaultProfileId}", which is not one of: ${[...profiles.keys()].join(", ")}.`
    );
  }

  assertDistinctBrowserTargets(profiles, base.profilesFile);

  return {
    profiles,
    defaultProfileId,
    source: "profiles_file",
    profilesFile: base.profilesFile
  };
}

export function resolveProfileConfig(
  registry: ProfileRegistry,
  profileId?: string
): RuntimeConfig {
  const requested = profileId?.trim();
  const id = requested && requested.length > 0 ? requested : registry.defaultProfileId;
  const config = registry.profiles.get(id);
  if (!config) {
    throw new Error(
      `Unknown profile "${id}". Configured profiles: ${[...registry.profiles.keys()].join(", ")}.`
    );
  }
  return config;
}

export function summarizeProfiles(registry: ProfileRegistry): ProfileSummary[] {
  return [...registry.profiles.values()].map((config) => ({
    profile: config.profileId,
    label: config.label ?? null,
    is_default: config.profileId === registry.defaultProfileId,
    browser_mode: config.browserMode,
    browser_cdp_url: config.browserMode === "existing_cdp" ? config.browserCdpUrl : null,
    data_dir: config.dataDir,
    drafts_dir: config.draftsDir,
    browser_user_data_dir: config.browserUserDataDir
  }));
}

function readProfilesFile(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the profiles file at ${filePath}: ${detail}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${filePath} is not valid JSON: ${detail}`);
  }
}

/**
 * Two managed profiles sharing a user data directory make Chrome refuse to start
 * the second one; two CDP profiles sharing an endpoint silently hand back the
 * same context, so both "accounts" would drive one logged-in browser.
 */
function assertDistinctBrowserTargets(
  profiles: Map<string, RuntimeConfig>,
  profilesFile: string
): void {
  const dataDirOwners = new Map<string, string>();
  const userDataDirOwners = new Map<string, string>();
  const cdpOwners = new Map<string, string>();

  for (const config of profiles.values()) {
    // inventory.json, messages.db, screenshots and logs all hang off dataDir,
    // so sharing one would silently merge two accounts' listings and buyer
    // conversations into the same files.
    const dataDirKey = normalizePathKey(config.dataDir);
    const dataDirOwner = dataDirOwners.get(dataDirKey);
    if (dataDirOwner) {
      throw new Error(
        `${profilesFile}: profiles "${dataDirOwner}" and "${config.profileId}" share the data directory ${config.dataDir}. Each account needs its own, or their listings and messages would be merged.`
      );
    }
    dataDirOwners.set(dataDirKey, config.profileId);

    if (config.browserMode === "managed_profile") {
      const key = normalizePathKey(config.browserUserDataDir);
      const owner = userDataDirOwners.get(key);
      if (owner) {
        throw new Error(
          `${profilesFile}: profiles "${owner}" and "${config.profileId}" share the browser user data directory ${config.browserUserDataDir}. Chrome locks this directory, so each managed_profile account needs its own.`
        );
      }
      userDataDirOwners.set(key, config.profileId);
      continue;
    }

    const key = config.browserCdpUrl.trim().toLowerCase();
    const owner = cdpOwners.get(key);
    if (owner) {
      throw new Error(
        `${profilesFile}: profiles "${owner}" and "${config.profileId}" share the CDP endpoint ${config.browserCdpUrl}. Each existing_cdp account needs its own Chrome started on a separate remote debugging port.`
      );
    }
    cdpOwners.set(key, config.profileId);
  }
}

function normalizePathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export { DEFAULT_PROFILE_ID };
