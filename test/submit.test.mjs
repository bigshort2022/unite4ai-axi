import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { submit } from '../src/submit.mjs';
import { UPSTREAM } from '../src/shared.mjs';

const root = 'apps/web/src/content';
const record = `${root}/findings/fresh-record.json`;
const earlier = 'findings/already-published.json';
const bytes = Buffer.from('{"author":"alice","summary":"évidence"}\r\n');
const oldBytes = Buffer.from('{"author":"bob"}\n');
const main = 'a'.repeat(40);
const pin = 'b'.repeat(40);
const head = 'c'.repeat(40);
const fork = 'alice/unite4ai.github.io';
const prUrl = `https://github.com/${UPSTREAM}/pull/5`;
const sha = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
const blobSha = (bytes) => sha('blob', bytes);
const treeSha = (rows) => sha('tree', Buffer.concat(rows.flatMap(({ path, mode, sha }) => [
  Buffer.from(`${mode === '040000' ? '40000' : mode} ${path}\0`), Buffer.from(sha, 'hex'),
])));
const blob = (path, bytes) => ({ path, mode: '100644', type: 'blob', sha: blobSha(bytes), size: bytes.length });
const directory = (path, children) => ({ path, mode: '040000', type: 'tree', sha: treeSha(children) });

function siteTree(hasRecord, extraEntry, selected = bytes) {
  const children = [blob('already-published.json', oldBytes)];
  if (hasRecord) children.push(blob('fresh-record.json', selected));
  const findings = directory('findings', children);
  const contents = extraEntry ? [findings, extraEntry] : [findings];
  const content = directory('content', contents);
  const src = directory('src', [content]);
  const web = directory('web', [src]);
  const apps = directory('apps', [web]);
  // Git orders a directory's name as if followed by '/', so apps.txt comes before apps/.
  const base = treeSha([blob('apps.txt', oldBytes), apps]);
  return { base, trees: new Map([
    [base, [blob('apps.txt', oldBytes), apps]], [apps.sha, [web]], [web.sha, [src]], [src.sha, [content]],
    [`${content.sha}?recursive=1`, [...contents, ...children.map((entry) => ({ ...entry, path: `findings/${entry.path}` }))]],
  ]) };
}

