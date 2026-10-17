#!/usr/bin/env node
/**
 * Omeka S MCP server (stdio) for the Gouda Tijdmachine.
 *
 * Configuration comes from the environment (load it with `node --env-file=.env`):
 *   OMEKA_API_URL, OMEKA_KEY_IDENTITY, OMEKA_KEY_CREDENTIAL,
 *   OMEKA_READ_ONLY (1 = read tools only), OMEKA_READBACK_DELAY_MS.
 *
 * stdout is the MCP channel: log to stderr only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OmekaClient } from './omeka.js';
import { Terms } from './terms.js';
import { registerPageReadTools, registerPageWriteTools } from './tools/pages.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

const VERSION = '0.2.0';

const env = process.env;
const apiUrl = env.OMEKA_API_URL || 'https://www.goudatijdmachine.nl/omeka/api';
const readOnly = ['1', 'true', 'yes'].includes((env.OMEKA_READ_ONLY ?? '').toLowerCase());

const client = new OmekaClient({
  apiUrl,
  keyIdentity: env.OMEKA_KEY_IDENTITY,
  keyCredential: env.OMEKA_KEY_CREDENTIAL,
});

const server = new McpServer(
  { name: 'omeka-gtm', version: VERSION },
  {
    instructions:
      `Tools for the Omeka S REST API at ${apiUrl} (Gouda Tijdmachine). ` +
      'Use omeka_search to find resources, omeka_get for details and omeka_get_template to see which ' +
      'properties and data types a template expects before writing. Property values use a simplified ' +
      'notation: {"value","lang"} for literals, {"uri","label"} for URIs, {"resource": id} for links, ' +
      'plus an optional "type" for other data types and an optional "annotation" (values about the value, ' +
      'keyed by term). Site pages: omeka_get_page shows blocks by index; omeka_update_page edits them.' +
      (readOnly || !client.hasKey ? ' This instance is read-only.' : ' Updates always keep unmentioned values (GET + merge + PUT).'),
  },
);

const ctx = {
  client,
  terms: new Terms(client),
  readbackDelayMs: Number(env.OMEKA_READBACK_DELAY_MS ?? 1500),
};

registerReadTools(server, ctx);
registerPageReadTools(server, ctx);
if (!client.hasKey) {
  console.error('[omeka-gtm] No API key configured: write tools disabled, reads are anonymous (no o: fields, no private resources).');
} else if (readOnly) {
  console.error('[omeka-gtm] OMEKA_READ_ONLY is set: write tools disabled.');
} else {
  registerWriteTools(server, ctx);
  registerPageWriteTools(server, ctx);
}

await server.connect(new StdioServerTransport());
console.error(`[omeka-gtm] v${VERSION} ready on stdio for ${apiUrl}`);
