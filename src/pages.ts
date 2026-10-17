/**
 * Site pages and page blocks: simplified block notation, block operations and
 * compact rendering. Blocks have no IDs in the API; they are addressed by their
 * position (0-based index) in the page's o:block list.
 */

import type { Json } from './omeka.js';

export interface SimpleAttachment {
  item?: number | null;
  media?: number | null;
  caption?: string;
}

export interface SimpleBlock {
  /** Block layout, e.g. "html", "markdown", "pageTitle", "browsePreview", "geoJsonMap". */
  layout: string;
  /** Block data; its keys depend on the layout (e.g. {"html": "..."} or {"markdown": "..."}). */
  data?: Record<string, unknown>;
  /** Grid/layout settings of the block (o:layout_data). */
  layout_data?: Record<string, unknown> | null;
  attachments?: SimpleAttachment[];
}

/** Written blocks mapped to the data keys that were explicitly set. */
export type Touched = Map<Json, string[]>;

/** All given blocks as written with all of their data keys. */
export function touchAll(blocks: Json[]): Touched {
  return new Map(blocks.map((b) => [b, Object.keys(b['o:data'] ?? {})]));
}

export type BlockOp =
  | { op: 'append'; block: SimpleBlock }
  | { op: 'insert'; index: number; block: SimpleBlock }
  | { op: 'replace'; index: number; block: SimpleBlock }
  | { op: 'update'; index: number; data?: Record<string, unknown>; layout_data?: Record<string, unknown>; attachments?: SimpleAttachment[] }
  | { op: 'delete'; index: number }
  | { op: 'move'; index: number; to: number };

const ref = (id: number | null | undefined) => (id === null || id === undefined ? null : { 'o:id': id });

export function toOmekaAttachment(a: SimpleAttachment): Json {
  return { 'o:item': ref(a.item), 'o:media': ref(a.media), 'o:caption': a.caption ?? '' };
}

export function compactAttachment(a: Json): SimpleAttachment {
  const out: SimpleAttachment = {};
  if (a['o:item']?.['o:id'] !== undefined) out.item = a['o:item']['o:id'];
  if (a['o:media']?.['o:id'] !== undefined) out.media = a['o:media']['o:id'];
  if (a['o:caption']) out.caption = a['o:caption'];
  return out;
}

export function toOmekaBlock(b: SimpleBlock): Json {
  if (!b.layout) throw new Error('Every block needs a layout.');
  const out: Json = { 'o:layout': b.layout, 'o:data': b.data ?? {} };
  if (b.layout_data !== undefined) out['o:layout_data'] = b.layout_data;
  out['o:attachment'] = (b.attachments ?? []).map(toOmekaAttachment);
  return out;
}

function checkIndex(blocks: unknown[], index: number, op: string, allowEnd = false): void {
  const max = allowEnd ? blocks.length : blocks.length - 1;
  if (!Number.isInteger(index) || index < 0 || index > max) {
    throw new Error(`${op}: block index ${index} is out of range (page has ${blocks.length} block(s)).`);
  }
}

/**
 * Apply block operations in order to a copy of the page's o:block list.
 * Indices refer to the list as it is when that operation runs.
 * Returns the new list and, per written block, the data keys the caller set
 * (only those are compared in the read-back: layouts may derive other keys).
 */
export function applyBlockOps(current: Json[], ops: BlockOp[]): { blocks: Json[]; touched: Touched } {
  const blocks: Json[] = current.map((b) => ({ ...b }));
  const touched: Touched = new Map();
  for (const op of ops) {
    switch (op.op) {
      case 'append': {
        const b = toOmekaBlock(op.block);
        blocks.push(b);
        touched.set(b, Object.keys(op.block.data ?? {}));
        break;
      }
      case 'insert': {
        checkIndex(blocks, op.index, 'insert', true);
        const b = toOmekaBlock(op.block);
        blocks.splice(op.index, 0, b);
        touched.set(b, Object.keys(op.block.data ?? {}));
        break;
      }
      case 'replace': {
        checkIndex(blocks, op.index, 'replace');
        const b = toOmekaBlock(op.block);
        touched.delete(blocks[op.index]);
        blocks[op.index] = b;
        touched.set(b, Object.keys(op.block.data ?? {}));
        break;
      }
      case 'update': {
        checkIndex(blocks, op.index, 'update');
        const old = blocks[op.index];
        const b: Json = { ...old };
        if (op.data) b['o:data'] = { ...(old['o:data'] ?? {}), ...op.data };
        if (op.layout_data) b['o:layout_data'] = { ...(old['o:layout_data'] ?? {}), ...op.layout_data };
        if (op.attachments) b['o:attachment'] = op.attachments.map(toOmekaAttachment);
        const keys = [...(touched.get(old) ?? []), ...Object.keys(op.data ?? {})];
        touched.delete(old);
        blocks[op.index] = b;
        touched.set(b, [...new Set(keys)]);
        break;
      }
      case 'delete': {
        checkIndex(blocks, op.index, 'delete');
        touched.delete(blocks[op.index]);
        blocks.splice(op.index, 1);
        break;
      }
      case 'move': {
        checkIndex(blocks, op.index, 'move');
        checkIndex(blocks, op.to, 'move');
        const [b] = blocks.splice(op.index, 1);
        blocks.splice(op.to, 0, b);
        break;
      }
      default:
        throw new Error(`Unknown block operation ${JSON.stringify(op)}.`);
    }
  }
  return { blocks, touched };
}

