/**
 * Live smoke test against the real API through the stdio transport.
 * Read-only. Skipped when no .env is present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = `${root}.env`;

test('read tools work end-to-end over stdio', { skip: !fs.existsSync(envFile) && 'no .env' }, async () => {
  const client = new Client({ name: 'live-test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', `--env-file=${envFile}`, `${root}src/server.ts`],
      cwd: root,
      stderr: 'ignore',
    }),
  );
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const res: any = await client.callTool({ name, arguments: args });
      assert.ok(!res.isError, `${name}: ${res.content?.[0]?.text}`);
      return JSON.parse(res.content[0].text);
    };

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['omeka_search', 'omeka_get', 'omeka_get_template', 'omeka_lookup_term']) assert.ok(names.includes(n), n);

    const search = await call('omeka_search', { fulltext_search: 'Markt', per_page: 3 });
    assert.ok(search.total > 0);
    assert.equal(search.results.length, 3);

    const filtered = await call('omeka_search', { property: [{ term: 'sdo:name', type: 'in', text: 'Goudsche Courant' }], per_page: 1 });
    assert.ok(filtered.total > 0);

    const item = await call('omeka_get', { id: 9 });
    assert.equal(item.id, 9);
    assert.ok(item.values);

    const template = await call('omeka_get_template', { id: 89 });
    assert.equal(template.label, 'Krantenknipsel');
    assert.ok(template.properties.some((p: any) => p.term === 'sdo:name'));

    const terms = await call('omeka_lookup_term', { query: 'sdo:name' });
    assert.equal(terms[0].term, 'sdo:name');

    const page = await call('omeka_get_page', { site: 'data', slug: 'hofstedegeldnummers', max_string: 100 });
    assert.equal(page.id, 73);
    assert.ok(page.blocks.length > 0 && page.blocks[0].index === 0);
  } finally {
    await client.close();
  }
});
