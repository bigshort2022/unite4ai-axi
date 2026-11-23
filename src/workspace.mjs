import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN, isResultId } from './shared.mjs';

const BRIDGE = fileURLToPath(new URL('./bridge.ts', import.meta.url));
const PIN_FILE = new URL('../site-pin.json', import.meta.url);
const PIN_MARKER = '.git/unite4ai-axi-pin';
const MAIN_REF = 'refs/remotes/origin/main';
const ACTIONS = new Set(['catalog', 'validate', 'eval', 'exchange']);
const DEPENDENCIES = ['node_modules', 'apps/api/node_modules', 'apps/cli/node_modules', 'apps/web/node_modules', 'packages/core/node_modules', 'packages/schema/node_modules'];
const ID = '[a-z0-9]+(?:-[a-z0-9]+)*';
const EXCHANGE_ARTIFACT = new RegExp(`^(?:hypotheses/${ID}\\.md|findings/${ID}\\.json|reviews/${ID}--${ID}--\\d{4}-\\d{2}-\\d{2}\\.json)$`);
const TRANSCRIPT_ARTIFACT = new RegExp(`^\\.agent/evals/[a-f0-9]{64}/(?:pin\\.json|${ID}--${ID}--${ID}--[a-f0-9]{8}\\.jsonl(?:\\.lock)?|cache/[a-f0-9]{64}\\.txt)$`);
const CONTENT = 'apps/web/src/content/';
const BASE_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);

async function pin() {
  let info;
  try { info = JSON.parse(await readFile(PIN_FILE, 'utf8')); }
  catch { throw new Error('The installed package has no valid site-pin.json'); }
  if (typeof info?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(info.sha)) throw new Error('The installed package has no full site commit pin');
  return info.sha;
}

const missing = (error) => error?.code === 'ENOENT';
async function stat(path) {
  try { return await lstat(path); }
  catch (error) { if (missing(error)) return null; throw error; }
}

async function directory(path, { optional = false } = {}) {
  const info = await stat(path);
  if (!info && optional) return false;
  if (!info?.isDirectory()) throw new Error('Managed workspace paths must be real directories, not symlinks');
  return true;
}

async function stateDirectory(path) {
  const info = await stat(path);
  if (!info?.isDirectory() || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (info.mode & 0o022) !== 0) {
    throw new Error('Workspace state must be an owner-controlled directory without group or world write access');
  }
}

async function regular(path) {
  const info = await stat(path);
  if (!info?.isFile() || info.nlink !== 1) throw new Error('Managed workspace artifacts must be regular files, not symlinks or hardlinks');
}

function isolatedEnv(overrides = {}) {
  // The pinned code and package installer need no application, GitHub, or inference credentials.
  const env = {};
  for (const key of Object.keys(process.env)) if (!BASE_ENV.has(key)) env[key] = undefined;
  return Object.assign(env, { GH_HOST: undefined, GH_PROMPT_DISABLED: undefined }, overrides);
}

function git(ctx, cwd, args, timeout) {
  return ctx.exec('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.ignoreStat=false',
    '-c', 'core.fileMode=true', '-c', 'http.followRedirects=false', ...args,
  ], {
    cwd, timeout,
    env: isolatedEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' }),
  });
}

function acceptableArtifact(path) {
  if (TRANSCRIPT_ARTIFACT.test(path)) return true;
  if (!path.startsWith(CONTENT)) return false;
  const rel = path.slice(CONTENT.length);
  if (rel.startsWith('evals/') && rel.endsWith('.json')) return isResultId(rel.slice(6, -5));
  return EXCHANGE_ARTIFACT.test(rel);
}

