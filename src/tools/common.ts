import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OmekaError, type OmekaClient } from '../omeka.js';
import type { Terms } from '../terms.js';

export interface Context {
  client: OmekaClient;
  terms: Terms;
  readbackDelayMs: number;
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function fail(error: unknown): CallToolResult {
  let text: string;
  if (error instanceof OmekaError) {
    text = error.message;
    if (error.status === 403 || error.status === 401) {
      text += ' (the API key\'s user lacks permission for this action; see README "Omeka user & API key requirements")';
    }
  } else {
    text = error instanceof Error ? error.message : String(error);
  }
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Wrap a tool handler so exceptions become MCP tool errors. */
export function handle<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
