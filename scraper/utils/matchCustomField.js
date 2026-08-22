const fs = require('fs');
const path = require('path');
const { normaliseName, findFuzzyMatch } = require('./matchRequirement');

const DEFAULT_OUTPUT_FILE = path.join(__dirname, '..', 'mappings', 'customFieldMapping.js');
const NP_TYPES = new Set(['SELECT', 'SHORT_TEXT', 'LONG_TEXT', 'NUMBER', 'DATE']);
const TEXT_TYPES = new Set(['SHORT_TEXT', 'LONG_TEXT']);

function typesAreCompatible(sourceType, destinationType) {
  return sourceType === destinationType
    || (TEXT_TYPES.has(sourceType) && TEXT_TYPES.has(destinationType))
    // Dates can be preserved as their formatted text in a short-text field.
    || (sourceType === 'DATE' && destinationType === 'SHORT_TEXT');
}

function normaliseCmType(dataTypeName, isMultiline = false) {
  const type = normaliseName(dataTypeName).replace(/[^a-z0-9]+/g, '');

  // NotusPoint has no Boolean custom-field type. Boolean values migrate into
  // a SELECT/multiple-choice field (for example Yes/No).
  if (['list', 'dropdown', 'select', 'choice', 'boolean', 'bool', 'yesno'].includes(type)) {
    return 'SELECT';
  }
  if (['text', 'string', 'shorttext'].includes(type)) {
    return isMultiline ? 'LONG_TEXT' : 'SHORT_TEXT';
  }
  if (['longtext', 'multilinetext', 'memo'].includes(type)) return 'LONG_TEXT';
  if (['number', 'integer', 'decimal', 'currency'].includes(type)) return 'NUMBER';
  if (['date', 'datetime'].includes(type)) return 'DATE';
  return null;
}

function validateField(field, source, index) {
  if (!field || typeof field !== 'object') {
    throw new TypeError(`${source}[${index}] must be an object`);
  }
  if (typeof field.id !== 'string' || !field.id.trim()) {
    throw new TypeError(`${source}[${index}].id must be a non-empty string`);
  }
  if (typeof field.name !== 'string' || !field.name.trim()) {
    throw new TypeError(`${source}[${index}].name must be a non-empty string`);
  }
}

function buildCustomFieldMapping(fieldsFromCM, fieldsFromNP) {
  if (!Array.isArray(fieldsFromCM) || !Array.isArray(fieldsFromNP)) {
    throw new TypeError('fieldsFromCM and fieldsFromNP must both be arrays');
  }

  fieldsFromCM.forEach((field, index) => validateField(field, 'fieldsFromCM', index));
  fieldsFromNP.forEach((field, index) => {
    validateField(field, 'fieldsFromNP', index);
    if (!NP_TYPES.has(field.type)) {
      throw new TypeError(`fieldsFromNP[${index}].type is not a supported NotusPoint custom field type`);
    }
  });

  const npByName = new Map();
  for (const field of fieldsFromNP) {
    const name = normaliseName(field.name);
    const candidates = npByName.get(name) ?? [];
    candidates.push(field);
    npByName.set(name, candidates);
  }

  const mapping = {};
  const matches = [];
  const unmatched = [];
  const ambiguous = [];
  const typeMismatches = [];
  const unsupported = [];
  const entries = [];
  const optionsByCaseManagerFieldId = {};
  const labelsByCaseManagerFieldId = {};
  const caseManagerFieldsById = {};

  for (const oldField of fieldsFromCM) {
    labelsByCaseManagerFieldId[oldField.id] = oldField.name;
    caseManagerFieldsById[oldField.id] = {
      label: oldField.name,
      type: oldField.type,
      sourceType: oldField.sourceType,
      ...(oldField.valueKey ? { valueKey: oldField.valueKey } : {}),
      ...(Array.isArray(oldField.options) ? { options: oldField.options } : {}),
    };
    if (!oldField.type || !NP_TYPES.has(oldField.type)) {
      unsupported.push(oldField);
      mapping[oldField.id] = null;
      entries.push({ oldField, newField: null });
      continue;
    }

    const sameName = npByName.get(normaliseName(oldField.name)) ?? [];
    let candidates = sameName.filter((field) =>
      typesAreCompatible(oldField.type, field.type));
    let matchType = 'exact';
    let score = 1;

    if (candidates.length === 0) {
      const compatibleFields = fieldsFromNP.filter((field) =>
        typesAreCompatible(oldField.type, field.type));
      const fuzzy = findFuzzyMatch(oldField.name, compatibleFields);
      if (fuzzy) {
        candidates = [fuzzy.candidate];
        matchType = 'fuzzy';
        score = fuzzy.score;
      }
    }

    if (candidates.length === 0) {
      if (sameName.length) typeMismatches.push({ oldField, candidates: sameName });
      else unmatched.push(oldField);
      mapping[oldField.id] = null;
      entries.push({ oldField, newField: null });
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.push({ oldField, candidates });
      mapping[oldField.id] = null;
      entries.push({ oldField, newField: null });
      continue;
    }

    const newField = candidates[0];
    mapping[oldField.id] = newField.id;
    if (Array.isArray(newField.options)) {
      optionsByCaseManagerFieldId[oldField.id] = newField.options;
    }
    matches.push({ oldField, newField, matchType, score });
    entries.push({ oldField, newField, matchType, score });
  }

  return {
    mapping,
    labelsByCaseManagerFieldId,
    caseManagerFieldsById,
    optionsByCaseManagerFieldId,
    entries,
    matches,
    unmatched,
    ambiguous,
    typeMismatches,
    unsupported,
  };
}

