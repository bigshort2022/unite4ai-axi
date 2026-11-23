import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { ORIGIN, exec } from '../src/shared.mjs';
import { requireWorkspace, runBridge, setupWorkspace } from '../src/workspace.mjs';

const { sha } = JSON.parse(await readFile(new URL('../site-pin.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const state = await mkdtemp(join(await realpath(tmpdir()), 'u4ai-workspace-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const calls = [];
  let dirty = '', untracked = '', index = '';
  const exec = async (file, args, options = {}) => {
    calls.push({ file, args, ...options });
    const { cwd, input } = options;
    if (file === 'bun') {
      if (args.includes('install')) await mkdir(join(cwd, 'node_modules'));
      else {
        assert.ok(isAbsolute(args.at(-2)));
        assert.match(args.at(-2), /\/src\/bridge\.ts$/);
        assert.deepEqual(JSON.parse(input), { siteRoot: join(state, 'site'), payload: { contentRoot: join(state, 'overlay') } });
        return JSON.stringify({ errors: [], warnings: [] });
      }
    } else {
      if (args.includes('clone')) {
        assert.ok(args.includes('--no-checkout'));
        assert.equal(args.at(-2), ORIGIN);
        await mkdir(join(args.at(-1), '.git'), { recursive: true });
      }
      if (args.includes('checkout')) {
        assert.ok(args.includes('--detach'));
        await writeFile(join(cwd, '.git/HEAD'), `${sha}\n`);
      }
      if (args.includes('--show-toplevel')) return `${cwd}\n`;
      if (args.includes('status')) return dirty;
      if (args.includes('--others')) return untracked;
      if (args.includes('-v')) return index;
    }
    return '';
  };
  return { ctx: { state, exec }, calls, dirty(value) { dirty = value; }, untracked(value) { untracked = value; }, index(value) { index = value; } };
}

test('reads never set up the absent workspace', async (t) => {
  const { ctx, calls } = await fixture(t);
  await assert.rejects(runBridge(ctx, 'catalog'), /setup workspace/);
  assert.deepEqual(calls, []);
});

test('setup verifies the canonical main ancestor before a detached frozen script-free install', async (t) => {
  const { ctx, calls } = await fixture(t);
  const output = await setupWorkspace(ctx, { args: [], flags: {} });
  assert.equal(output.siteSha, sha);
  assert.deepEqual(await requireWorkspace(ctx), { siteRoot: join(ctx.state, 'site'), siteSha: sha });
  await setupWorkspace(ctx, { args: [], flags: {} });
  const clone = calls.findIndex(({ args }) => args.includes('clone'));
  const fetch = calls.findIndex(({ args }) => args.includes('fetch'));
  const ancestor = calls.findIndex(({ args }) => args.includes('--is-ancestor') && args.includes(sha));
  const checkout = calls.findIndex(({ args }) => args.includes('checkout'));
  const install = calls.findIndex(({ file, args }) => file === 'bun' && args.includes('install'));
  assert.ok(clone >= 0 && clone < fetch && fetch < ancestor && ancestor < checkout && checkout < install);
  assert.ok(calls[install].args.includes('--frozen-lockfile') && calls[install].args.includes('--ignore-scripts'));
  assert.equal(calls.filter(({ args }) => args.includes('install')).length, 1);
});

test('bridge rejects tracked modifications, hidden index flags, and foreign artifacts', async (t) => {
  const { ctx, calls, dirty, untracked, index } = await fixture(t);
  await setupWorkspace(ctx);
  dirty(' M packages/core/src/validate.ts\0');
  await assert.rejects(runBridge(ctx, 'catalog'), /tracked/i);
  dirty('');
  index('h packages/core/src/validate.ts\0');
  await assert.rejects(runBridge(ctx, 'catalog'), /tracked/i);
  index('');
  untracked('apps/cli/src/eval/args.js\0');
  await assert.rejects(runBridge(ctx, 'catalog'), /unexpected/i);
  assert.equal(calls.filter(({ file }) => file === 'bun').length, 1);
});

test('bridge refuses a symlink disguised as a record', async (t) => {
  const { ctx, untracked } = await fixture(t);
  await setupWorkspace(ctx);
  const rel = 'apps/web/src/content/findings/study.json';
  await mkdir(join(ctx.state, 'site/apps/web/src/content/findings'), { recursive: true });
  await symlink('/not-an-artifact', join(ctx.state, 'site', rel));
  assert.equal((await lstat(join(ctx.state, 'site', rel))).isSymbolicLink(), true);
  untracked(`${rel}\0`);
  await assert.rejects(runBridge(ctx, 'catalog'), /regular|symbolic/i);
});

test('validate forwards the chosen content overlay to the package-owned bridge', async (t) => {
  const { ctx } = await fixture(t);
  await setupWorkspace(ctx);
  assert.deepEqual(await runBridge(ctx, 'validate', { contentRoot: join(ctx.state, 'overlay') }), { errors: [], warnings: [], siteSha: sha });
});

test('the real Bun bridge refuses model swaps and never follows a completion redirect', {
  timeout: 15_000,
  skip: spawnSync('bun', ['--version'], { stdio: 'ignore', timeout: 2000 }).status !== 0,
}, async (t) => {
  const { ctx } = await fixture(t);
  await setupWorkspace(ctx);
  const siteRoot = join(ctx.state, 'site');
  const paths = {
    'apps/web/src/content/benchmarks/study.md': '---\nversion: "1"\n---\n',
    'packages/schema/src/index.ts': `export const benchmarkSchema = { parse: () => ({
      source_url: 'https://example.invalid/pinned.json', source_sha256: '${'a'.repeat(64)}'
    }) };`,
    'apps/cli/src/eval/suites.ts': 'export const SUITES = { study: {} };',
    'apps/cli/src/eval/args.ts': `export function parseEvalArgs(argv) {
      const flag = (key) => argv[argv.indexOf(key) + 1];
      return { baseUrl: flag('--base-url'), model: flag('--served-model'), swap: flag('--notes') === 'swap' };
    }`,
    'apps/cli/src/eval/run.ts': `export async function runEval({ baseUrl, model, swap }) {
      await fetch(baseUrl + '/chat/completions', { method: 'POST', redirect: 'follow',
        body: JSON.stringify({ model: swap ? 'wrong-model' : model })
      });
      throw Error('fixture ends before a result');
    }`,
  };
  await Promise.all(Object.entries(paths).map(async ([path, contents]) => {
    await mkdir(join(siteRoot, path, '..'), { recursive: true });
    await writeFile(join(siteRoot, path), contents);
  }));
  const fixtureExec = ctx.exec;
  ctx.exec = (file, args, options) => file === 'bun' ? exec(file, args, options) : fixtureExec(file, args, options);
  const requests = [];
  const listener = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'checkpoint' }] }));
    if (req.url === '/_omp/status') { res.statusCode = 404; return res.end(); }
    if (req.url === '/v1/chat/completions') {
      for await (const _ of req) { /* Drain the synthetic request. */ }
      res.statusCode = 307;
      res.setHeader('Location', '/v1/redirect-target');
      return res.end();
    }
    res.statusCode = 500;
    res.end();
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => { listener.closeAllConnections(); listener.close(); });
  const payload = { benchmark: 'study', model: 'alpha', submitter: 'me', maxSeconds: 5, server: {
    id: 'desk', base_url: `http://127.0.0.1:${listener.address().port}/v1`, loaded_model: 'checkpoint', runtime: 'ollama',
    runtime_version: '1', format: 'gguf', quantization: 'Q4_K_M', device: 'fixture', accelerator: 'cpu', memory_gb: 1,
    notes: 'swap',
  } };
  await assert.rejects(runBridge(ctx, 'eval', payload), /change the loaded model/);
  assert.equal(requests.filter((line) => line.startsWith('POST')).length, 0);
  delete payload.server.notes;
  await assert.rejects(runBridge(ctx, 'eval', payload), /pinned evaluation did not complete/);
  assert.deepEqual(requests.filter((line) => line.startsWith('POST')), ['POST /v1/chat/completions']);
  assert.equal(requests.some((line) => line.includes('redirect-target')), false);
});
