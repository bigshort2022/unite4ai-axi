import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse, relative, sep } from 'node:path';
import { UPSTREAM, UsageError, isId, isResultId } from './shared.mjs';
import { readPinnedTreePaths, runBridge } from './workspace.mjs';

const CONTENT = 'apps/web/src/content';
const RECORD_LIMIT = 16 * 1024;
const SNAPSHOT_ENTRY_LIMIT = 4096;
const SNAPSHOT_FILE_LIMIT = 256 * 1024;
const SNAPSHOT_BYTE_LIMIT = 16 * 1024 * 1024;
const MAIN_REF = 'refs/heads/main';
const TITLE = 'Add Unite4AI evidence records';
const [UPSTREAM_OWNER, UPSTREAM_NAME] = UPSTREAM.split('/');

const isSha = (value) => typeof value === 'string' && value.length === 40 && /^[0-9a-f]+$/.test(value);
const isLogin = (value) => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(value) && !/\s/.test(value);
const repoNamed = (repo, name) => typeof repo?.full_name === 'string' && repo.full_name.toLowerCase() === name;
const loginNamed = (user, name) => typeof user?.login === 'string' && user.login.toLowerCase() === name;
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;

function recordPaths(args, requested) {
  if (args.length || !Array.isArray(requested) || requested.length < 1 || requested.length > 10) {
    throw new UsageError('submit requires 1–10 --record paths and no positional arguments');
  }
  const selected = new Set();
  for (const path of requested) {
    if (typeof path !== 'string' || !path.startsWith(`${CONTENT}/`)) {
      throw new UsageError('Record paths must be relative to the managed site under apps/web/src/content');
    }
    const [kind, name, extra] = path.slice(CONTENT.length + 1).split('/');
    const extension = kind === 'hypotheses' ? '.md' : '.json';
    if (extra !== undefined || !name?.endsWith(extension) || name.length > 255 || /[^a-z0-9.-]/.test(name)) {
      throw new UsageError('Expected a flat record path with a valid basename and extension');
    }
    const id = name.slice(0, -extension.length);
    const review = kind === 'reviews' ? id.split('--') : [];
    const valid = kind === 'evals' ? isResultId(id)
      : kind === 'hypotheses' || kind === 'findings' ? isId(id)
      : kind === 'reviews' && review.length === 3 && isId(review[0]) && isLogin(review[1]) && /^\d{4}-\d{2}-\d{2}$/.test(review[2]);
    if (!valid || selected.has(path)) throw new UsageError('Invalid or duplicate eval, finding, hypothesis or review record path');
    selected.add(path);
  }
  return [...selected].sort();
}

async function inspectLocal(path) {
  try {
    return await lstat(path);
  } catch {
    throw new Error('Cannot inspect the record or its parent directory in the managed site');
  }
}

async function checkedRecord(siteRoot, path) {
  const file = join(siteRoot, path);
  const parent = dirname(file);
  let directory = parse(file).root;
  const parents = [];
  for (const part of relative(directory, parent).split(sep)) {
    directory = join(directory, part);
    const stat = await inspectLocal(directory);
    if (!stat.isDirectory()) throw new Error('Every record parent must be a real directory, not a symlink');
    parents.push([directory, stat]);
  }
  const initial = await inspectLocal(file);
  if (!initial.isFile() || initial.nlink !== 1) throw new Error('The record must be a regular file, not a symlink or hardlink');
  if (initial.size > RECORD_LIMIT) throw new Error('The record exceeds the 16 KiB limit');

  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error('Cannot safely open the record as a regular file');
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !sameInode(initial, before)) throw new Error('The record changed while it was opened');
    if (before.size > RECORD_LIMIT) throw new Error('The record exceeds the 16 KiB limit');
    for (const [dir, initialParent] of parents) {
      const after = await inspectLocal(dir);
      if (!after.isDirectory() || !sameInode(initialParent, after)) throw new Error('A record parent directory changed');
    }
    // Read at most one byte beyond the inspected size, even if the file grows.
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    const current = await inspectLocal(file);
    if (!current.isFile() || current.nlink !== 1 || !sameInode(before, current) || used !== before.size
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('The record changed while it was read');
    }
    return { path, bytes: bytes.subarray(0, used) };
  } finally {
    await handle.close();
  }
}

const gitDigest = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');

