const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { createClient } = require('./lib/cmClient');
const {
  DEFAULT_OUTPUT_FILE,
  buildRequirementMapping,
  writeRequirementMappingFile,
} = require('./utils/matchRequirement');

const USERNAME = process.env.CM_USER || '';
const PASSWORD = process.env.CM_PASS || '';
const IMPORT_REQUIREMENTS_URL = process.env.IMPORT_REQUIREMENTS_URL
  || process.env.IMPORT_URL?.replace(/\/case\/?$/, '/requirements/matching')
  || 'http://localhost:8080/api/importer/requirements/matching';
const IMPORTER_API_KEY = process.env.IMPORTER_API_KEY || '';

function cmReferralTypesToNames(referralTypes) {
  if (!Array.isArray(referralTypes)) {
    throw new TypeError('Case Manager ReferralType lookup did not return an array');
  }

  return referralTypes
    .filter((item) => item?.ID && item?.Description)
    .map((item) => ({ id: String(item.ID), name: String(item.Description) }));
}

function unwrapImporterRequirements(body) {
  const requirements = Array.isArray(body)
    ? body
    : body?.requirements ?? body?.data;

  if (!Array.isArray(requirements)) {
    throw new TypeError(
      'Importer matching endpoint must return an array, or an object with a requirements/data array',
    );
  }

  return requirements.map((item, index) => {
    const id = item?.id ?? item?.ID;
    const name = item?.name ?? item?.Name;
    if (id == null || name == null) {
      throw new TypeError(`Importer requirement at index ${index} must contain id and name`);
    }
    return { id: String(id), name: String(name) };
  });
}

async function fetchImporterRequirements({
  url = IMPORT_REQUIREMENTS_URL,
  apiKey = IMPORTER_API_KEY,
} = {}) {
  const response = await fetch(url, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Importer requirements request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
    );
  }

  return unwrapImporterRequirements(await response.json());
}

async function generateRequirementMapping({
  username = USERNAME,
  password = PASSWORD,
  importerUrl = IMPORT_REQUIREMENTS_URL,
  apiKey = IMPORTER_API_KEY,
  outputFile = DEFAULT_OUTPUT_FILE,
  createCmClient = createClient,
} = {}) {
  if (!username || !password) {
    throw new Error('CM_USER and CM_PASS must be set in scraper/.env');
  }
  if (!apiKey) {
    throw new Error('IMPORTER_API_KEY must be set in scraper/.env');
  }

  // Fetch both independent sources together. The CM lookup named
  // "ReferralType" is the value stored on each CM case; its description is
  // what corresponds to a NotusPoint requirement name.
  const client = await createCmClient({ username, password });

  try {
    const [referralTypes, npRequirements] = await Promise.all([
      client.getLookupList('ReferralType'),
      fetchImporterRequirements({ url: importerUrl, apiKey }),
    ]);
    const cmReferralTypes = cmReferralTypesToNames(referralTypes);
    const result = buildRequirementMapping(cmReferralTypes, npRequirements);
    const writtenTo = writeRequirementMappingFile(result, outputFile);

    return {
      ...result,
      writtenTo,
      cmCount: cmReferralTypes.length,
      npCount: npRequirements.length,
    };
  } finally {
    await client.close();
  }
}

async function main() {
  console.error('Fetching CM Referral Types and NotusPoint requirements...');
  console.error(`Importer: ${IMPORT_REQUIREMENTS_URL}`);

  const result = await generateRequirementMapping();
  const fallbackCount = result.unmatched.length + result.ambiguous.length;
  console.error(
    `Mapped ${result.matches.length}/${result.cmCount} CM Referral Type(s) `
    + `against ${result.npCount} NotusPoint requirement(s): `
    + `${result.matches.length - fallbackCount} name match(es), `
    + `${fallbackCount} fallback assignment(s).`,
  );
  console.error(`Wrote ${result.writtenTo}`);

  if (result.unmatched.length) {
    console.error(`${result.unmatched.length} unmatched CM Referral Type(s) were assigned to Unmatched Requirements.`);
  }
  if (result.ambiguous.length) {
    console.error(`${result.ambiguous.length} ambiguous CM Referral Type(s) were assigned to Unmatched Requirements.`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Requirement mapping failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  cmReferralTypesToNames,
  unwrapImporterRequirements,
  fetchImporterRequirements,
  generateRequirementMapping,
};
