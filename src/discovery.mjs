import { ACCELERATORS, FORMATS, PUBLIC_RULES, RUNTIMES, SITE, UsageError, isId, isResultId, localEndpoint } from './shared.mjs';
import { runBridge } from './workspace.mjs';

const FEED_BYTES = 2 * 1024 * 1024;
const PROBE_BYTES = 128 * 1024;
const KINDS = ['baseline', 'replication', 'review'];
const DEFAULT_FIELDS = ['kind', 'id', 'benchmark', 'action', 'reason'];
const FIELDS = new Set([
  ...DEFAULT_FIELDS, 'benchmark_version', 'model', 'server', 'submitter', 'served_model',
  'runtime', 'format', 'quantization', 'device', 'accelerator', 'memory_gb', 'href', 'hypothesis',
  'finding_sha256', 'results', 'independent_replicators', 'contested',
]);
const SCORING = ['exact-match', 'multiple-choice', 'canary', 'measured'];
const RELATIONSHIPS = ['consistent', 'inconsistent', 'repeated_on_other_hardware'];
const STATES = ['unreviewed', 'accepted', 'rejected', 'disputed'];
const ROUTE_ABSENT = Symbol('route absent');
const C = 'unite4ai-axi';
const SETUP = `${C} setup workspace`;
const PUBLISH = `${C} submit --record <new-repository-path>`;
const runCommand = (benchmark, model, server = '<server>') => `${C} run ${benchmark} --model ${model} --server ${server} --max-seconds <seconds>`;
const replicateCommand = (result, server = '<server>') => `${C} replicate ${result} --server ${server} --max-seconds <seconds>`;

