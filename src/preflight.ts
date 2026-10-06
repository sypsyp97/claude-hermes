// preflight.ts — Install Claude Code plugins on first run
// Skips any plugin that is already installed.

import { execSync, type ExecSyncOptions } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  rmSync,
  renameSync,
  realpathSync,
  statSync,
  type Dirent,
} from "fs";
import { join, dirname, isAbsolute, relative, resolve, sep } from "path";
import { homedir, tmpdir } from "os";
import { fileURLToPath } from "url";
import { claudeConfigDir, type ClaudeConfigEnv } from "./runtime/claude-paths";

// ── Plugin repos to install (one plugin per repo) ───────────────────
const PLUGINS = [
  "https://github.com/SawyerHood/dev-browser",
  "https://github.com/thedotmack/claude-mem",
  "https://github.com/obra/superpowers-marketplace",
  // Add more repos here:
  // "https://github.com/user/repo",
];

// ── Cherry-pick from anthropics/claude-plugins-official ─────────────
const OFFICIAL_PLUGINS = [
  "ralph-loop",
  "hookify",
  "code-review",
  "pr-review-toolkit",
  "commit-commands",
  "plugin-dev",
  // Add more plugin names here (must match names in marketplace.json):
  // "typescript-lsp",
  // "playwright",
];

// ── Config ──────────────────────────────────────────────────────────
const OFFICIAL_REPO = "https://github.com/anthropics/claude-plugins-official";
const WHISPER_WARMUP_SCRIPT = fileURLToPath(new URL("./whisper-warmup.ts", import.meta.url));

export interface ClaudePluginPaths {
  pluginsDir: string;
  installedPluginsFile: string;
  knownMarketplacesFile: string;
}

/** Resolve once per preflight run, or explicitly inject home/env for isolated use. */
export function claudePluginPaths(
  home: string = homedir(),
  env: ClaudeConfigEnv = process.env,
): ClaudePluginPaths {
  const pluginsDir = join(claudeConfigDir(home, env), "plugins");
  return {
    pluginsDir,
    installedPluginsFile: join(pluginsDir, "installed_plugins.json"),
    knownMarketplacesFile: join(pluginsDir, "known_marketplaces.json"),
  };
}

interface PluginEntry {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha: string;
  projectPath: string;
}

interface InstalledPlugins {
  version: number;
  plugins: Record<string, PluginEntry[]>;
}

interface MarketplacePlugin {
  name: string;
  skills?: string[];
  source?: string;
}

interface MarketplaceJson {
  name: string;
  plugins: MarketplacePlugin[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function run(cmd: string, opts: ExecSyncOptions = {}): string {
  const result = execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts });
  return (result ?? "").toString().trim();
}

export function readJSON<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function containedPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function pluginIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error("Invalid plugin or marketplace name");
  }
  return value;
}

function pluginDirectory(root: string, source: unknown): string {
  if (source === undefined) return root;
  if (typeof source !== "string" || isAbsolute(source)) {
    throw new Error("Only relative local plugin paths are supported by preflight");
  }
  const path = resolve(root, source);
  if (!containedPath(root, path) || !containedPath(realpathSync(root), realpathSync(path))) {
    throw new Error(`Plugin path escapes its root: ${source}`);
  }
  return path;
}

/** Validate the full copy before removing an older marketplace or executing dependencies. */
function validatePluginTree(src: string, root = realpathSync(src)): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(src, entry.name);
    if (!containedPath(root, realpathSync(path))) {
      throw new Error(`Plugin symlink escapes its root: ${entry.name}`);
    }
    if (entry.isSymbolicLink() && statSync(path).isDirectory()) {
      throw new Error(`Directory symlinks are not supported by preflight: ${entry.name}`);
    }
    if (entry.isDirectory()) validatePluginTree(path, root);
  }
}