function oneLine(text) {
  return String(text ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function renderMappingFile(result) {
  const matchedCount = result.matches.length;
  const unmatchedCount = result.entries.length - matchedCount;
  const lines = [
    '// Generated by generateCustomFieldMapping.js. Do not edit by hand.',
    `// Matched: ${matchedCount}`,
    `// Unmatched: ${unmatchedCount}`,
    '// Every active Case Manager custom field is listed; null means it will not be transferred.',
    'const customFieldMapping = {',
    '  // CaseManager custom field ID                 NotusPoint custom field ID',
  ];

  for (const { oldField, newField, matchType, score } of result.entries) {
    const destination = newField ? JSON.stringify(newField.id) : 'null';
    const fuzzyNote = matchType === 'fuzzy' ? ` (fuzzy match ${Math.round(score * 100)}%)` : '';
    const description = newField
      ? `${JSON.stringify(oneLine(oldField.name))} Custom Field in CaseManager (${oldField.type}) becomes ${JSON.stringify(oneLine(newField.name))} Custom Field in NotusPoint (${newField.type})${fuzzyNote}`
      : `${JSON.stringify(oneLine(oldField.name))} Will not be transferred into NotusPoint as no match could be found.`;
    const destinationColumn = `${destination},`.padEnd(40);
    lines.push(
      `  ${JSON.stringify(oldField.id)}: ${destinationColumn}// ${description}`,
    );
  }

  lines.push(
    '};',
    '',
    '// Original Case Manager labels, keyed by Case Manager custom field ID.',
    `const customFieldLabelsByCaseManagerId = ${JSON.stringify(result.labelsByCaseManagerFieldId, null, 2)};`,
    '',
    "Object.defineProperty(customFieldMapping, 'LABELS_BY_CASE_MANAGER_FIELD_ID', {",
    '  value: customFieldLabelsByCaseManagerId,',
    '});',
    '',
    '// Case Manager field metadata used to extract and interpret case values.',
    `const caseManagerFieldsById = ${JSON.stringify(result.caseManagerFieldsById, null, 2)};`,
    '',
    "Object.defineProperty(customFieldMapping, 'CASE_MANAGER_FIELDS_BY_ID', {",
    '  value: caseManagerFieldsById,',
    '});',
    '',
    '// NotusPoint option IDs and labels, keyed by Case Manager custom field ID.',
    `const customFieldOptionsByCaseManagerId = ${JSON.stringify(result.optionsByCaseManagerFieldId, null, 2)};`,
    '',
    "Object.defineProperty(customFieldMapping, 'OPTIONS_BY_CASE_MANAGER_FIELD_ID', {",
    '  value: customFieldOptionsByCaseManagerId,',
    '});',
    '',
    'module.exports = customFieldMapping;',
    '',
  );

  const unmatchedEntries = result.entries.filter(({ newField }) => !newField);
  if (unmatchedEntries.length) {
    lines.push('// Unmatched Case Manager custom fields:');
    for (const { oldField } of unmatchedEntries) {
      lines.push(`// - ${JSON.stringify(oneLine(oldField.name))} [${oneLine(oldField.id)}]`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function writeCustomFieldMappingFile(result, outputFile = DEFAULT_OUTPUT_FILE) {
  const resolvedOutputFile = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(resolvedOutputFile), { recursive: true });
  const temporaryFile = `${resolvedOutputFile}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryFile, renderMappingFile(result), 'utf8');
  fs.renameSync(temporaryFile, resolvedOutputFile);
  return resolvedOutputFile;
}

module.exports = {
  DEFAULT_OUTPUT_FILE,
  NP_TYPES,
  typesAreCompatible,
  normaliseCmType,
  buildCustomFieldMapping,
  renderMappingFile,
  writeCustomFieldMappingFile,
};
