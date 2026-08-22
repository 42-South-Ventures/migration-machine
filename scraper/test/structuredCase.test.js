const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStructuredCase, contactRolesForImport } = require('../lib/structured');
const { normaliseAustralianState } = require('../lib/importerCustomer');

test('normalizes Australian state names and parenthesized lookup labels', () => {
  assert.equal(normaliseAustralianState('Western Australia'), 'WA');
  assert.equal(normaliseAustralianState('Queensland (QLD)'), 'QLD');
  assert.equal(normaliseAustralianState('nsw'), 'NSW');
});

test('removes excluded roles while retaining and expanding other roles', () => {
  assert.deepEqual(contactRolesForImport({
    PrimaryRoleName: 'QA',
    RoleNames: 'QA, Doctor',
  }), ['Doctor']);
  assert.deepEqual(contactRolesForImport({
    PrimaryRoleName: 'Doctor',
    RoleNames: 'Doctor, Nurse',
  }), ['Doctor', 'Nurse']);
  assert.deepEqual(contactRolesForImport({
    PrimaryRoleName: 'Referrer',
    RoleNames: 'Referrer, Workcom Admin',
  }), []);
});

test('maps CaseManager Team and Office to clientRegion and clientSubregion', () => {
  const structured = buildStructuredCase('123', {
    '/Case/GetData': [{ TeamID: 'team-id', OfficeID: 'office-id' }],
    '/CaseContact/_List': [{
      data: [{
        ID: 'client-id',
        PrimaryRoleName: 'Client',
        FirstName: 'Jane',
        LastName: 'Smith',
      }],
    }],
    '/CaseContact/GetData': [{
      ID: 'client-id',
      ContactInfo: { RegionID: 'state-id' },
    }],
  }, {
    'team-id': 'Sydney Region',
    'office-id': 'Sydney Office',
    'state-id': 'New South Wales (NSW)',
  }, {});

  assert.equal(structured.clientRegion, 'Sydney Region');
  assert.equal(structured.clientSubregion, 'Sydney Office');
  assert.equal(structured.clientAddress.state, 'NSW');
});
