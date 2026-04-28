// Skills management routes

import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { DATA_DIR } from '../config.js';
import { getEffectiveExternalDir } from '../runtime-config.js';
import { getWebDeps } from '../web-context.js';
import { getGroupsByOwner } from '../db.js';
import { logger } from '../logger.js';
import {
  parseFrontmatter,
  validateSkillId,
  validateSkillPath,
  listFiles,
  scanSkillDirectory,
} from '../skill-utils.js';

const execFileAsync = promisify(execFile);
let skillInstallLock: Promise<void> = Promise.resolve();

const skillsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project' | 'external';
  enabled: boolean;
  packageName?: string;
  installedAt?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

interface SkillDetail extends Skill {
  content: string;
}

interface SkillsManifest {
  skills: Record<
    string,
    {
      packageName: string;
      installedAt: string;
      source: string;
    }
  >;
}

interface SearchResult {
  package: string;
  url: string;
  description?: string;
  installs?: number;
  skillId?: string;
  source?: string;
}

// --- Utility Functions ---

function getUserSkillsDir(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId);
}

function getProjectSkillsDir(): string {
  return path.resolve(process.cwd(), 'container', 'skills');
}

function getSkillsManifestPath(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId, '.skills-manifest.json');
}

function readSkillsManifest(userId: string): SkillsManifest {
  try {
    const data = fs.readFileSync(getSkillsManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { skills: {} };
  }
}

function writeSkillsManifest(userId: string, manifest: SkillsManifest): void {
  const manifestPath = getSkillsManifestPath(userId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Update the skills manifest after installing skills.
 * Records packageName, installedAt, and source for each installed skill.
 */
function updateSkillsManifest(
  userId: string,
  packageName: string,
  installedSkillIds: string[],
): void {
  const manifest = readSkillsManifest(userId);
  const now = new Date().toISOString();
  for (const id of installedSkillIds) {
    manifest.skills[id] = {
      packageName,
      installedAt: now,
      source: 'skills.sh',
    };
  }
  writeSkillsManifest(userId, manifest);
}

/**
 * Remove a skill from the manifest when it is deleted.
 */
function removeFromSkillsManifest(userId: string, skillId: string): void {
  const manifest = readSkillsManifest(userId);
  if (skillId in manifest.skills) {
    delete manifest.skills[skillId];
    writeSkillsManifest(userId, manifest);
  }
}

// validateSkillId, validateSkillPath, parseFrontmatter, listFiles, scanSkillDirectory
// are imported from '../skill-utils.js'

function scanDirectory(rootDir: string, source: 'user' | 'project'): Skill[] {
  return scanSkillDirectory(rootDir, source) as Skill[];
}

function discoverSkills(userId: string, userRole?: string): Skill[] {
  const userSkills = scanDirectory(getUserSkillsDir(userId), 'user');
  const projectSkills = scanDirectory(getProjectSkillsDir(), 'project');

  // 宿主机 ~/.claude/skills（仅 admin 可见）
  const externalSkills: Skill[] = [];
  if (userRole === 'admin') {
    const extSkillsDir = path.join(getEffectiveExternalDir(), 'skills');
    if (fs.existsSync(extSkillsDir)) {
      const scanned = scanDirectory(extSkillsDir, 'project');
      for (const s of scanned) {
        (s as any).source = 'external';
      }
      externalSkills.push(...scanned);
    }
  }

  // 读取 skills manifest 补充安装元数据
  const skillsManifest = readSkillsManifest(userId);

  for (const skill of userSkills) {
    const meta = skillsManifest.skills[skill.id];
    if (meta) {
      skill.packageName = meta.packageName;
      skill.installedAt = meta.installedAt;
    }
  }

  // 按优先级去重（user > project > external），同 ID 高优先级覆盖低优先级
  const seen = new Set<string>();
  const result: Skill[] = [];
  for (const skill of [...userSkills, ...projectSkills, ...externalSkills]) {
    if (!seen.has(skill.id)) {
      seen.add(skill.id);
      result.push(skill);
    }
  }
  return result;
}

function getSkillDetail(skillId: string, userId: string, userRole?: string): SkillDetail | null {
  if (!validateSkillId(skillId)) return null;

  const searchDirs: Array<{ rootDir: string; source: 'user' | 'project' | 'external' }> = [
    { rootDir: getUserSkillsDir(userId), source: 'user' },
    { rootDir: getProjectSkillsDir(), source: 'project' },
  ];
  if (userRole === 'admin') {
    const extSkillsDir = path.join(getEffectiveExternalDir(), 'skills');
    if (fs.existsSync(extSkillsDir)) {
      searchDirs.push({ rootDir: extSkillsDir, source: 'external' });
    }
  }

  const skillsManifest = readSkillsManifest(userId);

  for (const { rootDir, source } of searchDirs) {
    const skillDir = path.join(rootDir, skillId);
    if (!fs.existsSync(skillDir)) continue;

    if (!validateSkillPath(rootDir, skillDir)) continue;

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const skillMdDisabledPath = path.join(skillDir, 'SKILL.md.disabled');

    let enabled = false;
    let skillFilePath: string | null = null;

    if (fs.existsSync(skillMdPath)) {
      enabled = true;
      skillFilePath = skillMdPath;
    } else if (fs.existsSync(skillMdDisabledPath)) {
      enabled = false;
      skillFilePath = skillMdDisabledPath;
    } else {
      continue;
    }

    try {
      const content = fs.readFileSync(skillFilePath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const stats = fs.statSync(skillDir);

      const detail: SkillDetail = {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || '',
        source,
        enabled,
        userInvocable:
          frontmatter['user-invocable'] === undefined
            ? true
            : frontmatter['user-invocable'] !== 'false',
        allowedTools: frontmatter['allowed-tools']
          ? frontmatter['allowed-tools'].split(',').map((t) => t.trim())
          : [],
        argumentHint: frontmatter['argument-hint'] || null,
        updatedAt: stats.mtime.toISOString(),
        files: listFiles(skillDir),
        content,
      };

      if (source === 'user') {
        const meta = skillsManifest.skills[skillId];
        if (meta) {
          detail.packageName = meta.packageName;
          detail.installedAt = meta.installedAt;
        }
      }

      return detail;
    } catch {
      // Skip malformed skill
    }
  }

  return null;
}

/**
 * Parse the output of `npx skills find <query>` to extract search results.
 * The output contains ANSI codes and formatted text like:
 *   owner/repo@skill-name
 *   https://skills.sh/owner/repo/skill
 */
function parseSearchOutput(output: string): SearchResult[] {
  // Strip ANSI escape codes
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const results: SearchResult[] = [];

  const lines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match package pattern: owner/repo or owner/repo@skill
    const pkgMatch = line.match(/^([\w\-]+\/[\w\-.]+(?:@[\w\-.]+)?)$/);
    if (pkgMatch) {
      const pkg = pkgMatch[1];
      // Next line might be the URL (possibly prefixed with └ or similar chars)
      let url = '';
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].replace(/^[└├│─\s]+/, '');
        if (nextLine.startsWith('http')) {
          url = nextLine;
          i++;
        }
      }
      results.push({ package: pkg, url });
    }
  }

  return results;
}

/**
 * Find skill entries under a path that were modified after the given timestamp.
 * Handles both real directories and symlinks (skills CLI creates symlinks in
 * ~/.claude/skills/ pointing to ~/.agents/skills/).
 * Returns entry names.
 */
function findModifiedEntries(dir: string, afterMs: number): string[] {
  const result: string[] = [];
  if (!fs.existsSync(dir)) return result;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        // Use lstat for symlinks, stat (follows symlink) for mtime of real target
        const lstat = fs.lstatSync(fullPath);

        if (lstat.isSymbolicLink()) {
          // Symlink: check both the symlink creation time and target mtime
          if (lstat.mtimeMs >= afterMs) {
            result.push(entry.name);
            continue;
          }
          // Also check the resolved target's mtime
          const realStat = fs.statSync(fullPath);
          if (realStat.mtimeMs >= afterMs) {
            result.push(entry.name);
          }
        } else if (lstat.isDirectory()) {
          if (lstat.mtimeMs >= afterMs) {
            result.push(entry.name);
          }
        }
      } catch {
        // skip broken symlinks etc.
      }
    }
  } catch {
    // ignore
  }
  return result;
}

