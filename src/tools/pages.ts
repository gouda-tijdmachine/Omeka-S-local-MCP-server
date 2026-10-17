import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Json } from '../omeka.js';
import { applyBlockOps, blockWarnings, compactPage, toOmekaBlock, touchAll, type BlockOp, type Touched } from '../pages.js';
import { handle, sleep, type Context } from './common.js';

const attachment = z.object({
  item: z.number().int().nullable().optional().describe('Attached item ID.'),
  media: z.number().int().nullable().optional().describe('Attached media ID (must belong to the item).'),
  caption: z.string().optional(),
});

const block = z
  .object({
    layout: z.string().min(1).describe('Block layout, e.g. "html", "markdown", "pageTitle", "browsePreview", "geoJsonMap", "sparql".'),
    data: z.record(z.string(), z.any()).optional().describe('Layout-specific data, e.g. {"html":"<p>…</p>"} or {"markdown":"# …"}. Copy the shape from an existing block of the same layout.'),
    layout_data: z.record(z.string(), z.any()).nullable().optional().describe('Grid settings, e.g. {"grid_column_position":"auto","grid_column_span":"12"}.'),
    attachments: z.array(attachment).optional(),
  })
  .describe('A page block in simplified notation.');

const blockOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('append'), block }),
  z.object({ op: z.literal('insert'), index: z.number().int().min(0), block }),
  z.object({ op: z.literal('replace'), index: z.number().int().min(0), block }),
  z.object({
    op: z.literal('update'),
    index: z.number().int().min(0),
    data: z.record(z.string(), z.any()).optional().describe('Keys merged into the existing block data.'),
    layout_data: z.record(z.string(), z.any()).optional().describe('Keys merged into the existing layout data.'),
    attachments: z.array(attachment).optional().describe('Replaces all attachments of the block.'),
  }),
  z.object({ op: z.literal('delete'), index: z.number().int().min(0) }),
  z.object({ op: z.literal('move'), index: z.number().int().min(0), to: z.number().int().min(0) }),
]);

const siteRef = z.union([z.number().int(), z.string()]).describe('Site ID or site slug (e.g. "data").');

