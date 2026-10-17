import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OmekaError, type Json } from '../omeka.js';
import { collectTerms, compactResource, mergeValues, missingValues, toOmekaValue, type SimpleValue, type TermUpdate } from '../values.js';
import { handle, sleep, type Context } from './common.js';

const WRITE_RESOURCES = ['items', 'item_sets', 'media'] as const;

const plainValue = z
  .object({
    value: z.union([z.string(), z.number()]).optional().describe('Literal value.'),
    lang: z.string().optional().describe('Language tag for literals and URIs, e.g. "nl".'),
    uri: z.string().optional().describe('URI value.'),
    label: z.string().optional().describe('Label for a URI value.'),
    resource: z.number().int().optional().describe('ID of a linked Omeka resource.'),
    type: z
      .string()
      .optional()
      .describe(
        'Omeka data type. Inferred when omitted: "resource:item" if resource is set, "uri" if uri is set, else "literal". ' +
          'Set explicitly for e.g. "resource:itemset", "resource:media", "numeric:timestamp", "numeric:integer", ' +
          '"geography:coordinates", "customvocab:<id>". Check omeka_get_template for allowed types.',
      ),
    public: z.boolean().optional().describe('false makes this single value private.'),
  })
  .describe('One property value in simplified notation.');

const simpleValue = plainValue.extend({
  annotation: z
    .record(z.string(), z.array(plainValue))
    .optional()
    .describe('Value annotation: values about this value keyed by term, e.g. {"prov:hadPrimarySource":[{"resource":266234}]}. Cannot be nested.'),
});

const valuesMap = z
  .record(z.string(), z.array(simpleValue))
  .describe('Property values keyed by term, e.g. {"dcterms:title":[{"value":"Markt","lang":"nl"}]}.');

const termUpdate = z.object({
  mode: z
    .enum(['set', 'add', 'remove', 'annotate'])
    .describe(
      'set = replace all values of this term; add = append (duplicates skipped, also their annotation); ' +
        'remove = delete the given values, or the whole term when values is empty; ' +
        'annotate = replace the annotation of the given existing values (matched by value+lang, URI or resource ID; no annotation = remove it).',
    ),
  values: z.array(simpleValue).default([]),
});

const ref = (id: number) => ({ 'o:id': id });