function treeDigest(entries) {
  // Git sorts names as bytes, with a virtual '/' after subtree names.
  const sorted = [...entries].map(([name, entry]) => ({ name, entry, key: Buffer.from(entry.type === 'tree' ? `${name}/` : name) }));
  sorted.sort((a, b) => Buffer.compare(a.key, b.key));
  const parts = [];
  for (const { name, entry } of sorted) {
    parts.push(Buffer.from(`${entry.type === 'tree' ? '40000' : entry.mode} ${name}\0`), Buffer.from(entry.sha, 'hex'));
  }
  return gitDigest('tree', Buffer.concat(parts));
}

function gitRef(row, name) {
  if (row?.ref !== name || row.object?.type !== 'commit' || !isSha(row.object.sha)) throw new Error('GitHub returned an invalid branch ref');
  return row.object.sha;
}

async function verifyRepositories(ctx, login) {
  const configured = ctx.config.fork ?? (login === UPSTREAM_OWNER ? UPSTREAM : `${login}/${UPSTREAM_NAME}`);
  if (typeof configured !== 'string' || /[^a-zA-Z0-9/_.-]/.test(configured)) throw new UsageError('Configure a GitHub fork as owner/repo');
  const fork = configured.toLowerCase();
  const [owner, name, extra] = fork.split('/');
  if (owner !== login || !name || name === '.' || name === '..' || extra !== undefined) {
    throw new UsageError('The configured fork must belong to the authenticated GitHub account');
  }
  const canonical = await ctx.github(`repos/${UPSTREAM}`);
  if (!repoNamed(canonical, UPSTREAM) || !loginNamed(canonical.owner, UPSTREAM_OWNER)
    || !Number.isSafeInteger(canonical.id) || canonical.id <= 0) {
    throw new Error('Cannot verify the canonical GitHub repository');
  }
  if (fork === UPSTREAM) return { fork, canonical, target: canonical };
  const target = await ctx.github(`repos/${fork}`);
  if (!repoNamed(target, fork) || !loginNamed(target.owner, login) || !Number.isSafeInteger(target.id)
    || target.id <= 0 || target.id === canonical.id || target.fork !== true || target.permissions?.push !== true
    || target.parent?.id !== canonical.id || !repoNamed(target.parent, UPSTREAM)
    || typeof target.default_branch !== 'string' || !target.default_branch) {
    throw new Error('Require an initialized, writable GitHub fork of the canonical repository owned by the authenticated account');
  }
  const ref = await ctx.github(`repos/${fork}/git/ref/heads/${encodeURIComponent(target.default_branch)}`);
  gitRef(ref, `refs/heads/${target.default_branch}`);
  return { fork, canonical, target };
}

async function readMain(ctx) {
  return gitRef(await ctx.github(`repos/${UPSTREAM}/git/ref/heads/main`), MAIN_REF);
}

async function expectMain(ctx, expected) {
  if (await readMain(ctx) !== expected) throw new Error('Canonical main changed since validation; run submit again');
}

async function treeRows(ctx, sha, recursive = false) {
  const listing = await ctx.github(`repos/${UPSTREAM}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`);
  if (listing?.sha !== sha || listing.truncated !== false || !Array.isArray(listing.tree) || listing.tree.length > SNAPSHOT_ENTRY_LIMIT) {
    throw new Error('Cannot verify a complete, bounded canonical Git tree');
  }
  return listing.tree;
}

function checkEntry(row) {
  const valid = (row?.type === 'tree' && row.mode === '040000')
    || (row?.type === 'blob' && ['100644', '100755', '120000'].includes(row.mode))
    || (row?.type === 'commit' && row.mode === '160000');
  if (!valid || !isSha(row.sha) || typeof row.path !== 'string' || !row.path || row.path.includes('\0')) {
    throw new Error('Canonical Git tree contains an invalid entry');
  }
}

async function readTree(ctx, sha) {
  const entries = new Map();
  for (const row of await treeRows(ctx, sha)) {
    checkEntry(row);
    if (row.path.includes('/') || entries.has(row.path)) throw new Error('Invalid canonical directory entry');
    entries.set(row.path, row);
  }
  if (treeDigest(entries) !== sha) throw new Error('Canonical Git tree SHA does not match its entries');
  return entries;
}

