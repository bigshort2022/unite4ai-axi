import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/shared.mjs';

test('only metadata publishable by the pinned result schema can configure a server', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'unite4ai-config-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const server = { id: 'mini', base_url: 'http://127.0.0.1:8082/v1', loaded_model: 'exact-checkpoint', runtime: 'mlx-lm', runtime_version: '0.31.3', format: 'mlx', quantization: '4bit', device: 'Mac mini', accelerator: 'apple-silicon', memory_gb: 32 };
  const write = (override) => writeFile(join(state, 'config.json'), JSON.stringify({ servers: [{ ...server, ...override }] }));
  await write({});
  assert.deepEqual((await loadConfig(state)).servers, [server]);
  for (const invalid of [{ runtime: 'api' }, { runtime: 'mlx' }, { format: 'ggml' }, { accelerator: 'Apple GPU' }, { runtime_version: 'x'.repeat(101) }]) {
    await write(invalid);
    await assert.rejects(loadConfig(state), /invalid.*server/i);
  }
});
