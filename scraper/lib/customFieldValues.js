const { normaliseFuzzyName, findFuzzyMatch } = require('../utils/matchRequirement');

const CUSTOM_FIELD_META_KEYS = new Set([
  'CaseNumber', 'Source', 'DisplayOnCaseDetails', 'CategoryID', 'ROP',
]);

function normaliseCaseManagerValueKey(value) {
  return normaliseFuzzyName(
    String(value ?? '')
      .replace(/^cc/i, '')
      .replace(/(?:DatePart|TimePart)$/i, ''),
  );
}

function attachCaseManagerLookupOptions(fields, lookupRows) {
  if (!Array.isArray(lookupRows)) {
    throw new TypeError('Case Manager custom-field lookups must be an array');
  }

  const rowsByLookupType = new Map();
  for (const [index, row] of lookupRows.entries()) {
    if (!row || row.LookupType == null || row.ID == null || row.Description == null) {
      throw new TypeError(`Case Manager custom-field lookup at index ${index} is incomplete`);
    }
    if (row.Active === false) continue;
    const lookupType = String(row.LookupType);
    const rows = rowsByLookupType.get(lookupType) ?? [];
    rows.push(row);
    rowsByLookupType.set(lookupType, rows);
  }

  const lookupTypes = [...rowsByLookupType.keys()].map((lookupType) => ({
    id: lookupType,
    name: normaliseCaseManagerValueKey(lookupType),
    lookupType,
  }));

  return fields.map((field) => {
    if (field.type !== 'SELECT') return field;

    const fieldName = normaliseFuzzyName(field.name);
    const exact = lookupTypes.filter(({ name }) => name === fieldName);
    let selected = exact.length === 1 ? exact[0] : null;
    if (!selected && exact.length === 0) {
      selected = findFuzzyMatch(field.name, lookupTypes)?.candidate ?? null;
    }
    if (!selected) return field;

    const options = rowsByLookupType.get(selected.lookupType)
      .filter((row) => String(row.ID) !== '0')
      .map((row) => ({ value: String(row.ID), label: String(row.Description) }));
    return { ...field, valueKey: selected.lookupType, options };
  });
}

function buildCaseManagerFieldMetadata(fields) {
  return Object.fromEntries(fields.map((field) => [field.id, {
    label: field.name,
    type: field.type,
    sourceType: field.sourceType,
    ...(field.valueKey ? { valueKey: field.valueKey } : {}),
    ...(Array.isArray(field.options) ? { options: field.options } : {}),
  }]));
}

function rawValueGroups(raw) {
  const groups = new Map();
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (CUSTOM_FIELD_META_KEYS.has(key) || !/^cc/i.test(key)) continue;
    const name = normaliseCaseManagerValueKey(key);
    const group = groups.get(name) ?? { id: name, name, values: [] };
    group.values.push({ key, value });
    groups.set(name, group);
  }
  return [...groups.values()];
}

function findRawValue(field, raw, groups) {
  if (field.valueKey && Object.prototype.hasOwnProperty.call(raw, field.valueKey)) {
    return [{ key: field.valueKey, value: raw[field.valueKey] }];
  }

  const label = normaliseFuzzyName(field.label);
  const exact = groups.filter((group) => group.name === label);
  if (exact.length === 1) return exact[0].values;
  if (exact.length > 1) return null;
  return findFuzzyMatch(field.label, groups)?.candidate?.values ?? null;
}

function isEmptyValue(value, field) {
  if (value == null || value === '') return true;
  return field.type === 'SELECT' && (value === 0 || value === '0');
}

function dateText(value) {
  if (typeof value !== 'string') return String(value);
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(value.trim())) {
    return value.trim();
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/);
  if (!match) return value.trim();
  return match[1];
}

function combineRawValues(values, field) {
  const populated = values.filter(({ value }) => !isEmptyValue(value, field));
  if (!populated.length) return undefined;
  if (populated.length === 1) return populated[0].value;

  const datePart = populated.find(({ key }) => /DatePart$/i.test(key));
  const timePart = populated.find(({ key }) => /TimePart$/i.test(key));
  if (datePart || timePart) {
    const date = datePart ? dateText(datePart.value) : '';
    const timeMatch = String(timePart?.value ?? '').match(/(?:T|^)(\d{2}:\d{2}(?::\d{2})?)/);
    const time = timeMatch && !/^00:00(?::00)?$/.test(timeMatch[1]) ? timeMatch[1] : '';
    return [date, time].filter(Boolean).join(' ');
  }

  throw new Error(`More than one Case Manager value key matched "${field.label}"`);
}

