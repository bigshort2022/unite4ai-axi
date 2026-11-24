import { readFile, writeFile } from 'node:fs/promises';
import { publicManifest, NAME } from '../src/commands.mjs';
import { PUBLIC_RULES } from '../src/shared.mjs';

const skill = `---
name: ${NAME}
description: Discover, preview, and submit reproducible local AI benchmark evidence to the Unite4AI research exchange. Use when selecting a baseline, replicating a published result, drafting a finding, or reviewing evidence.
---

# Unite4AI AXI

Run \`${NAME}\` with no arguments to discover status and actionable next steps. To select one bounded task, use \`${NAME} next --kind baseline\`, \`${NAME} next --kind replication\`, or \`${NAME} next --kind review\`. Use \`${NAME} prompt /exchange --full\` for reproducibility guidance.

## Guardrails

${PUBLIC_RULES.map((rule) => `- ${rule}`).join('\n')}

## Workflow

1. Check identity and endpoint readiness. Ask the owner which local machine and loaded model to use and agree on wall time before execution.
2. Use \`${NAME} setup workspace\` to prepare the pinned site runner if needed. Preview \`run\` or \`replicate\` without \`--confirm\`. Ask before adding it.
3. Read the local result and its limitations. Use \`finding draft\` or \`review\` as applicable; never create plausible-but-unobserved evidence.
4. Run \`${NAME} submit --record PATH\` for each intended new record in a single preview. Submit with \`--confirm\` only after the owner approves the preview. Return the draft PR URL; do not merge it.

## Commands

${publicManifest.commands.map(({ name, positionals, summary }) => `- \`${NAME} ${name}${positionals.map((p) => ` <${p}>`).join('')} --help\`: ${summary}`).join('\n')}
`;
const files = [
  ['command-manifest.json', `${JSON.stringify(publicManifest, null, 2)}\n`],
  ['skills/unite4ai-axi/SKILL.md', skill],
];
const check = process.argv.includes('--check');
for (const [path, content] of files) {
  const url = new URL(`../${path}`, import.meta.url);
  if (!check) await writeFile(url, content);
  else if (await readFile(url, 'utf8').catch(() => null) !== content) {
    console.error(`${path} is stale; run npm run skill:generate`);
    process.exitCode = 1;
  }
}