const obj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && value.trim().length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const id = (value) => line(value, 150) && isId(value);
const login = (value) => line(value, 39) && /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(value);
const date = (value) => typeof value === 'string' && value.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(value);
const hash = (value) => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
const resultId = (value) => line(value, 350) && isResultId(value);
const count = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const numberBetween = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const all = (value, match) => Array.isArray(value) && value.every(match);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function getJson(fetcher, url, maxBytes, timeout, { optional = false } = {}) {
  const signal = AbortSignal.timeout(timeout);
  const response = await fetcher(url, { method: 'GET', redirect: 'error', signal, headers: { accept: 'application/json' } });
  if (response.redirected || !response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    if (optional && !response.redirected && [404, 405, 501].includes(response.status)) return ROUTE_ABSENT;
    throw new Error('Response unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    let bytes = 0, text = '';
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('Response too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    abort();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/** A read-only readiness check over the two fixed routes of an owner-configured endpoint. */
export async function probeServer(server, fetcher = fetch) {
  const serverId = id(server?.id) ? server.id : null;
  const row = (status) => ({ id: serverId, status });
  const base = server?.base_url;
  const configuredModel = server?.loaded_model;
  if (!serverId || !line(base, 200) || !localEndpoint(base) || !line(configuredModel, 300)) return row('unconfigured');

  let listed;
  try {
    const response = await getJson(fetcher, `${base}/models`, PROBE_BYTES, 2_000);
    if (!obj(response) || !all(response.data, (model) => obj(model) && line(model.id, 300))) return row('unavailable');
    listed = new Set(response.data.map(({ id }) => id));
  } catch { return row('unavailable'); }
  if (!listed.has(configuredModel)) return row('model_mismatch');

  let status;
  try { status = await getJson(fetcher, `${base.slice(0, -3)}/_omp/status`, PROBE_BYTES, 2_000, { optional: true }); }
  catch { return row('model_unverified'); }
  if (status === ROUTE_ABSENT) return listed.size === 1 ? { ...row('ready'), loaded_model: configuredModel } : row('model_unverified');
  if (!obj(status) || status.version !== 1 || !line(status.model, 300) || !count(status.active_requests)) return row('model_unverified');
  if (status.model !== configuredModel) return row('model_mismatch');
  return { ...row(status.active_requests === 0 ? 'ready' : 'busy'), loaded_model: configuredModel, active_requests: status.active_requests };
}

const validHardware = (value) => obj(value) && line(value.device, 200) && ACCELERATORS.includes(value.accelerator)
  && Number.isFinite(value.memory_gb) && value.memory_gb > 0;
const validSetup = (value) => obj(value) && RUNTIMES.includes(value.runtime) && FORMATS.includes(value.format)
  && line(value.runtime_version, 100) && line(value.quantization, 100) && validHardware(value.hardware)
  && (value.served_model === undefined || line(value.served_model, 300));
const validMethod = (value) => obj(value) && count(value.runs, 2) && value.runs <= 20
  && numberBetween(value.temperature, 0, 2) && numberBetween(value.top_p, Number.MIN_VALUE, 1);
const validBenchmark = (value) => obj(value) && id(value.id) && line(value.version, 50) && SCORING.includes(value.scoring)
  && count(value.items, value.scoring === 'measured' ? 0 : 1) && (value.repeat == null || validMethod(value.repeat));
const modelCard = (value) => line(value, 500) && value.startsWith('https://') && URL.canParse(value);
const validApi = (value) => obj(value) && id(value.provider) && (value.model_card === undefined || modelCard(value.model_card));
const validRunRef = (value, model, benchmark, submitter) => resultId(value) && value.startsWith(`${model}--${benchmark}--${submitter}--`);
const validReplication = (value) => obj(value) && id(value.benchmark) && id(value.model) && login(value.submitter)
  && validRunRef(value.result, value.model, value.benchmark, value.submitter) && line(value.benchmark_version, 50)
  && count(value.n, 1) && validMethod(value.repeat_method) && validSetup(value.setup)
  && (value.setup.runtime === 'api' ? validApi(value.api) : value.api === undefined)
  && count(value.independent_replicators) && typeof value.contested === 'boolean'
  && all(value.peers, (peer) => obj(peer) && resultId(peer.result) && RELATIONSHIPS.includes(peer.relationship));
const validGroup = (value) => obj(value) && id(value.model) && id(value.benchmark) && line(value.benchmark_version, 50)
  && FORMATS.includes(value.format) && line(value.quantization, 100) && all(value.run_ids, (run) => resultId(run) && run.startsWith(`${value.model}--${value.benchmark}--`));
const validFinding = (value) => obj(value) && id(value.id) && login(value.author) && hash(value.sha256) && STATES.includes(value.state)
  && id(value.hypothesis) && all(value.superseded_by, id) && all(value.reviews, (review) => line(review, 350))
  && all(value.results, resultId) && value.results.length > 0;
const validReview = (value) => obj(value) && line(value.id, 350) && id(value.finding) && login(value.reviewer) && hash(value.finding_sha256);
const validHypothesis = (value) => obj(value) && id(value.id) && id(value.benchmark) && all(value.models, id) && login(value.author) && hash(value.sha256);
const validBaselineEntry = (value) => obj(value) && id(value.id) && id(value.model) && login(value.submitter)
  && line(value.served_model, 300) && RUNTIMES.includes(value.runtime) && FORMATS.includes(value.format)
  && line(value.quantization, 100) && validHardware(value.hardware) && date(value.registered_on)
  && (value.withdrawal === undefined || (obj(value.withdrawal) && date(value.withdrawal.date)))
  && (value.runtime === 'api' ? validApi(value) : value.provider === undefined && value.model_card === undefined);
const validManifest = (value) => obj(value) && id(value.benchmark) && line(value.benchmark_version, 50)
  && all(value.entries, validBaselineEntry) && value.entries.length >= 1 && value.entries.length <= 100;
const validRawResult = (value) => obj(value) && id(value.model) && id(value.benchmark) && line(value.benchmark_version, 50)
  && obj(value.run) && date(value.run.date) && login(value.run.submitter)
  && validRunRef(value.id, value.model, value.benchmark, value.run.submitter) && value.id.split('--')[3] === value.run.date
  && validSetup(value.setup) && (value.setup.runtime === 'api' ? validApi(value.api) : value.api === undefined);

function index(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const item = row[key];
    if (map.has(item)) return null;
    map.set(item, row);
  }
  return map;
}

function evalCatalog(value, source) {
  if (!obj(value) || !all(value.benchmarks, validBenchmark) || !all(value.replications, validReplication)) return null;
  if (source === 'public' && (value.schema_version !== 1 || !count(value.runs) || !all(value.groups, validGroup))) return null;
  const benchmarks = index(value.benchmarks, 'id');
  const replications = index(value.replications, 'result');
  return benchmarks && replications ? { source, benchmarks, replications, groups: source === 'public' ? value.groups : [] } : null;
}

function exchangeCatalog(value) {
  return obj(value) && value.schema_version === 1 && all(value.hypotheses, validHypothesis)
    && all(value.findings, validFinding) && all(value.reviews, validReview)
    && index(value.findings, 'id') && index(value.reviews, 'id') ? value : null;
}

async function feed(fetcher, name, parse) {
  try { return parse(await getJson(fetcher, `${SITE}/data/${name}.json`, FEED_BYTES, 3_000)); }
  catch { return null; }
}

async function bridgeCatalog(ctx) {
  try { return await (ctx.runBridge ?? runBridge)(ctx, 'catalog', {}); }
  catch { return null; }
}

const sameHardware = (a, b) => a.device === b.device && a.accelerator === b.accelerator && a.memory_gb === b.memory_gb;
const hardwareFields = ({ device, accelerator, memory_gb }) => ({ device, accelerator, memory_gb });
const sameMethod = (a, b) => a?.runs === b?.runs && a?.temperature === b?.temperature && a?.top_p === b?.top_p;
const sameApi = (a, b) => a?.provider === b?.provider && a?.model_card === b?.model_card;
const sameCohort = (a, b) => a.benchmark === b.benchmark && a.benchmark_version === b.benchmark_version
  && a.model === b.model && a.setup.format === b.setup.format && a.setup.quantization === b.setup.quantization
  && a.n === b.n && sameMethod(a.repeat_method, b.repeat_method) && sameApi(a.api, b.api)
  && (a.api === undefined || a.setup.served_model === b.setup.served_model);
const baselineSetupKey = (benchmark, version, model, submitter, { runtime, format, quantization, served_model, hardware }, api) => JSON.stringify([
  benchmark, version, model, submitter, runtime, format, quantization, served_model, api?.provider, api?.model_card,
  hardware.device, hardware.accelerator, hardware.memory_gb,
]);
const statusReason = {
  busy: 'configured_server_busy',
  model_mismatch: 'configured_model_mismatch',
  model_unverified: 'configured_model_unverified',
};

function chooseServer(servers, matches, missing) {
  let reason = missing;
  for (const { configured, probe } of servers) {
    if (!matches(configured)) continue;
    if (probe.status === 'ready') return { server: probe.id };
    if (reason === missing) reason = statusReason[probe.status] ?? 'configured_server_unavailable';
  }
  return { reason };
}

function baselinesFrom(catalog) {
  if (!obj(catalog) || !all(catalog.baselines, validManifest) || !all(catalog.results, validRawResult)
    || !all(catalog.benchmarks, validBenchmark)) return null;
  return index(catalog.results, 'id') && index(catalog.benchmarks, 'id') ? catalog : null;
}

const comparableKey = (item) => JSON.stringify([item.model, item.benchmark, item.benchmark_version, item.format, item.quantization]);

function baselineRows(catalog, evaluations, servers, identity) {
  const pinnedBenchmarks = index(catalog.benchmarks, 'id');
  const knownRuns = new Set(), latestMatches = new Map();
  const add = (result, benchmark, version, model, submitter, ranOn, setup, api) => {
    knownRuns.add(result);
    const key = baselineSetupKey(benchmark, version, model, submitter, setup, api);
    if (ranOn > (latestMatches.get(key) ?? '')) latestMatches.set(key, ranOn);
  };
  for (const { id, benchmark, benchmark_version, model, run, setup, api } of catalog.results) {
    add(id, benchmark, benchmark_version, model, run.submitter, run.date, setup, api);
  }
  if (evaluations?.source === 'public') {
    // Published repeat runs have exact per-run metadata; other runs are only in groups.
    for (const { result, benchmark, benchmark_version, model, submitter, setup, api } of evaluations.replications.values()) {
      add(result, benchmark, benchmark_version, model, submitter, result.split('--')[3], setup, api);
    }
  }
  const unknownGroups = new Map();
  for (const group of evaluations?.groups ?? []) {
    const key = comparableKey(group);
    for (const run of group.run_ids) {
      if (knownRuns.has(run)) continue;
      if (!unknownGroups.has(key)) unknownGroups.set(key, []);
      unknownGroups.get(key).push(run);
    }
  }

  const rows = [];
  for (const { benchmark, benchmark_version, entries } of catalog.baselines) {
    const current = evaluations?.benchmarks.get(benchmark) ?? pinnedBenchmarks.get(benchmark);
    for (const entry of entries) {
      const row = { kind: 'baseline', id: entry.id, benchmark, benchmark_version, model: entry.model,
        submitter: entry.submitter, served_model: entry.served_model, runtime: entry.runtime, format: entry.format,
        quantization: entry.quantization, ...hardwareFields(entry.hardware),
        href: `${SITE}/evals/${benchmark}#baseline-${encodeURIComponent(benchmark_version)}--${entry.id}` };
      if (entry.withdrawal) { rows.push({ ...row, reason: 'withdrawn' }); continue; }
      const key = baselineSetupKey(benchmark, benchmark_version, entry.model, entry.submitter, entry, entry);
      if (latestMatches.get(key) >= entry.registered_on) continue;
      let reason;
      if (!current) reason = 'benchmark_definition_unavailable';
      else if (current.version !== benchmark_version) reason = 'benchmark_version_mismatch';
      else if (entry.runtime === 'api') reason = 'paid_run_unsupported';
      else if (!identity) reason = 'github_login_required';
      else if (entry.submitter !== identity) reason = 'registered_to_another_submitter';
      else if (unknownGroups.get(comparableKey(row))?.some((candidate) => {
        const [, , submitter, ranOn] = candidate.split('--');
        return submitter === entry.submitter && ranOn >= entry.registered_on;
      })) reason = 'baseline_result_details_unavailable';
      if (reason) { rows.push({ ...row, reason }); continue; }
      const selected = chooseServer(servers, (s) => s.loaded_model === entry.served_model && s.runtime === entry.runtime
        && s.format === entry.format && s.quantization === entry.quantization && sameHardware(s, entry.hardware), 'exact_setup_unavailable');
      rows.push({ ...row, ...selected, ...(selected.server ? { action: runCommand(benchmark, entry.model, selected.server) } : {}) });
    }
  }
  return rows;
}

function replicationRows(evaluations, servers, identity) {
  const rows = [];
  for (const row of evaluations.replications.values()) {
    const { result, benchmark, benchmark_version, model, submitter, setup, n, repeat_method, independent_replicators, contested } = row;
    if (identity === submitter) continue;
    let invalidPeer = false, alreadyReplicated = false;
    for (const peer of row.peers) {
      const reference = evaluations.replications.get(peer.result);
      if (!reference || reference === row || !sameCohort(row, reference)) invalidPeer = true;
      else if (peer.relationship === 'consistent' && reference.submitter === identity) alreadyReplicated = true;
    }
    if (alreadyReplicated) continue;
    const current = evaluations.benchmarks.get(benchmark);
    const work = { kind: 'replication', id: result, benchmark, benchmark_version, model, submitter,
      served_model: setup.served_model, runtime: setup.runtime, format: setup.format, quantization: setup.quantization,
      ...hardwareFields(setup.hardware), independent_replicators, contested, href: `${SITE}/evals/${benchmark}#run-${result}` };
    let reason;
    if (!current) reason = 'benchmark_definition_unavailable';
    else if (current.version !== benchmark_version) reason = 'benchmark_version_mismatch';
    else if (current.scoring === 'measured' || n !== current.items || !sameMethod(current.repeat, repeat_method) || invalidPeer) reason = 'workload_reference_mismatch';
    else if (!identity) reason = 'github_login_required';
    else if (setup.runtime === 'api') reason = 'paid_run_unsupported';
    else if (!setup.served_model) reason = 'served_model_not_recorded';
    if (reason) { rows.push({ ...work, reason }); continue; }
    const selected = chooseServer(servers, (s) => s.runtime !== 'api' && s.loaded_model === setup.served_model
      && s.format === setup.format && s.quantization === setup.quantization, 'available_model_required');
    rows.push({ ...work, ...selected, ...(selected.server ? { action: replicateCommand(result, selected.server) } : {}) });
  }
  return rows;
}

function reviewRows(exchange, identity) {
  const reviewed = new Set(exchange.reviews.filter((review) => review.reviewer === identity).map((review) => review.finding));
  return exchange.findings.filter((finding) => finding.author !== identity && finding.state === 'unreviewed'
    && finding.superseded_by.length === 0 && !reviewed.has(finding.id))
    .map((finding) => ({ kind: 'review', id: finding.id, submitter: finding.author, hypothesis: finding.hypothesis,
      href: `${SITE}/exchange/findings/${finding.id}`, finding_sha256: finding.sha256, results: finding.results,
      ...(identity ? { action: `${C} prompt /exchange/findings/${finding.id} --full` } : { reason: 'github_login_required' }) }));
}

function options(flags) {
  const { kind, limit = '10', fields, full = false } = flags;
  if (kind !== undefined && !KINDS.includes(kind)) throw new UsageError('--kind must be baseline, replication, or review');
  const size = Number(limit);
  if (String(size) !== String(limit) || !count(size, 1) || size > 100) throw new UsageError('--limit must be an integer from 1 to 100');
  const selected = fields === undefined ? full ? FIELDS : DEFAULT_FIELDS : new Set(fields.split(',').map((value) => value.trim()));
  if ([...selected].some((field) => !FIELDS.has(field))) throw new UsageError(`--fields accepts: ${[...FIELDS].join(', ')}`);
  return { kind, limit: size, fields: [...selected] };
}

async function discover(ctx, { kind, limit, fields }) {
  const fetcher = ctx.fetch ?? fetch;
  const want = (item) => kind === undefined || kind === item;
  const needsEvals = want('baseline') || want('replication');
  const getIdentity = Promise.resolve().then(() => ctx.login()).then((value) => login(value) ? value : null, () => null);
  const getServers = needsEvals ? Promise.all(ctx.config.servers.map(async (configured) => ({ configured, probe: await probeServer(configured, fetcher) }))) : [];
  const [publicEvals, publicExchange, baselineCatalog] = await Promise.all([
    needsEvals ? feed(fetcher, 'evals', (value) => evalCatalog(value, 'public')) : null,
    want('review') ? feed(fetcher, 'exchange', exchangeCatalog) : null,
    want('baseline') ? bridgeCatalog(ctx) : null,
  ]);
  const pinned = want('baseline') ? baselineCatalog
    : (needsEvals && !publicEvals) || (want('review') && !publicExchange) ? await bridgeCatalog(ctx) : null;
  const evaluations = needsEvals ? publicEvals ?? evalCatalog(pinned, 'pinned') : null;
  const exchange = want('review') ? publicExchange ?? exchangeCatalog(pinned?.exchange) : null;
  const baselines = want('baseline') ? baselinesFrom(pinned) : null;
  const [identity, servers] = await Promise.all([getIdentity, getServers]);
  const rows = [
    ...(baselines ? baselineRows(baselines, evaluations, servers, identity) : []),
    ...(want('replication') && evaluations ? replicationRows(evaluations, servers, identity) : []),
    ...(exchange ? reviewRows(exchange, identity) : []),
  ];
  rows.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || order(a.benchmark ?? '', b.benchmark ?? '') || order(a.id, b.id));
  const sources = {
    ...(want('baseline') ? { baselines: baselines ? 'pinned' : 'unavailable' } : {}),
    ...(needsEvals ? { evals: evaluations?.source ?? 'unavailable' } : {}),
    ...(want('review') ? { exchange: publicExchange ? 'public' : exchange ? 'pinned' : 'unavailable' } : {}),
  };
  const totals = { ready: 0, blocked: 0, withdrawn: 0 };
  const work = [], blocked = [], withdrawn = [];
  for (const row of rows) {
    const state = row.reason === 'withdrawn' ? 'withdrawn' : row.reason ? 'blocked' : 'ready';
    const selected = state === 'ready' ? work : state === 'blocked' ? blocked : withdrawn;
    totals[state]++;
    if (selected.length < limit) {
      const display = {};
      for (const field of fields) if (row[field] !== undefined) display[field] = row[field];
      selected.push(display);
    }
  }
  const unavailable = Object.entries(sources).filter(([, source]) => source === 'unavailable').map(([name]) => name);
  const messageParts = [];
  if (totals.ready === 0) messageParts.push(`0 ready results for ${kind ?? 'baseline, replication, and review'} in available discovery data.`);
  if (unavailable.length) messageParts.push(`Discovery sources unavailable: ${unavailable.join(', ')}.`);
  const message = messageParts.join(' ');
  const siteSha = Object.values(sources).includes('pinned') && /^[a-f0-9]{40}$/.test(pinned?.siteSha) ? pinned.siteSha : undefined;
  return { identity, sources, totals, work, blocked, withdrawn, servers: servers.map(({ probe }) => probe),
    ...(siteSha ? { site_sha: siteSha } : {}), ...(message ? { message } : {}) };
}

export async function home(ctx, { flags }) {
  const { blocked: _blocked, withdrawn: _withdrawn, ...view } = await discover(ctx, options(flags));
  return { ...view, help: [`${C} next --kind baseline`, `${C} next --kind replication`, `${C} next --kind review`,
    ...(view.sources.baselines === 'unavailable' ? [SETUP] : [])] };
}

export async function next(ctx, { flags }) {
  const { servers: _servers, ...view } = await discover(ctx, options(flags));
  const more = `${C} next${flags.kind ? ` --kind ${flags.kind}` : ''} --full --limit 20`;
  return { ...view, help: [Object.values(view.sources).includes('unavailable') ? SETUP : more, `${C} prompt /exchange --full`] };
}

function pageTask(path) {
  if (path === '/exchange') return [
    'Choose one open baseline, replication, or review that you can complete with genuine evidence. Do not treat suggestions as approval.',
    `${C} next`, `${C} next --kind review`,
  ];
  const [, section = '', collection = '', target = '', ...extra] = path.split('/');
  if (section === 'evals' && id(collection) && !target && path === `/evals/${collection}`) return [
    `Run ${collection} on one eligible setup or reproduce a specific current-version result. Inspect the benchmark and compare the exact workload before attempting a run.`,
    `${C} next --kind baseline`, `${C} next --kind replication`, runCommand(collection, '<model-card>'), replicateCommand('<result-id>'),
  ];
  if (!id(target) || extra.length) return null;
  if (section === 'registry' && collection === 'models') return [
    `Run one benchmark on ${target}. Match the model card and checkpoint, the configured server's currently loaded ID, and the registered setup before proposing the run.`,
    `${C} next --kind baseline --full`, runCommand('<benchmark>', target),
  ];
  if (section === 'exchange' && collection === 'hypotheses') return [
    `Test hypothesis ${target}. Read its prediction as a claim to check. Pick comparable results for its exact models and benchmark; fill gaps with an approved run. Compare uncertainty, disclose limitations, and use an inconclusive verdict when the evidence cannot discriminate the prediction. Do not invent findings or cite results you have not inspected.`,
    `${C} next --kind baseline`, `${C} next --kind replication`,
    `${C} finding draft --id <new-finding> --hypothesis ${target} --results <result-ids> --verdict <verdict> --summary <summary> --limitations <limitations> --date <YYYY-MM-DD> --agent-model <model> --agent-harness <harness>`,
  ];
  if (section === 'exchange' && collection === 'findings') return [
    `Independently review finding ${target}. Inspect its exact bytes and SHA-256 and verify its cited results and comparability. Report only checks you actually performed, and explain why the evidence supports your verdict or leaves it unresolved. Do not review your own or a superseded finding.`,
    `${C} next --kind review --full`,
    `${C} review ${target} --finding-sha256 <hash> --verdict <verdict> --checks <checks> --notes <notes> --date <YYYY-MM-DD> --agent-model <model> --agent-harness <harness>`,
  ];
  return null;
}

export function prompt(_ctx, { args: [page], flags }) {
  const path = typeof page === 'string' && page.startsWith(`${SITE}/`) ? page.slice(SITE.length) : page;
  const task = typeof path === 'string' && path.startsWith('/') && path.length <= 500 ? pageTask(path) : null;
  if (!task) throw new UsageError(`Use a supported path on ${SITE}: /exchange, /exchange/hypotheses/<id>, /exchange/findings/<id>, /evals/<id>, /registry/models/<id>`);
  const body = [...PUBLIC_RULES, '', ...task, '',
    'Commands with placeholders are templates. Replace placeholders with values you verified; do not paste them literally. Review a preview first. Only use confirmation flags after explicit owner approval.',
    'If the pinned site workspace is not ready, prepare it explicitly:', SETUP,
    'After verifying the new evidence and approval, prepare one add-only PR:', PUBLISH,
  ].join('\n');
  const limit = 1_000;
  const truncated = !flags.full && body.length > limit;
  const shown = truncated ? body.slice(0, body.lastIndexOf('\n', limit)) : body;
  return { page: `${SITE}${path}`, prompt: shown,
    ...(truncated ? { truncated_chars: body.length - shown.length, prompt_chars: body.length } : {}),
    help: [`${C} prompt ${path} --full`, `${C} next --kind ${path.startsWith('/exchange/findings/') ? 'review' : 'baseline'}`] };
}
