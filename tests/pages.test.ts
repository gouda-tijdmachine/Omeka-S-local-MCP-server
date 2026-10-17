import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBlockOps, blockWarnings, compactPage, toOmekaBlock, truncateStrings } from '../src/pages.ts';

const blocks = [
  { 'o:layout': 'pageTitle', 'o:data': [], 'o:attachment': [] },
  { 'o:layout': 'html', 'o:data': { html: '<p>A</p>' }, 'o:layout_data': { grid_column_span: '12' }, 'o:attachment': [] },
  { 'o:layout': 'html', 'o:data': { html: '<p>B</p><script>x()</script>' }, 'o:attachment': [{ 'o:item': { 'o:id': 5 }, 'o:media': null, 'o:caption': '' }] },
];
const layouts = (bs: any[]) => bs.map((b) => b['o:layout'] + (b['o:data']?.html ?? ''));

test('block operations run in order on a copy', () => {
  const { blocks: out, touched } = applyBlockOps(blocks, [
    { op: 'append', block: { layout: 'markdown', data: { markdown: '# M' } } },
    { op: 'update', index: 1, data: { html: '<p>A2</p>' } },
    { op: 'move', index: 3, to: 1 },
    { op: 'delete', index: 0 },
    { op: 'insert', index: 0, block: { layout: 'html', data: { html: '<p>first</p>' } } },
  ]);
  assert.deepEqual(layouts(out), ['html<p>first</p>', 'markdown', 'html<p>A2</p>', 'html<p>B</p><script>x()</script>']);
  assert.deepEqual(out[2]['o:layout_data'], { grid_column_span: '12' }, 'update keeps layout data');
  assert.equal(touched.size, 3);
  assert.ok(!touched.has(out[3]));
  assert.equal(blocks[1]['o:data'].html, '<p>A</p>', 'input is not mutated');
  assert.throws(() => applyBlockOps(blocks, [{ op: 'delete', index: 3 }]), /out of range/);
});

test('toOmekaBlock builds attachments', () => {
  assert.deepEqual(toOmekaBlock({ layout: 'media', attachments: [{ item: 1, caption: 'c' }] })['o:attachment'], [
    { 'o:item': { 'o:id': 1 }, 'o:media': null, 'o:caption': 'c' },
  ]);
});

test('blockWarnings spots data rewritten on save, also in untouched blocks', () => {
  const { blocks: sent, touched } = applyBlockOps(blocks, [{ op: 'update', index: 1, data: { html: '<p>A</p><style>p{}</style>' } }]);
  const stored = sent.map((b) => ({ ...b, 'o:data': { ...b['o:data'] } }));
  stored[1]['o:data'].html = '<p>A</p>';
  stored[2]['o:data'].html = '<p>B</p>';
  const w = blockWarnings(sent, touched, stored);
  assert.equal(w.length, 2);
  assert.match(w[0], /^Block 1 .*changed on save/);
  assert.match(w[1], /^Untouched block 2 /);
  assert.deepEqual(blockWarnings(sent, touched, sent), []);
});

test('blockWarnings ignores data keys a layout derives itself', () => {
  const md = [{ 'o:layout': 'markdown', 'o:data': { markdown: '# A', html: '<h1>A</h1>' }, 'o:attachment': [] }];
  const { blocks: sent, touched } = applyBlockOps(md, [{ op: 'update', index: 0, data: { markdown: '# B' } }]);
  const stored = [{ ...sent[0], 'o:data': { markdown: '# B', html: '<h1>B</h1>' } }];
  assert.deepEqual(blockWarnings(sent, touched, stored), []);
});

test('compactPage truncates long block strings and selects one block', () => {
  const page = { 'o:id': 1, 'o:title': 'T', 'o:slug': 't', 'o:site': { 'o:id': 2 }, 'o:block': [{ 'o:layout': 'markdown', 'o:data': { markdown: 'x'.repeat(1000) } }] };
  assert.match(compactPage(page, { maxString: 100 }).blocks[0].data.markdown, /truncated: 1000/);
  assert.equal(compactPage(page, { maxString: 100, blockIndex: 0 }).blocks[0].data.markdown.length, 1000);
  assert.equal(truncateStrings({ a: ['abc'] }, 2).a[0].startsWith('ab…'), true);
});
