import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { probeServer } from './discovery.mjs';
import { isId, isResultId, localEndpoint } from './shared.mjs';

const CONTENT = 'apps/web/src/content';
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const PIN = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// The package bridge is static; canonical implementation files resolve under the user's pinned site.
const readSite = (site: string, path: string) => import(pathToFileURL(join(site, path)).href);
const safeLine = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 240);
const diagnostics = (values: string[]) => values.slice(0, 12).map(safeLine);
const optionalStat = async (path: string) => lstat(path).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});

class BridgeError extends Error {}

interface EvalRow {
  benchmark: string;
  benchmark_version: string;
  model: string;
  n: number;
  run: { date: string; submitter: string; harness: { name: string; version: string } };
  setup: { runtime: string; runtime_version: string; served_model?: string; format: string; quantization: string; hardware: object };
  api?: { provider: string; model_card?: string };
  repeat?: { runs: number; temperature: number; top_p: number };
}
interface BenchmarkRow {
  version: string;
  scoring: string;
  items: number;
  repeat?: EvalRow['repeat'];
}
interface Server {
  id: string;
  base_url: string;
  loaded_model: string;
  runtime: string;
  runtime_version: string;
  format: string;
  quantization: string;
  device: string;
  accelerator: string;
  memory_gb: number;
  notes?: string;
}
interface EvalPayload {
  benchmark: string;
  model: string;
  maxSeconds: number;
  submitter: string;
  siteSha: string;
  server: Server;
}

async function catalog(site: string, root: string, drafts: string[]) {
  const [{ validateEvals }, { buildExchangeFeeds }, { readExchangeRecords }, { baselineSchema }, { SUITES }, { buildReplicationIndex }] = await Promise.all([
    readSite(site, 'packages/core/src/validate-evals.ts'),
    readSite(site, 'packages/core/src/exchange.ts'),
    readSite(site, 'packages/core/src/read-exchange.ts'),
    readSite(site, 'packages/schema/src/index.ts'),
    readSite(site, 'apps/cli/src/eval/suites.ts'),
    readSite(site, 'packages/core/src/replication.ts'),
  ]);
  const errors: string[] = [], warnings: string[] = [];
  const checked = await validateEvals(root, errors, warnings);
  const { records, errors: exchangeErrors } = await readExchangeRecords(root);
  const localPaths = new Set(drafts.map((path) => path.slice(CONTENT.length + 1)));
  checked.results = new Map([...checked.results as Map<string, EvalRow>].filter(([id]) => !localPaths.has(`evals/${id}.json`)));
  for (const [kind, extension] of [['hypotheses', 'md'], ['findings', 'json'], ['reviews', 'json']]) {
    records[kind] = records[kind].filter(({ id }: { id: string }) => !localPaths.has(`${kind}/${id}.${extension}`));
  }
  if (errors.length || exchangeErrors.length) throw new BridgeError('The managed site content did not pass the pinned site gate');
  const { structure: exchange } = buildExchangeFeeds(records, checked);
  const benchmarks = Array.from(checked.benchmarks as Map<string, BenchmarkRow>, ([id, b]) => ({
    id, version: b.version, scoring: b.scoring, items: b.items, repeat: b.repeat ?? null, runnable: Object.hasOwn(SUITES, id),
  }));
  const results = Array.from(checked.results as Map<string, EvalRow>, ([id, run]) => ({
    ...run, id,
    run: { date: run.run.date, submitter: run.run.submitter, harness: run.run.harness },
    setup: { runtime: run.setup.runtime, runtime_version: run.setup.runtime_version, served_model: run.setup.served_model,
      format: run.setup.format, quantization: run.setup.quantization, hardware: run.setup.hardware },
    ...(run.api === undefined ? {} : { api: { provider: run.api.provider, model_card: run.api.model_card } }),
  }));
  const byId = new Map(results.map((row) => [row.id, row]));
  const replications = Array.from(buildReplicationIndex(results) as Map<string, object>, ([result, evidence]) => {
    const run = byId.get(result)!;
    const { benchmark, benchmark_version, model, n, setup, api } = run;
    const { runs, temperature, top_p } = run.repeat!;
    return { result, benchmark, benchmark_version, model, n, setup, api, submitter: run.run.submitter,
      repeat_method: { runs, temperature, top_p }, href: `/evals/${benchmark}#run-${result}`, ...evidence };
  });
  const dir = join(root, 'baselines');
  const files = (await readdir(dir).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [] as string[];
  })).filter((file) => file.endsWith('.md')).sort();
  const baselines = await Promise.all(files.map(async (file) => {
    const text = await readFile(join(dir, file), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const row = baselineSchema.parse(Bun.YAML.parse(fm?.[1] ?? ''));
    return { benchmark: row.benchmark, benchmark_version: row.benchmark_version, entries:
      row.entries.map(({ withdrawal, ...entry }: { withdrawal?: { date: string }; [key: string]: unknown }) =>
        ({ ...entry, ...(withdrawal ? { withdrawal: { date: withdrawal.date } } : {}) })) };
  }));
  return { baselines, benchmarks, models: [...checked.models].sort(), results, replications, exchange };
}

