const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNotusPointCustomFields } = require('../lib/customFieldValues');

test('uses Unknown when a populated select ID has no CaseManager lookup label', async () => {
  const mapping = { 'cm-field': 'np-field' };
  Object.defineProperty(mapping, 'CASE_MANAGER_FIELDS_BY_ID', {
    value: {
      'cm-field': {
        label: 'Acenda - status at closure',
        type: 'SELECT',
        sourceType: 'List',
        valueKey: 'ccAcenda_status_at_closure',
        options: [],
      },
    },
  });
  const labels = [];

  const result = await buildNotusPointCustomFields({
    caseId: '11524',
    raw: { ccAcenda_status_at_closure: 12572 },
    mapping,
    resolveOption: async (_cmId, _npId, label) => {
      labels.push(label);
      return 'unknown-option-id';
    },
  });

  assert.deepEqual(labels, ['Unknown']);
  assert.deepEqual(result, { 'np-field': 'unknown-option-id' });
});