async function readContent(ctx, sha) {
  const dirs = new Map([['', { sha, entries: new Map() }]]);
  const rows = await treeRows(ctx, sha, true);
  const files = [];
  let size = 0;
  for (const row of rows) {
    checkEntry(row);
    if (row.path.length > 1024 || row.path.split('/').some((part) => !part || /[^a-zA-Z0-9_.-]/.test(part)
      || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Unsafe path in canonical content');
    if (row.type === 'tree') {
      if (dirs.has(row.path)) throw new Error('Duplicate canonical content directory');
      dirs.set(row.path, { sha: row.sha, entries: new Map() });
    } else {
      if (row.type !== 'blob' || row.mode === '120000') throw new Error('Canonical content must contain only regular files, not links');
      if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > SNAPSHOT_FILE_LIMIT || (size += row.size) > SNAPSHOT_BYTE_LIMIT) {
        throw new Error('Canonical content exceeds the snapshot size limit');
      }
      files.push(row);
    }
  }
  for (const row of rows) {
    const slash = row.path.lastIndexOf('/');
    const parent = dirs.get(slash === -1 ? '' : row.path.slice(0, slash));
    const name = row.path.slice(slash + 1);
    if (!parent || parent.entries.has(name)) throw new Error('Invalid canonical content tree hierarchy');
    parent.entries.set(name, row);
  }
  for (const dir of dirs.values()) {
    if (treeDigest(dir.entries) !== dir.sha) throw new Error('Canonical content tree SHA does not match its entries');
  }
  return { dirs, files };
}

async function snapshot(ctx, baseSha) {
  const commit = await ctx.github(`repos/${UPSTREAM}/git/commits/${baseSha}`);
  if (commit?.sha !== baseSha || !isSha(commit.tree?.sha)) throw new Error('Cannot verify the inspected canonical commit and tree');
  let sha = commit.tree.sha;
  const ancestry = [];
  for (const component of CONTENT.split('/')) {
    const tree = await readTree(ctx, sha);
    const entry = tree.get(component);
    if (entry?.type !== 'tree') throw new Error('Canonical commit does not contain the expected content directory');
    ancestry.push([tree, component]);
    sha = entry.sha;
  }
  return { baseTree: commit.tree.sha, ancestry, ...await readContent(ctx, sha) };
}

function addedTree(base, records) {
  const contentEntries = base.dirs.get('').entries;
  const newContents = new Map(contentEntries);
  const updates = new Map();
  for (const { path, sha } of records) {
    const [kind, name] = path.slice(CONTENT.length + 1).split('/');
    const original = contentEntries.get(kind);
    if (original && original.type !== 'tree') throw new Error('Canonical content record parent is not a directory');
    if (!updates.has(kind)) updates.set(kind, new Map(base.dirs.get(kind)?.entries));
    const entries = updates.get(kind);
    if (entries.has(name)) throw new Error(`Record already exists on canonical main: ${path}`);
    entries.set(name, { mode: '100644', type: 'blob', sha });
  }
  for (const [kind, entries] of updates) newContents.set(kind, { mode: '040000', type: 'tree', sha: treeDigest(entries) });
  let sha = treeDigest(newContents);
  for (const [entries, component] of [...base.ancestry].reverse()) {
    const updated = new Map(entries);
    updated.set(component, { mode: '040000', type: 'tree', sha });
    sha = treeDigest(updated);
  }
  return sha;
}

async function materialize(ctx, root, source) {
  const dirs = [...source.dirs.keys()].filter(Boolean).sort((a, b) => a.length - b.length);
  for (const path of dirs) await mkdir(join(root, path), { mode: 0o700 });
  // Limit parallel gh processes while fetching immutable blobs by their verified object IDs.
  for (let i = 0; i < source.files.length; i += 8) {
    const batch = await Promise.allSettled(source.files.slice(i, i + 8).map(async (file) => {
      const blob = await ctx.github(`repos/${UPSTREAM}/git/blobs/${file.sha}`);
      if (blob?.sha !== file.sha || blob.size !== file.size || blob.encoding !== 'base64' || typeof blob.content !== 'string'
        || blob.content.length > Math.ceil(file.size / 3) * 6 + 8) throw new Error('Cannot verify the canonical content blob');
      const bytes = Buffer.from(blob.content, 'base64');
      if (bytes.length !== file.size || gitDigest('blob', bytes) !== file.sha) throw new Error('Canonical content blob SHA does not match its bytes');
      await writeFile(join(root, file.path), bytes, { flag: 'wx', mode: 0o600 });
    }));
    const failure = batch.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

async function validateOverlay(ctx, bridge, source, records, login, siteSha) {
  const contentRoot = await mkdtemp(join(tmpdir(), 'unite4ai-submit-'));
  try {
    await materialize(ctx, contentRoot, source);
    const paths = records.map(({ path }) => path.slice(CONTENT.length + 1));
    for (const [i, path] of paths.entries()) {
      if (!source.dirs.has(dirname(path))) await mkdir(join(contentRoot, dirname(path)), { recursive: true, mode: 0o700 });
      await writeFile(join(contentRoot, path), records[i].bytes, { flag: 'wx', mode: 0o600 });
    }
    const validation = await bridge(ctx, 'validate', { contentRoot, records: paths });
    if (validation?.siteSha !== siteSha || !Array.isArray(validation.errors) || validation.errors.length) {
      throw new Error('Pinned site content validation failed; inspect the records locally before submitting');
    }
    if (!Array.isArray(validation.identities) || validation.identities.length !== records.length
      || paths.some((_, i) => validation.identities[i] !== login)) {
      throw new Error('Every record identity must match the authenticated GitHub account');
    }
  } finally {
    await rm(contentRoot, { recursive: true, force: true });
  }
}

async function topicHead(ctx, fork, branch) {
  const rows = await ctx.github(`repos/${fork}/git/matching-refs/heads/${branch}`);
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.ref !== 'string')) throw new Error('Cannot inspect the submission branch');
  const name = `refs/heads/${branch}`;
  const matches = rows.filter((row) => row.ref === name);
  if (matches.length > 1 || rows.some((row) => row.ref.startsWith(`${name}/`))) {
    throw new Error('Cannot uniquely match the submission branch; its namespace is occupied');
  }
  return matches.length ? gitRef(matches[0], name) : null;
}

function sameCommit(commit, sha, parent, tree) {
  return isSha(sha) && commit?.sha === sha && commit.tree?.sha === tree
    && Array.isArray(commit.parents) && commit.parents.length === 1 && commit.parents[0]?.sha === parent;
}

async function inspectTopic(ctx, spec, head) {
  const commit = await ctx.github(`repos/${spec.fork}/git/commits/${head}`);
  if (!sameCommit(commit, head, spec.baseSha, spec.tree)) throw new Error('Existing branch does not match the inspected commit parent and tree');
}

function inspectPr(pr, spec, head) {
  const { login, fork, branch, baseSha, canonical, target } = spec;
  if (!head || pr?.state !== 'open' || pr.draft !== true || !loginNamed(pr.user, login)
    || pr.base?.ref !== 'main' || pr.base.sha !== baseSha || pr.base.repo?.id !== canonical.id || !repoNamed(pr.base.repo, UPSTREAM)
    || pr.head?.ref !== branch || pr.head.sha !== head || pr.head.repo?.id !== target.id || !repoNamed(pr.head.repo, fork)
    || !Number.isSafeInteger(pr.number) || pr.number <= 0 || pr.html_url !== `https://github.com/${UPSTREAM}/pull/${pr.number}`) {
    throw new Error('Pull request collision or response does not match the inspected draft, head, and base');
  }
  return pr.html_url;
}

async function findPr(ctx, spec, head) {
  const query = new URLSearchParams({ state: 'all', head: `${spec.login}:${spec.branch}`, per_page: '100' });
  const rows = await ctx.github(`repos/${UPSTREAM}/pulls?${query}`);
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('Cannot uniquely match the submission pull request');
  return rows.length ? inspectPr(rows[0], spec, head) : null;
}

const post = (ctx, repo, endpoint, body) => ctx.github(`repos/${repo}/${endpoint}`, { method: 'POST', body });

async function makeCommit(ctx, spec, records) {
  const tree = [];
  for (const { path, bytes, sha } of records) {
    const blob = await post(ctx, spec.fork, 'git/blobs', { encoding: 'base64', content: bytes.toString('base64') });
    if (blob?.sha !== sha) throw new Error('GitHub returned a blob SHA that does not match the validated bytes');
    tree.push({ path, mode: '100644', type: 'blob', sha });
  }
  const createdTree = await post(ctx, spec.fork, 'git/trees', { base_tree: spec.baseTree, tree });
  if (createdTree?.sha !== spec.tree) throw new Error('GitHub returned a tree other than the inspected add-only tree');
  const commit = await post(ctx, spec.fork, 'git/commits', { message: TITLE, tree: spec.tree, parents: [spec.baseSha] });
  if (!sameCommit(commit, commit?.sha, spec.baseSha, spec.tree)) throw new Error('GitHub returned a commit with the wrong parent or tree');
  return commit.sha;
}

async function publishRef(ctx, spec, commit) {
  const name = `refs/heads/${spec.branch}`;
  let created;
  try {
    created = await post(ctx, spec.fork, 'git/refs', { ref: name, sha: commit });
  } catch (error) {
    // Another exact submission (or a lost response) can win ref creation; never update it.
    const head = await topicHead(ctx, spec.fork, spec.branch);
    if (!head) throw error;
    await inspectTopic(ctx, spec, head);
    return head;
  }
  if (gitRef(created, name) !== commit) throw new Error('GitHub created a ref with an unexpected head');
  return commit;
}

async function draftPr(ctx, spec, head, paths, siteSha) {
  let pr;
  try {
    pr = await post(ctx, UPSTREAM, 'pulls', {
      title: TITLE,
      head: spec.fork === UPSTREAM ? spec.branch : `${spec.login}:${spec.branch}`,
      base: 'main', draft: true,
      body: `Add only:\n${paths.map((path) => `- \`${path}\``).join('\n')}\n\nValidated against canonical main \`${spec.baseSha}\` using pinned site \`${siteSha}\`.`,
    });
  } catch (error) {
    const existing = await findPr(ctx, spec, head);
    if (!existing) throw error;
    return existing;
  }
  return inspectPr(pr, spec, head);
}

