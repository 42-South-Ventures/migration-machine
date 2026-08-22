const test = require('node:test');
const assert = require('node:assert/strict');
const { getNotusPointConfig } = require('../lib/notuspointConfig');

test('derives every importer endpoint from NOTUSPOINT_URL', () => {
  assert.deepEqual(getNotusPointConfig({ NOTUSPOINT_URL: 'https://dev.example.com/' }), {
    baseUrl: 'https://dev.example.com',
    caseUrl: 'https://dev.example.com/api/importer/case',
    customerUrl: 'https://dev.example.com/api/importer/customer',
    fileUrl: 'https://dev.example.com/api/importer/case/file',
    staffUrl: 'https://dev.example.com/api/importer/staff',
    costsUrl: 'https://dev.example.com/api/importer/case/costs',
    requirementsUrl: 'https://dev.example.com/api/importer/requirements/matching',
    customFieldsUrl: 'https://dev.example.com/api/importer/custom-fields/matching',
    customFieldOptionsUrl: 'https://dev.example.com/api/importer/custom-fields',
  });
});

test('keeps legacy and endpoint-specific overrides working', () => {
  const config = getNotusPointConfig({
    IMPORT_URL: 'https://legacy.example.com/api/importer/case/',
    IMPORT_FILE_URL: 'https://uploads.example.com/file',
  });

  assert.equal(config.caseUrl, 'https://legacy.example.com/api/importer/case');
  assert.equal(config.staffUrl, 'https://legacy.example.com/api/importer/staff');
  assert.equal(config.fileUrl, 'https://uploads.example.com/file');
  assert.equal(config.requirementsUrl, 'https://legacy.example.com/api/importer/requirements/matching');
});

test('accepts a base URL that already includes the importer path', () => {
  const config = getNotusPointConfig({
    NOTUSPOINT_URL: 'https://prod.example.com/api/importer',
  });

  assert.equal(config.caseUrl, 'https://prod.example.com/api/importer/case');
});