async function validate(site: string, root: string, records: unknown) {
  const { validateContent } = await readSite(site, 'packages/core/src/validate.ts');
  if (!isAbsolute(root) || !(await lstat(root)).isDirectory()) throw new BridgeError('Content root must be an absolute, real directory');
  const { errors, warnings } = await validateContent(root);
  const reply = { errors: diagnostics(errors), warnings: diagnostics(warnings) };
  if (records === undefined || errors.length) return reply;
  if (!Array.isArray(records) || records.length > 10) throw new BridgeError('Unsupported record identity request');
  const [{ validateEvals }, { readExchangeRecords }] = await Promise.all([
    readSite(site, 'packages/core/src/validate-evals.ts'), readSite(site, 'packages/core/src/read-exchange.ts'),
  ]);
  const [evals, exchange] = await Promise.all([validateEvals(root, [], []), readExchangeRecords(root)]);
  return { ...reply, identities: records.map((path) => {
    if (typeof path !== 'string') return null;
    const match = /^(evals|hypotheses|findings|reviews)\/([a-z0-9-]+)\.(json|md)$/.exec(path);
    if (!match) return null;
    const [, kind, id, extension] = match;
    if (extension !== (kind === 'hypotheses' ? 'md' : 'json')) return null;
    if (kind === 'evals') return evals.results.get(id)?.run.submitter ?? null;
    const record = exchange.records[kind].find((entry: { id: string }) => entry.id === id);
    return (kind === 'reviews' ? record?.data.reviewer : record?.data.author) ?? null;
  }) };
}

async function exchange(site: string, argv: unknown) {
  if (!Array.isArray(argv) || !['new-finding', 'review'].includes(argv[0]) || argv.length > 27
    || argv.some((arg, i) => typeof arg !== 'string' || (i % 2 === 1 && arg === '--content-dir'))) {
    throw new BridgeError('Unsupported exchange authoring payload');
  }
  const { runExchange } = await readSite(site, 'apps/cli/src/exchange.ts');
  try {
    const { path, id, sha256 } = await runExchange(argv, site);
    return { record: relative(site, path), id, sha256 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new BridgeError('The exchange record already exists; it was not overwritten');
    throw new BridgeError(`Site exchange rejected the record: ${safeLine((error as Error).message)}`);
  }
}

function protectFetch(server: Server, sourceUrls: Set<string>, maxSeconds: number) {
  const fetcher = globalThis.fetch.bind(globalThis);
  const base = new URL(server.base_url).href;
  const models = `${base}/models`;
  const status = `${base.slice(0, -3)}/_omp/status`;
  const completions = `${base}/chat/completions`;
  const stopAt = performance.now() + maxSeconds * 1000;
  const remaining = () => stopAt - performance.now();
  const request = async (url: string | URL, init: RequestInit = {}) => {
    const remainingMs = remaining();
    if (remainingMs <= 0) throw new BridgeError('The run time limit has expired');
    const timer = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(2_147_483_647, remainingMs))));
    const signal = init.signal ? AbortSignal.any([timer, init.signal]) : timer;
    const headers = new Headers(init.headers);
    if (headers.has('authorization') || headers.has('cookie') || headers.has('proxy-authorization')) throw new BridgeError('Credentials are forbidden in local benchmark requests');
    return fetcher(url, { ...init, headers, credentials: 'omit', signal, redirect: 'error' });
  };
  const probeFetch = (url: string | URL, init?: RequestInit) => {
    if (![models, status].includes(new URL(url).href) || (init?.method ?? 'GET') !== 'GET') throw new BridgeError('Unexpected local probe route');
    return request(url, init);
  };
  return {
    hasTime: () => remaining() > 0,
    async ready() {
      const probe = await probeServer(server, probeFetch);
      if (probe.status !== 'ready') throw new BridgeError(`Local server is not ready (${probe.status}); no completion request sent`);
    },
    async fetch(input: string | URL, init: RequestInit = {}) {
      const url = new URL(input).href;
      const method = init.method ?? 'GET';
      if (method === 'GET' && (url === models || url === status || sourceUrls.has(url))) return request(input, init);
      if (method !== 'POST' || url !== completions || typeof init.body !== 'string') throw new BridgeError('Unexpected request from the pinned evaluation runner');
      const body = JSON.parse(init.body);
      if (body.model !== server.loaded_model || Object.hasOwn(body, 'tools') || Object.hasOwn(body, 'functions')) {
        throw new BridgeError('Completion would change the loaded model or enable real tools');
      }
      await this.ready();
      const response = await request(input, init);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return new Response(null, { status: response.status });
      }
      return response;
    },
  };
}