function sourceSelectLabel(field, value) {
  if (/^(boolean|bool|yes\/?no)$/i.test(field.sourceType ?? '')) {
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (value === 1 || value === '1') return 'Yes';
  }

  const option = field.options?.find((item) => String(item.value) === String(value));
  if (option) return option.label;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return value.trim();
  throw new Error(
    `Case Manager option ${value} for "${field.label}" has no label in GetAllLookups`,
  );
}

function scalarValue(field, value) {
  if (field.type === 'DATE') return dateText(value);
  if (field.type === 'NUMBER') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error(`"${field.label}" is not a valid number`);
    return number;
  }
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  return String(value);
}

function normaliseOptionLabel(label) {
  return String(label ?? '').trim().toLocaleLowerCase('en-AU');
}

function createCustomFieldOptionResolver({
  baseUrl,
  apiKey,
  fieldMapping = {},
  optionsByCaseManagerFieldId = {},
  fetchImpl = fetch,
}) {
  const cached = new Map();
  const inFlight = new Map();

  for (const [cmFieldId, options] of Object.entries(optionsByCaseManagerFieldId)) {
    const npFieldId = fieldMapping[cmFieldId];
    if (!npFieldId) continue;
    for (const option of options) {
      cached.set(`${npFieldId}\0${normaliseOptionLabel(option.label)}`, String(option.value));
    }
  }

  return async function resolveOption(cmFieldId, npFieldId, label) {
    const normalized = normaliseOptionLabel(label);
    const key = `${npFieldId}\0${normalized}`;
    if (cached.has(key)) return cached.get(key);
    if (inFlight.has(key)) return inFlight.get(key);

    const request = (async () => {
      const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(npFieldId)}/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ label: String(label).trim() }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Custom-field option creation failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
        );
      }
      // Nest may return Promise<string> as a JSON string, a plain-text UUID,
      // or an object depending on the configured HTTP adapter/content type.
      const responseText = await response.text();
      let body = responseText.trim();
      try {
        body = JSON.parse(body);
      } catch {
        // A raw UUID is a valid response from this endpoint.
      }
      const optionId = typeof body === 'string' ? body : body?.id ?? body?.value;
      if (!optionId) {
        throw new Error(
          `Custom-field option endpoint returned no option ID for ${JSON.stringify(String(label).trim())}`,
        );
      }
      cached.set(key, String(optionId));
      return String(optionId);
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  };
}

async function buildNotusPointCustomFields({
  caseId,
  raw,
  mapping,
  resolveOption,
}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Case ${caseId} has no /CustomField/GetData export; re-export it before uploading`);
  }
  const metadata = mapping.CASE_MANAGER_FIELDS_BY_ID;
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('Custom-field mapping is outdated; regenerate it before uploading');
  }

  const groups = rawValueGroups(raw);
  const output = {};
  for (const [cmFieldId, npFieldId] of Object.entries(mapping)) {
    if (!npFieldId) continue;
    const field = metadata[cmFieldId];
    if (!field) throw new Error(`Custom-field mapping has no Case Manager metadata for ${cmFieldId}`);
    const matchedValues = findRawValue(field, raw, groups);
    if (!matchedValues) continue;
    const rawValue = combineRawValues(matchedValues, field);
    if (rawValue === undefined) continue;

    const value = field.type === 'SELECT'
      ? await resolveOption(cmFieldId, npFieldId, sourceSelectLabel(field, rawValue))
      : scalarValue(field, rawValue);
    if (Object.prototype.hasOwnProperty.call(output, npFieldId) && output[npFieldId] !== value) {
      throw new Error(`Case ${caseId} has conflicting values mapped to custom field ${npFieldId}`);
    }
    output[npFieldId] = value;
  }
  return output;
}

module.exports = {
  normaliseCaseManagerValueKey,
  attachCaseManagerLookupOptions,
  buildCaseManagerFieldMetadata,
  createCustomFieldOptionResolver,
  buildNotusPointCustomFields,
};
