const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { createClient } = require('./lib/cmClient');
const {
  DEFAULT_OUTPUT_FILE,
  normaliseCmType,
  buildCustomFieldMapping,
  writeCustomFieldMappingFile,
} = require('./utils/matchCustomField');
const { getNotusPointConfig } = require('./lib/notuspointConfig');

const USERNAME = process.env.CM_USER || '';
const PASSWORD = process.env.CM_PASS || '';
const IMPORT_CUSTOM_FIELDS_URL = getNotusPointConfig().customFieldsUrl;
const IMPORTER_API_KEY = process.env.IMPORTER_API_KEY || '';

function cmCustomFieldsToMatchingFields(customFields) {
  if (!Array.isArray(customFields)) {
    throw new TypeError('Case Manager custom field list did not return an array');
  }

  return customFields
    .filter((field) => field?.Active !== false)
    .map((field, index) => {
      if (!field?.ID || !field?.Label) {
        throw new TypeError(`Case Manager custom field at index ${index} must contain ID and Label`);
      }
      return {
        id: String(field.ID),
        name: String(field.Label),
        type: normaliseCmType(field.DataTypeName, field.IsMultiline === true),
        sourceType: String(field.DataTypeName ?? ''),
      };
    });
}

function unwrapImporterCustomFields(body) {
  const fields = Array.isArray(body) ? body : body?.customFields ?? body?.data;
  if (!Array.isArray(fields)) {
    throw new TypeError(
      'Importer matching endpoint must return an array, or an object with a customFields/data array',
    );
  }

  return fields.map((field, index) => {
    const id = field?.id ?? field?.ID;
    const name = field?.name ?? field?.Name;
    const type = field?.type ?? field?.Type;
    if (id == null || name == null || type == null) {
      throw new TypeError(`Importer custom field at index ${index} must contain id, name and type`);
    }
    return { id: String(id), name: String(name), type: String(type).toUpperCase() };
  });
}

async function fetchImporterCustomFields({
  url = IMPORT_CUSTOM_FIELDS_URL,
  apiKey = IMPORTER_API_KEY,
} = {}) {
  const response = await fetch(url, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Importer custom fields request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
    );
  }
  return unwrapImporterCustomFields(await response.json());
}

async function generateCustomFieldMapping({
  username = USERNAME,
  password = PASSWORD,
  importerUrl = IMPORT_CUSTOM_FIELDS_URL,
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

  const client = await createCmClient({ username, password });
  try {
    const [cmResponse, npFields] = await Promise.all([
      client.getCustomFieldList(),
      fetchImporterCustomFields({ url: importerUrl, apiKey }),
    ]);
    const cmFields = cmCustomFieldsToMatchingFields(cmResponse);
    const result = buildCustomFieldMapping(cmFields, npFields);
    const writtenTo = writeCustomFieldMappingFile(result, outputFile);
    return { ...result, writtenTo, cmCount: cmFields.length, npCount: npFields.length };
  } finally {
    await client.close();
  }
}

async function main() {
  console.error('Fetching Case Manager and NotusPoint custom fields...');
  console.error(`Importer: ${IMPORT_CUSTOM_FIELDS_URL}`);
  const result = await generateCustomFieldMapping();
  console.error(
    `Mapped ${result.matches.length}/${result.cmCount} Case Manager custom field(s) `
    + `against ${result.npCount} NotusPoint custom field(s).`,
  );
  console.error(`Wrote ${result.writtenTo}`);

  if (result.unmatched.length) console.error(`${result.unmatched.length} field(s) had no name match.`);
  if (result.typeMismatches.length) console.error(`${result.typeMismatches.length} field(s) had a type mismatch.`);
  if (result.ambiguous.length) console.error(`${result.ambiguous.length} field(s) had ambiguous matches.`);
  if (result.unsupported.length) console.error(`${result.unsupported.length} field(s) had unsupported Case Manager types.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Custom field mapping failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  cmCustomFieldsToMatchingFields,
  unwrapImporterCustomFields,
  fetchImporterCustomFields,
  generateCustomFieldMapping,
};
