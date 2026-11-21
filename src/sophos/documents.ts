/**
 * Every GraphQL document the exporter sends. All are queries, and all use
 * only operations and fields in the documented Sophos Fusion schemas
 * (Cases v2 and Detections v2 on developer.sophos.com, vendored under
 * schemas/fusion/). The read-only guard lets a document through only when it
 * is one of these strings, character for character; a test validates each
 * against the vendored schemas.
 *
 * Case titles and detection entities are selected here, but the mappers drop
 * them unless the personal data switch is on.
 */

export const CASES_PAGE = `query ExportCasesPage($arguments: CasesArguments!) {
  cases(arguments: $arguments) {
    totalCount
    pageInfo { endCursor hasNextPage }
    cases {
      id
      shortId
      title
      severity
      type { id name title }
      primaryStatus { id name title isClosed }
      secondaryStatus { id name title }
      primaryVerdict { id name title }
      secondaryVerdict { id name title }
      closeReason
      managedBy
      isCreatedByMDRProvider
      isCreatedByPartner
      assigneeId
      tenantId
      createdAt
      updatedAt
      closedAt
      archivedAt
      riskScore
      source { id name title }
      tags
      detectionsCount
      eventsCount
      assetsCount
    }
  }
}`;

export const CASE_REFERENCE_DATA = `query ExportCaseReferenceData {
  caseTypes(arguments: {}) { types { id name title managedBy } }
  casePrimaryStatuses(arguments: {}) { primaryStatuses { id name title isClosed } }
  caseSecondaryStatuses(arguments: {}) { secondaryStatuses { id name title } }
  casePrimaryVerdicts(arguments: {}) { primaryVerdicts { id name title } }
  caseSecondaryVerdicts(arguments: {}) { secondaryVerdicts { id name title } }
}`;

export const DETECTION_SEARCH = `query ExportDetectionSearch($in: SearchRequestInput!) {
  detectionSearch(in: $in) {
    status
    reason
    alerts {
      total_results
      next_offset
      list {
        id
        status
        resolution_reason
        attack_technique_ids
        sensor_types
        threat_score
        metadata {
          title
          description
          severity
          confidence
          created_at { seconds }
          first_seen_at { seconds }
          creator { detector { detector_id detector_name } }
        }
        enrichment_details { mitre_attack_info { technique_id technique tactics } }
        investigation_ids { id }
        source_entities { display_name subtype }
        target_entities { display_name subtype }
      }
    }
  }
}`;

export const DETECTION_COUNT = `query ExportDetectionCount($in: AlertsCountByTenantInput!) {
  detectionCountByTenant(in: $in) {
    items { count tenant { id } }
  }
}`;

/** Name to document, for the guard and the tests. */
export const DOCUMENTS: ReadonlyMap<string, string> = new Map([
  ["ExportCasesPage", CASES_PAGE],
  ["ExportCaseReferenceData", CASE_REFERENCE_DATA],
  ["ExportDetectionSearch", DETECTION_SEARCH],
  ["ExportDetectionCount", DETECTION_COUNT],
]);
