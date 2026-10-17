import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Json, Query } from '../omeka.js';
import { compactResource, fullResource } from '../values.js';
import { handle, type Context } from './common.js';

export const READ_RESOURCES = [
  'items',
  'media',
  'item_sets',
  'sites',
  'site_pages',
  'properties',
  'vocabularies',
  'resource_classes',
  'resource_templates',
  'assets',
  'users',
] as const;

const PROPERTY_FILTER_TYPES = [
  'eq', 'neq', 'in', 'nin', 'sw', 'nsw', 'ew', 'new', 'ex', 'nex', 'exs', 'nexs', 'exm', 'nexm',
  'res', 'nres', 'lex', 'nlex', 'tp', 'ntp', 'dtp', 'ndtp',
] as const;

const propertyFilter = z.object({
  term: z.string().optional().describe('Property term, e.g. "sdo:name". Omit to match any property.'),
  type: z
    .enum(PROPERTY_FILTER_TYPES)
    .default('in')
    .describe('eq/neq = is exactly, in/nin = contains, sw/ew = starts/ends with, ex/nex = has any value, res/nres = links to resource ID, dtp = has data type.'),
  text: z.string().optional().describe('Value to compare with (resource ID for res/nres, data type for dtp).'),
  joiner: z.enum(['and', 'or']).optional(),
});

/** Turn a compact listing entry into a minimal one when values are not wanted. */
function summary(entry: Json): Json {
  const { values: _values, ...rest } = entry;
  return rest;
}

export function registerReadTools(server: McpServer, ctx: Context): void {
  const { client, terms } = ctx;

  const classTermOf = async () => {
    const index = await terms.resourceClasses();
    return (id: number) => index.id(id)?.term;
  };

  server.registerTool(
    'omeka_search',
    {
      title: 'Search Omeka resources',
      description:
        'Search or list Omeka S resources (items, media, item sets, sites, site pages, vocabularies, properties, ' +
        'resource classes, resource templates, assets, users). Returns the total number of matches and one page of ' +
        'compact results. Property filters accept terms such as "dcterms:title" instead of numeric IDs.',
      inputSchema: {
        resource: z.enum(READ_RESOURCES).default('items'),
        fulltext_search: z.string().optional().describe('Full-text search over titles and values.'),
        search: z.string().optional().describe('Simple keyword search ("search" parameter; for items/media/item sets).'),
        property: z.array(propertyFilter).optional().describe('Property value filters, combined with "and" unless joiner is "or".'),
        resource_class: z.string().optional().describe('Resource class term, e.g. "sdo:Person".'),
        resource_template_id: z.number().int().optional(),
        item_set_id: z.number().int().optional(),
        item_id: z.number().int().optional().describe('For media: only media of this item.'),
        site_id: z.number().int().optional(),
        is_public: z.boolean().optional(),
        id: z.array(z.number().int()).optional().describe('Restrict to these resource IDs.'),
        sort_by: z.string().optional().describe('e.g. "created", "modified", "title", "id" or a property term.'),
        sort_order: z.enum(['asc', 'desc']).optional(),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(25),
        include_values: z.boolean().default(false).describe('Include all property values per result (larger output).'),
        extra: z.record(z.string(), z.any()).optional().describe('Additional raw API query parameters, passed through unchanged.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handle(async (a) => {
      const query: Query = {
        fulltext_search: a.fulltext_search,
        search: a.search,
        resource_template_id: a.resource_template_id,
        item_set_id: a.item_set_id,
        item_id: a.item_id,
        site_id: a.site_id,
        is_public: a.is_public,
        id: a.id,
        sort_by: a.sort_by,
        sort_order: a.sort_order,
        page: a.page,
        per_page: a.per_page,
        ...(a.extra ?? {}),
      };
      if (a.resource_class) query.resource_class_id = await terms.classId(a.resource_class);
      if (a.property?.length) {
        const filters: Query[] = [];
        for (const f of a.property) {
          filters.push({
            property: f.term ? await terms.propertyId(f.term) : undefined,
            type: f.type,
            text: f.text,
            joiner: f.joiner,
          });
        }
        query.property = filters;
      }
      const { total, items } = await client.list(a.resource, query);
      const termOf = await classTermOf();
      const results = items.map((r) => compactResource(r, termOf)).map((r) => (a.include_values ? r : summary(r)));
      return { resource: a.resource, total, page: a.page, per_page: a.per_page, count: results.length, results };
    }),
  );

  server.registerTool(
    'omeka_get',
    {
      title: 'Get an Omeka resource',
      description:
        'Fetch one Omeka S resource by type and ID. "compact" (default) gives id, title, class, template, ' +
        'item sets, media and all property values in a simplified notation; "full" gives the raw JSON-LD representation.',
      inputSchema: {
        resource: z.enum(READ_RESOURCES).default('items'),
        id: z.number().int(),
        format: z.enum(['compact', 'full']).default('compact'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handle(async (a) => {
      const r = await client.get(a.resource, a.id);
      return a.format === 'full' ? fullResource(r) : compactResource(r, await classTermOf());
    }),
  );

  server.registerTool(
    'omeka_get_template',
    {
      title: 'Get a resource template',
      description:
        'Fetch a resource template with, per property, the term, label (alternate label if set), whether it is ' +
        'required or private, and the allowed data types. Use this before creating or updating items with that template.',
      inputSchema: {
        id: z.number().int().describe('Resource template ID.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handle(async (a) => {
      const t = await client.get('resource_templates', a.id);
      const props = await terms.props();
      const classes = await terms.resourceClasses();
      const termOf = (ref: Json) => (ref?.['o:id'] !== undefined ? props.id(ref['o:id'])?.term ?? ref['o:id'] : null);
      return {
        id: t['o:id'],
        label: t['o:label'],
        resource_class: t['o:resource_class'] ? classes.id(t['o:resource_class']['o:id'])?.term ?? t['o:resource_class']['o:id'] : null,
        title_property: termOf(t['o:title_property']),
        description_property: termOf(t['o:description_property']),
        properties: (t['o:resource_template_property'] ?? []).map((p: Json) => {
          const info = props.id(p['o:property']['o:id']);
          return {
            term: info?.term ?? p['o:property']['o:id'],
            property_id: p['o:property']['o:id'],
            label: p['o:alternate_label'] || info?.label,
            comment: p['o:alternate_comment'] || undefined,
            required: p['o:is_required'],
            private: p['o:is_private'] || undefined,
            data_types: p['o:data_type']?.length ? p['o:data_type'] : ['any'],
            default_lang: p['o:default_lang'] || undefined,
          };
        }),
      };
    }),
  );

  server.registerTool(
    'omeka_lookup_term',
    {
      title: 'Look up a property or class',
      description:
        'Find properties or resource classes by term, local name or label (case-insensitive, exact matches first). ' +
        'Returns term, ID, label, comment and vocabulary ID.',
      inputSchema: {
        query: z.string().min(1).describe('e.g. "name", "sdo:Person", "Titel".'),
        kind: z.enum(['property', 'class']).default('property'),
        limit: z.number().int().min(1).max(100).default(15),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handle(async (a) => {
      const index = a.kind === 'class' ? await terms.resourceClasses() : await terms.props();
      return index.search(a.query, a.limit);
    }),
  );
}
