const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normaliseCmType,
  typesAreCompatible,
  buildCustomFieldMapping,
  renderMappingFile,
} = require('../utils/matchCustomField');
const {
  cmCustomFieldsToMatchingFields,
  unwrapImporterCustomFields,
} = require('../generateCustomFieldMapping');

test('converts Case Manager field types to NotusPoint types', () => {
  assert.equal(normaliseCmType('List'), 'SELECT');
  assert.equal(normaliseCmType('Boolean'), 'SELECT');
  assert.equal(normaliseCmType('Yes/No'), 'SELECT');
  assert.equal(normaliseCmType('Text', false), 'SHORT_TEXT');
  assert.equal(normaliseCmType('Text', true), 'LONG_TEXT');
  assert.equal(normaliseCmType('Number'), 'NUMBER');
  assert.equal(normaliseCmType('Date'), 'DATE');
  assert.equal(normaliseCmType('Something new'), null);
});

test('matches a Case Manager Boolean to a NotusPoint multiple-choice field', () => {
  const cmFields = cmCustomFieldsToMatchingFields([{
    ID: 'old-boolean',
    Label: 'Plan closing - AIR not required',
    DataTypeName: 'Boolean',
    IsMultiline: false,
    Active: true,
  }]);
  const result = buildCustomFieldMapping(cmFields, [{
    id: 'new-select',
    name: 'Plan closing - AIR not required',
    type: 'SELECT',
  }]);

  assert.equal(result.mapping['old-boolean'], 'new-select');
});

test('treats short and long text as compatible', () => {
  assert.equal(typesAreCompatible('SHORT_TEXT', 'LONG_TEXT'), true);
  assert.equal(typesAreCompatible('LONG_TEXT', 'SHORT_TEXT'), true);
  assert.equal(typesAreCompatible('SHORT_TEXT', 'SHORT_TEXT'), true);
  assert.equal(typesAreCompatible('SHORT_TEXT', 'SELECT'), false);
  assert.equal(typesAreCompatible('DATE', 'SHORT_TEXT'), true);
  assert.equal(typesAreCompatible('DATE', 'LONG_TEXT'), false);
  assert.equal(typesAreCompatible('SHORT_TEXT', 'DATE'), false);
});

test('matches a Case Manager date to NotusPoint short text', () => {
  const result = buildCustomFieldMapping([{
    id: 'old-date',
    name: 'Welfare event notification received',
    type: 'DATE',
    sourceType: 'Date',
  }], [{
    id: 'new-text',
    name: 'Welfare event notification received',
    type: 'SHORT_TEXT',
  }]);

  assert.equal(result.mapping['old-date'], 'new-text');
  assert.match(
    renderMappingFile(result),
    /CaseManager \(DATE\) becomes .* NotusPoint \(SHORT_TEXT\)/,
  );
});

test('normalises Case Manager response fields and excludes inactive fields', () => {
  assert.deepEqual(cmCustomFieldsToMatchingFields([
    {
      ID: 'old-1',
      Label: 'Benefit Type',
      DataTypeName: 'List',
      IsMultiline: false,
      Active: true,
    },
    {
      ID: 'old-2',
      Label: 'Inactive',
      DataTypeName: 'Text',
      Active: false,
    },
  ]), [{
    id: 'old-1',
    name: 'Benefit Type',
    type: 'SELECT',
    sourceType: 'List',
  }]);
});

test('unwraps the NotusPoint matching DTO response', () => {
  assert.deepEqual(unwrapImporterCustomFields([
    {
      id: 'new-1',
      name: 'Benefit Type',
      type: 'SELECT',
      options: [
        { value: 'option-1', label: 'Weekly benefit' },
        { value: 2, label: 20 },
      ],
    },
  ]), [
    {
      id: 'new-1',
      name: 'Benefit Type',
      type: 'SELECT',
      options: [
        { value: 'option-1', label: 'Weekly benefit' },
        { value: '2', label: '20' },
      ],
    },
  ]);
});

test('rejects malformed NotusPoint custom-field options', () => {
  assert.throws(
    () => unwrapImporterCustomFields([{
      id: 'new-1',
      name: 'Benefit Type',
      type: 'SELECT',
      options: [{ label: 'Missing value' }],
    }]),
    /must contain value and label/,
  );
});