function copyDirSync(src: string, dest: string, root = realpathSync(src)): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true }) as Dirent[]) {
    if (entry.name === ".git") continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (!containedPath(root, realpathSync(srcPath))) {
      throw new Error(`Plugin symlink escapes its root: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, root);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function detectPkgManager(): string | null {
  try { run("bun --version"); return "bun"; } catch {}
  try { run("npm --version"); return "npm"; } catch {}
  return null;
}

export function extractRepo(url: string): string {
  return url.replace(/.*github\.com[:/]/, "").replace(/\.git$/, "");
}

export function isCached(pluginKey: string, instFile: string = claudePluginPaths().installedPluginsFile): boolean {
  const instData = readJSON<InstalledPlugins>(instFile, { version: 2, plugins: {} });
  const entries = instData.plugins[pluginKey];
  if (!entries || entries.length === 0) return false;
  return entries.some((e) => existsSync(e.installPath));
}

export function isEnabledInProject(pluginKey: string, projectPath: string): boolean {
  const projSettings = join(projectPath, ".claude", "settings.json");
  const settings = readJSON<Record<string, unknown>>(projSettings, {});
  const enabled = settings.enabledPlugins as Record<string, boolean> | undefined;
  return !!enabled?.[pluginKey];
}

/** Only a missing file may become a new settings object. Never discard broken permissions. */
function readObjectForUpdate(filePath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${filePath}; refusing to overwrite it`);
  }
  return parsed as Record<string, unknown>;
}

export function enableInProject(pluginKey: string, projectPath: string): void {
  const projSettings = join(projectPath, ".claude", "settings.json");
  const settings = readObjectForUpdate(projSettings);
  const enabled = settings.enabledPlugins;
  if (enabled !== undefined && (!enabled || typeof enabled !== "object" || Array.isArray(enabled))) {
    throw new Error(`Invalid enabledPlugins in ${projSettings}; refusing to overwrite it`);
  }
  settings.enabledPlugins = { ...(enabled as Record<string, unknown> | undefined), [pluginKey]: true };
  writeJSON(projSettings, settings);
}

function installDepsIfPresent(dir: string, pkgMgr: string, label: string): void {
  if (!existsSync(join(dir, "package.json"))) return;
  console.log(`    deps (${label}): ${pkgMgr} install`);
  run(`${pkgMgr} install`, { cwd: dir, stdio: "inherit" });
}