export async function submit(ctx, { args, flags }, deps = { readPinnedTreePaths, runBridge }) {
  const paths = recordPaths(args, flags.record);
  const login = await ctx.login();
  if (!isLogin(login)) throw new Error('Sign in to GitHub before submitting records');

  const root = join(ctx.state, 'site');
  const records = [];
  for (const path of paths) {
    const record = await checkedRecord(root, path);
    records.push({ ...record, sha: gitDigest('blob', record.bytes) });
  }
  const { siteRoot, siteSha, tracked } = await deps.readPinnedTreePaths(ctx, paths);
  if (siteRoot !== root || !isSha(siteSha)) throw new Error('Cannot verify the pinned managed site workspace');
  if (tracked !== '') throw new Error('Record already exists in the pinned site; submission is add-only');

  const repository = await verifyRepositories(ctx, login);
  const baseSha = await readMain(ctx);
  const base = await snapshot(ctx, baseSha);
  const tree = addedTree(base, records);
  await validateOverlay(ctx, deps.runBridge, base, records, login, siteSha);

  const fingerprint = records.map(({ path, bytes }) => ({ path, sha256: createHash('sha256').update(bytes).digest('hex') }));
  const key = createHash('sha256').update(JSON.stringify([login, repository.fork, UPSTREAM, fingerprint])).digest('hex');
  const branch = `unite4ai/${login}/${key.slice(0, 32)}`;
  const spec = { ...repository, login, branch, baseSha, baseTree: base.baseTree, tree };
  let head = await topicHead(ctx, spec.fork, branch);
  if (head) await inspectTopic(ctx, spec, head);
  let url = await findPr(ctx, spec, head);
  const summary = { records: fingerprint, account: login, fork: spec.fork, branch, base_sha: baseSha, site_sha: siteSha };
  if (flags.confirm !== true) {
    return { status: 'preview', ...summary, help: [
      'Review these record paths and SHA-256 digests with the owner.',
      'Only after the owner explicitly approves publication, repeat the submission with --confirm.',
    ] };
  }

  if (!head) {
    await expectMain(ctx, baseSha);
    const commit = await makeCommit(ctx, spec, records);
    await expectMain(ctx, baseSha);
    head = await publishRef(ctx, spec, commit);
  }
  if (await topicHead(ctx, spec.fork, branch) !== head) throw new Error('Submission branch head changed before opening the pull request');
  await expectMain(ctx, baseSha);
  url ??= await draftPr(ctx, spec, head, paths, siteSha);
  return { status: 'draft', ...summary, commit_sha: head, pr_url: url, help: [
    'Send the draft PR URL to the owner.',
    'Leave the PR as a draft for review. This command does not merge or deploy.',
  ] };
}