/**
 * Copy a skill entry (directory or symlink target) to dest.
 * Resolves symlinks and copies the real content so the copy is self-contained.
 */
function copySkillToUser(src: string, dest: string): void {
  // Resolve symlink to get the real directory
  let realSrc = src;
  try {
    const lstat = fs.lstatSync(src);
    if (lstat.isSymbolicLink()) {
      realSrc = fs.realpathSync(src);
    }
  } catch {
    // use src as-is
  }

  fs.cpSync(realSrc, dest, { recursive: true });
}

// --- Search cache (LRU, 5min TTL, max 100 entries) ---

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const SEARCH_CACHE_MAX = 100;
const searchCache = new Map<string, CacheEntry<SearchResult[]>>();

function getCachedSearch(key: string): SearchResult[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedSearch(key: string, value: SearchResult[]): void {
  // Evict oldest if at capacity
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { value, expiresAt: Date.now() + SEARCH_CACHE_TTL });
}

/**
 * Search skills via skills.sh API.
 * Returns structured results with install counts.
 */
async function searchSkillsApi(query: string): Promise<SearchResult[]> {
  const cached = getCachedSearch(query);
  if (cached) return cached;

  try {
    const resp = await fetch(
      `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=20`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) throw new Error(`skills.sh returned ${resp.status}`);

    const data = (await resp.json()) as {
      skills?: Array<{
        id: string;
        skillId: string;
        name: string;
        installs: number;
        source: string;
      }>;
    };

    const results: SearchResult[] = (data.skills || []).map((s) => ({
      package:
        s.source === s.skillId || !s.skillId
          ? s.source
          : `${s.source}@${s.skillId}`,
      url: `https://skills.sh/s/${s.id}`,
      description: '',
      installs: s.installs,
      skillId: s.skillId,
      source: s.source,
    }));

    setCachedSearch(query, results);
    return results;
  } catch {
    // Fallback to npx skills find
    return searchSkillsFallback(query);
  }
}

