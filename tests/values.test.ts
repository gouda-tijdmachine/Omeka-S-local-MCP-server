import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery } from '../src/omeka.ts';
import { compactValue, mergeValues, missingValues, toOmekaValue } from '../src/values.ts';

const ids: Record<string, number> = { 'dcterms:title': 1, 'sdo:keywords': 1358, 'owl:sameAs': 1177 };
const lookup = (t: string) => ids[t];

const item = {
  '@context': 'x',
  'o:id': 7,
  'o:media': [{ 'o:id': 70 }],
  'o:item_set': [{ 'o:id': 3 }],
  'dcterms:title': [{ type: 'literal', property_id: 1, '@value': 'Markt', '@language': 'nl' }],
  'sdo:keywords': [{ type: 'literal', property_id: 1358, '@value': 'plein' }],
  'owl:sameAs': [{ type: 'uri', property_id: 1177, '@id': 'https://n2t.net/ark:/60537/b0x' }],
};

test('toOmekaValue infers data types', () => {
  assert.deepEqual(toOmekaValue({ value: 'a', lang: 'nl' }, 1), { type: 'literal', property_id: 1, '@value': 'a', '@language': 'nl' });
  assert.deepEqual(toOmekaValue({ uri: 'http://x', label: 'X' }, 1), { type: 'uri', property_id: 1, '@id': 'http://x', 'o:label': 'X' });
  assert.deepEqual(toOmekaValue({ resource: 5 }, 1), { type: 'resource:item', property_id: 1, value_resource_id: 5 });
  assert.equal(toOmekaValue({ value: 1880, type: 'numeric:timestamp' }, 1)['@value'], '1880');
  assert.throws(() => toOmekaValue({ lang: 'nl' }, 1));
});

test('compactValue round-trips the simplified notation', () => {
  assert.deepEqual(compactValue(item['dcterms:title'][0]), { value: 'Markt', lang: 'nl' });
  assert.deepEqual(compactValue(item['owl:sameAs'][0]), { uri: 'https://n2t.net/ark:/60537/b0x' });
  assert.deepEqual(
    compactValue({ type: 'resource:itemset', value_resource_id: 9, display_title: 'Set' }),
    { resource: 9, title: 'Set', type: 'resource:itemset' },
  );
});

test('set replaces only the given term and keeps everything else', () => {
  const out = mergeValues(item, { 'dcterms:title': { mode: 'set', values: [{ value: 'Grote Markt', lang: 'nl' }] } }, lookup);
  assert.equal(out['dcterms:title'].length, 1);
  assert.equal(out['dcterms:title'][0]['@value'], 'Grote Markt');
  assert.deepEqual(out['owl:sameAs'], item['owl:sameAs']);
  assert.deepEqual(out['sdo:keywords'], item['sdo:keywords']);
  assert.deepEqual(out['o:media'], item['o:media']);
  assert.deepEqual(out['o:item_set'], item['o:item_set']);
  assert.equal(item['dcterms:title'][0]['@value'], 'Markt', 'input is not mutated');
});

test('add appends and skips duplicates', () => {
  const out = mergeValues(item, { 'sdo:keywords': { mode: 'add', values: [{ value: 'plein' }, { value: 'markt' }, { value: 'markt' }] } }, lookup);
  assert.deepEqual(out['sdo:keywords'].map((v: any) => v['@value']), ['plein', 'markt']);
});

test('remove drops single values or the whole term', () => {
  const one = mergeValues(item, { 'sdo:keywords': { mode: 'add', values: [{ value: 'markt' }] } }, lookup);
  const removed = mergeValues(one, { 'sdo:keywords': { mode: 'remove', values: [{ value: 'plein' }] } }, lookup);
  assert.deepEqual(removed['sdo:keywords'].map((v: any) => v['@value']), ['markt']);
  const gone = mergeValues(item, { 'sdo:keywords': { mode: 'remove', values: [] } }, lookup);
  assert.equal('sdo:keywords' in gone, false);
  assert.deepEqual(gone['owl:sameAs'], item['owl:sameAs']);
});