async function fixture(t, opts = {}) {
  const repo = opts.sameOwner ? UPSTREAM : fork;
  const login = opts.sameOwner ? 'bigshort2022' : 'alice';
  const selected = opts.sameOwner ? Buffer.from(bytes.toString().replace('alice', login)) : bytes;
  const state = await mkdtemp(join(await realpath(tmpdir()), 'u4ai-submit-test-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const siteRoot = join(state, 'site');
  const file = join(siteRoot, record);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, selected);
  await writeFile(join(dirname(file), 'private-draft.json'), 'not submitted');
  const base = siteTree(opts.hasRecord, opts.extraEntry, selected);
  const expected = siteTree(true, undefined, selected).base;
  const commits = new Map([[main, { sha: main, tree: { sha: base.base }, parents: [] }]]);
  const refs = new Map();
  const pulls = new Map();
  const calls = [];
  const writes = [];
  let baseReads = 0;
  const canonical = { id: 1, full_name: UPSTREAM, owner: { login: 'bigshort2022' }, default_branch: 'main' };
  const target = opts.sameOwner ? canonical : { id: 2, full_name: fork, owner: { login }, default_branch: 'main', fork: true, permissions: { push: true }, parent: canonical, ...opts.forkMetadata };
  function makePr(branch, commit = head) {
    return {
      number: 5, html_url: prUrl, state: 'open', draft: true, user: { login },
      head: { ref: branch, sha: commit, repo: target }, base: { ref: 'main', sha: main, repo: canonical },
    };
  }
  function ref(name, commit) { return { ref: `refs/heads/${name}`, object: { type: 'commit', sha: commit } }; }
  const ctx = {
    state, config: { fork: opts.configFork }, login: async () => opts.login === undefined ? login : opts.login,
    github: async (endpoint, { method = 'GET', body } = {}) => {
      calls.push(endpoint);
      if (method === 'POST') writes.push({ endpoint, body });
      else assert.equal(method, 'GET');
      const canonicalPath = `repos/${UPSTREAM}`;
      const forkPath = `repos/${repo}`;
      if (endpoint === canonicalPath) return canonical;
      if (endpoint === forkPath) return target;
      if (endpoint === `${canonicalPath}/git/ref/heads/main`) return ref('main', ++baseReads > 1 ? opts.movedMain ?? main : main);
      if (endpoint === `${forkPath}/git/ref/heads/main`) return ref('main', main);
      const treePrefix = `${canonicalPath}/git/trees/`;
      if (endpoint.startsWith(treePrefix)) {
        const key = endpoint.slice(treePrefix.length);
        const tree = base.trees.get(key);
        assert.ok(tree, 'read only requested canonical trees');
        return { sha: key.split('?')[0], truncated: false, tree };
      }
      const blobPrefix = `${canonicalPath}/git/blobs/`;
      if (endpoint.startsWith(blobPrefix)) {
        const hash = endpoint.slice(blobPrefix.length);
        const content = hash === blobSha(selected) ? selected : oldBytes;
        return { sha: hash, encoding: 'base64', size: content.length, content: content.toString('base64') };
      }
      const commitsMatch = endpoint.match(/\/git\/commits\/([0-9a-f]{40})$/);
      if (method === 'GET' && commitsMatch) return commits.get(commitsMatch[1]);
      const refsPrefix = `${forkPath}/git/matching-refs/heads/`;
      if (endpoint.startsWith(refsPrefix)) {
        const branch = endpoint.slice(refsPrefix.length);
        const commit = refs.get(branch);
        return commit ? [ref(branch, opts.movedHead ?? commit)] : [];
      }
      if (endpoint.startsWith(`${canonicalPath}/pulls?`)) {
        const query = new URLSearchParams(endpoint.split('?')[1]);
        assert.equal(query.has('base'), false, 'look for PRs with a retargeted base too');
        assert.equal(query.get('state'), 'all');
        const found = pulls.get(query.get('head'));
        return found ? [found] : [];
      }
      if (endpoint === `${forkPath}/git/blobs` && method === 'POST') return { sha: blobSha(Buffer.from(body.content, 'base64')) };
      if (endpoint === `${forkPath}/git/trees` && method === 'POST') return { sha: opts.wrongTree ?? expected };
      if (endpoint === `${forkPath}/git/commits` && method === 'POST') {
        const commit = { sha: head, tree: { sha: body.tree }, parents: body.parents.map((sha) => ({ sha })) };
        commits.set(head, commit);
        return commit;
      }
      if (endpoint === `${forkPath}/git/refs` && method === 'POST') {
        const branch = body.ref.slice('refs/heads/'.length);
        refs.set(branch, body.sha);
        if (opts.lostRefResponse) throw new Error('Transport interrupted');
        return ref(branch, body.sha);
      }
      if (endpoint === `${canonicalPath}/pulls` && method === 'POST') {
        const branch = body.head.split(':').at(-1);
        const pr = makePr(branch, opts.prHead ?? refs.get(branch));
        pulls.set(`${login}:${branch}`, pr);
        return pr;
      }
      throw new Error(`Unexpected API call: ${method} ${endpoint}`);
    },
  };
  const inspect = async (_ctx, action, { contentRoot, records }) => {
    assert.equal(action, 'validate');
    assert.notEqual(contentRoot, join(siteRoot, root));
    assert.deepEqual(records, ['findings/fresh-record.json']);
    assert.deepEqual(await readFile(join(contentRoot, earlier)), oldBytes);
    assert.deepEqual(await readFile(join(contentRoot, records[0])), selected);
    await assert.rejects(readFile(join(contentRoot, 'findings/private-draft.json')), { code: 'ENOENT' });
    return { errors: opts.validationErrors ?? [], warnings: [], siteSha: pin, identities: [opts.identity ?? login] };
  };
  const deps = {
    readPinnedTreePaths: async (_ctx, paths) => {
      assert.deepEqual(paths, [record]);
      const tracked = opts.tracked ? `100644 blob ${blobSha(selected)}\t${record}\0` : '';
      return { siteRoot, siteSha: pin, tracked };
    },
    runBridge: inspect,
  };
  const run = (flags = {}, args = []) => submit(ctx, { args, flags: { record: [record], ...flags } }, deps);
  return { base, calls, commits, ctx, expected, file, makePr, pulls, refs, run, state, writes };
}

test('submit preview validates isolated exact bytes and makes no GitHub writes', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, 'preview');
  assert.equal(result.base_sha, main);
  assert.equal(result.site_sha, pin);
  assert.deepEqual(result.records, [{ path: record, sha256: createHash('sha256').update(bytes).digest('hex') }]);
  assert.ok(result.help.some((line) => line.includes('owner explicitly approves')));
  assert.deepEqual(f.writes, []);
});

