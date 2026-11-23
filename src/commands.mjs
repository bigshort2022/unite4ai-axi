import { UsageError } from './shared.mjs';

export const NAME = 'unite4ai-axi';
const flag = (name, description, { value, required = false, repeatable = false } = {}) => ({ name, description, ...(value ? { value } : {}), ...(required ? { required } : {}), ...(repeatable ? { repeatable } : {}) });
const value = (name, metavar, description, required = true) => flag(name, description, { value: metavar, required });
const full = flag('full', 'Show extended guidance and provenance.');
const helpFlag = flag('help', 'Show help without loading configuration or calling dependencies.');
const confirm = flag('confirm', 'Perform this operation only after explicit owner approval. Omit for a preview.');
const provenance = [value('date', 'YYYY-MM-DD', 'UTC date of the work.'), value('agent-model', 'model', 'Actual authoring model.'), value('agent-harness', 'harness', 'Actual authoring harness.')];
const runtime = [value('server', 'id', 'Configured local endpoint.'), value('max-seconds', 'seconds', 'Owner-approved wall-clock budget.'), value('served-model', 'exact-id', 'Additional assertion for the already loaded model.', false), confirm];
const command = (name, summary, positionals, flags, examples) => ({ name, summary, positionals, flags: [...flags, helpFlag], examples });
export const commands = [
  command('home', 'Show discovery, identity and workspace status.', [], [], ['next --kind baseline', 'setup workspace']),
  command('next', 'Find a baseline, replication or review and explain blockers.', [], [value('kind', 'baseline|replication|review', 'Type of evidence work; omit for all kinds.', false), value('limit', 'count', 'Maximum number of work items (default 10, range 1–100).', false), value('fields', 'fields', 'Comma-separated output fields.', false), full], ['next --kind replication --limit 3']),
  command('prompt', 'Print static, page-specific instructions without fetching HTML.', ['page'], [full], ['prompt /exchange --full']),
  command('setup workspace', 'Prepare the pinned upstream checkout; no inference.', [], [], ['setup workspace']),
  command('setup hooks', 'Print opt-in hook guidance without changing the host.', [], [], ['setup hooks']),
  command('skill', 'Locate the packaged agent skill and show how to install it.', [], [], ['skill']),
  command('run', 'Preview or explicitly run a registered local benchmark.', ['benchmark'], [value('model', 'model-card-id', 'Unite4AI model card ID.'), ...runtime], ['run bfcl-multiple-50 --model qwen3-8-27b --server mini --max-seconds 900']),
  command('replicate', 'Preview or rerun a published result on a configured local server.', ['result'], runtime, ['replicate <result-id> --server mini --max-seconds 900']),
  command('finding draft', 'Validate and write an add-only finding to the local evidence workspace.', [], [value('id', 'id', 'New finding ID.'), value('hypothesis', 'id', 'Published hypothesis ID.'), value('results', 'ids', 'Comma-separated result IDs.'), value('verdict', 'verdict', 'Finding verdict from the exchange schema.'), value('summary', 'text', 'What the evidence establishes.'), value('limitations', 'text', 'Limits and comparability caveats.'), ...provenance, value('incumbent', 'result-id', 'Result for the configured incumbent.', false), value('candidate', 'result-id', 'Result for the candidate.', false), value('supersedes', 'id', 'Previous finding explicitly replaced by this one.', false)], ['prompt /exchange --full']),
  command('review', 'Validate and write an exact-hash review to the local evidence workspace.', ['finding'], [value('verdict', 'verdict', 'Review verdict from the exchange schema.'), value('checks', 'checks', 'Checks actually performed.'), value('notes', 'text', 'Review evidence and limitations.'), value('finding-sha256', 'hash', 'SHA-256 of the exact finding bytes reviewed.'), ...provenance], ['next --kind review']),
  command('submit', 'Validate a preview or open one confirmed add-only draft PR.', [], [flag('record', 'New record path relative to the upstream tree. Repeat for related records.', { value: 'path', required: true, repeatable: true }), confirm], ['submit --record apps/web/src/content/findings/<id>.json']),
];

