/**
 * Lazy per-process cache of vocabulary terms: properties and resource classes,
 * mapping "prefix:localName" terms to Omeka IDs and back.
 */

import type { Json, OmekaClient } from './omeka.js';

export interface TermInfo {
  id: number;
  term: string;
  label: string;
  comment: string | null;
  vocabulary_id: number | undefined;
}

class TermIndex {
  private byTerm = new Map<string, TermInfo>();
  private byId = new Map<number, TermInfo>();

  constructor(entries: Json[]) {
    for (const e of entries) {
      const info: TermInfo = {
        id: e['o:id'],
        term: e['o:term'],
        label: e['o:label'],
        comment: e['o:comment'] ?? null,
        vocabulary_id: e['o:vocabulary']?.['o:id'],
      };
      this.byTerm.set(info.term, info);
      this.byId.set(info.id, info);
    }
  }

  term(term: string): TermInfo | undefined {
    return this.byTerm.get(term);
  }

  id(id: number): TermInfo | undefined {
    return this.byId.get(id);
  }

  /** Case-insensitive match on term, local name or label; exact matches first. */
  search(query: string, limit = 25): TermInfo[] {
    const q = query.toLowerCase();
    const scored: Array<[number, TermInfo]> = [];
    for (const info of this.byTerm.values()) {
      const term = info.term.toLowerCase();
      const local = term.split(':')[1] ?? term;
      const label = (info.label ?? '').toLowerCase();
      let score = 0;
      if (term === q) score = 4;
      else if (local === q || label === q) score = 3;
      else if (term.startsWith(q) || local.startsWith(q) || label.startsWith(q)) score = 2;
      else if (term.includes(q) || label.includes(q)) score = 1;
      if (score) scored.push([score, info]);
    }
    return scored
      .sort((a, b) => b[0] - a[0] || a[1].term.localeCompare(b[1].term))
      .slice(0, limit)
      .map(([, info]) => info);
  }
}

export class Terms {
  private properties?: Promise<TermIndex>;
  private classes?: Promise<TermIndex>;

  constructor(private readonly client: OmekaClient) {}

  private load(resource: string): Promise<TermIndex> {
    return this.client.listAll(resource).then((all) => new TermIndex(all));
  }

  props(): Promise<TermIndex> {
    this.properties ??= this.load('properties').catch((e) => {
      this.properties = undefined;
      throw e;
    });
    return this.properties;
  }

  resourceClasses(): Promise<TermIndex> {
    this.classes ??= this.load('resource_classes').catch((e) => {
      this.classes = undefined;
      throw e;
    });
    return this.classes;
  }

  /** Resolve a property term to its ID, or throw a helpful error. */
  async propertyId(term: string): Promise<number> {
    const index = await this.props();
    const info = index.term(term);
    if (!info) {
      const suggestions = index.search(term.split(':').pop() ?? term, 5).map((i) => i.term);
      throw new Error(`Unknown property "${term}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`);
    }
    return info.id;
  }

  /** Resolve a resource class term to its ID, or throw a helpful error. */
  async classId(term: string): Promise<number> {
    const index = await this.resourceClasses();
    const info = index.term(term);
    if (!info) {
      const suggestions = index.search(term.split(':').pop() ?? term, 5).map((i) => i.term);
      throw new Error(`Unknown resource class "${term}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`);
    }
    return info.id;
  }

  /** Resolve the property IDs for a list of terms up front (async), returning a sync lookup. */
  async propertyIdLookup(terms: string[]): Promise<(term: string) => number> {
    const ids = new Map<string, number>();
    for (const term of terms) ids.set(term, await this.propertyId(term));
    return (term) => {
      const id = ids.get(term);
      if (id === undefined) throw new Error(`Unknown property "${term}".`);
      return id;
    };
  }
}