async function storePin(workDir: string, siteSha: string) {
  const pinFile = join(workDir, 'pin.json');
  const bytes = `${JSON.stringify({ siteSha })}\n`;
  try { await writeFile(pinFile, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await lstat(pinFile);
    if (!info.isFile() || info.nlink !== 1 || info.size !== Buffer.byteLength(bytes) || await readFile(pinFile, 'utf8') !== bytes) {
      throw new BridgeError('Run transcript directory has unexpected site pin data');
    }
  }
}

async function publishEvals(site: string, stagedRoot: string, paths: string[]) {
  const prepared = [];
  for (const path of paths) {
    const filename = relative(join(stagedRoot, 'evals'), path);
    if (!filename.endsWith('.json') || !isResultId(filename.slice(0, -5))) throw new BridgeError('The evaluation runner returned an unexpected record path');
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024) throw new BridgeError('Evaluation output must be a new regular result file');
    const bytes = await readFile(path);
    const record = `${CONTENT}/evals/${filename}`;
    const target = join(site, record);
    const existing = await optionalStat(target);
    if (existing && (!existing.isFile() || existing.nlink !== 1 || existing.size !== bytes.length || !bytes.equals(await readFile(target)))) {
      throw new BridgeError('An existing evaluation record differs; it was not overwritten');
    }
    prepared.push({ target, bytes, record, existing });
  }
  await mkdir(join(site, CONTENT, 'evals'), { recursive: true });
  for (const { target, bytes, existing } of prepared) {
    if (!existing) await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  return prepared.map(({ record }) => record);
}

async function evaluate(site: string, root: string, payload: EvalPayload) {
  const { benchmark, model, maxSeconds, submitter, siteSha, server } = payload;
  if (!isId(benchmark) || !isId(model) || typeof submitter !== 'string' || !LOGIN.test(submitter)
    || typeof siteSha !== 'string' || !PIN.test(siteSha) || !Number.isSafeInteger(maxSeconds) || maxSeconds <= 0
    || !localEndpoint(server?.base_url) || server.runtime === 'api') throw new BridgeError('Unsupported local evaluation payload');
  const [{ runEval }, { parseEvalArgs }, { SUITES }, { benchmarkSchema }] = await Promise.all([
    readSite(site, 'apps/cli/src/eval/run.ts'), readSite(site, 'apps/cli/src/eval/args.ts'),
    readSite(site, 'apps/cli/src/eval/suites.ts'), readSite(site, 'packages/schema/src/index.ts'),
  ]);
  if (!Object.hasOwn(SUITES, benchmark)) throw new BridgeError('That benchmark cannot be run at the site pin');
  const suite = SUITES[benchmark];
  const definitionBytes = await readFile(join(root, 'benchmarks', `${benchmark}.md`), 'utf8');
  const definition = benchmarkSchema.parse(Bun.YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(definitionBytes)?.[1] ?? ''));
  const allowedUrls = new Set<string>();
  for (const [url, sha] of [[definition.source_url, definition.source_sha256], [suite.answers?.url, suite.answers?.sha256]]) {
    if (url === undefined) continue;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || !DIGEST.test(sha ?? '')) {
      throw new BridgeError('The pinned benchmark is missing a safe hash-checked source');
    }
    allowedUrls.add(parsed.href);
  }
  const { id: _id, ...setup } = server;
  const runKey = hash(JSON.stringify({ siteSha, benchmark, model, submitter, setup }));
  const workDir = join(site, '.agent/evals', runKey);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  if (!(await lstat(workDir)).isDirectory()) throw new BridgeError('Run transcript directory must be a real directory');
  await storePin(workDir, siteSha);
  const argv = [
    '--benchmark', benchmark, '--model', model, '--submitter', submitter,
    '--served-model', server.loaded_model, '--base-url', server.base_url, '--runtime', server.runtime,
    '--runtime-version', server.runtime_version, '--format', server.format, '--quantization', server.quantization,
    '--device', server.device, '--accelerator', server.accelerator, '--memory-gb', String(server.memory_gb),
    '--max-seconds', String(maxSeconds), ...(server.notes === undefined ? [] : ['--notes', server.notes]),
  ];
  let options;
  try { options = parseEvalArgs(argv, { root: site, env: {} }); }
  catch (error) { throw new BridgeError(`Site runner rejected the configured setup: ${safeLine((error as Error).message)}`); }
  const stage = await mkdtemp(join(site, '..', '.eval-stage-'));
  try {
    // Isolate the runner's ordinary overwrite behavior. Validate its exact output before admitting any record.
    const stagedRoot = join(stage, 'content');
    await cp(root, stagedRoot, { recursive: true, errorOnExist: true, force: false });
    const sourceFile = suite.localSource === undefined ? undefined : resolve(root, suite.localSource);
    const guard = protectFetch(server, allowedUrls, maxSeconds);
    await guard.ready();
    const originalFetch = globalThis.fetch;
    let outcome;
    const logs: string[] = [];
    try {
      globalThis.fetch = guard.fetch.bind(guard) as typeof fetch;
      outcome = await runEval({ ...options, contentRoot: stagedRoot, workDir, sourceFile,
        log: (line: string) => { if (logs.length === 12) logs.shift(); logs.push(safeLine(line).replace(workDir, '.agent/evals/' + runKey)); },
      });
    } catch (error) {
      if (!guard.hasTime()) throw new BridgeError('Time limit reached; the partial transcript is local and the same command can resume it');
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('The pinned evaluation did not complete; any partial transcript stayed local');
    } finally {
      globalThis.fetch = originalFetch;
    }
    const paths = [outcome.resultPath, ...(outcome.speedResultPath ? [outcome.speedResultPath] : [])];
    const checked = await validate(site, stagedRoot, undefined);
    if (checked.errors.length) throw new BridgeError(`Completed results failed the pinned site gate: ${checked.errors.join('; ').slice(0, 900)}`);
    const transcript = await lstat(outcome.transcriptPath);
    const transcriptName = relative(workDir, outcome.transcriptPath);
    if (!transcript.isFile() || transcript.nlink !== 1 || !/^[a-z0-9-]+--[a-f0-9]{8}\.jsonl$/.test(transcriptName)) {
      throw new BridgeError('The evaluation runner returned an unexpected transcript');
    }
    const records = await publishEvals(site, stagedRoot, paths);
    return { records, transcript: relative(site, outcome.transcriptPath), score: outcome.score, correct: outcome.correct,
      n: outcome.n, runs: outcome.runs, logs };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

try {
  const { siteRoot, payload } = JSON.parse(await Bun.stdin.text());
  if (await realpath(siteRoot) !== process.cwd()) throw new BridgeError('Bridge working directory is not the managed site');
  const action = process.argv[2];
  const root = join(siteRoot, CONTENT);
  let output;
  if (action === 'catalog') output = await catalog(siteRoot, root, payload.drafts);
  else if (action === 'validate') output = await validate(siteRoot, payload.contentRoot ?? root, payload.records);
  else if (action === 'eval') output = await evaluate(siteRoot, root, payload);
  else if (action === 'exchange') output = await exchange(siteRoot, payload.argv);
  else throw new BridgeError('Unsupported site bridge action');
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  process.stdout.write(JSON.stringify({ failure: error instanceof BridgeError ? error.message : 'The pinned site bridge failed to process this action' }));
}