test('missingValues reports values Omeka dropped', () => {
  const sent = { 'sdo:keywords': [toOmekaValue({ value: 'plein' }, 1358), toOmekaValue({ value: 'x', type: 'bogus' }, 1358)] };
  const warnings = missingValues(sent, item);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bogus/);
});

test('buildQuery serialises nested filters the PHP way', () => {
  const qs = buildQuery({ property: [{ property: 1, type: 'in', text: 'Markt' }], id: [1, 2], is_public: true, skip: undefined });
  assert.equal(
    decodeURIComponent(qs.toString()),
    'property[0][property]=1&property[0][type]=in&property[0][text]=Markt&id[]=1&id[]=2&is_public=1',
  );
});

const ids2: Record<string, number> = { ...ids, 'sdo:description': 993, 'prov:hadPrimarySource': 5042 };
const lookup2 = (t: string) => ids2[t];

const annotated = {
  'o:id': 8,
  'sdo:description': [
    {
      type: 'literal', property_id: 993, '@value': 'Oud', '@language': 'nl',
      '@annotation': { 'prov:hadPrimarySource': [{ type: 'resource:item', property_id: 5042, value_resource_id: 1, display_title: 'Bron 1' }] },
    },
    { type: 'literal', property_id: 993, '@value': 'Nieuw', '@language': 'nl' },
  ],
};

test('annotations are converted both ways', () => {
  const v = toOmekaValue({ value: 'x', lang: 'nl', annotation: { 'prov:hadPrimarySource': [{ resource: 5 }] } }, 993, lookup2);
  assert.deepEqual(v['@annotation'], { 'prov:hadPrimarySource': [{ type: 'resource:item', property_id: 5042, value_resource_id: 5 }] });
  assert.throws(() => toOmekaValue({ value: 'x', annotation: { 'prov:hadPrimarySource': [{ resource: 5 }] } }, 993));
  assert.deepEqual(compactValue(annotated['sdo:description'][0]), {
    value: 'Oud', lang: 'nl', annotation: { 'prov:hadPrimarySource': [{ resource: 1, title: 'Bron 1' }] },
  });
});

test('uri values carry their language as o:lang', () => {
  assert.equal(toOmekaValue({ uri: 'http://x', lang: 'nl' }, 1)['o:lang'], 'nl');
  assert.equal(compactValue({ type: 'uri', '@id': 'http://x', 'o:lang': 'nl' }).lang, 'nl');
});

test('updates keep existing annotations; annotate replaces or removes them', () => {
  const kept = mergeValues(annotated, { 'sdo:description': { mode: 'add', values: [{ value: 'Derde', lang: 'nl' }] } }, lookup2);
  assert.deepEqual(kept['sdo:description'][0]['@annotation'], annotated['sdo:description'][0]['@annotation']);

  const set = mergeValues(annotated, {
    'sdo:description': { mode: 'annotate', values: [{ value: 'Nieuw', lang: 'nl', annotation: { 'prov:hadPrimarySource': [{ resource: 2 }] } }] },
  }, lookup2);
  assert.equal(set['sdo:description'][1]['@annotation']['prov:hadPrimarySource'][0].value_resource_id, 2);
  assert.ok(set['sdo:description'][0]['@annotation'], 'other value untouched');

  const removed = mergeValues(annotated, { 'sdo:description': { mode: 'annotate', values: [{ value: 'Oud', lang: 'nl' }] } }, lookup2);
  assert.equal('@annotation' in removed['sdo:description'][0], false);
  assert.ok(annotated['sdo:description'][0]['@annotation'], 'input is not mutated');

  assert.throws(() => mergeValues(annotated, { 'sdo:description': { mode: 'annotate', values: [{ value: 'Bestaat niet' }] } }, lookup2), /no existing value/);
});

test('missingValues reports dropped annotation values', () => {
  const sent = { 'sdo:description': [toOmekaValue({ value: 'Oud', lang: 'nl', annotation: { 'prov:hadPrimarySource': [{ resource: 1 }, { resource: 99 }] } }, 993, lookup2)] };
  const warnings = missingValues(sent, annotated);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /annotation prov:hadPrimarySource/);
});
