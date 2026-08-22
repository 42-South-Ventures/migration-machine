const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRequirementMapping,
  fuzzyNameScore,
  findFuzzyMatch,
  renderMappingFile,
  resolveRequirementId,
} = require('../utils/matchRequirement');

test('reports unique requirement matches separately from fallback assignments', () => {
  const result = buildRequirementMapping([
    { id: 'old-1', name: 'Assessment' },
    { id: 'old-2', name: 'Missing' },
    { id: 'old-3', name: 'Duplicate' },
  ], [
    { id: 'new-1', name: 'Assessment' },
    { id: 'new-2', name: 'Duplicate' },
    { id: 'new-3', name: 'Duplicate' },
    { id: 'fallback', name: 'Unmatched Requirements' },
  ]);

  const output = renderMappingFile(result);
  assert.deepEqual(result.mapping, {
    'old-1': 'new-1',
    'old-2': null,
    'old-3': null,
  });
  assert.match(output, /^\/\/ Matched: 1$/m);
  assert.match(output, /^\/\/ Unmatched: 2$/m);
  assert.match(output, /"old-2": null, \/\/ "Missing"/);
  assert.equal(
    resolveRequirementId(result.mapping, {
      caseId: 'case-1',
      referralTypeId: 'old-2',
    }),
    'fallback',
  );
  assert.throws(
    () => resolveRequirementId(result.mapping, {
      caseId: 'case-1',
      referralTypeId: 'not-exported',
    }),
    /missing from mappings\/requirementMapping\.js/,
  );
});

test('fuzzy matching handles punctuation, misspellings, and a missing word', () => {
  assert.equal(fuzzyNameScore('Worker’s Compensation', 'Workers Compensation'), 1);
  assert.ok(fuzzyNameScore('Initial Needs Assesment', 'Initial Needs Assessment') > 0.9);
  assert.ok(fuzzyNameScore('Initial Needs Assessment', 'Needs Assessment') > 0.85);

  const result = buildRequirementMapping([
    { id: 'old-1', name: 'Worker’s Compensation' },
    { id: 'old-2', name: 'Initial Needs Assesment' },
    { id: 'old-3', name: 'Vocational Needs Assessment' },
  ], [
    { id: 'new-1', name: 'Workers Compensation' },
    { id: 'new-2', name: 'Initial Needs Assessment' },
    { id: 'new-3', name: 'Needs Assessment' },
    { id: 'fallback', name: 'Unmatched Requirements' },
  ]);

  assert.deepEqual(result.mapping, {
    'old-1': 'new-1',
    'old-2': 'new-2',
    'old-3': 'new-3',
  });
  assert.match(renderMappingFile(result), /fuzzy match \d+%/);
});

test('fuzzy matching rejects close ties', () => {
  assert.equal(findFuzzyMatch('Case Status', [
    { id: 'new-1', name: 'Case Statuz' },
    { id: 'new-2', name: 'Case Statux' },
  ]), null);

  const result = buildRequirementMapping(
    [{ id: 'old-1', name: 'Case Status' }],
    [
      { id: 'new-1', name: 'Case Statuz' },
      { id: 'new-2', name: 'Case Statux' },
      { id: 'fallback', name: 'Unmatched Requirements' },
    ],
  );
  assert.equal(result.mapping['old-1'], null);
});
