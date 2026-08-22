const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachCaseManagerLookupOptions,
  buildNotusPointCustomFields,
} = require('../lib/customFieldValues');

function mappingWithMetadata(mapping, metadata) {
  Object.defineProperty(mapping, 'CASE_MANAGER_FIELDS_BY_ID', { value: metadata });
  return mapping;
}

test('maps ccUpdated___date to Metlife Date of Update', async () => {
  const mapping = mappingWithMetadata({ cm: 'np' }, {
    cm: { label: 'Metlife Date of Update', type: 'DATE', sourceType: 'Date' },
  });
  const output = await buildNotusPointCustomFields({
    caseId: 'example',
    raw: { ccUpdated___date: '2026-08-21T00:00:00' },
    mapping,
    resolveOption: async () => assert.fail('date fields do not resolve options'),
  });
  assert.deepEqual(output, { np: '2026-08-21' });
});

test('merges duplicate normalized CaseManager lookup keys and ignores zero', async () => {
  const [field] = attachCaseManagerLookupOptions([
    { id: 'cm', name: 'Closure Outcome', type: 'SELECT', sourceType: 'List' },
  ], [
    { ID: 0, Description: '----------', Active: true, LookupType: 'ccClosure_Outcome' },
    { ID: 12526, Description: 'Returned to work', Active: true, LookupType: 'ccClosure_Outcome_' },
  ]);
  assert.deepEqual(field.valueKeys, ['ccClosure_Outcome', 'ccClosure_Outcome_']);
  assert.deepEqual(field.options, [{ value: '12526', label: 'Returned to work' }]);

  const labels = [];
  const mapping = mappingWithMetadata({ cm: 'np' }, { cm: {
    label: field.name,
    type: field.type,
    sourceType: field.sourceType,
    valueKeys: field.valueKeys,
    options: field.options,
  } });
  const output = await buildNotusPointCustomFields({
    caseId: 'example',
    raw: { ccClosure_Outcome: 0, ccClosure_Outcome_: 12526 },
    mapping,
    resolveOption: async (_cm, _np, label) => {
      labels.push(label);
      return 'returned-to-work-id';
    },
  });
  assert.deepEqual(labels, ['Returned to work']);
  assert.deepEqual(output, { np: 'returned-to-work-id' });
});