export function registerPageReadTools(server: McpServer, ctx: Context): void {
  const helpers = pageHelpers(ctx);

  server.registerTool(
    'omeka_get_page',
    {
      title: 'Get a site page with its blocks',
      description:
        'Fetch an Omeka S site page by ID, or by site + page slug, including its blocks (layout, data, layout data, ' +
        'attachments). Blocks have no IDs: they are addressed by "index" (0-based), which the page tools use. Long ' +
        'strings in block data are truncated unless full is true or block_index selects one block.',
      inputSchema: {
        id: z.number().int().optional().describe('Site page ID.'),
        site: siteRef.optional(),
        slug: z.string().optional().describe('Page slug, together with site.'),
        block_index: z.number().int().min(0).optional().describe('Return only this block, untruncated.'),
        full: z.boolean().default(false).describe('Do not truncate long block data strings.'),
        max_string: z.number().int().min(50).default(500).describe('Truncation length for block data strings.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handle(async (a) => {
      const page = await helpers.findPage(a.id, a.site, a.slug);
      return compactPage(page, {
        publicUrl: await helpers.publicUrl(page),
        maxString: a.full ? undefined : a.max_string,
        blockIndex: a.block_index,
      });
    }),
  );
}

export function registerPageWriteTools(server: McpServer, ctx: Context): void {
  const { client } = ctx;
  const helpers = pageHelpers(ctx);

  const readBack = async (id: number, sent: Json[], touched: Touched) => {
    await sleep(ctx.readbackDelayMs);
    const stored = await client.get('site_pages', id);
    const warnings = blockWarnings(sent, touched, stored['o:block'] ?? []);
    return {
      page: compactPage(stored, { publicUrl: await helpers.publicUrl(stored), maxString: 300 }),
      ...(warnings.length ? { warnings } : {}),
    };
  };

  server.registerTool(
    'omeka_create_page',
    {
      title: 'Create a site page',
      description:
        'Create a new page in an Omeka S site, optionally with blocks. Without blocks Omeka adds a pageTitle block. ' +
        'The page is not added to the site navigation. The stored page is read back; block data that Omeka changed ' +
        'on save (e.g. HTML cleaned by HTMLPurifier) is reported under "warnings".',
      inputSchema: {
        site: siteRef,
        title: z.string().min(1),
        slug: z.string().optional().describe('URL slug; generated from the title when omitted.'),
        is_public: z.boolean().default(true),
        blocks: z.array(block).optional(),
        layout: z.string().optional().describe('Page layout, e.g. "grid"; omit for the default.'),
        layout_data: z.record(z.string(), z.any()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handle(async (a) => {
      const body: Json = {
        'o:site': { 'o:id': await helpers.siteId(a.site) },
        'o:title': a.title,
        'o:slug': a.slug ?? '',
        'o:is_public': a.is_public,
      };
      if (a.layout !== undefined) body['o:layout'] = a.layout;
      if (a.layout_data !== undefined) body['o:layout_data'] = a.layout_data;
      const blocks = (a.blocks ?? []).map(toOmekaBlock);
      if (blocks.length) body['o:block'] = blocks;
      const created = await client.create('site_pages', body);
      return { created: true, ...(await readBack(created['o:id'], blocks.length ? blocks : created['o:block'] ?? [], touchAll(blocks))) };
    }),
  );

  server.registerTool(
    'omeka_update_page',
    {
      title: 'Update a site page and its blocks',
      description:
        'Change a site page: title, slug, visibility, layout and its blocks. Always GET + modify + PUT of the whole ' +
        'page (a PATCH with blocks would append them). Either give "blocks" to replace all blocks, or "block_ops" ' +
        'to edit them: append, insert (at index), replace, update (merge data keys), delete, move (index -> to). ' +
        'Operations run in order, and each index refers to the block list as it is at that moment. Use ' +
        'omeka_get_page first to see the indexes and the data shape per layout, and pass its "modified" as ' +
        'expect_modified to avoid overwriting a concurrent edit.',
      inputSchema: {
        id: z.number().int().describe('Site page ID.'),
        expect_modified: z.string().optional().describe('The "modified" timestamp from omeka_get_page; the update is refused if the page changed since.'),
        title: z.string().min(1).optional(),
        slug: z.string().min(1).optional(),
        is_public: z.boolean().optional(),
        layout: z.string().nullable().optional(),
        layout_data: z.record(z.string(), z.any()).nullable().optional(),
        blocks: z.array(block).optional().describe('Replace all blocks with these.'),
        block_ops: z.array(blockOp).optional().describe('Block operations, applied in order.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle(async (a) => {
      if (a.blocks && a.block_ops) throw new Error('Give either "blocks" or "block_ops", not both.');
      const current = await client.get('site_pages', a.id);
      const modified = current['o:modified']?.['@value'];
      if (a.expect_modified && modified !== a.expect_modified) {
        throw new Error(`The page was modified at ${modified}, after ${a.expect_modified}. Fetch it again with omeka_get_page before updating.`);
      }

      const body: Json = { ...current };
      delete body['@context'];
      if (a.title !== undefined) body['o:title'] = a.title;
      if (a.slug !== undefined) body['o:slug'] = a.slug;
      if (a.is_public !== undefined) body['o:is_public'] = a.is_public;
      if (a.layout !== undefined) body['o:layout'] = a.layout;
      if (a.layout_data !== undefined) body['o:layout_data'] = a.layout_data;

      let touched: Touched = new Map();
      if (a.blocks) {
        body['o:block'] = a.blocks.map(toOmekaBlock);
        touched = touchAll(body['o:block']);
      } else if (a.block_ops?.length) {
        const result = applyBlockOps(current['o:block'] ?? [], a.block_ops as BlockOp[]);
        body['o:block'] = result.blocks;
        touched = result.touched;
      }

      await client.replace('site_pages', a.id, body);
      return { updated: true, ...(await readBack(a.id, body['o:block'] ?? [], touched)) };
    }),
  );
}

function pageHelpers(ctx: Context) {
  const { client } = ctx;
  let sites: Promise<Json[]> | undefined;
  const allSites = () => {
    sites ??= client.listAll('sites').catch((e) => {
      sites = undefined;
      throw e;
    });
    return sites;
  };
  const omekaBase = client.apiUrl.replace(/\/api$/, '');

  const siteId = async (site: number | string): Promise<number> => {
    if (typeof site === 'number' || /^\d+$/.test(site)) return Number(site);
    const found = (await allSites()).find((s) => s['o:slug'] === site);
    if (!found) throw new Error(`Unknown site slug "${site}". Known: ${(await allSites()).map((s) => s['o:slug']).join(', ')}.`);
    return found['o:id'];
  };

  return {
    siteId,

    async findPage(id?: number, site?: number | string, slug?: string): Promise<Json> {
      if (id !== undefined) return client.get('site_pages', id);
      if (site === undefined || !slug) throw new Error('Give a page "id", or "site" and "slug".');
      const { items } = await client.list('site_pages', { site_id: await siteId(site), slug });
      if (!items.length) throw new Error(`No page "${slug}" in site ${site}.`);
      return items[0];
    },

    async publicUrl(page: Json): Promise<string | undefined> {
      const sid = page['o:site']?.['o:id'];
      const s = (await allSites()).find((x) => x['o:id'] === sid);
      return s ? `${omekaBase}/s/${s['o:slug']}/page/${page['o:slug']}` : undefined;
    },
  };
}
