const AUSTRALIAN_STATE_CODES = new Map([
  ['australian capital territory', 'ACT'],
  ['new south wales', 'NSW'],
  ['northern territory', 'NT'],
  ['queensland', 'QLD'],
  ['south australia', 'SA'],
  ['tasmania', 'TAS'],
  ['victoria', 'VIC'],
  ['western australia', 'WA'],
]);
const FALLBACK_CUSTOMER_NAME = 'Unmatched Customers';

function normaliseAustralianState(value) {
  const state = String(value ?? '').trim();
  if (!state) return '';

  // Case Manager commonly returns "Western Australia (WA)".
  const parenthesisedCode = state.match(/\(([A-Z]{2,3})\)\s*$/i)?.[1];
  if (parenthesisedCode) return parenthesisedCode.toUpperCase();

  const code = AUSTRALIAN_STATE_CODES.get(state.toLocaleLowerCase('en-AU'));
  if (code) return code;
  if (/^(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)$/i.test(state)) {
    return state.toUpperCase();
  }
  return state;
}

function toCustomerImportDto(customer) {
  const source = customer ?? {};
  const name = String(source.name ?? '').trim() || FALLBACK_CUSTOMER_NAME;

  const valueOr = (value, fallback = '') => String(value ?? '').trim() || fallback;
  const address = {
    addressLine1: valueOr(source.addressLine1, 'Placeholder St'),
    addressLine2: valueOr(source.addressLine2),
    suburb: valueOr(source.suburb, 'Placeholderville'),
    postcode: valueOr(source.postcode, '0000'),
    state: normaliseAustralianState(source.state) || 'QLD',
    country: valueOr(source.country, 'Australia'),
  };
  const dto = {
    name,
    addressLine1: address.addressLine1,
    suburb: address.suburb,
    postcode: address.postcode,
    state: address.state,
    country: address.country,
    billingTo: name,
    billingAddress: JSON.stringify(address),
  };
  if (address.addressLine2) dto.addressLine2 = address.addressLine2;
  const email = valueOr(source.email);
  if (email) dto.email = email;
  return dto;
}

async function postCustomer(dto, { url, apiKey, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(dto),
  });

  const body = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(
      `Customer import failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
    );
  }

  // Nest may serialize a returned string as JSON ("uuid") or plain text,
  // depending on the adapter/content type. Accept both representations.
  let customerId = body;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === 'string') customerId = parsed;
  } catch {}
  customerId = customerId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) {
    throw new Error(`Customer import returned an invalid id: ${customerId || '(empty)'}`);
  }
  return customerId;
}

function createCustomerResolver({ url, apiKey, fetchImpl = fetch }) {
  const idByName = new Map();

  return async function resolveCustomerId(customer) {
    const dto = toCustomerImportDto(customer);
    let request = idByName.get(dto.name);
    if (!request) {
      request = postCustomer(dto, { url, apiKey, fetchImpl });
      idByName.set(dto.name, request);
      request.catch(() => idByName.delete(dto.name));
    }
    return request;
  };
}

module.exports = {
  FALLBACK_CUSTOMER_NAME,
  normaliseAustralianState,
  toCustomerImportDto,
  postCustomer,
  createCustomerResolver,
};
