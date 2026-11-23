#!/usr/bin/env node
import { encode } from '@toon-format/toon';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { helpView, NAME, parse } from '../src/commands.mjs';
import { context, PUBLIC_RULES, UsageError } from '../src/shared.mjs';

const loaders = {
  home: () => import('../src/discovery.mjs').then((m) => m.home),
  next: () => import('../src/discovery.mjs').then((m) => m.next),
  prompt: () => import('../src/discovery.mjs').then((m) => m.prompt),
  'setup workspace': () => import('../src/workspace.mjs').then((m) => m.setupWorkspace),
  run: () => import('../src/authoring.mjs').then((m) => m.run),
  replicate: () => import('../src/authoring.mjs').then((m) => m.replicate),
  'finding draft': () => import('../src/authoring.mjs').then((m) => m.findingDraft),
  review: () => import('../src/authoring.mjs').then((m) => m.review),
  submit: () => import('../src/submit.mjs').then((m) => m.submit),
};

const local = {
  skill: () => ({
    name: NAME,
    path: fileURLToPath(new URL('../skills/unite4ai-axi/SKILL.md', import.meta.url)),
    install: 'npx skills add bigshort2022/unite4ai-axi --skill unite4ai-axi',
    help: [`${NAME} prompt /exchange`, `${NAME} setup hooks`],
  }),
  'setup hooks': () => ({
    action: 'Prints hook configuration only; no existing settings were written.',
    harness: 'Claude Code',
    install: 'If wanted, merge the SessionStart entry into your Claude Code hooks configuration; requires unite4ai-axi on PATH.',
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${NAME} prompt /exchange --full` }] }] },
    rules: PUBLIC_RULES,
    help: [`${NAME} skill`, `${NAME} prompt /exchange --full`],
  }),
};

function print(document) { process.stdout.write(`${encode(document)}\n`); }
let selected;
try {
  const parsed = parse(process.argv.slice(2));
  selected = parsed.name;
  if (parsed.view) print(parsed.view);
  else if (parsed.version) print({ name: NAME, version: packageJson.version, help: [`${NAME} --help`, `${NAME} skill`] });
  else if (Object.hasOwn(local, selected)) print(local[selected]());
  else {
    const handler = await loaders[selected]();
    const ctx = selected === 'prompt' ? undefined : await context();
    const result = await handler(ctx, parsed);
    print({ ...result, help: result.help?.length ? result.help : helpView(selected).help });
  }
} catch (error) {
  const usage = error instanceof UsageError;
  const scope = error.command ?? selected;
  const hint = scope ? `${NAME} ${scope} --help` : `${NAME} --help`;
  const message = error instanceof Error && !error.code ? error.message : 'Operation failed; check inputs and local prerequisites';
  print({ error: { code: usage ? 'usage' : 'operation_failed', message }, help: [hint, `${NAME} prompt /exchange`] });
  process.exitCode = usage ? 2 : 1;
}
