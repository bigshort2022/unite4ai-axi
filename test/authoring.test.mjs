import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findingDraft, replicate, review, run } from '../src/authoring.mjs';

const { sha } = JSON.parse(await readFile(new URL('../site-pin.json', import.meta.url), 'utf8'));
const result = 'alpha--study--peer--2026-11-01--12345678';
const method = { runs: 5, temperature: 0.2, top_p: 0.9 };
const flags = { model: 'alpha', server: 'desk', 'max-seconds': '120' };
const agent = { date: '2026-11-23', 'agent-model': 'model-a', 'agent-harness': 'harness-a' };
const server = {
  id: 'desk', base_url: 'http://127.0.0.1:7890/v1', loaded_model: 'checkpoint',
  runtime: 'ollama', runtime_version: '7.2', format: 'gguf', quantization: 'Q4_K_M',
  device: 'Desk PC', accelerator: 'cpu', memory_gb: 32,
};

async function fixture(t) {
  const state = await mkdtemp(join(await realpath(tmpdir()), 'u4ai-authoring-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const site = join(state, 'site');
  await mkdir(join(site, '.git'), { recursive: true });
  await mkdir(join(site, 'node_modules'));
  await writeFile(join(site, '.git/HEAD'), `${sha}\n`);
  await writeFile(join(site, '.git/unite4ai-axi-pin'), `${sha}\n`);
  const catalog = {
    benchmarks: [{ id: 'study', version: '1', scoring: 'multiple-choice', items: 50, repeat: method, runnable: true }],
    models: ['alpha'],
    results: [{ id: result, model: 'alpha', benchmark: 'study', benchmark_version: '1', n: 50, repeat: { ...method },
      run: { submitter: 'peer' }, setup: { runtime: 'llama.cpp', served_model: 'checkpoint', format: 'gguf', quantization: 'Q4_K_M', hardware: { device: 'Peer machine' } } }],
  };
  const calls = [], requests = [];
  let models = ['checkpoint'], status = null;
  const ctx = {
    state, config: { servers: [server] }, login: async () => 'me',
    fetch: async (url, options) => {
      requests.push({ url: String(url), ...options });
      const route = new URL(url).pathname;
      assert.notEqual(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      if (route === '/v1/models') return Response.json({ data: models.map((id) => ({ id })) });
      if (route === '/_omp/status') return status === null ? new Response(null, { status: 404 }) : Response.json(status);
      throw new Error('unexpected fixture request');
    },
    exec: async (file, args, { cwd, input } = {}) => {
      if (file === 'git') return args.includes('--show-toplevel') ? `${cwd}\n` : '';
      const action = args.at(-1);
      const { payload } = JSON.parse(input);
      calls.push({ action, payload });
      return JSON.stringify(action === 'catalog' ? catalog : action === 'exchange'
        ? { record: `apps/web/src/content/${payload.argv[0] === 'review' ? 'reviews/study--me--2026-11-23' : 'findings/study'}.json`, sha256: 'b'.repeat(64) }
        : { records: [`apps/web/src/content/evals/${result}.json`], n: 50 });
    },
  };
  return { ctx, catalog, calls, requests, models(value) { models = value; }, status(value) { status = value; } };
}

test('run previews the exact scoped model, hardware and time without invoking the runner', async (t) => {
  const { ctx, calls, requests } = await fixture(t);
  const output = await run(ctx, { args: ['study'], flags });
  assert.equal(output.status, 'preview');
  assert.equal(output.ownerCheck, 'ready');
  assert.equal(output.setup.hardware.device, 'Desk PC');
  assert.equal(output.maxSeconds, 120);
  assert.equal(output.siteSha, sha);
  assert.match(output.help.join('\n'), /run study.*--max-seconds 120/);
  assert.doesNotMatch(output.help[0], /--confirm/);
  assert.match(output.approval, /--confirm only after the owner approves/);
  assert.deepEqual(calls.map(({ action }) => action), ['catalog']);
  assert.equal(requests.length, 2);
});

test('run rejects noninteger time and wrong served-model assertions before probing', async (t) => {
  const { ctx, requests } = await fixture(t);
  for (const value of ['1.5', '0', '-5', 'Infinity', '1e3']) {
    await assert.rejects(run(ctx, { args: ['study'], flags: { ...flags, 'max-seconds': value } }), /positive integer/);
  }
  await assert.rejects(run(ctx, { args: ['study'], flags: { ...flags, 'served-model': 'different' } }), /loaded model/);
  assert.equal(requests.length, 0);
});

test('confirmation cannot invoke eval on an unmanaged ambiguous server or a busy managed server', async (t) => {
  const { ctx, calls, models, status } = await fixture(t);
  models(['checkpoint', 'other-checkpoint']);
  await assert.rejects(run(ctx, { args: ['study'], flags: { ...flags, confirm: true } }), /model_unverified/);
  status({ version: 1, model: 'checkpoint', active_requests: 2 });
  await assert.rejects(run(ctx, { args: ['study'], flags: { ...flags, confirm: true } }), /busy/);
  assert.ok(calls.every(({ action }) => action === 'catalog'));
});

test('confirmed execution passes only configured local details and authenticated identity to the bridge', async (t) => {
  const { ctx, calls } = await fixture(t);
  const output = await run(ctx, { args: ['study'], flags: { ...flags, confirm: true } });
  assert.equal(output.siteSha, sha);
  const { action, payload } = calls.at(-1);
  assert.equal(action, 'eval');
  assert.equal(payload.submitter, 'me');
  assert.equal(payload.model, 'alpha');
  assert.equal(payload.maxSeconds, 120);
  assert.equal(payload.siteSha, sha);
  assert.deepEqual(payload.server, server);
});

test('replication pins exact method and checkpoint but reports own independent runtime/hardware', async (t) => {
  const { ctx, catalog, calls } = await fixture(t);
  const local = { server: 'desk', 'max-seconds': '120', confirm: true };
  const output = await replicate(ctx, { args: [result], flags: local });
  assert.equal(output.reference.result, result);
  assert.equal(output.reference.setup.runtime, 'llama.cpp');
  assert.equal(output.setup.runtime, 'ollama');
  assert.equal(output.setup.hardware.device, 'Desk PC');
  assert.equal(calls.at(-1).payload.model, 'alpha');
  catalog.results[0].n -= 1;
  await assert.rejects(replicate(ctx, { args: [result], flags: local }), /workload|method/i);
  catalog.results[0].n += 1;
  catalog.results[0].repeat.runs += 1;
  await assert.rejects(replicate(ctx, { args: [result], flags: local }), /workload|method/i);
  catalog.results[0].repeat.runs -= 1;
  catalog.results[0].run.submitter = 'me';
  await assert.rejects(replicate(ctx, { args: [result], flags: local }), /own|same/i);
});

test('finding and exact-byte review use the site authoring path and disclose actual provenance', async (t) => {
  const { ctx, calls } = await fixture(t);
  const candidate = 'beta--study--peer--2026-11-01--12345678';
  const findingFlags = { ...agent, id: 'study', hypothesis: 'claim', results: `${result},${candidate}`, verdict: 'inconclusive',
    summary: 'Measured evidence.', limitations: 'Model family not isolated.', incumbent: result, candidate, supersedes: 'older-study' };
  const found = await findingDraft(ctx, { args: [], flags: findingFlags });
  assert.match(found.record, /findings\/study\.json$/);
  const expected = 'a'.repeat(64);
  const reviewed = await review(ctx, { args: ['study'], flags: { ...agent, verdict: 'needs-work', checks: 'read-results', notes: 'Not enough evidence.', 'finding-sha256': expected } });
  assert.match(reviewed.record, /reviews\/study--me--2026-11-23\.json$/);
  assert.equal(reviewed.siteSha, sha);
  assert.deepEqual(calls.map(({ action }) => action), ['exchange', 'exchange']);
  const form = (argv) => Object.fromEntries(argv.slice(1).flatMap((flag, i) => i % 2 === 0 ? [[flag, argv[i + 2]]] : []));
  assert.equal(form(calls[0].payload.argv)['--author'], 'me');
  assert.equal(form(calls[1].payload.argv)['--reviewer'], 'me');
  assert.equal(form(calls[1].payload.argv)['--finding-sha256'], expected);
  assert.equal(form(calls[0].payload.argv)['--agent-harness'], 'harness-a');
  assert.equal(form(calls[0].payload.argv)['--supersedes'], 'older-study');
  assert.equal(form(calls[0].payload.argv)['--candidate'], candidate);
  assert.equal(form(calls[1].payload.argv)['--agent-model'], 'model-a');
});

test('record commands fail closed on malformed evidence references or missing inspected hash', async (t) => {
  const { ctx, calls } = await fixture(t);
  await assert.rejects(findingDraft(ctx, { args: [], flags: { ...agent, id: 'study', hypothesis: 'claim', results: '../result' } }), /--results/);
  await assert.rejects(review(ctx, { args: ['study'], flags: { ...agent, verdict: 'reject', notes: 'Observed.', checks: 'read-results' } }), /--finding-sha256/);
  assert.equal(calls.length, 0);
});
