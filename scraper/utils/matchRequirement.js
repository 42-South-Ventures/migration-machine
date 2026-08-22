const fs = require('fs');
const path = require('path');

const DEFAULT_OUTPUT_FILE = path.join(__dirname, '..', 'mappings', 'requirementMapping.js');
const FALLBACK_REQUIREMENT_NAME = 'Unmatched Requirements';

const normaliseName = (text) => {
  if (typeof text !== 'string') return '';

  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-AU')
    .trim()
    .replace(/\s+/g, ' ');
};

// More permissive normalisation used only after exact matching fails. It
// makes typographic apostrophes/punctuation and diacritics irrelevant while
// retaining word boundaries for token comparison.
const normaliseFuzzyName = (text) => {
  if (typeof text !== 'string') return '';

  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-AU')
    .replace(/&/g, ' and ')
    .replace(/[\u2018\u2019'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
};

function levenshteinDistance(left, right) {
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function fuzzyNameScore(left, right) {
  const a = normaliseFuzzyName(left);
  const b = normaliseFuzzyName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const charScore = 1 - levenshteinDistance(a, b) / Math.max(a.length, b.length);
  const aTokens = new Set(a.split(' '));
  const bTokens = new Set(b.split(' '));
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const diceScore = (2 * intersection) / (aTokens.size + bTokens.size);
  const shorterSize = Math.min(aTokens.size, bTokens.size);
  const containmentScore = shorterSize >= 2 && intersection === shorterSize
    ? 0.9 - 0.02 * Math.abs(aTokens.size - bTokens.size)
    : 0;

  return Math.max(charScore, diceScore, containmentScore);
}

// A fuzzy match must be strong and clearly better than the runner-up. This
// deliberately favours leaving a row null over guessing between close names.
function findFuzzyMatch(sourceName, candidates, {
  minimumScore = 0.82,
  minimumLead = 0.05,
} = {}) {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: fuzzyNameScore(sourceName, candidate.name) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best || best.score < minimumScore) return null;

  const runnerUp = ranked[1];
  if (runnerUp && best.score - runnerUp.score < minimumLead) return null;
  return best;
}

function validateRequirement(requirement, source, index) {
  if (!requirement || typeof requirement !== 'object') {
    throw new TypeError(`${source}[${index}] must be an object`);
  }
  if (typeof requirement.id !== 'string' || !requirement.id.trim()) {
    throw new TypeError(`${source}[${index}].id must be a non-empty string`);
  }
  if (typeof requirement.name !== 'string' || !requirement.name.trim()) {
    throw new TypeError(`${source}[${index}].name must be a non-empty string`);
  }
}

function buildRequirementMapping(namesFromCM, namesFromNP) {
  if (!Array.isArray(namesFromCM) || !Array.isArray(namesFromNP)) {
    throw new TypeError('namesFromCM and namesFromNP must both be arrays');
  }

  namesFromCM.forEach((item, index) => {
    validateRequirement(item, 'namesFromCM', index);
  });
  namesFromNP.forEach((item, index) => {
    validateRequirement(item, 'namesFromNP', index);
  });

  // Keep every new-system item under its normalised name. More than one item
  // with the same name is ambiguous, so it must not be selected silently.
  const npByName = new Map();
  for (const requirement of namesFromNP) {
    const name = normaliseName(requirement.name);
    const requirements = npByName.get(name) ?? [];
    requirements.push(requirement);
    npByName.set(name, requirements);
  }

  const fallbackRequirements = namesFromNP.filter(
    ({ name }) => name === FALLBACK_REQUIREMENT_NAME,
  );
  if (fallbackRequirements.length !== 1) {
    throw new Error(
      `NotusPoint must contain exactly one requirement named "${FALLBACK_REQUIREMENT_NAME}"`,
    );
  }
  const fallbackRequirement = fallbackRequirements[0];

  const mapping = {};
  const matches = [];
  const unmatched = [];
  const ambiguous = [];

  for (const oldRequirement of namesFromCM) {
    let candidates = npByName.get(normaliseName(oldRequirement.name)) ?? [];
    let matchType = 'exact';
    let score = 1;

    if (candidates.length === 0) {
      const fuzzy = findFuzzyMatch(oldRequirement.name, namesFromNP);
      if (fuzzy) {
        candidates = [fuzzy.candidate];
        matchType = 'fuzzy';
        score = fuzzy.score;
      }
    }

    if (candidates.length === 0) {
      unmatched.push(oldRequirement);
    } else if (candidates.length > 1) {
      ambiguous.push({ oldRequirement, candidates });
    }

    // Anything without one unique name match is deliberately sent to the
    // configured catch-all requirement instead of being left unmapped.
    const newRequirement = candidates.length === 1
      ? candidates[0]
      : fallbackRequirement;
    const existingNewId = mapping[oldRequirement.id];
    if (existingNewId && existingNewId !== newRequirement.id) {
      throw new Error(
        `Old requirement id ${oldRequirement.id} matched more than one new id`,
      );
    }

    // Keep unsuccessful matches visibly distinct in the generated table.
    // The uploader resolves an explicit null to UNMATCHED_REQUIREMENT_ID.
    mapping[oldRequirement.id] = candidates.length === 1
      ? newRequirement.id
      : null;
    matches.push({ oldRequirement, newRequirement, matchType, score });
  }

  Object.defineProperty(mapping, 'UNMATCHED_REQUIREMENT_ID', {
    value: fallbackRequirement.id,
  });

  return { mapping, matches, unmatched, ambiguous, fallbackRequirement };
}

function oneLine(text) {
  return text.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function renderMappingFile(result) {
  const unmatchedCount = result.unmatched.length + result.ambiguous.length;
  const matchedCount = result.matches.length - unmatchedCount;
  const lines = [
    '// Generated by utils/matchRequirement.js. Do not edit by hand.',
    `// Matched: ${matchedCount}`,
    `// Unmatched: ${unmatchedCount}`,
    'const requirementMapping = {',
  ];

  for (const { oldRequirement, newRequirement, matchType, score } of result.matches) {
    const fuzzyNote = matchType === 'fuzzy' ? ` (fuzzy match ${Math.round(score * 100)}%)` : '';
    const description = `"${oneLine(oldRequirement.name)}" in CaseManager becomes "${oneLine(newRequirement.name)}" in NotusPoint${fuzzyNote}`;
    const destination = result.mapping[oldRequirement.id];
    lines.push(
      `  ${JSON.stringify(oldRequirement.id)}: ${JSON.stringify(destination)}, // ${description}`,
    );
  }

  lines.push(
    '};',
    '',
    '// Used when a CM case has no Referral Type selected.',
    `Object.defineProperty(requirementMapping, 'UNMATCHED_REQUIREMENT_ID', { value: ${JSON.stringify(result.fallbackRequirement.id)} });`,
    '',
    'module.exports = requirementMapping;',
    '',
  );

  if (result.ambiguous.length > 0) {
    lines.push(`// Ambiguous old requirements assigned to ${FALLBACK_REQUIREMENT_NAME}:`);
    for (const { oldRequirement, candidates } of result.ambiguous) {
      const ids = candidates.map(({ id }) => oneLine(id)).join(', ');
      lines.push(`// ${oneLine(oldRequirement.name)} (${oneLine(oldRequirement.id)}): ${ids}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function writeRequirementMappingFile(result, outputFile = DEFAULT_OUTPUT_FILE) {
  const resolvedOutputFile = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(resolvedOutputFile), { recursive: true });

  // Write then rename so an interrupted run cannot leave a partial mapping.
  const temporaryFile = `${resolvedOutputFile}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryFile, renderMappingFile(result), 'utf8');
  fs.renameSync(temporaryFile, resolvedOutputFile);

  return resolvedOutputFile;
}

function resolveRequirementId(requirementMapping, caseRecord) {
  const referralTypeId = caseRecord.referralTypeId;
  if (!referralTypeId) {
    const unmatchedRequirementId =
      requirementMapping.UNMATCHED_REQUIREMENT_ID;
    if (unmatchedRequirementId) return unmatchedRequirementId;
    throw new Error(`Case ${caseRecord.caseId} has no Case Manager Referral Type ID and the mapping has no Unmatched Requirements fallback`);
  }

  if (!Object.prototype.hasOwnProperty.call(requirementMapping, referralTypeId)) {
    throw new Error(
      `Case ${caseRecord.caseId} Referral Type ${referralTypeId} is missing from mappings/requirementMapping.js; regenerate the mapping`,
    );
  }

  const requirementId = requirementMapping[referralTypeId];
  if (requirementId === null) {
    const unmatchedRequirementId = requirementMapping.UNMATCHED_REQUIREMENT_ID;
    if (unmatchedRequirementId) return unmatchedRequirementId;
    throw new Error(`Case ${caseRecord.caseId} Referral Type ${referralTypeId} is unmatched and the mapping has no Unmatched Requirements fallback`);
  }
  if (!requirementId) {
    throw new Error(
      `Case ${caseRecord.caseId} Referral Type ${referralTypeId} has an invalid requirement mapping`,
    );
  }

  return requirementId;
}

// Names are { name: string, id: string } for both systems. This returns the
// old-id -> new-id object and writes the same mapping to a CommonJS file.
function matchRequirement(namesFromCM, namesFromNP, outputFile = DEFAULT_OUTPUT_FILE) {
  const result = buildRequirementMapping(namesFromCM, namesFromNP);
  writeRequirementMappingFile(result, outputFile);
  return result.mapping;
}

module.exports = {
  DEFAULT_OUTPUT_FILE,
  FALLBACK_REQUIREMENT_NAME,
  normaliseName,
  normaliseFuzzyName,
  fuzzyNameScore,
  findFuzzyMatch,
  buildRequirementMapping,
  renderMappingFile,
  writeRequirementMappingFile,
  resolveRequirementId,
  matchRequirement,
};