function startWhisperWarmupInBackground(): void {
  try {
    const proc = Bun.spawn([process.execPath, "run", WHISPER_WARMUP_SCRIPT], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    proc.unref();
    console.log("preflight: whisper warmup started in background");
  } catch (err) {
    console.error(`preflight: failed to start whisper warmup - ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Install a single-repo plugin ────────────────────────────────────

export function installRepoPlugin(
  repoUrl: string,
  projectPath: string,
  pkgMgr: string,
  paths: ClaudePluginPaths,
): "installed" | "enabled" | "skipped" {
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "claude-plugin-"));
    run(`git clone --quiet "${repoUrl}" "${tempDir}"`);

    const marketplaceJsonPath = join(tempDir, ".claude-plugin", "marketplace.json");
    if (!existsSync(marketplaceJsonPath)) {
      console.log(`  skip: ${repoUrl} (no .claude-plugin/marketplace.json)`);
      return "skipped";
    }

    const marketplace: MarketplaceJson = JSON.parse(readFileSync(marketplaceJsonPath, "utf-8"));
    const marketplaceName = pluginIdentifier(marketplace.name);
    const plugin = marketplace.plugins[0];
    const pluginName = pluginIdentifier(plugin?.name);
    const skillPath = plugin.skills?.[0];
    // Check every manifest-controlled read before replacing an existing marketplace.
    const source = pluginDirectory(tempDir, plugin.source);
    validatePluginTree(source);
    if (skillPath) pluginDirectory(source, skillPath);
    const pluginKey = `${pluginName}@${marketplaceName}`;

    if (isCached(pluginKey, paths.installedPluginsFile) && isEnabledInProject(pluginKey, projectPath)) {
      console.log(`  skip: ${pluginKey} (already installed)`);
      return "skipped";
    }

    if (isCached(pluginKey, paths.installedPluginsFile)) {
      console.log(`  enable: ${pluginKey} (cached, enabling for project)`);
      enableInProject(pluginKey, projectPath);
      return "enabled";
    }

    console.log(`  install: ${pluginKey}`);

    const marketplaceDir = join(paths.pluginsDir, "marketplaces", marketplaceName);
    if (existsSync(marketplaceDir)) {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
    renameSync(tempDir, marketplaceDir);
    tempDir = null;

    const fullSha = run("git rev-parse HEAD", { cwd: marketplaceDir });
    const shortSha = fullSha.slice(0, 12);

    const cacheDir = join(paths.pluginsDir, "cache", marketplaceName, pluginName, shortSha);
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
    copyDirSync(pluginDirectory(marketplaceDir, plugin.source), cacheDir);

    // Install plugin root deps (used by runtime code under src/)
    installDepsIfPresent(cacheDir, pkgMgr, "root");

    if (skillPath) {
      const skillDir = pluginDirectory(cacheDir, skillPath);
      installDepsIfPresent(skillDir, pkgMgr, "skill");
    }

    const now = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
    const repo = extractRepo(repoUrl);

    const mktpData = readJSON<Record<string, unknown>>(paths.knownMarketplacesFile, {});
    mktpData[marketplaceName] = {
      source: { source: "github", repo },
      installLocation: marketplaceDir,
      lastUpdated: now,
    };
    writeJSON(paths.knownMarketplacesFile, mktpData);

    const instData = readJSON<InstalledPlugins>(paths.installedPluginsFile, { version: 2, plugins: {} });
    instData.plugins[pluginKey] = [
      {
        scope: "project",
        installPath: cacheDir,
        version: shortSha,
        installedAt: now,
        lastUpdated: now,
        gitCommitSha: fullSha,
        projectPath: projectPath,
      },
    ];
    writeJSON(paths.installedPluginsFile, instData);

    enableInProject(pluginKey, projectPath);
    return "installed";
  } finally {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// ── Install cherry-picked plugins from the official monorepo ────────

function installOfficialPlugins(
  pluginNames: string[],
  projectPath: string,
  pkgMgr: string,
  paths: ClaudePluginPaths,
): { installed: number; skipped: number } {
  if (pluginNames.length === 0) return { installed: 0, skipped: 0 };

  const marketplaceName = "claude-plugins-official";
  const repo = extractRepo(OFFICIAL_REPO);
  let installed = 0;
  let skipped = 0;

  // Check which plugins actually need work before cloning
  const needed: string[] = [];
  const enableOnly: string[] = [];
  for (const rawName of pluginNames) {
    const name = pluginIdentifier(rawName);
    const pluginKey = `${name}@${marketplaceName}`;
    if (isCached(pluginKey, paths.installedPluginsFile) && isEnabledInProject(pluginKey, projectPath)) {
      console.log(`  skip: ${pluginKey} (already installed)`);
      skipped++;
    } else if (isCached(pluginKey, paths.installedPluginsFile)) {
      enableOnly.push(name);
    } else {
      needed.push(name);
    }
  }

  // Enable cached ones without cloning
  for (const name of enableOnly) {
    const pluginKey = `${name}@${marketplaceName}`;
    console.log(`  enable: ${pluginKey} (cached, enabling for project)`);
    enableInProject(pluginKey, projectPath);
    installed++;
  }

  // Nothing to clone
  if (needed.length === 0) return { installed, skipped };

  // Clone the monorepo once
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "claude-official-"));
    console.log(`  cloning ${marketplaceName} (${needed.length} plugin(s) to install)...`);
    run(`git clone --quiet --depth 1 "${OFFICIAL_REPO}" "${tempDir}"`);

    const marketplaceJsonPath = join(tempDir, ".claude-plugin", "marketplace.json");
    if (!existsSync(marketplaceJsonPath)) {
      console.error(`  error: ${OFFICIAL_REPO} (no .claude-plugin/marketplace.json)`);
      return { installed, skipped };
    }

    const marketplace: MarketplaceJson = JSON.parse(readFileSync(marketplaceJsonPath, "utf-8"));
    const fullSha = run("git rev-parse HEAD", { cwd: tempDir });
    const shortSha = fullSha.slice(0, 12);

    // Reject malformed source trees before replacing the previous marketplace.
    for (const name of needed) {
      const plugin = marketplace.plugins.find((entry) => entry.name === name);
      if (!plugin) continue;
      const source = pluginDirectory(tempDir, plugin.source);
      validatePluginTree(source);
      if (plugin.skills?.[0]) pluginDirectory(source, plugin.skills[0]);
    }

    // Save the monorepo to marketplaces dir
    const marketplaceDir = join(paths.pluginsDir, "marketplaces", marketplaceName);
    if (existsSync(marketplaceDir)) {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
    renameSync(tempDir, marketplaceDir);
    tempDir = null;

    const now = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");

    // Update known_marketplaces.json once
    const mktpData = readJSON<Record<string, unknown>>(paths.knownMarketplacesFile, {});
    mktpData[marketplaceName] = {
      source: { source: "github", repo },
      installLocation: marketplaceDir,
      lastUpdated: now,
    };
    writeJSON(paths.knownMarketplacesFile, mktpData);

    // Install each requested plugin
    for (const name of needed) {
      const pluginDef = marketplace.plugins.find((p) => p.name === name);
      if (!pluginDef) {
        console.log(`  skip: ${name} (not found in ${marketplaceName})`);
        skipped++;
        continue;
      }

      const pluginKey = `${name}@${marketplaceName}`;
      console.log(`  install: ${pluginKey}`);

      // Cache the plugin's source directory
      const sourceDir = pluginDirectory(marketplaceDir, pluginDef.source);

      const cacheDir = join(paths.pluginsDir, "cache", marketplaceName, name, shortSha);
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, { recursive: true, force: true });
      }

      // Copy the plugin source + the marketplace.json (needed by Claude Code)
      copyDirSync(sourceDir, cacheDir);
      const cacheDotPlugin = join(cacheDir, ".claude-plugin");
      mkdirSync(cacheDotPlugin, { recursive: true });
      copyFileSync(
        join(marketplaceDir, ".claude-plugin", "marketplace.json"),
        join(cacheDotPlugin, "marketplace.json"),
      );

      // Install deps if the plugin has skills with a package.json
      installDepsIfPresent(cacheDir, pkgMgr, "root");
      const skillPath = pluginDef.skills?.[0];
      if (skillPath) {
        const skillDir = pluginDirectory(cacheDir, skillPath);
        installDepsIfPresent(skillDir, pkgMgr, "skill");
      }

      // Register in installed_plugins.json
      const instData = readJSON<InstalledPlugins>(paths.installedPluginsFile, { version: 2, plugins: {} });
      instData.plugins[pluginKey] = [
        {
          scope: "project",
          installPath: cacheDir,
          version: shortSha,
          installedAt: now,
          lastUpdated: now,
          gitCommitSha: fullSha,
          projectPath: projectPath,
        },
      ];
      writeJSON(paths.installedPluginsFile, instData);

      enableInProject(pluginKey, projectPath);
      installed++;
    }
  } catch (err: any) {
    console.error(`  error: ${OFFICIAL_REPO} — ${err.message}`);
  } finally {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return { installed, skipped };
}

// ── Main ────────────────────────────────────────────────────────────

export function preflight(
  projectPath: string,
  roots: { home?: string; env?: ClaudeConfigEnv } = {},
): void {
  const paths = claudePluginPaths(roots.home, roots.env);
  try { run("git --version"); } catch {
    console.error("preflight: git is required but not installed.");
    process.exit(1);
  }

  const pkgMgr = detectPkgManager();
  if (!pkgMgr) {
    console.error("preflight: bun or npm is required.");
    process.exit(1);
  }

  mkdirSync(join(paths.pluginsDir, "marketplaces"), { recursive: true });
  mkdirSync(join(paths.pluginsDir, "cache"), { recursive: true });
  startWhisperWarmupInBackground();

  let installed = 0;
  let skipped = 0;

  // Standalone repos
  for (const repoUrl of PLUGINS) {
    try {
      const result = installRepoPlugin(repoUrl, projectPath, pkgMgr, paths);
      if (result === "installed" || result === "enabled") installed++;
      else skipped++;
    } catch (err: any) {
      console.error(`  error: ${repoUrl} — ${err.message}`);
    }
  }

  // Official monorepo (cherry-picked)
  const official = installOfficialPlugins(OFFICIAL_PLUGINS, projectPath, pkgMgr, paths);
  installed += official.installed;
  skipped += official.skipped;

  console.log(`preflight: ${installed} installed, ${skipped} skipped`);
}

// Allow standalone: bun run src/preflight.ts [project-path]
if (import.meta.main) {
  preflight(process.argv[2] || process.cwd());
}