test('confirmed submit makes one add-only commit and draft PR, then reuses them without writes', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ confirm: true });
  assert.equal(result.pr_url, prUrl);
  const branch = result.branch;
  assert.match(branch, /^unite4ai\/alice\/[0-9a-f]+$/);
  assert.deepEqual(f.writes, [
    { endpoint: `repos/${fork}/git/blobs`, body: { content: bytes.toString('base64'), encoding: 'base64' } },
    { endpoint: `repos/${fork}/git/trees`, body: { base_tree: f.base.base, tree: [{ path: record, mode: '100644', type: 'blob', sha: blobSha(bytes) }] } },
    { endpoint: `repos/${fork}/git/commits`, body: { message: 'Add Unite4AI evidence records', tree: f.expected, parents: [main] } },
    { endpoint: `repos/${fork}/git/refs`, body: { ref: `refs/heads/${branch}`, sha: head } },
    { endpoint: `repos/${UPSTREAM}/pulls`, body: {
      title: 'Add Unite4AI evidence records', head: `alice:${branch}`, base: 'main', draft: true,
      body: `Add only:\n- \`${record}\`\n\nValidated against canonical main \`${main}\` using pinned site \`${pin}\`.`,
    } },
  ]);
  f.writes.length = 0;
  assert.equal((await f.run({ confirm: true })).pr_url, prUrl);
  assert.deepEqual(f.writes, []);
});

test('the canonical owner can submit in the canonical repository without a fork', async (t) => {
  const f = await fixture(t, { sameOwner: true });
  const result = await f.run({ confirm: true });
  assert.equal(result.pr_url, prUrl);
  assert.equal(result.fork, UPSTREAM);
  assert.equal(f.writes.at(-1).body.head, result.branch);
  assert.ok(f.writes.every(({ endpoint }) => endpoint.startsWith(`repos/${UPSTREAM}/`)));
});

test('an interrupted ref creation resumes only from the verified commit', async (t) => {
  const f = await fixture(t, { lostRefResponse: true });
  assert.equal((await f.run({ confirm: true })).pr_url, prUrl);
  assert.equal(f.writes.filter(({ endpoint }) => endpoint.endsWith('/refs')).length, 1);
});

test('a changed topic head stops submission before opening a pull request', async (t) => {
  const f = await fixture(t, { movedHead: pin });
  await assert.rejects(f.run({ confirm: true }), /branch head changed/i);
  assert.equal(f.writes.at(-1).endpoint, `repos/${fork}/git/refs`);
});

test('malformed or duplicate record paths are rejected before API calls', async (t) => {
  const f = await fixture(t);
  for (const paths of [[], [record, record], Array(11).fill(record), [`/${record}`], [`./${record}`],
    [`${root}//findings/fresh-record.json`], [`${root}/findings/../findings/fresh-record.json`],
    [record.replaceAll('/', '\\')], [`${root}/findings/.gitkeep`], [`${root}/findings/fresh-record.md`],
    [`${root}/evals/transcript.json`], [`${root}/reviews/approval.json`], [`${record}\n`],
    [`${root}/benchmarks/unrelated.md`]]) {
    await assert.rejects(f.run({ record: paths, confirm: true }), /record/i);
  }
  assert.deepEqual(f.calls, []);
});

test('submit rejects symlink leaves and the full chain of parent directories', async (t) => {
  const f = await fixture(t);
  const linkDestination = join(f.state, 'real-file');
  await rename(f.file, linkDestination);
  await symlink(linkDestination, f.file);
  await assert.rejects(f.run({ confirm: true }), /regular|link/i);
  await rm(f.file);
  await rename(linkDestination, f.file);
  const actualDirectory = join(f.state, 'real-content');
  const symlinkParent = join(f.state, 'site', root);
  await rename(symlinkParent, actualDirectory);
  await symlink(actualDirectory, symlinkParent, 'dir');
  await assert.rejects(f.run({ confirm: true }), /directory|link/i);
  assert.deepEqual(f.writes, []);
});