/**
 * Fallback search using npx skills find CLI.
 */
async function searchSkillsFallback(query: string): Promise<SearchResult[]> {
  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['-y', 'skills', 'find', query],
      { timeout: 30_000 },
    );
    return parseSearchOutput(stdout);
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error) {
      const results = parseSearchOutput((error as any).stdout || '');
      if (results.length > 0) return results;
    }
    return [];
  }
}

/**
 * Fetch SKILL.md content from GitHub for a given source repo and skill ID.
 * Tries multiple common directory layouts.
 */
async function fetchSkillMdFromGitHub(
  source: string,
  skillId: string,
): Promise<{ content: string; description: string; skillName: string } | null> {
  // Try common paths where SKILL.md might live
  const pathCandidates = [
    `skills/${skillId}/SKILL.md`,
    `${skillId}/SKILL.md`,
    `.claude/skills/${skillId}/SKILL.md`,
    `SKILL.md`,
  ];

  for (const branch of ['main', 'master']) {
    for (const filePath of pathCandidates) {
      try {
        const url = `https://raw.githubusercontent.com/${source}/${branch}/${filePath}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!resp.ok) continue;

        const content = await resp.text();
        // Verify it looks like a SKILL.md (has frontmatter)
        if (!content.startsWith('---')) continue;

        const frontmatter = parseFrontmatter(content);
        return {
          content,
          description: frontmatter.description || '',
          skillName: frontmatter.name || skillId,
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function withSkillInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = skillInstallLock.catch(() => undefined);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  skillInstallLock = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Scan an extracted directory for skill directories (containing SKILL.md),
 * copy them to the user's skills dir, and return the list of installed skill IDs.
 * Handles both flat layout (extractDir/skill-name/SKILL.md) and
 * single-wrapper layout (extractDir/wrapper/skill-name/SKILL.md).
 */
function installFromExtractedDir(
  extractDir: string,
  userDir: string,
  userId: string,
): string[] {
  const installed: string[] = [];

  // Collect candidate dirs: immediate children that contain SKILL.md
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  const skillDirs: Array<{ name: string; fullPath: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(extractDir, entry.name);
    if (
      fs.existsSync(path.join(dirPath, 'SKILL.md')) ||
      fs.existsSync(path.join(dirPath, 'SKILL.md.disabled'))
    ) {
      skillDirs.push({ name: entry.name, fullPath: dirPath });
    }
  }

  // If no direct children have SKILL.md, check if it's a single-wrapper case
  // e.g. zip extracts to wrapper-dir/skill-name/SKILL.md
  if (skillDirs.length === 0 && entries.length === 1 && entries[0].isDirectory()) {
    const wrapperDir = path.join(extractDir, entries[0].name);
    const innerEntries = fs.readdirSync(wrapperDir, { withFileTypes: true });
    for (const inner of innerEntries) {
      if (!inner.isDirectory()) continue;
      const innerPath = path.join(wrapperDir, inner.name);
      if (
        fs.existsSync(path.join(innerPath, 'SKILL.md')) ||
        fs.existsSync(path.join(innerPath, 'SKILL.md.disabled'))
      ) {
        skillDirs.push({ name: inner.name, fullPath: innerPath });
      }
    }

    // Also check if the wrapper dir itself IS the skill
    if (
      skillDirs.length === 0 &&
      (fs.existsSync(path.join(wrapperDir, 'SKILL.md')) ||
        fs.existsSync(path.join(wrapperDir, 'SKILL.md.disabled')))
    ) {
      skillDirs.push({ name: entries[0].name, fullPath: wrapperDir });
    }
  }

  // Also check if extractDir itself is the skill root (single skill, flat files)
  if (
    skillDirs.length === 0 &&
    (fs.existsSync(path.join(extractDir, 'SKILL.md')) ||
      fs.existsSync(path.join(extractDir, 'SKILL.md.disabled')))
  ) {
    // Derive a name from frontmatter or use "uploaded-skill"
    const mdPath = fs.existsSync(path.join(extractDir, 'SKILL.md'))
      ? path.join(extractDir, 'SKILL.md')
      : path.join(extractDir, 'SKILL.md.disabled');
    const content = fs.readFileSync(mdPath, 'utf-8');
    const fm = parseFrontmatter(content);
    const skillName = (fm.name || 'uploaded-skill').replace(/[^\w\-]/g, '-');
    skillDirs.push({ name: skillName, fullPath: extractDir });
  }

  for (const { name, fullPath } of skillDirs) {
    if (!validateSkillId(name)) continue;
    const dest = path.join(userDir, name);
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.cpSync(fullPath, dest, { recursive: true });
    installed.push(name);
  }

  if (installed.length > 0) {
    updateSkillsManifest(userId, 'local-upload', installed);
  }

  return installed;
}

// Skill symlink refresh shell snippet (mirrors entrypoint.sh logic for /workspace/user-skills)
const REFRESH_SYMLINKS_CMD = [
  'sh', '-c',
  'for skill in /workspace/user-skills/*/; do ' +
    'if [ -d "$skill" ]; then ' +
      'name=$(basename "$skill"); ' +
      'target="/home/node/.claude/skills/$name"; ' +
      'if [ -e "$target" ] && [ ! -L "$target" ]; then rm -rf "$target" 2>/dev/null || true; fi; ' +
      'ln -sfn "$skill" "$target" 2>/dev/null || true; ' +
    'fi; ' +
  'done',
];

/**
 * After skill install/upload/delete, refresh symlinks inside all Docker
 * containers owned by this user so the new skill is visible immediately.
 * Fire-and-forget — errors are logged but not propagated.
 */
function refreshSkillSymlinksForUser(userId: string): void {
  const deps = getWebDeps();
  if (!deps) return;

  const groups = getGroupsByOwner(userId);
  const folders = new Set(groups.map((g) => g.folder));
  const containerNames = deps.queue.getActiveContainerNames(folders);
  if (containerNames.length === 0) return;

  for (const name of containerNames) {
    execFile(
      'docker',
      ['exec', name, ...REFRESH_SYMLINKS_CMD],
      { timeout: 10_000 },
      (err) => {
        if (err) {
          logger.debug({ containerName: name, err }, 'Skill symlink refresh failed (container may have stopped)');
        }
      },
    );
  }
}

// --- Routes ---

skillsRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const skills = discoverSkills(authUser.id, authUser.role);
  return c.json({ skills });
});

skillsRoutes.get('/search', authMiddleware, async (c) => {
  const query = c.req.query('q')?.trim();
  if (!query) {
    return c.json({ results: [] });
  }

  const results = await searchSkillsApi(query);
  return c.json({ results });
});

skillsRoutes.get('/search/detail', authMiddleware, async (c) => {
  const source = c.req.query('source')?.trim();
  const skillId = c.req.query('skillId')?.trim();

  // Support legacy url-based lookup for backwards compat
  const url = c.req.query('url')?.trim();

  if (source && skillId) {
    // New path: fetch SKILL.md from GitHub using source/skillId
    const result = await fetchSkillMdFromGitHub(source, skillId);
    if (!result) {
      return c.json({ detail: null });
    }

    return c.json({
      detail: {
        description: result.description,
        skillName: result.skillName,
        readme: result.content,
        installs: '',
        age: '',
        features: [],
      },
    });
  }

  // Legacy: extract source/skillId from skills.sh URL
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'skills.sh') {
        // URL pattern: https://skills.sh/s/{owner}/{repo}/{skillId}
        const segments = parsed.pathname
          .replace(/^\/s\//, '')
          .split('/')
          .filter(Boolean);
        if (segments.length >= 3) {
          const srcFromUrl = `${segments[0]}/${segments[1]}`;
          const skillIdFromUrl = segments[2];
          const result = await fetchSkillMdFromGitHub(
            srcFromUrl,
            skillIdFromUrl,
          );
          if (result) {
            return c.json({
              detail: {
                description: result.description,
                skillName: result.skillName,
                readme: result.content,
                installs: '',
                age: '',
                features: [],
              },
            });
          }
        }
      }
    } catch {
      // fall through
    }
  }

  return c.json({ detail: null });
});


skillsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const skill = getSkillDetail(id, authUser.id, authUser.role);

  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  return c.json({ skill });
});

// Toggle enable/disable for user-level skills via SKILL.md ↔ SKILL.md.disabled rename.
// Project-level skills are read-only.
skillsRoutes.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const { enabled } = await c.req.json<{ enabled: boolean }>();

  if (!validateSkillId(id)) return c.json({ error: 'Invalid skill ID' }, 400);

  const userDir = getUserSkillsDir(authUser.id);
  const skillDir = path.join(userDir, id);

  if (!fs.existsSync(skillDir)) {
    return c.json(
      { error: 'Skill not found or is not a user-level skill' },
      404,
    );
  }
  if (!validateSkillPath(userDir, skillDir)) {
    return c.json({ error: 'Invalid skill path' }, 400);
  }

  const srcPath = path.join(
    skillDir,
    enabled ? 'SKILL.md.disabled' : 'SKILL.md',
  );
  const dstPath = path.join(
    skillDir,
    enabled ? 'SKILL.md' : 'SKILL.md.disabled',
  );

  if (!fs.existsSync(srcPath)) {
    return c.json(
      { error: 'Skill not found or already in desired state' },
      404,
    );
  }

  fs.renameSync(srcPath, dstPath);
  return c.json({ success: true });
});

/**
 * Delete a user-level skill by ID.
 * Reusable by both the HTTP route and IPC handler.
 */
function deleteSkillForUser(
  userId: string,
  skillId: string,
): { success: boolean; error?: string } {
  if (!validateSkillId(skillId)) {
    return { success: false, error: 'Invalid skill ID' };
  }

  const userDir = getUserSkillsDir(userId);
  const skillDir = path.join(userDir, skillId);

  if (!fs.existsSync(skillDir)) {
    return {
      success: false,
      error: 'Skill not found or is a project-level skill',
    };
  }

  if (!validateSkillPath(userDir, skillDir)) {
    return { success: false, error: 'Invalid skill path' };
  }

  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removeFromSkillsManifest(userId, skillId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// 批量删除所有用户级技能（清理旧的同步副本）
skillsRoutes.delete('/user-all', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const userDir = getUserSkillsDir(authUser.id);
  let deleted = 0;
  try {
    if (fs.existsSync(userDir)) {
      for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const p = path.join(userDir, entry.name);
        try {
          fs.rmSync(p, { recursive: true, force: true });
          deleted++;
        } catch { /* ignore */ }
      }
    }
  } catch {
    return c.json({ error: 'Failed to delete user skills' }, 500);
  }
  return c.json({ success: true, deleted });
});

skillsRoutes.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const result = deleteSkillForUser(authUser.id, id);

  if (!result.success) {
    const status =
      result.error === 'Invalid skill ID' ||
      result.error === 'Invalid skill path'
        ? 400
        : result.error?.includes('not found')
          ? 404
          : 500;
    return c.json({ error: result.error }, status);
  }

  return c.json({ success: true });
});

/**
 * Install a skill package for a specific user.
 * Uses a temporary HOME directory to isolate `npx skills add --global` from
 * the real ~/.claude/skills, eliminating race conditions across concurrent installs.
 * Reusable by both the HTTP route and IPC handler.
 */
async function installSkillForUser(
  userId: string,
  pkg: string,
): Promise<{ success: boolean; installed?: string[]; error?: string }> {
  if (
    !/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) &&
    !/^https?:\/\//.test(pkg)
  ) {
    return { success: false, error: 'Invalid package name format' };
  }

  // Create an isolated temp directory to act as HOME so `--global` installs
  // into tempHome/.claude/skills/ instead of the real ~/.claude/skills/.
  // This avoids any race condition when multiple installs run concurrently.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-'));
  const tempSkillsDir = path.join(tempHome, '.claude', 'skills');
  fs.mkdirSync(tempSkillsDir, { recursive: true });

  try {
    await execFileAsync(
      'npx',
      ['-y', 'skills', 'add', pkg, '--global', '--yes', '-a', 'claude-code'],
      {
        timeout: 60_000,
        env: { ...process.env, HOME: tempHome },
      },
    );

    // Discover all skill directories installed into the temp location
    const installedEntries: string[] = [];
    if (fs.existsSync(tempSkillsDir)) {
      for (const entry of fs.readdirSync(tempSkillsDir, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          installedEntries.push(entry.name);
        }
      }
    }

    if (installedEntries.length === 0) {
      return {
        success: false,
        error: 'No skills were installed — package may be invalid',
      };
    }

    // Copy resolved skill content to per-user directory
    const userDir = getUserSkillsDir(userId);
    fs.mkdirSync(userDir, { recursive: true });

    for (const name of installedEntries) {
      const src = path.join(tempSkillsDir, name);
      const dest = path.join(userDir, name);
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      copySkillToUser(src, dest);
    }

    // Write manifest metadata
    updateSkillsManifest(userId, pkg, installedEntries);

    return { success: true, installed: installedEntries };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    // Always clean up the temp directory
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

// Upload a skill from a local zip file or folder (multipart form).
// Accepts:
//   - A single .zip file (field: "file")
//   - Multiple files with relative paths (field: "files" + "paths" JSON array)
// The uploaded content must contain at least one directory with a SKILL.md.
skillsRoutes.post('/upload', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const formData = await c.req.formData();

  const userDir = getUserSkillsDir(authUser.id);
  fs.mkdirSync(userDir, { recursive: true });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-upload-'));

  try {
    const file = formData.get('file');
    const filesRaw = formData.getAll('files');
    const pathsRaw = formData.get('paths');

    if (file instanceof File && file.name.endsWith('.zip')) {
      // --- Zip upload ---
      const zipPath = path.join(tempDir, 'upload.zip');
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length > 50 * 1024 * 1024) {
        return c.json({ error: 'Zip file exceeds 50MB limit' }, 400);
      }
      fs.writeFileSync(zipPath, buf);

      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });

      try {
        await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', extractDir], {
          timeout: 30_000,
        });
      } catch (err) {
        return c.json(
          {
            error: 'Failed to extract zip',
            details: err instanceof Error ? err.message : 'unzip command failed',
          },
          400,
        );
      }

      // Remove __MACOSX if present
      const macosxDir = path.join(extractDir, '__MACOSX');
      if (fs.existsSync(macosxDir)) {
        fs.rmSync(macosxDir, { recursive: true, force: true });
      }

      const installed = installFromExtractedDir(extractDir, userDir, authUser.id);
      if (installed.length === 0) {
        return c.json(
          { error: '未找到包含 SKILL.md 的技能目录。请确保 zip 包含 skill-name/SKILL.md 结构。' },
          400,
        );
      }

      refreshSkillSymlinksForUser(authUser.id);
      return c.json({ success: true, installed });
    } else if (filesRaw.length > 0 && pathsRaw) {
      // --- Folder upload (files + relative paths) ---
      let relativePaths: string[];
      try {
        relativePaths = JSON.parse(pathsRaw as string);
      } catch {
        return c.json({ error: 'Invalid paths field' }, 400);
      }

      const files: File[] = [];
      for (const f of filesRaw) {
        if (f instanceof File) files.push(f);
      }
      if (files.length !== relativePaths.length) {
        return c.json({ error: 'files and paths length mismatch' }, 400);
      }

      let totalSize = 0;
      for (const f of files) totalSize += f.size;
      if (totalSize > 50 * 1024 * 1024) {
        return c.json({ error: 'Total upload size exceeds 50MB limit' }, 400);
      }

      const folderDir = path.join(tempDir, 'folder');
      fs.mkdirSync(folderDir, { recursive: true });

      for (let i = 0; i < files.length; i++) {
        const relPath = relativePaths[i];
        if (relPath.includes('..') || path.isAbsolute(relPath)) {
          return c.json({ error: `Invalid path: ${relPath}` }, 400);
        }
        const destPath = path.join(folderDir, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const buf = Buffer.from(await files[i].arrayBuffer());
        fs.writeFileSync(destPath, buf);
      }

      const installed = installFromExtractedDir(folderDir, userDir, authUser.id);
      if (installed.length === 0) {
        return c.json(
          { error: '未找到包含 SKILL.md 的技能目录。请确保文件夹包含 skill-name/SKILL.md 结构。' },
          400,
        );
      }

      refreshSkillSymlinksForUser(authUser.id);
      return c.json({ success: true, installed });
    } else {
      return c.json(
        { error: '请上传 .zip 文件或文件夹' },
        400,
      );
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

skillsRoutes.post('/install', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  if (typeof body.package !== 'string') {
    return c.json({ error: 'package field must be string' }, 400);
  }

  const pkg = body.package.trim();
  const result = await installSkillForUser(authUser.id, pkg);

  if (!result.success) {
    return c.json(
      { error: 'Failed to install skill', details: result.error },
      result.error === 'Invalid package name format' ? 400 : 500,
    );
  }

  refreshSkillSymlinksForUser(authUser.id);
  return c.json({ success: true, installed: result.installed });
});

// Reinstall a skill by its ID — requires the skill to have a packageName in the manifest.
skillsRoutes.post('/:id/reinstall', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;

  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }

  const manifest = readSkillsManifest(authUser.id);
  const meta = manifest.skills[id];
  if (!meta?.packageName) {
    return c.json(
      { error: 'Skill has no package info — cannot reinstall' },
      400,
    );
  }

  // Delete then reinstall
  const deleteResult = deleteSkillForUser(authUser.id, id);
  if (!deleteResult.success) {
    return c.json(
      { error: 'Failed to delete old skill', details: deleteResult.error },
      500,
    );
  }

  const installResult = await installSkillForUser(
    authUser.id,
    meta.packageName,
  );
  if (!installResult.success) {
    return c.json(
      { error: 'Failed to reinstall skill', details: installResult.error },
      500,
    );
  }

  refreshSkillSymlinksForUser(authUser.id);
  return c.json({ success: true, installed: installResult.installed });
});

export { getUserSkillsDir, installSkillForUser, deleteSkillForUser, refreshSkillSymlinksForUser };
export default skillsRoutes;
