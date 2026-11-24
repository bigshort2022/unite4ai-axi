import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = join(root, 'bin/unite4ai-axi.mjs');
function invoke(...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, PATH: '/no-dependencies', U4AI_AXI_HOME: '/not-a-config-directory' },
    encoding: 'utf8', timeout: 5000,
  });
}

test('help works with no dependencies or local configuration', () => {
  const output = invoke('replicate', '--help');
  assert.equal(output.status, 0, output.stderr);
  const help = decode(output.stdout);
  assert.equal(help.usage, 'unite4ai-axi replicate <result> [flags]');
  assert.ok(help.flags.some((flag) => flag.startsWith('--confirm ')));
  assert.equal(output.stderr, '');
});

test('unknown flags are rejected before a dependency call', () => {
  const output = invoke('submit', '--bogus');
  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stdout, /--bogus/);
  assert.match(output.stdout, /--record/);
  assert.equal(output.stderr, '');
});

test('external prompt URLs are rejected without fetching them', () => {
  const output = invoke('prompt', 'https://example.org/exchange');
  assert.equal(output.status, 2, output.stderr);
  assert.equal(decode(output.stdout).error.code, 'usage');
  assert.equal(output.stderr, '');
});