test('the full parent chain includes the configured state directory', async (t) => {
  const f = await fixture(t);
  const alias = join(f.state, 'state-alias');
  await symlink(f.state, alias, 'dir');
  f.ctx.state = alias;
  await assert.rejects(f.run({ confirm: true }), /directory|link/i);
  assert.deepEqual(f.writes, []);
});

test('submit rejects records over the 16KiB byte limit', async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, Buffer.alloc(16 * 1024 + 1));
  await assert.rejects(f.run({ confirm: true }), /16\s*KiB|16384/i);
  assert.deepEqual(f.writes, []);
});

test('already-present paths are never additions even when bytes match', async (t) => {
  for (const options of [{ tracked: true }, { hasRecord: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run({ confirm: true }), /already exists|add-only/i);
    assert.deepEqual(f.writes, []);
  }
});

test('submit rejects missing authentication and mismatched record identities', async (t) => {
  for (const options of [{ login: null }, { identity: 'mallory' }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run({ confirm: true }), /sign in|authenticat|identity/i);
    assert.deepEqual(f.writes, []);
  }
});

test('validation failure does not publish any objects or print record prose', async (t) => {
  const f = await fixture(t, { validationErrors: ['Untrusted record prose'] });
  await assert.rejects(f.run({ confirm: true }), (err) => /validation/i.test(err.message) && !err.message.includes('prose'));
  assert.deepEqual(f.writes, []);
});

test('submit rejects unrelated forks and canonical main drift before writes', async (t) => {
  for (const options of [{ forkMetadata: { parent: { id: 55, full_name: UPSTREAM } } }, { movedMain: 'e'.repeat(40) }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run({ confirm: true }), /fork|main.*changed/i);
    assert.deepEqual(f.writes, []);
  }
});

test('canonical symlinks are rejected without materializing them', async (t) => {
  const f = await fixture(t, { extraEntry: { ...blob('unsafe-link', Buffer.from('/tmp')), mode: '120000' } });
  await assert.rejects(f.run({ confirm: true }), /regular|link/i);
  assert.deepEqual(f.writes, []);
});

test('existing branches are rejected on changed parent, merge commit, or wrong tree', async (t) => {
  const f = await fixture(t);
  const { branch } = await f.run();
  f.refs.set(branch, head);
  for (const [parents, tree] of [
    [[pin], f.expected], [[main, pin], f.expected], [[main], f.base.base],
  ]) {
    f.commits.set(head, { sha: head, parents: parents.map((sha) => ({ sha })), tree: { sha: tree } });
    await assert.rejects(f.run({ confirm: true }), /existing branch.*(?:commit|parent|tree)/i);
    assert.deepEqual(f.writes, []);
  }
});

test('an existing PR for a different head is not reused or replaced', async (t) => {
  const f = await fixture(t);
  const { branch } = await f.run();
  f.refs.set(branch, head);
  f.commits.set(head, { sha: head, parents: [{ sha: main }], tree: { sha: f.expected } });
  f.pulls.set(`alice:${branch}`, f.makePr(branch, pin));
  await assert.rejects(f.run({ confirm: true }), /pull request.*(?:matches|matching|head|collision)/i);
  assert.deepEqual(f.writes, []);
});

test('a retargeted PR for the same head blocks another PR', async (t) => {
  const f = await fixture(t);
  const { branch } = await f.run();
  f.refs.set(branch, head);
  f.commits.set(head, { sha: head, parents: [{ sha: main }], tree: { sha: f.expected } });
  const pr = f.makePr(branch);
  pr.base.ref = 'other';
  f.pulls.set(`alice:${branch}`, pr);
  await assert.rejects(f.run({ confirm: true }), /pull request.*collision/i);
  assert.deepEqual(f.writes, []);
});

test('a mismatched newly created Git tree cannot reach a commit, ref, or PR', async (t) => {
  const f = await fixture(t, { wrongTree: 'f'.repeat(40) });
  await assert.rejects(f.run({ confirm: true }), /tree/i);
  assert.deepEqual(f.writes.map(({ endpoint }) => endpoint.split('/').at(-1)), ['blobs', 'trees']);
});
