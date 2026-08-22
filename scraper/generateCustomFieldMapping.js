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
const { attachCaseManagerLookupOptions } = require('./lib/customFieldValues');

const USERNAME = process.env.CM_USER || '';
const PASSWORD = process.env.CM_PASS || '';
const IMPORT_CUSTOM_FIELDS_URL = getNotusPointConfig().customFieldsUrl;
const IMPORTER_API_KEY = process.env.IMPORTER_API_KEY || '';

function cmCustomFieldsToMatchingFields(customFields, lookupRows = []) {
  if (!Array.isArray(customFields)) {
    throw new TypeError('Case Manager custom field list did not return an array');
  }

  const fields = customFields
    .filter((field) => field?.Active !== false)
    .map((field, index) => {
      if (!field?.ID || !field?.Label) {
        throw new TypeError(`Case Manager custom field at index ${index} must contain ID and Label`);
      }
      const columnName = field.ColumnName ?? field.columnName;
      const valueKey = columnName == null || String(columnName).trim() === ''
        ? null
        : /^cc/i.test(String(columnName).trim())
          ? String(columnName).trim()
          : `cc${String(columnName).trim()}`;
      const referenceList = field.ReferenceList ?? field.referenceList;
      const options = Array.isArray(referenceList)
        ? referenceList
          .filter((option) => option?.Active !== false && String(option?.ID) !== '0')
          .map((option) => {
            if (option?.ID == null || option?.Description == null) {
              throw new TypeError(
                `Case Manager custom field at index ${index} has an incomplete ReferenceList option`,
              );
            }
            return { value: String(option.ID), label: String(option.Description) };
          })
        : undefined;
      return {
        id: String(field.ID),
        name: String(field.Label),
        type: normaliseCmType(field.DataTypeName, field.IsMultiline === true),
        sourceType: String(field.DataTypeName ?? ''),
        ...(valueKey ? { valueKey } : {}),
        ...(options !== undefined ? { options } : {}),
      };
    });
  const fieldsWithoutDefinitionOptions = fields.filter((field) => field.options === undefined);
  if (!fieldsWithoutDefinitionOptions.length) return fields;

  const withFallbackOptions = attachCaseManagerLookupOptions(fieldsWithoutDefinitionOptions, lookupRows);
  const fallbackById = new Map(withFallbackOptions.map((field) => [field.id, field]));
  return fields.map((field) => fallbackById.get(field.id) ?? field);
}

async function fetchCustomFieldDefinitions(client, customFields) {
  if (!Array.isArray(customFields)) {
    throw new TypeError('Case Manager custom field list did not return an array');
  }
  if (typeof client?.getCustomFieldDefinition !== 'function') {
    throw new TypeError('Case Manager client must provide getCustomFieldDefinition');
  }

  return Promise.all(customFields
    .filter((field) => field?.Active !== false)
    .map(async (field, index) => {
      if (!field?.ID) {
        throw new TypeError(`Case Manager custom field at index ${index} must contain ID`);
      }
      const detail = await client.getCustomFieldDefinition(field.ID);
      if (!detail || String(detail.ID) !== String(field.ID)) {
        throw new Error(
          `Case Manager custom field detail response did not match requested ID ${field.ID}`,
        );
      }
      // _List supplies DataTypeName/IsMultiline while GetData supplies the
      // authoritative ColumnName and field-specific ReferenceList.
      return { ...field, ...detail };
    }));
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
    let options;
    if (field.options != null) {
      if (!Array.isArray(field.options)) {
        throw new TypeError(`Importer custom field at index ${index}.options must be an array`);
      }
      options = field.options.map((option, optionIndex) => {
        if (option?.value == null || option?.label == null) {
          throw new TypeError(
            `Importer custom field at index ${index}.options[${optionIndex}] must contain value and label`,
          );
        }
        return { value: String(option.value), label: String(option.label) };
      });
    }

    return {
      id: String(id),
      name: String(name),
      type: String(type).toUpperCase(),
      ...(options !== undefined ? { options } : {}),
    };
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
    const cmDefinitions = await fetchCustomFieldDefinitions(client, cmResponse);
    const cmFields = cmCustomFieldsToMatchingFields(cmDefinitions);
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
  fetchCustomFieldDefinitions,
  unwrapImporterCustomFields,
  fetchImporterCustomFields,
  generateCustomFieldMapping,
};
