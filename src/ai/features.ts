import type { ConfigState, Feature, Routing, SavedProfile } from '../ai-provider'

/**
 * A row in the settings page's feature assignment. A row may cover several internal feature
 * names: rewriting, expanding, shortening and tone all follow the polish profile, yet keep their
 * own names on every call so they can be split into rows of their own later.
 */
export interface FeatureGroup {
  feature: Feature
  label: string
  members: readonly Feature[]
  desktopOnly?: boolean
}

export const featureGroups: readonly FeatureGroup[] = [
  { feature: 'ask', label: 'aiProvider.featureAsk', members: [] },
  { feature: 'polish', label: 'aiProvider.featurePolish', members: ['extension:rewrite', 'extension:expand', 'extension:shorten', 'extension:tone'] },
  { feature: 'extension:continue', label: 'aiProvider.featureContinue', members: [] },
  { feature: 'proofread', label: 'aiProvider.featureProofread', members: [] },
  { feature: 'extension:summary', label: 'aiProvider.featureSummary', members: [] },
  { feature: 'bookSummary', label: 'aiProvider.featureBookSummary', members: [] },
  { feature: 'extension:webSummary', label: 'aiProvider.featureWebSummary', members: [], desktopOnly: true },
  { feature: 'extension:styleAnalysis', label: 'aiProvider.featureStyleAnalysis', members: [] },
]

/** The row a feature name belongs to. */
export function groupOf(feature: Feature): FeatureGroup | undefined {
  return featureGroups.find((group) => group.feature === feature || group.members.includes(feature))
}

/**
 * Writes one row's choice into the routing: `undefined` follows the default profile, `null` turns
 * the feature off, a string names a profile. Members get the same value as their row.
 */
export function assignFeature(routing: Routing, feature: Feature, value: string | null | undefined): Routing {
  const group = groupOf(feature)
  const byFeature = { ...routing.byFeature }
  for (const name of group ? [group.feature, ...group.members] : [feature]) {
    if (value === undefined) delete byFeature[name]
    else byFeature[name] = value
  }
  return { defaultProfileId: routing.defaultProfileId, byFeature }
}

/** Keeps every member in step with its row, e.g. after an import that only named the row. */
export function alignMembers(routing: Routing): Routing {
  let next = routing
  for (const group of featureGroups) {
    if (!group.members.length) continue
    next = assignFeature(next, group.feature, Object.hasOwn(routing.byFeature, group.feature) ? routing.byFeature[group.feature] : undefined)
  }
  return next
}

/** The profile a call for this feature would use, or why there is none. */
export function profileFor(state: ConfigState, feature: Feature):
  | { ok: true; profile: SavedProfile }
  | { ok: false; reason: 'not_configured' | 'disabled' } {
  const bound = Object.hasOwn(state.routing.byFeature, feature) ? state.routing.byFeature[feature] : undefined
  if (bound === null) return { ok: false, reason: 'disabled' }
  const id = bound ?? state.routing.defaultProfileId
  const profile = id ? state.profiles.find((item) => item.id === id) : undefined
  return profile ? { ok: true, profile } : { ok: false, reason: 'not_configured' }
}