export function registerWriteTools(server: McpServer, ctx: Context): void {
  const { client, terms } = ctx;

  const classTermOf = async () => {
    const index = await terms.resourceClasses();
    return (id: number) => index.id(id)?.term;
  };

  const toOmekaValues = async (values: Record<string, SimpleValue[]>): Promise<Record<string, Json[]>> => {
    const lookup = await terms.propertyIdLookup(collectTerms(values));
    const out: Record<string, Json[]> = {};
    for (const [term, list] of Object.entries(values)) {
      out[term] = list.map((v) => toOmekaValue(v, lookup(term), lookup));
    }
    return out;
  };

  /** Wait for the replica, fetch the stored resource and report dropped values. */
  const readBack = async (resource: string, id: number, sent: Record<string, Json[]>) => {
    await sleep(ctx.readbackDelayMs);
    const stored = await client.get(resource, id);
    const warnings = missingValues(sent, stored);
    return { resource: compactResource(stored, await classTermOf()), ...(warnings.length ? { warnings } : {}) };
  };

  server.registerTool(
    'omeka_create_item',
    {
      title: 'Create an item',
      description:
        'Create a new Omeka S item (or item set) with property values in simplified notation. The stored item is ' +
        'read back afterwards; values Omeka silently dropped (e.g. invalid data type) are listed under "warnings".',
      inputSchema: {
        resource: z.enum(['items', 'item_sets']).default('items'),
        values: valuesMap,
        resource_template_id: z.number().int().optional(),
        resource_class: z.string().optional().describe('Resource class term, e.g. "sdo:Person".'),
        item_set_ids: z.array(z.number().int()).optional().describe('Item sets to add the item to.'),
        site_ids: z.array(z.number().int()).optional().describe('Sites to assign. Omit to use the sites\' default assignment.'),
        is_public: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handle(async (a) => {
      const values = await toOmekaValues(a.values);
      const body: Json = { 'o:is_public': a.is_public, ...values };
      if (a.resource_template_id !== undefined) body['o:resource_template'] = ref(a.resource_template_id);
      if (a.resource_class) body['o:resource_class'] = ref(await terms.classId(a.resource_class));
      if (a.resource === 'items') {
        if (a.item_set_ids) body['o:item_set'] = a.item_set_ids.map(ref);
        if (a.site_ids) body['o:site'] = a.site_ids.map(ref);
      }
      const created = await client.create(a.resource, body);
      return { created: true, ...(await readBack(a.resource, created['o:id'], values)) };
    }),
  );

  server.registerTool(
    'omeka_update_resource',
    {
      title: 'Update an item, item set or media',
      description:
        'Change property values and/or settings of an existing item, item set or media. Always implemented as ' +
        'GET + merge + PUT (never PATCH), so terms and fields you do not mention are kept exactly as they are. ' +
        'Per term choose mode set/add/remove. The result is read back and dropped values are reported as "warnings".',
      inputSchema: {
        resource: z.enum(WRITE_RESOURCES).default('items'),
        id: z.number().int(),
        values: z.record(z.string(), termUpdate).default({}).describe('Per term an update, e.g. {"sdo:keywords":{"mode":"add","values":[{"value":"Markt","lang":"nl"}]}}.'),
        is_public: z.boolean().optional(),
        resource_template_id: z.number().int().nullable().optional().describe('New template ID, or null to remove the template.'),
        resource_class: z.string().nullable().optional().describe('New class term, or null to remove the class.'),
        add_item_set_ids: z.array(z.number().int()).optional().describe('Items only.'),
        remove_item_set_ids: z.array(z.number().int()).optional().describe('Items only.'),
        site_ids: z.array(z.number().int()).optional().describe('Items only: replaces the site assignment.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle(async (a) => {
      const updates = a.values as Record<string, TermUpdate>;
      const lookup = await terms.propertyIdLookup(
        collectTerms(Object.fromEntries(Object.entries(updates).map(([t, u]) => [t, u.values]))),
      );
      const current = await client.get(a.resource, a.id);
      const body = mergeValues(current, updates, lookup);
      delete body['@context'];

      if (a.is_public !== undefined) body['o:is_public'] = a.is_public;
      if (a.resource_template_id !== undefined) body['o:resource_template'] = a.resource_template_id === null ? null : ref(a.resource_template_id);
      if (a.resource_class !== undefined) body['o:resource_class'] = a.resource_class === null ? null : ref(await terms.classId(a.resource_class));
      if (a.resource === 'items') {
        if (a.add_item_set_ids || a.remove_item_set_ids) {
          const ids = new Set<number>((current['o:item_set'] ?? []).map((s: Json) => s['o:id']));
          a.add_item_set_ids?.forEach((id) => ids.add(id));
          a.remove_item_set_ids?.forEach((id) => ids.delete(id));
          body['o:item_set'] = [...ids].map(ref);
        }
        if (a.site_ids) body['o:site'] = a.site_ids.map(ref);
      }

      await client.replace(a.resource, a.id, body);
      // Only the values that were added or set need checking; existing ones were already stored.
      const sent: Record<string, Json[]> = {};
      for (const [term, u] of Object.entries(updates)) {
        if (u.mode === 'remove') continue;
        const checked = u.mode === 'annotate' ? (u.values ?? []).filter((v) => v.annotation) : (u.values ?? []);
        sent[term] = checked.map((v) => toOmekaValue(v, lookup(term), lookup));
      }
      return { updated: true, ...(await readBack(a.resource, a.id, sent)) };
    }),
  );

  server.registerTool(
    'omeka_add_media',
    {
      title: 'Add media to an item',
      description:
        'Attach a new media object to an existing item. Ingesters: "url" downloads a file from a URL (e.g. a IIIF ' +
        'region URL ending in /default.jpg), "iiif" registers a IIIF image (info.json URL, whole image only), ' +
        '"html" stores an HTML snippet.',
      inputSchema: {
        item_id: z.number().int(),
        ingester: z.enum(['url', 'iiif', 'html']).default('url'),
        url: z.string().optional().describe('For url/iiif ingesters.'),
        html: z.string().optional().describe('For the html ingester.'),
        values: valuesMap.optional(),
        is_public: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handle(async (a) => {
      if (a.ingester === 'html' ? !a.html : !a.url) {
        throw new Error(a.ingester === 'html' ? 'The html ingester needs "html".' : `The ${a.ingester} ingester needs "url".`);
      }
      const values = await toOmekaValues(a.values ?? {});
      const body: Json = { 'o:ingester': a.ingester, 'o:item': ref(a.item_id), 'o:is_public': a.is_public, ...values };
      if (a.ingester === 'html') body.html = a.html;
      else body.ingest_url = a.url;
      const created = await client.create('media', body);
      return { created: true, ...(await readBack('media', created['o:id'], values)) };
    }),
  );

  server.registerTool(
    'omeka_delete',
    {
      title: 'Delete an item, item set, media or site page',
      description: 'Permanently delete an Omeka S item, item set, media or site page. Cannot be undone.',
      inputSchema: {
        resource: z.enum([...WRITE_RESOURCES, 'site_pages']).default('items'),
        id: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handle(async (a) => {
      try {
        await client.delete(a.resource, a.id);
        return { deleted: true, resource: a.resource, id: a.id };
      } catch (e) {
        // Some modules (e.g. Comment) throw after the delete has already happened: check.
        if (!(e instanceof OmekaError) || e.status < 500) throw e;
        await sleep(ctx.readbackDelayMs);
        try {
          await client.get(a.resource, a.id);
        } catch (check) {
          if (check instanceof OmekaError && check.status === 404) {
            return { deleted: true, resource: a.resource, id: a.id, note: `The API returned an error (${e.message}), but the resource is gone.` };
          }
        }
        throw e;
      }
    }),
  );
}