async function inspectTree(ctx, root, sha, ready) {
  await directory(root);
  await directory(join(root, '.git'));
  await regular(join(root, '.git/HEAD'));
  if ((await readFile(join(root, '.git/HEAD'), 'utf8')).trim() !== sha) {
    throw new Error('Managed site HEAD is not detached at the package pin; use a fresh state directory');
  }
  if (ready) {
    const marker = join(root, PIN_MARKER);
    if (!(await stat(marker))) throw new Error('Managed site is not initialized; run setup workspace in a fresh state directory');
    await regular(marker);
    if ((await readFile(marker, 'utf8')).trim() !== sha) throw new Error('Managed site does not match this package pin; use a fresh state directory');
  }
  const [toplevel, tracked, index, untracked] = await Promise.all([
    git(ctx, root, ['rev-parse', '--show-toplevel']),
    git(ctx, root, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none']),
    git(ctx, root, ['ls-files', '-v', '-z']),
    git(ctx, root, ['ls-files', '--others', '-z', '--', '.', ...DEPENDENCIES.flatMap((path) => [`:!${path}`, `:!${path}/**`])]),
  ]);
  if (toplevel.trimEnd() !== await realpath(root)) throw new Error('Managed site is not the root of its own worktree');
  if (tracked !== '' || index.split('\0').some((entry) => entry && (entry[0] === 'S' || /^[a-z]/.test(entry)))) {
    throw new Error('The pinned site has modified or hidden tracked files; use a clean managed workspace');
  }
  for (const path of DEPENDENCIES) await directory(join(root, path), { optional: !ready || path !== 'node_modules' });
  for (const path of ['.agent', '.agent/evals', 'apps/web/src/content/evals', 'apps/web/src/content/findings', 'apps/web/src/content/reviews', 'apps/web/src/content/hypotheses']) {
    await directory(join(root, path), { optional: true });
  }
  const drafts = [];
  for (const path of untracked.split('\0')) {
    if (!path) continue;
    if (!acceptableArtifact(path)) throw new Error('Managed site contains unexpected untracked artifacts; use a clean managed workspace');
    await regular(join(root, path));
    if (path.startsWith(CONTENT)) drafts.push(path);
  }
  return drafts;
}

async function checkedWorkspace(ctx) {
  const siteSha = await pin();
  const siteRoot = join(ctx.state, 'site');
  if (!(await stat(siteRoot))) throw new Error('Managed site is absent; run unite4ai-axi setup workspace');
  await stateDirectory(ctx.state);
  const drafts = await inspectTree(ctx, siteRoot, siteSha, true);
  return { siteRoot, siteSha, drafts };
}

export async function requireWorkspace(ctx) {
  const { siteRoot, siteSha } = await checkedWorkspace(ctx);
  return { siteRoot, siteSha };
}

export async function readPinnedTreePaths(ctx, paths) {
  const { siteRoot, siteSha } = await requireWorkspace(ctx);
  const tracked = await git(ctx, siteRoot, ['--literal-pathspecs', 'ls-tree', '--full-tree', '-z', siteSha, '--', ...paths]);
  return { siteRoot, siteSha, tracked };
}

export async function setupWorkspace(ctx, _input) {
  const siteSha = await pin();
  const siteRoot = join(ctx.state, 'site');
  const help = ['unite4ai-axi next --kind baseline', 'unite4ai-axi run --help'];
  if (await stat(siteRoot)) {
    await requireWorkspace(ctx);
    return { status: 'ready', siteRoot, siteSha, help };
  }
  await mkdir(ctx.state, { recursive: true, mode: 0o700 });
  await stateDirectory(ctx.state);
  const pending = await mkdtemp(join(ctx.state, '.site-setup-'));
  try {
    const clone = join(pending, 'site');
    await git(ctx, pending, ['clone', '--no-checkout', '--single-branch', '--branch', 'main', '--no-tags', '--template=', '--', ORIGIN, clone], 300_000);
    await git(ctx, clone, ['fetch', '--no-tags', '--', ORIGIN, `refs/heads/main:${MAIN_REF}`], 300_000);
    try { await git(ctx, clone, ['merge-base', '--is-ancestor', siteSha, MAIN_REF]); }
    catch { throw new Error('The packaged site pin is not an ancestor of canonical main'); }
    await git(ctx, clone, ['checkout', '--detach', siteSha]);
    await inspectTree(ctx, clone, siteSha, false);
    await ctx.exec('bun', ['--no-env-file', 'install', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: clone, timeout: 300_000, env: isolatedEnv({ GIT_TERMINAL_PROMPT: undefined }),
    });
    await writeFile(join(clone, PIN_MARKER), `${siteSha}\n`, { flag: 'wx', mode: 0o600 });
    await inspectTree(ctx, clone, siteSha, true);
    try { await rename(clone, siteRoot); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await requireWorkspace(ctx); // Another explicit setup completed first.
    }
    return { status: 'ready', siteRoot, siteSha, help };
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

export async function runBridge(ctx, action, payload = {}) {
  if (!ACTIONS.has(action)) throw new Error('Unsupported site bridge action');
  const { siteRoot, siteSha, drafts } = await checkedWorkspace(ctx);
  const timeout = action === 'eval' ? Math.min(2_147_483_647, (payload.maxSeconds + 120) * 1000) : 45_000;
  const body = action === 'catalog' ? { drafts } : action === 'eval' ? { ...payload, siteSha } : payload;
  const stdout = await ctx.exec('bun', ['--no-install', '--no-env-file', BRIDGE, action], {
    cwd: siteRoot, input: JSON.stringify({ siteRoot, payload: body }), timeout,
    env: isolatedEnv({ GIT_TERMINAL_PROMPT: undefined }),
  });
  let data;
  try { data = JSON.parse(stdout); }
  catch { throw new Error('Pinned site bridge did not return valid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Pinned site bridge returned an invalid response');
  if (typeof data.failure === 'string') throw new Error(data.failure);
  return { ...data, siteSha };
}
