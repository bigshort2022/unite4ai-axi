import { probeServer } from './discovery.mjs';
import { ACCELERATORS, FORMATS, RUNTIMES, UsageError, isId, isResultId, localEndpoint } from './shared.mjs';
import { runBridge } from './workspace.mjs';

const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVIEW_CHECKS = new Set(['reran', 'read-transcript', 'read-results', 'read-page-only']);

function requireValue(flag, value, check) {
  if (!check(value)) throw new UsageError(`Invalid or missing --${flag}`);
  return value;
}

async function identity(ctx) {
  const login = await ctx.login();
  if (typeof login !== 'string' || !LOGIN.test(login)) throw new Error('Authenticate to GitHub as the contributor before authoring evidence (gh auth login)');
  return login;
}

function text(value, limit, oneLine = false) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= limit && !value.startsWith('--')
    && !/[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(value)
    && !(oneLine && value.includes('\n')) && !/<[^>]*>|!?\[[\s\S]*?\]\s*(?:\(|\[|:)/u.test(value);
}

function runScope(ctx, flags) {
  const requestedId = requireValue('server', flags.server, isId);
  const server = ctx.config.servers.find(({ id }) => id === requestedId);
  if (!server || !localEndpoint(server.base_url)) throw new UsageError('--server must name an owner-configured loopback endpoint');
  const seconds = flags['max-seconds'];
  const maxSeconds = Number(seconds);
  if (typeof seconds !== 'string' || !/^\d+$/.test(seconds) || !Number.isSafeInteger(maxSeconds) || maxSeconds <= 0) {
    throw new UsageError('--max-seconds must be a positive integer');
  }
  if (flags['served-model'] !== undefined && flags['served-model'] !== server.loaded_model) {
    throw new UsageError('--served-model must exactly match the configured loaded model');
  }
  const line = (s, max) => typeof s === 'string' && s.trim() !== '' && s.length <= max && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s);
  if (server.runtime === 'api' || !RUNTIMES.includes(server.runtime) || !FORMATS.includes(server.format) || !ACCELERATORS.includes(server.accelerator)
    || !line(server.loaded_model, 300) || !line(server.runtime_version, 100) || !line(server.quantization, 100)
    || !line(server.device, 200) || !Number.isFinite(server.memory_gb) || server.memory_gb <= 0
    || (server.notes !== undefined && !line(server.notes, 200))) {
    throw new UsageError('Configure the server’s exact runtime, version, checkpoint format, quantization and machine before running');
  }
  return { maxSeconds, server };
}

async function evaluate(ctx, { benchmark, model, submitter, server, maxSeconds, confirm, siteSha, reference }) {
  const { status: ownerCheck } = await probeServer(server, ctx.fetch ?? fetch);
  const command = reference ? `replicate ${reference.result}` : `run ${benchmark.id} --model ${model}`;
  const invocation = `unite4ai-axi ${command} --server ${server.id} --max-seconds ${maxSeconds}`;
  const help = [invocation, `unite4ai-axi ${reference ? 'replicate' : 'run'} --help`];
  const details = {
    siteSha, benchmark: benchmark.id, benchmarkVersion: benchmark.version, model, submitter,
    items: benchmark.items, runs: benchmark.repeat?.runs ?? 1, maxSeconds,
    server: server.id, ownerCheck,
    setup: { served_model: server.loaded_model, format: server.format, quantization: server.quantization,
      runtime: server.runtime, runtime_version: server.runtime_version,
      hardware: { device: server.device, accelerator: server.accelerator, memory_gb: server.memory_gb } },
    ...(reference === undefined ? {} : { reference }),
  };
  if (!confirm) return { status: 'preview', ...details, approval: 'Append --confirm only after the owner approves this machine, workload and time budget.', help };
  if (ownerCheck !== 'ready') throw new Error(`Configured local server is not ready (${ownerCheck}); no inference requested`);
  const evidence = await runBridge(ctx, 'eval', { benchmark: benchmark.id, model, submitter, server, maxSeconds });
  const records = evidence.records ?? [];
  return { status: 'complete', ...details, ...evidence, help: [
    `unite4ai-axi submit ${records.map((record) => `--record ${record}`).join(' ')}`,
    'unite4ai-axi next --kind baseline',
  ] };
}

export async function run(ctx, { args: [benchmarkId], flags }) {
  if (!isId(benchmarkId)) throw new UsageError('Benchmark must be an exact lowercase site benchmark ID');
  const model = requireValue('model', flags.model, isId);
  const scope = runScope(ctx, flags);
  const catalog = await runBridge(ctx, 'catalog');
  const benchmark = catalog.benchmarks.find(({ id }) => id === benchmarkId);
  if (!benchmark?.runnable) throw new UsageError('That benchmark has no runnable suite at the managed site pin');
  if (!catalog.models.includes(model)) throw new UsageError('--model must name a model card at the managed site pin');
  const submitter = await identity(ctx);
  return evaluate(ctx, { benchmark, model, submitter, ...scope, siteSha: catalog.siteSha, confirm: flags.confirm === true });
}

export async function replicate(ctx, { args: [result], flags }) {
  if (!isResultId(result)) throw new UsageError('Replication requires the full result filename ID without .json');
  const scope = runScope(ctx, flags);
  const catalog = await runBridge(ctx, 'catalog');
  const row = catalog.results.find(({ id }) => id === result);
  if (!row || row.setup.runtime === 'api' || !row.repeat) throw new UsageError('No matching local repeat result at the managed site pin');
  const submitter = await identity(ctx);
  if (row.run.submitter === submitter) throw new UsageError('Cannot claim independent replication of your own result');
  const benchmark = catalog.benchmarks.find(({ id }) => id === row.benchmark);
  if (!benchmark?.runnable || !benchmark.repeat || benchmark.version !== row.benchmark_version || benchmark.items !== row.n
    || ['runs', 'temperature', 'top_p'].some((key) => benchmark.repeat[key] !== row.repeat[key])) {
    throw new UsageError('The reference workload, version or repeat method does not match the pinned current benchmark');
  }
  const { server } = scope;
  const { format, quantization, served_model } = row.setup;
  if (!served_model || server.loaded_model !== served_model || server.format !== format || server.quantization !== quantization) {
    throw new UsageError('Configured server does not match the reference’s exact checkpoint, format and quantization');
  }
  const reference = { result, submitter: row.run.submitter, setup: row.setup };
  return evaluate(ctx, { benchmark, model: row.model, submitter, reference, ...scope, siteSha: catalog.siteSha, confirm: flags.confirm === true });
}

function provenance(flags) {
  const date = requireValue('date', flags.date, (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && new Date(`${s}T00:00:00Z`).toJSON()?.slice(0, 10) === s);
  return { date, 'agent-model': requireValue('agent-model', flags['agent-model'], (s) => text(s, 100, true)),
    'agent-harness': requireValue('agent-harness', flags['agent-harness'], (s) => text(s, 100, true)) };
}

async function writeExchange(ctx, action, fields) {
  const argv = [action, ...Object.entries(fields).flatMap(([key, value]) => [`--${key}`, value])];
  const output = await runBridge(ctx, 'exchange', { argv });
  return { status: 'drafted', ...output, help: [`unite4ai-axi submit --record ${output.record}`, 'unite4ai-axi submit --help'] };
}

export async function findingDraft(ctx, { flags }) {
  const id = requireValue('id', flags.id, isId);
  const hypothesis = requireValue('hypothesis', flags.hypothesis, isId);
  const results = requireValue('results', flags.results, (s) => typeof s === 'string' && s.split(',').every(isResultId));
  const verdict = requireValue('verdict', flags.verdict, (s) => ['supports', 'refutes', 'inconclusive'].includes(s));
  const summary = requireValue('summary', flags.summary, (s) => text(s, 800));
  const limitations = requireValue('limitations', flags.limitations, (s) => text(s, 600));
  const authoring = provenance(flags);
  const optional = {};
  if (flags.supersedes !== undefined) optional.supersedes = requireValue('supersedes', flags.supersedes, isId);
  if (flags.incumbent !== undefined || flags.candidate !== undefined) {
    const namedResult = (s) => isResultId(s) && results.split(',').includes(s);
    optional.incumbent = requireValue('incumbent', flags.incumbent, namedResult);
    optional.candidate = requireValue('candidate', flags.candidate, namedResult);
    if (optional.incumbent === optional.candidate) throw new UsageError('--incumbent and --candidate must be different results');
  }
  const author = await identity(ctx);
  return writeExchange(ctx, 'new-finding', { id, hypothesis, results, verdict, summary, limitations,
    author, ...authoring, ...optional });
}

export async function review(ctx, { args: [finding], flags }) {
  if (!isId(finding)) throw new UsageError('Review requires the exact finding ID');
  const inspected = requireValue('finding-sha256', flags['finding-sha256'], (s) => typeof s === 'string' && SHA256.test(s));
  const verdict = requireValue('verdict', flags.verdict, (s) => ['accept', 'reject', 'needs-work'].includes(s));
  const checks = requireValue('checks', flags.checks, (s) => typeof s === 'string' && s.split(',').every((check) => REVIEW_CHECKS.has(check)));
  const notes = requireValue('notes', flags.notes, (s) => text(s, 600));
  const authoring = provenance(flags);
  const reviewer = await identity(ctx);
  return writeExchange(ctx, 'review', { finding, reviewer, verdict, checks, notes, 'finding-sha256': inspected, ...authoring });
}