/** Shorten long strings (e.g. a 300 KB markdown block) unless full output is wanted. */
export function truncateStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') {
    return value.length > max ? `${value.slice(0, max)}… [truncated: ${value.length} characters in total]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, max));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateStrings(v, max)]));
  }
  return value;
}

export function compactBlock(b: Json, index: number, maxString?: number): Json {
  const out: Json = { index, layout: b['o:layout'] };
  const data = b['o:data'] ?? {};
  out.data = maxString ? truncateStrings(data, maxString) : data;
  if (b['o:layout_data'] && Object.keys(b['o:layout_data']).length) out.layout_data = b['o:layout_data'];
  if (Array.isArray(b['o:attachment']) && b['o:attachment'].length) out.attachments = b['o:attachment'].map(compactAttachment);
  return out;
}

export function compactPage(p: Json, opts: { publicUrl?: string; maxString?: number; blockIndex?: number } = {}): Json {
  const out: Json = {
    id: p['o:id'],
    title: p['o:title'],
    slug: p['o:slug'],
    site_id: p['o:site']?.['o:id'],
    is_public: p['o:is_public'],
  };
  if (opts.publicUrl) out.url = opts.publicUrl;
  if (p['o:layout']) out.layout = p['o:layout'];
  if (p['o:layout_data'] && Object.keys(p['o:layout_data']).length) out.layout_data = p['o:layout_data'];
  if (p['o:created']?.['@value']) out.created = p['o:created']['@value'];
  if (p['o:modified']?.['@value']) out.modified = p['o:modified']['@value'];
  const blocks: Json[] = p['o:block'] ?? [];
  out.block_count = blocks.length;
  if (opts.blockIndex !== undefined) {
    if (opts.blockIndex < 0 || opts.blockIndex >= blocks.length) {
      throw new Error(`Block index ${opts.blockIndex} is out of range (page has ${blocks.length} block(s)).`);
    }
    out.blocks = [compactBlock(blocks[opts.blockIndex], opts.blockIndex)];
  } else {
    out.blocks = blocks.map((b, i) => compactBlock(b, i, opts.maxString));
  }
  return out;
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

/**
 * Compare the sent blocks with what Omeka stored. A PUT re-saves every block,
 * and block layouts may rewrite their data on save (the html layout runs
 * HTMLPurifier when the "use_htmlpurifier" setting is on, which strips inline
 * <style> and <script>). Untouched blocks are checked too.
 */
export function blockWarnings(sent: Json[], touched: Touched, stored: Json[]): string[] {
  const warnings: string[] = [];
  if (sent.length !== stored.length) {
    warnings.push(`Sent ${sent.length} block(s), but the page now has ${stored.length}.`);
    return warnings;
  }
  sent.forEach((b, i) => {
    const s = stored[i];
    const label = touched.has(b) ? `Block ${i}` : `Untouched block ${i}`;
    if (s['o:layout'] !== b['o:layout']) {
      warnings.push(`${label}: layout "${b['o:layout']}" was stored as "${s['o:layout']}".`);
      return;
    }
    const data: Json = b['o:data'] ?? {};
    for (const key of touched.get(b) ?? Object.keys(data)) {
      const value = data[key];
      const storedValue = s['o:data']?.[key];
      if (stable(storedValue) === stable(value)) continue;
      if (storedValue === undefined) {
        warnings.push(`${label} (${b['o:layout']}): data key "${key}" was not stored.`);
      } else if (typeof value === 'string' && typeof storedValue === 'string') {
        let at = 0;
        while (at < value.length && value[at] === storedValue[at]) at++;
        warnings.push(
          `${label} (${b['o:layout']}): "${key}" was changed on save (e.g. by HTMLPurifier), first difference at ` +
            `character ${at}: sent ${JSON.stringify(value.slice(at, at + 80))}, stored ${JSON.stringify(storedValue.slice(at, at + 80))}.`,
        );
      } else {
        warnings.push(`${label} (${b['o:layout']}): "${key}" was changed on save.`);
      }
    }
    const sentAttachments = (b['o:attachment'] ?? []).length;
    const storedAttachments = (s['o:attachment'] ?? []).length;
    if (sentAttachments !== storedAttachments) {
      warnings.push(`${label}: sent ${sentAttachments} attachment(s), stored ${storedAttachments}.`);
    }
  });
  return warnings;
}
