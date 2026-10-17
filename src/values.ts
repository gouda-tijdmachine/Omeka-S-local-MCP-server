/**
 * Conversion between a simplified value notation (what the tools accept and
 * return) and Omeka S JSON-LD property values, plus the GET+merge+PUT logic.
 */

import type { Json } from './omeka.js';

/** Simplified value as accepted by the write tools. */
export interface SimpleValue {
  /** Literal value (also used for numeric:*, geography:*, customvocab literals, ...). */
  value?: string | number;
  /** Language tag for literals and URIs, e.g. "nl". */
  lang?: string;
  /** URI value. */
  uri?: string;
  /** Label of a URI value. */
  label?: string;
  /** ID of a linked Omeka resource (item, item set or media). */
  resource?: number;
  /** Explicit Omeka data type, e.g. "numeric:timestamp", "resource:itemset", "customvocab:3". */
  type?: string;
  /** Set to false to make this value private. */
  public?: boolean;
  /** Value annotation: property values about this value, keyed by term (e.g. a source). */
  annotation?: Record<string, SimpleValue[]>;
}

export type UpdateMode = 'set' | 'add' | 'remove' | 'annotate';

export type PropertyIdOf = (term: string) => number;

export interface TermUpdate {
  mode: UpdateMode;
  values?: SimpleValue[];
}

/** Keys of a resource representation that hold property values. */
export function isValueKey(key: string): boolean {
  return key.includes(':') && !key.startsWith('o:') && !key.startsWith('@') && !key.startsWith('o-');
}

export function inferType(v: SimpleValue): string {
  if (v.type) return v.type;
  if (v.resource !== undefined) return 'resource:item';
  if (v.uri !== undefined) return 'uri';
  return 'literal';
}

/** All terms used in a values map, including the terms inside value annotations. */
export function collectTerms(values: Record<string, SimpleValue[] | undefined>): string[] {
  const terms = new Set<string>();
  for (const [term, list] of Object.entries(values)) {
    terms.add(term);
    for (const v of list ?? []) {
      if (v.annotation) collectTerms(v.annotation).forEach((t) => terms.add(t));
    }
  }
  return [...terms];
}

/** Build an Omeka value object from the simplified notation. */
export function toOmekaValue(v: SimpleValue, propertyId: number, propertyIdOf?: PropertyIdOf): Json {
  const type = inferType(v);
  const out: Json = { type, property_id: propertyId };
  if (v.public === false) out.is_public = false;
  if (v.resource !== undefined) {
    out.value_resource_id = v.resource;
  } else if (v.uri !== undefined) {
    out['@id'] = v.uri;
    if (v.label !== undefined) out['o:label'] = v.label;
    if (v.lang) out['o:lang'] = v.lang;
  } else if (v.value !== undefined) {
    out['@value'] = String(v.value);
    if (v.lang) out['@language'] = v.lang;
  } else {
    throw new Error(`Value of type "${type}" needs one of "value", "uri" or "resource".`);
  }
  // Some data types (e.g. valuesuggest) carry a URI and a literal label at once.
  if (v.uri !== undefined && v.value !== undefined && out['@value'] === undefined) out['@value'] = String(v.value);
  if (v.annotation && Object.keys(v.annotation).length) {
    if (!propertyIdOf) throw new Error('Value annotations need a property lookup.');
    out['@annotation'] = toOmekaAnnotation(v.annotation, propertyIdOf);
  }
  return out;
}

/** Build the @annotation object of a value. */
export function toOmekaAnnotation(annotation: Record<string, SimpleValue[]>, propertyIdOf: PropertyIdOf): Json {
  const out: Json = {};
  for (const [term, list] of Object.entries(annotation)) {
    if (list.some((a) => a.annotation)) throw new Error(`Annotations cannot be nested (${term}).`);
    if (list.length) out[term] = list.map((a) => toOmekaValue(a, propertyIdOf(term)));
  }
  return out;
}

export type CompactValue = Omit<SimpleValue, 'annotation'> & { title?: string; annotation?: Record<string, CompactValue[]> };

