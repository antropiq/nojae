// The test harness's own spelling of the workspace field (clws-02).
//
// Every workspace-scoped request the client makes now carries the tab's folder,
// and the one function that spells it is `withWorkspace`. A route stub that
// matched a hand-written `?workspace=…` would be a second spelling of the field
// inside the suite — the same drift the guard test refuses in `web/src` — so the
// stubs ask this helper instead: `withWorkspace(url)` builds the URL a call site
// produces, and `withoutWorkspace(url)` reads a recorded call back to the route
// it hit.
//
// `pointTabAt(root)` is the other half: the field travels only when the tab
// *has* a folder, so a suite that wants to see it must say so.

import {
  useWorkspaceSession,
  withWorkspace,
} from '../../src/composables/useWorkspaceSession'

export { withWorkspace }

const TEST_WORKSPACE = '/w/tab-workspace'

export function pointTabAt(root = TEST_WORKSPACE) {
  useWorkspaceSession().state.workspace = root
  return root
}

export function clearTabWorkspace() {
  useWorkspaceSession().state.workspace = ''
}

// The URL as the call site built it, minus the workspace field and its query.
export function routeOf(url) {
  return String(url).split('?')[0]
}

// The URL as the call site built it, minus the workspace field.
export function withoutWorkspace(url) {
  const text = String(url)
  const [base, search = ''] = text.split('?')
  const kept = search
    .split('&')
    .filter((pair) => pair && !pair.startsWith('workspace='))
    .join('&')
  return kept ? `${base}?${kept}` : base
}

// The folder a recorded call named, or '' when it named none.
export function workspaceOf(url) {
  const search = String(url).split('?')[1] ?? ''
  for (const pair of search.split('&')) {
    if (pair.startsWith('workspace=')) {
      return decodeURIComponent(pair.slice('workspace='.length))
    }
  }
  return ''
}