test('stores destination options by Case Manager custom field ID', () => {
  const result = buildCustomFieldMapping([
    { id: 'old-1', name: 'Benefit Type', type: 'SELECT', sourceType: 'List' },
    { id: 'old-2', name: 'Empty List', type: 'SELECT', sourceType: 'List' },
  ], [
    {
      id: 'new-1',
      name: 'Benefit Type',
      type: 'SELECT',
      options: [{ value: 'option-1', label: 'Weekly benefit' }],
    },
    { id: 'new-2', name: 'Empty List', type: 'SELECT', options: [] },
  ]);

  assert.deepEqual(result.optionsByCaseManagerFieldId, {
    'old-1': [{ value: 'option-1', label: 'Weekly benefit' }],
    'old-2': [],
  });
  assert.deepEqual(result.labelsByCaseManagerFieldId, {
    'old-1': 'Benefit Type',
    'old-2': 'Empty List',
  });

  const output = renderMappingFile(result);
  assert.match(output, /const customFieldLabelsByCaseManagerId =/);
  assert.match(output, /"old-1": "Benefit Type"/);
  assert.match(output, /LABELS_BY_CASE_MANAGER_FIELD_ID/);
  assert.match(output, /CASE_MANAGER_FIELDS_BY_ID/);
  assert.match(output, /const customFieldOptionsByCaseManagerId =/);
  assert.match(output, /"value": "option-1"/);
  assert.match(output, /"label": "Weekly benefit"/);
  assert.match(output, /OPTIONS_BY_CASE_MANAGER_FIELD_ID/);
});

test('matches only a unique normalised name with the same type', () => {
  const result = buildCustomFieldMapping([
    { id: 'old-1', name: ' Benefit   Type ', type: 'SELECT', sourceType: 'List' },
    { id: 'old-2', name: 'Case note', type: 'LONG_TEXT', sourceType: 'Text' },
    { id: 'old-3', name: 'Start date', type: 'DATE', sourceType: 'Date' },
    { id: 'old-4', name: 'Duplicate', type: 'NUMBER', sourceType: 'Number' },
    { id: 'old-5', name: 'Unknown', type: null, sourceType: 'Checkbox' },
  ], [
    { id: 'new-1', name: 'benefit type', type: 'SELECT' },
    { id: 'new-2', name: 'Case note', type: 'SHORT_TEXT' },
    { id: 'new-3', name: 'Duplicate', type: 'NUMBER' },
    { id: 'new-4', name: 'Duplicate', type: 'NUMBER' },
  ]);

  assert.deepEqual(result.mapping, {
    'old-1': 'new-1',
    'old-2': 'new-2',
    'old-3': null,
    'old-4': null,
    'old-5': null,
  });
  assert.deepEqual(result.unmatched.map((field) => field.id), ['old-3']);
  assert.deepEqual(result.typeMismatches, []);
  assert.deepEqual(result.ambiguous.map(({ oldField }) => oldField.id), ['old-4']);
  assert.deepEqual(result.unsupported.map((field) => field.id), ['old-5']);

  const output = renderMappingFile(result);
  assert.match(output, /^\/\/ Matched: 2$/m);
  assert.match(output, /^\/\/ Unmatched: 3$/m);
  assert.match(output, /"old-1": "new-1"/);
  assert.match(
    output,
    /"Benefit Type" Custom Field in CaseManager \(SELECT\) becomes "benefit type" Custom Field in NotusPoint \(SELECT\)/,
  );
  assert.match(
    output,
    /"Case note" Custom Field in CaseManager \(LONG_TEXT\) becomes "Case note" Custom Field in NotusPoint \(SHORT_TEXT\)/,
  );
  assert.match(
    output,
    /"old-3": null, +\/\/ "Start date" Will not be transferred into NotusPoint as no match could be found\./,
  );
  assert.match(
    output,
    /"old-4": null, +\/\/ "Duplicate" Will not be transferred into NotusPoint as no match could be found\./,
  );
  assert.match(
    output,
    /"old-5": null, +\/\/ "Unknown" Will not be transferred into NotusPoint as no match could be found\./,
  );
  assert.doesNotMatch(output, /Unsupported Case Manager data types:/);
  assert.match(output, /\/\/ Unmatched Case Manager custom fields:/);
  assert.match(output, /\/\/ - "Start date" \[old-3\]/);
  assert.match(output, /\/\/ - "Duplicate" \[old-4\]/);
  assert.match(output, /\/\/ - "Unknown" \[old-5\]/);
});

test('fuzzy custom-field matching considers only compatible field types', () => {
  const result = buildCustomFieldMapping([
    { id: 'old-1', name: 'Client’s Gool', type: 'SHORT_TEXT', sourceType: 'Text' },
  ], [
    { id: 'wrong-type', name: 'Clients Gool', type: 'DATE' },
    { id: 'new-1', name: 'Clients Goal', type: 'LONG_TEXT' },
  ]);

  assert.equal(result.mapping['old-1'], 'new-1');
  assert.match(renderMappingFile(result), /fuzzy match \d+%/);
});