/** Render an Omeka value object in the simplified notation. */
export function compactValue(v: Json): CompactValue {
  const out: CompactValue = {};
  const type: string = v.type ?? 'literal';
  if (v.value_resource_id !== undefined) {
    out.resource = v.value_resource_id;
    if (v.display_title !== undefined) out.title = v.display_title;
    if (type !== 'resource:item') out.type = type;
  } else {
    if (v['@id'] !== undefined) {
      out.uri = v['@id'];
      if (v['o:label']) out.label = v['o:label'];
    }
    if (v['@value'] !== undefined) out.value = v['@value'];
    if (v['@language'] || v['o:lang']) out.lang = v['@language'] || v['o:lang'];
    const defaultType = v['@id'] !== undefined && v['@value'] === undefined ? 'uri' : 'literal';
    if (type !== defaultType) out.type = type;
  }
  if (v.is_public === false) out.public = false;
  const annotation = v['@annotation'];
  if (annotation && typeof annotation === 'object' && !Array.isArray(annotation)) {
    const entries = Object.entries(annotation).filter(([key, list]) => isValueKey(key) && Array.isArray(list) && list.length);
    if (entries.length) out.annotation = Object.fromEntries(entries.map(([key, list]) => [key, (list as Json[]).map(compactValue)]));
  }
  return out;
}

/** Identity of a value, used for de-duplication, removal and read-back checks. */
export function valueKey(v: Json): string {
  if (v.value_resource_id !== undefined) return `r:${v.value_resource_id}`;
  if (v['@id'] !== undefined) return `u:${v['@id']}`;
  return `l:${String(v['@value'] ?? '').trim()}|${v['@language'] ?? ''}`;
}

/** Same identity for a simplified value. */
export function simpleValueKey(v: SimpleValue): string {
  const { annotation: _annotation, ...plain } = v;
  return valueKey(toOmekaValue(plain, 0));
}

export function valuesOf(resource: Json): Record<string, Json[]> {
  const out: Record<string, Json[]> = {};
  for (const [key, value] of Object.entries(resource ?? {})) {
    if (isValueKey(key) && Array.isArray(value)) out[key] = value;
  }
  return out;
}

/**
 * Apply term updates to a full resource representation (as returned by GET).
 * Everything not mentioned (other terms, all o: fields) is left untouched.
 * Returns a new object; the input is not modified.
 */
