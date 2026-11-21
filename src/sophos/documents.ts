/**
 * Every GraphQL document the exporter sends. All are queries, and all use
 * only operations and fields in the documented Sophos Fusion schemas
 * (Cases v2, Detections v2, AI Defense Activity v1 and AI Defense Policy v1
 * on developer.sophos.com, vendored under schemas/fusion/). The read-only guard lets a document through only when it
 * is one of these strings, character for character; a test validates each
 * against the vendored schemas.
 *
 * Case titles, detection entities, and AI Defense user and device names are
 * selected here, but the mappers drop them unless the personal data switch is
 * on.
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

/** AI Defense settings (license, onboarding) and the inventory totals for a window, in one request. */
export const AI_DEFENSE_OVERVIEW = `query ExportAiDefenseOverview($summary: SecureAIInventorySummaryFilter) {
  secureAITenantSettings {
    onboarding { status }
    licenseState
    licenseType
    licenseExpiryDate
    gracePeriodEndsAt
    renewalPending
    refreshedAt
  }
  inventorySummary(filter: $summary) {
    apps { totalApps criticalRisk highRisk mediumRisk lowRisk infoRisk unknownRisk errorRisk trainsOnData unsanctionedCount }
    users { totalUsers criticalRisk highRisk mediumRisk lowRisk infoRisk unknownRisk withViolations unsanctionedCount }
  }
}`;

export const AI_ACTIVITIES = `query ExportAiActivities($filter: SecureAiActivityFilter, $first: Int64, $after: String) {
  activities(filter: $filter, sort: { field: TIMESTAMP, order: ASC }, first: $first, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    activities {
      id
      timestamp { startTime endTime }
      actor { id name type }
      application { id name }
      applicationProvider { name }
      modelProvider { name }
      model { name }
      sensors { name type }
      action
      policyId
      policy
      device { id name type platform }
      risk
      aggregationCount
      isUnsanctioned
    }
  }
}`;

export const AI_APP_INVENTORY = `query ExportAiAppInventory($filter: SecureAIAppInventoryFilter, $limit: Int64, $offset: Int64) {
  appInventory(filter: $filter, sort: { field: USAGE, order: DESC }, limit: $limit, offset: $offset) {
    totalCount
    offset
    hasNextPage
    entries { id name provider risk usage uniqueUsers lastSeen unsanctionedCount }
  }
}`;

export const AI_USER_INVENTORY = `query ExportAiUserInventory($filter: SecureAIUserInventoryFilter, $limit: Int64, $offset: Int64) {
  userInventory(filter: $filter, sort: { field: USAGE, order: DESC }, limit: $limit, offset: $offset) {
    totalCount
    offset
    hasNextPage
    entries { id name risk appsUsed usage policyViolations topAppId topApp firstSeen lastSeen unsanctionedCount }
  }
}`;

export const AI_APP_SANCTIONING = `query ExportAiAppSanctioning($appIds: [String!]!) {
  appSanctioning(appIds: $appIds) {
    entries {
      appId
      status
      enforcementTargets { mechanism status matchedPolicy { id name } }
    }
  }
}`;

export const AI_POLICIES = `query ExportAiPolicies($first: Int64, $after: String) {
  policies(first: $first, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    policies {
      id
      name
      rank
      priority
      state
      enforcementStatus
      origin
      kind
      builtInKey
      createdAt
      updatedAt
      rules { position action }
      baseRule { generativeAiCategoryAction appControlCategoryAction }
      sensors { endpoint { enabled } firewall { enabled } dns { enabled } browser { enabled } }
    }
  }
}`;

/** Name to document, for the guard and the tests. */
export const DOCUMENTS: ReadonlyMap<string, string> = new Map([
  ["ExportCasesPage", CASES_PAGE],
  ["ExportCaseReferenceData", CASE_REFERENCE_DATA],
  ["ExportDetectionSearch", DETECTION_SEARCH],
  ["ExportDetectionCount", DETECTION_COUNT],
  ["ExportAiDefenseOverview", AI_DEFENSE_OVERVIEW],
  ["ExportAiActivities", AI_ACTIVITIES],
  ["ExportAiAppInventory", AI_APP_INVENTORY],
  ["ExportAiUserInventory", AI_USER_INVENTORY],
  ["ExportAiAppSanctioning", AI_APP_SANCTIONING],
  ["ExportAiPolicies", AI_POLICIES],
]);
