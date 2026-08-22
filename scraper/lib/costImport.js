const BILLING_TYPES = new Set(['HOURLY', 'FIXED_AMOUNT', 'ITEM']);

// New exports carry billingType translated from the logged cost's own
// CaseManager CostType. The linked template item remains a compatibility
// fallback for older exports. Hourly quantities are already seconds.
function toCostImportDtos(caseRecord, resolvedUserIdByEmployeeId, fileIdByDocumentId) {
  const itemById = new Map(
    (caseRecord.billingTemplates ?? []).flatMap((template) =>
      (template.items ?? []).map((item) => [item.id, item]),
    ),
  );
  const costs = [];
  let skipped = 0;
  let unmatchedDocuments = 0;

  for (const cost of caseRecord.costs ?? []) {
    const item = itemById.get(cost.billingInstanceItemId);
    if (!item) {
      skipped++;
      continue;
    }
    const billingType = cost.billingType ?? item.billingType;
    if (!BILLING_TYPES.has(billingType)) {
      throw new Error(
        `Cost linked to billing item ${item.id} has unsupported billing type ${JSON.stringify(billingType)}`,
      );
    }

    const dto = {
      status: cost.status,
      billingType,
      quantity: cost.quantity,
      rate: cost.rate,
      total: cost.total,
      billingInstanceItemId: cost.billingInstanceItemId,
      date: cost.date,
      createdAt: cost.createdAt,
    };
    if (billingType === 'HOURLY') dto.nominalDuration = cost.quantity;

    const userId = resolvedUserIdByEmployeeId.get(cost.employeeId);
    if (userId) dto.userId = userId;
    if (cost.documentId) {
      const fileId = fileIdByDocumentId.get(cost.documentId);
      if (fileId) dto.fileId = fileId;
      else unmatchedDocuments++;
    }
    costs.push(dto);
  }

  return { costs, skipped, unmatchedDocuments };
}

module.exports = { toCostImportDtos };