export const publicManifest = { schema_version: 1, bin: NAME, root_flags: [helpFlag, flag('version', 'Show the installed version.')], commands };
const byName = new Map(commands.map((c) => [c.name, c]));
const groups = ['setup', 'finding'];
const invocation = (c) => `${NAME} ${c.name}${c.positionals.map((p) => ` <${p}>`).join('')}`;
const examples = (c) => c.examples.map((example) => `${NAME} ${example}`);
const flagLine = (item) => `--${item.name}${item.value ? ` <${item.value}>` : ''} — ${item.description}${item.required ? ' (required)' : ''}${item.repeatable ? ' (repeatable)' : ''}`;

export function helpView(name) {
  const item = byName.get(name);
  if (item) return { usage: `${invocation(item)} [flags]`, summary: item.summary, flags: item.flags.map(flagLine), examples: examples(item), help: [`${NAME} --help`, ...examples(item)] };
  const options = name ? commands.filter((c) => c.name.startsWith(`${name} `)) : commands;
  return {
    usage: `${NAME}${name ? ` ${name}` : ''} [command] [flags]`,
    commands: options.map((c) => ({ command: c.name, summary: c.summary })),
    flags: publicManifest.root_flags.map(flagLine),
    examples: [`${NAME} next --kind baseline`, `${NAME} prompt /exchange`, `${NAME} setup workspace`],
    help: [`${NAME} next --help`, `${NAME} prompt --help`, `${NAME} ${name ? options[0]?.name ?? '' : 'submit'} --help`],
  };
}

export function parse(argv) {
  if (!argv.length) return { name: 'home', args: [], flags: {} };
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) return { view: helpView() };
  if (argv.length === 1 && argv[0] === '--version') return { version: true };
  const tokens = [...argv];
  const requestedHelp = tokens[0] === 'help';
  if (requestedHelp) tokens.shift();
  let name = tokens.shift();
  if (groups.includes(name)) {
    if (!tokens.length || (tokens.length === 1 && ['--help', '-h'].includes(tokens[0]))) return { view: helpView(name) };
    name += ` ${tokens.shift()}`;
  }
  const item = byName.get(name);
  if (!item) throw new UsageError(`Unknown command or flag: ${name}. valid flags: --help, --version`);
  const fail = (message) => { throw Object.assign(new UsageError(`${message}. valid flags: ${item.flags.map(({ name }) => `--${name}`).join(', ')}`), { command: name }); };
  if (requestedHelp && tokens.length) fail('Unexpected help arguments');
  if (requestedHelp || (tokens.length === 1 && ['--help', '-h'].includes(tokens[0]))) return { view: helpView(name) };
  const args = [], flags = Object.create(null);
  while (tokens.length) {
    const token = tokens.shift();
    if (token === '-h' || token === '--help') return { view: helpView(name) };
    if (!token.startsWith('-')) { args.push(token); continue; }
    const split = token.indexOf('=');
    const key = token.slice(2, split === -1 ? undefined : split);
    const info = item.flags.find((f) => f.name === key);
    if (!token.startsWith('--') || !info || (!info.value && split !== -1)) fail(`Unknown flag: ${token.split('=')[0]}`);
    if (Object.hasOwn(flags, key) && !info.repeatable) fail(`Duplicate flag: --${key}`);
    const entry = !info.value ? true : split === -1 ? (tokens[0]?.startsWith('--') ? undefined : tokens.shift()) : token.slice(split + 1);
    if (entry === undefined || entry === '') fail(`Missing value for --${key}`);
    if (info.repeatable) (flags[key] ??= []).push(entry); else flags[key] = entry;
  }
  if (args.length !== item.positionals.length) fail(`Expected ${item.positionals.map((p) => `<${p}>`).join(' ') || 'no positional arguments'}`);
  for (const info of item.flags) if (info.required && !Object.hasOwn(flags, info.name)) fail(`Missing --${info.name}`);
  return { name, args, flags };
}