export function mergeValues(resource: Json, updates: Record<string, TermUpdate>, propertyIdOf: PropertyIdOf): Json {
  const out: Json = { ...resource };
  for (const [term, update] of Object.entries(updates)) {
    const existing: Json[] = Array.isArray(out[term]) ? out[term] : [];
    if (update.mode === 'annotate') {
      out[term] = annotateValues(term, existing, update.values ?? [], propertyIdOf);
      continue;
    }
    const incoming = (update.values ?? []).map((v) => toOmekaValue(v, propertyIdOf(term), propertyIdOf));
    switch (update.mode) {
      case 'set':
        if (incoming.length) out[term] = incoming;
        else delete out[term];
        break;
      case 'add': {
        const seen = new Set(existing.map(valueKey));
        const added = incoming.filter((v) => {
          const key = valueKey(v);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        out[term] = [...existing, ...added];
        break;
      }
      case 'remove': {
        if (!update.values || update.values.length === 0) {
          delete out[term];
          break;
        }
        const drop = new Set(incoming.map(valueKey));
        const kept = existing.filter((v) => !drop.has(valueKey(v)));
        if (kept.length) out[term] = kept;
        else delete out[term];
        break;
      }
      default:
        throw new Error(`Unknown mode "${(update as TermUpdate).mode}" for ${term}.`);
    }
  }
  return out;
}

/**
 * Mode "annotate": give existing values (matched by identity) a new annotation.
 * An empty or missing annotation removes it. Unknown values are an error.
 */
function annotateValues(term: string, existing: Json[], targets: SimpleValue[], propertyIdOf: PropertyIdOf): Json[] {
  const result = existing.map((v) => ({ ...v }));
  for (const target of targets) {
    const key = simpleValueKey(target);
    const matches = result.filter((v) => valueKey(v) === key);
    if (!matches.length) {
      throw new Error(`${term}: no existing value ${JSON.stringify({ ...target, annotation: undefined })} to annotate.`);
    }
    for (const v of matches) {
      if (target.annotation && Object.keys(target.annotation).length) v['@annotation'] = toOmekaAnnotation(target.annotation, propertyIdOf);
      else delete v['@annotation'];
    }
  }
  return result;
}

/**
 * Compare what was sent with what Omeka stored. Omeka silently drops values
 * with an invalid data type, so anything missing is reported.
 */
export function missingValues(sent: Record<string, Json[]>, stored: Json): string[] {
  const warnings: string[] = [];
  for (const [term, values] of Object.entries(sent)) {
    const storedKeys = new Set((Array.isArray(stored?.[term]) ? stored[term] : []).map(valueKey));
    const storedList: Json[] = Array.isArray(stored?.[term]) ? stored[term] : [];
    for (const v of values) {
      if (!storedKeys.has(valueKey(v))) {
        warnings.push(
          `${term}: value ${JSON.stringify(compactValue(v))} (type ${v.type}) is not present after saving; ` +
            'Omeka probably rejected the data type or normalised the value.',
        );
        continue;
      }
      // Check the annotation values of this value as well.
      const sentAnnotation: Json = v['@annotation'] ?? {};
      const storedValue = storedList.find((s) => valueKey(s) === valueKey(v));
      for (const [aTerm, aValues] of Object.entries(sentAnnotation)) {
        const storedAnnotation = new Set(((storedValue?.['@annotation']?.[aTerm] ?? []) as Json[]).map(valueKey));
        for (const av of aValues as Json[]) {
          if (!storedAnnotation.has(valueKey(av))) {
            warnings.push(
              `${term}: annotation ${aTerm} ${JSON.stringify(compactValue(av))} (type ${av.type}) on value ` +
                `${JSON.stringify(compactValue({ ...v, '@annotation': undefined }))} is not present after saving.`,
            );
          }
        }
      }
    }
  }
  return warnings;
}

const idOf = (ref: Json): number | undefined => (ref && typeof ref === 'object' ? ref['o:id'] : undefined);

/** Compact, token-friendly rendering of any Omeka resource representation. */
export function compactResource(r: Json, termOfClass?: (id: number) => string | undefined): Json {
  if (!r || typeof r !== 'object') return r;
  const out: Json = { id: r['o:id'] };
  const types: string[] = ([] as string[]).concat(r['@type'] ?? []);
  if (types.length) out.type = types.join(', ');
  for (const key of ['o:title', 'o:label', 'o:term', 'o:name', 'o:slug', 'o:email', 'o:role', 'o:ingester', 'o:renderer', 'o:media_type', 'o:source', 'o:lang']) {
    if (r[key] !== undefined && r[key] !== null && r[key] !== '') out[key.slice(2)] = r[key];
  }
  if (r['o:is_public'] !== undefined) out.is_public = r['o:is_public'];
  const classId = idOf(r['o:resource_class']);
  if (classId !== undefined) out.resource_class = termOfClass?.(classId) ?? classId;
  const templateId = idOf(r['o:resource_template']);
  if (templateId !== undefined) out.resource_template_id = templateId;
  const ownerId = idOf(r['o:owner']);
  if (ownerId !== undefined) out.owner_id = ownerId;
  if (r['o:item']) out.item_id = idOf(r['o:item']);
  if (Array.isArray(r['o:item_set']) && r['o:item_set'].length) out.item_set_ids = r['o:item_set'].map(idOf);
  if (Array.isArray(r['o:site']) && r['o:site'].length) out.site_ids = r['o:site'].map(idOf);
  if (Array.isArray(r['o:media']) && r['o:media'].length) out.media_ids = r['o:media'].map(idOf);
  if (r['o:original_url']) out.original_url = r['o:original_url'];
  if (r['thumbnail_display_urls']?.large) out.thumbnail = r['thumbnail_display_urls'].large;
  if (r['o:created']?.['@value']) out.created = r['o:created']['@value'];
  if (r['o:modified']?.['@value']) out.modified = r['o:modified']['@value'];
  const values = valuesOf(r);
  if (Object.keys(values).length) {
    out.values = Object.fromEntries(Object.entries(values).map(([term, vs]) => [term, vs.map(compactValue)]));
  }
  return out;
}

/** Strip noise from a full representation (JSON-LD context). */
export function fullResource(r: Json): Json {
  if (!r || typeof r !== 'object') return r;
  const { '@context': _ctx, ...rest } = r;
  return rest;
}
