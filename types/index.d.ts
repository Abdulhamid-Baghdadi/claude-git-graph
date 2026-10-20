export type Commit = {
  hash: string
  parents: string[]
  refs: string[]
  author: string
  when: string
  date: string
  subject: string
  isWorking?: boolean
}

export type Snapshot = {
  repo: string
  branch: string
  head: string
  commits: Commit[]
  dirty: number
  // `git status --porcelain` lines ("XY path"), the first MAX_FILES of them.
  files: string[]
  ahead: number | null
  behind: number | null
  branches: string[]
  worktreeBranches: string[]
  isTruncated: boolean
  loadedAt: number
}

export type LoadError = { repo: string; message: string }

// The last commit or push run from the pane, and how it went.
export type GitAction = { kind: 'busy' | 'ok' | 'error'; text: string }

// One project's activity, read with read-only git commands.
export type ProjectFacts = {
  // git's toplevel for the listed folder.
  root: string
  branch: string
  commits24h: number
  branches: number
  // Local branches with a commit in the last few days (ACTIVE_BRANCH_DAYS).
  activeBranches: number
  // Linked worktrees; the main checkout is not counted.
  worktrees: number
  dirty: number
  hasRemote: boolean
  // Commits on local branches that no remote has; null when there is no remote.
  unpushed: number | null
  // Whether the checked-out branch tracks an upstream.
  hasUpstream: boolean
  lastSubject: string
  // Unix seconds of the newest commit on any local branch; null with no commits.
  lastCommitAt: number | null
}

export type ProjectStatus = {
  kind: 'attention' | 'active' | 'idle' | 'error'
  label: string
  reasons: string[]
}

export type ProjectCard = {
  // The folder as listed.
  path: string
  facts: ProjectFacts | null
  error: string | null
  status: ProjectStatus
}

declare module 'claude-code' {
  interface PluginState {
    'git-graph': {
      repo: string
      repos: string[]
      snapshot: Snapshot | null
      error: LoadError | null
      isPicking: boolean
      portfolio: ProjectCard[]
      portfolioAt: number
      isPortfolioLoading: boolean
      isPortfolioEditing: boolean
      // How many commits the graph loads; "Show more" raises it.
      limit: number
      action: GitAction | null
    }
  }
}
