const DEFAULT_NOTUSPOINT_URL = 'http://localhost:8080';

function withoutTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function importerRoot(baseUrl) {
  const base = withoutTrailingSlash(baseUrl || DEFAULT_NOTUSPOINT_URL);
  return base.endsWith('/api/importer') ? base : `${base}/api/importer`;
}

function getNotusPointConfig(env = process.env) {
  const baseUrl = withoutTrailingSlash(env.NOTUSPOINT_URL || DEFAULT_NOTUSPOINT_URL);
  const defaultRoot = importerRoot(baseUrl);
  const caseUrl = withoutTrailingSlash(env.IMPORT_URL || `${defaultRoot}/case`);
  const rootFromCaseUrl = caseUrl.replace(/\/case$/, '');
  const root = rootFromCaseUrl === caseUrl ? defaultRoot : rootFromCaseUrl;

  return {
    baseUrl,
    caseUrl,
    customerUrl: env.IMPORT_CUSTOMER_URL || `${root}/customer`,
    fileUrl: env.IMPORT_FILE_URL || `${caseUrl}/file`,
    staffUrl: env.IMPORT_STAFF_URL || `${root}/staff`,
    costsUrl: env.IMPORT_COSTS_URL || `${caseUrl}/costs`,
    requirementsUrl: env.IMPORT_REQUIREMENTS_URL || `${root}/requirements/matching`,
    customFieldsUrl: env.IMPORT_CUSTOM_FIELDS_URL || `${root}/custom-fields/matching`,
  };
}

module.exports = { DEFAULT_NOTUSPOINT_URL, getNotusPointConfig };
