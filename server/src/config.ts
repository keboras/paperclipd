import { readConfigFile } from "./config-file.js";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { resolvePaperclipEnvPath } from "./paths.js";
import { maybeRepairLegacyWorktreeConfigAndEnvFiles } from "./worktree-config.js";
import {
  AUTH_BASE_URL_MODES,
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  type BindMode,
  type AuthBaseUrlMode,
  type DeploymentExposure,
  type DeploymentMode,
  type SecretProvider,
  type StorageProvider,
  inferBindModeFromHost,
  resolveRuntimeBind,
  validateConfiguredBindMode,
} from "@paperclipai/shared";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
} from "./home-paths.js";

function findAncestorDirContaining(markerName: string, startDir: string): string | null {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 24; depth += 1) {
    if (existsSync(path.join(current, markerName))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveMonorepoRootDir(): string | null {
  const serverPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return (
    findAncestorDirContaining("pnpm-workspace.yaml", process.cwd()) ??
    findAncestorDirContaining("pnpm-workspace.yaml", serverPackageDir)
  );
}

function realpathOrSelf(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function loadDotenvIfNewFile(filePath: string, alreadyLoaded: Set<string>): void {
  if (!existsSync(filePath)) return;
  const key = realpathOrSelf(filePath);
  if (alreadyLoaded.has(key)) return;
  loadDotenv({ path: filePath, override: false, quiet: true });
  alreadyLoaded.add(key);
}

const loadedEnvRealpaths = new Set<string>();

const PAPERCLIP_ENV_FILE_PATH = resolvePaperclipEnvPath();
loadDotenvIfNewFile(PAPERCLIP_ENV_FILE_PATH, loadedEnvRealpaths);

const CWD_ENV_PATH = path.resolve(process.cwd(), ".env");
loadDotenvIfNewFile(CWD_ENV_PATH, loadedEnvRealpaths);

const monorepoRoot = resolveMonorepoRootDir();
const MONOREPO_ENV_PATH = monorepoRoot ? path.join(monorepoRoot, ".env") : null;
if (MONOREPO_ENV_PATH) {
  loadDotenvIfNewFile(MONOREPO_ENV_PATH, loadedEnvRealpaths);
}

maybeRepairLegacyWorktreeConfigAndEnvFiles();

const TAILSCALE_DETECT_TIMEOUT_MS = 3000;

type DatabaseMode = "embedded-postgres" | "postgres";

export interface Config {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bind: BindMode;
  customBindHost: string | undefined;
  host: string;
  port: number;
  allowedHostnames: string[];
  authBaseUrlMode: AuthBaseUrlMode;
  authPublicBaseUrl: string | undefined;
  authDisableSignUp: boolean;
  databaseMode: DatabaseMode;
  databaseUrl: string | undefined;
  embeddedPostgresDataDir: string;
  embeddedPostgresPort: number;
  databaseBackupEnabled: boolean;
  databaseBackupIntervalMinutes: number;
  databaseBackupRetentionDays: number;
  databaseBackupDir: string;
  serveUi: boolean;
  uiDevMiddleware: boolean;
  secretsProvider: SecretProvider;
  secretsStrictMode: boolean;
  secretsMasterKeyFilePath: string;
  storageProvider: StorageProvider;
  storageLocalDiskBaseDir: string;
  storageS3Bucket: string;
  storageS3Region: string;
  storageS3Endpoint: string | undefined;
  storageS3Prefix: string;
  storageS3ForcePathStyle: boolean;
  feedbackExportBackendUrl: string | undefined;
  feedbackExportBackendToken: string | undefined;
  heartbeatSchedulerEnabled: boolean;
  heartbeatSchedulerIntervalMs: number;
  companyDeletionEnabled: boolean;
  telemetryEnabled: boolean;
}

/**
 * Better Auth requires an absolute URL (with scheme). Deploy envs often set only the host
 * (e.g. Railway: `app.up.railway.app`). Prepend https://, or http:// for obvious local hosts.
 */
function normalizeAuthPublicBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    const lower = trimmed.toLowerCase();
    const local =
      lower === "localhost" ||
      lower.startsWith("localhost:") ||
      lower === "127.0.0.1" ||
      lower.startsWith("127.0.0.1:") ||
      lower.startsWith("[::1]");
    const prefix = local ? "http://" : "https://";
    const candidate = `${prefix}${trimmed}`;
    try {
      new URL(candidate);
      return candidate;
    } catch {
      return trimmed;
    }
  }
}

function detectTailnetBindHost(): string | undefined {
  const explicit = process.env.PAPERCLIP_TAILNET_BIND_HOST?.trim();
  if (explicit) return explicit;

  try {
    const stdout = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TAILSCALE_DETECT_TIMEOUT_MS,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

export function loadConfig(): Config {
  const fileConfig = readConfigFile();
  const fileDatabaseMode =
    (fileConfig?.database.mode === "postgres" ? "postgres" : "embedded-postgres") as DatabaseMode;

  const fileDbUrl =
    fileDatabaseMode === "postgres"
      ? fileConfig?.database.connectionString
      : undefined;
  const fileDatabaseBackup = fileConfig?.database.backup;
  const fileSecrets = fileConfig?.secrets;
  const fileStorage = fileConfig?.storage;
  const strictModeFromEnv = process.env.PAPERCLIP_SECRETS_STRICT_MODE;
  const secretsStrictMode =
    strictModeFromEnv !== undefined
      ? strictModeFromEnv === "true"
      : (fileSecrets?.strictMode ?? false);

  const providerFromEnvRaw = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const providerFromEnv =
    providerFromEnvRaw && SECRET_PROVIDERS.includes(providerFromEnvRaw as SecretProvider)
      ? (providerFromEnvRaw as SecretProvider)
      : null;
  const providerFromFile = fileSecrets?.provider;
  const secretsProvider: SecretProvider = providerFromEnv ?? providerFromFile ?? "local_encrypted";

  const storageProviderFromEnvRaw = process.env.PAPERCLIP_STORAGE_PROVIDER;
  const storageProviderFromEnv =
    storageProviderFromEnvRaw && STORAGE_PROVIDERS.includes(storageProviderFromEnvRaw as StorageProvider)
      ? (storageProviderFromEnvRaw as StorageProvider)
      : null;
  const storageProvider: StorageProvider = storageProviderFromEnv ?? fileStorage?.provider ?? "local_disk";
  const storageLocalDiskBaseDir = resolveHomeAwarePath(
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR ??
      fileStorage?.localDisk?.baseDir ??
      resolveDefaultStorageDir(),
  );
  const storageS3Bucket = process.env.PAPERCLIP_STORAGE_S3_BUCKET ?? fileStorage?.s3?.bucket ?? "paperclip";
  const storageS3Region = process.env.PAPERCLIP_STORAGE_S3_REGION ?? fileStorage?.s3?.region ?? "us-east-1";
  const storageS3Endpoint = process.env.PAPERCLIP_STORAGE_S3_ENDPOINT ?? fileStorage?.s3?.endpoint ?? undefined;
  const storageS3Prefix = process.env.PAPERCLIP_STORAGE_S3_PREFIX ?? fileStorage?.s3?.prefix ?? "";
  const storageS3ForcePathStyle =
    process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE !== undefined
      ? process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE === "true"
      : (fileStorage?.s3?.forcePathStyle ?? false);
  const feedbackExportBackendUrl =
    process.env.PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL?.trim() ||
    process.env.PAPERCLIP_TELEMETRY_BACKEND_URL?.trim() ||
    undefined;
  const feedbackExportBackendToken =
    process.env.PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN?.trim() ||
    process.env.PAPERCLIP_TELEMETRY_BACKEND_TOKEN?.trim() ||
    undefined;

  const deploymentModeFromEnvRaw = process.env.PAPERCLIP_DEPLOYMENT_MODE;
  const deploymentModeFromEnv =
    deploymentModeFromEnvRaw && DEPLOYMENT_MODES.includes(deploymentModeFromEnvRaw as DeploymentMode)
      ? (deploymentModeFromEnvRaw as DeploymentMode)
      : null;
  const deploymentMode: DeploymentMode = deploymentModeFromEnv ?? fileConfig?.server.deploymentMode ?? "local_trusted";
  const deploymentExposureFromEnvRaw = process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
  const deploymentExposureFromEnv =
    deploymentExposureFromEnvRaw &&
    DEPLOYMENT_EXPOSURES.includes(deploymentExposureFromEnvRaw as DeploymentExposure)
      ? (deploymentExposureFromEnvRaw as DeploymentExposure)
      : null;
  const deploymentExposure: DeploymentExposure =
    deploymentMode === "local_trusted"
      ? "private"
      : (deploymentExposureFromEnv ?? fileConfig?.server.exposure ?? "private");
  const bindFromEnvRaw = process.env.PAPERCLIP_BIND;
  const bindFromEnv =
    bindFromEnvRaw && BIND_MODES.includes(bindFromEnvRaw as BindMode)
      ? (bindFromEnvRaw as BindMode)
      : null;
  const configuredHost = process.env.HOST ?? fileConfig?.server.host ?? "127.0.0.1";
  const tailnetBindHost = detectTailnetBindHost();
  const bind =
    bindFromEnv ??
    fileConfig?.server.bind ??
    inferBindModeFromHost(configuredHost, { tailnetBindHost });
  const customBindHost = process.env.PAPERCLIP_BIND_HOST ?? fileConfig?.server.customBindHost;
  const authBaseUrlModeFromEnvRaw = process.env.PAPERCLIP_AUTH_BASE_URL_MODE;
  const authBaseUrlModeFromEnv =
    authBaseUrlModeFromEnvRaw &&
    AUTH_BASE_URL_MODES.includes(authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      ? (authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      : null;
  const publicUrlFromEnv = process.env.PAPERCLIP_PUBLIC_URL;
  const authPublicBaseUrlRaw =
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    publicUrlFromEnv ??
    fileConfig?.auth?.publicBaseUrl;
  const authPublicBaseUrl = normalizeAuthPublicBaseUrl(authPublicBaseUrlRaw);
  const authBaseUrlMode: AuthBaseUrlMode =
    authBaseUrlModeFromEnv ??
    fileConfig?.auth?.baseUrlMode ??
    (authPublicBaseUrl ? "explicit" : "auto");
  const disableSignUpFromEnv = process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP;
  const authDisableSignUp: boolean =
    disableSignUpFromEnv !== undefined
      ? disableSignUpFromEnv === "true"
      : (fileConfig?.auth?.disableSignUp ?? false);
  const allowedHostnamesFromEnvRaw = process.env.PAPERCLIP_ALLOWED_HOSTNAMES;
  const allowedHostnamesFromEnv = allowedHostnamesFromEnvRaw
    ? allowedHostnamesFromEnvRaw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : null;
  const publicUrlHostname = authPublicBaseUrl
    ? (() => {
      try {
        return new URL(authPublicBaseUrl).hostname.trim().toLowerCase();
      } catch {
        return null;
      }
    })()
    : null;
  const allowedHostnames = Array.from(
    new Set(
      [
        ...(allowedHostnamesFromEnv ?? fileConfig?.server.allowedHostnames ?? []),
        ...(publicUrlHostname ? [publicUrlHostname] : []),
      ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const companyDeletionEnvRaw = process.env.PAPERCLIP_ENABLE_COMPANY_DELETION;
  const companyDeletionEnabled =
    companyDeletionEnvRaw !== undefined
      ? companyDeletionEnvRaw === "true"
      : deploymentMode === "local_trusted";
  const databaseBackupEnabled =
    process.env.PAPERCLIP_DB_BACKUP_ENABLED !== undefined
      ? process.env.PAPERCLIP_DB_BACKUP_ENABLED === "true"
      : (fileDatabaseBackup?.enabled ?? true);
  const databaseBackupIntervalMinutes = Math.max(
    1,
    Number(process.env.PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES) ||
      fileDatabaseBackup?.intervalMinutes ||
      60,
  );
  const databaseBackupRetentionDays = Math.max(
    1,
    Number(process.env.PAPERCLIP_DB_BACKUP_RETENTION_DAYS) ||
      fileDatabaseBackup?.retentionDays ||
      7,
  );
  const databaseBackupDir = resolveHomeAwarePath(
    process.env.PAPERCLIP_DB_BACKUP_DIR ??
      fileDatabaseBackup?.dir ??
      resolveDefaultBackupDir(),
  );
  const bindValidationErrors = validateConfiguredBindMode({
    deploymentMode,
    deploymentExposure,
    bind,
    host: configuredHost,
    customBindHost,
  });
  if (bindValidationErrors.length > 0) {
    throw new Error(bindValidationErrors[0]);
  }
  const resolvedBind = resolveRuntimeBind({
    bind,
    host: configuredHost,
    customBindHost,
    tailnetBindHost,
  });
  if (resolvedBind.errors.length > 0) {
    throw new Error(resolvedBind.errors[0]);
  }

  return {
    deploymentMode,
    deploymentExposure,
    bind: resolvedBind.bind,
    customBindHost: resolvedBind.customBindHost,
    host: resolvedBind.host,
    port: Number(process.env.PORT) || fileConfig?.server.port || 3100,
    allowedHostnames,
    authBaseUrlMode,
    authPublicBaseUrl,
    authDisableSignUp,
    databaseMode: fileDatabaseMode,
    databaseUrl: process.env.DATABASE_URL ?? fileDbUrl,
    embeddedPostgresDataDir: resolveHomeAwarePath(
      fileConfig?.database.embeddedPostgresDataDir ?? resolveDefaultEmbeddedPostgresDir(),
    ),
    embeddedPostgresPort: fileConfig?.database.embeddedPostgresPort ?? 54329,
    databaseBackupEnabled,
    databaseBackupIntervalMinutes,
    databaseBackupRetentionDays,
    databaseBackupDir,
    serveUi:
      process.env.SERVE_UI !== undefined
        ? process.env.SERVE_UI === "true"
        : fileConfig?.server.serveUi ?? true,
    uiDevMiddleware: process.env.PAPERCLIP_UI_DEV_MIDDLEWARE === "true",
    secretsProvider,
    secretsStrictMode,
    secretsMasterKeyFilePath:
      resolveHomeAwarePath(
        process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ??
          fileSecrets?.localEncrypted.keyFilePath ??
          resolveDefaultSecretsKeyFilePath(),
      ),
    storageProvider,
    storageLocalDiskBaseDir,
    storageS3Bucket,
    storageS3Region,
    storageS3Endpoint,
    storageS3Prefix,
    storageS3ForcePathStyle,
    feedbackExportBackendUrl,
    feedbackExportBackendToken,
    heartbeatSchedulerEnabled: process.env.HEARTBEAT_SCHEDULER_ENABLED !== "false",
    heartbeatSchedulerIntervalMs: Math.max(10000, Number(process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS) || 30000),
    companyDeletionEnabled,
    telemetryEnabled: fileConfig?.telemetry?.enabled ?? true,
  };
}
