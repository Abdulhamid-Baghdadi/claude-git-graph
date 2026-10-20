import type { ProjectCard, ProjectFacts, ProjectStatus } from '../types'

const DAY = 86_400

// A project with this many uncommitted files needs attention even if nothing is unpushed.
export const DIRTY_ATTENTION = 10
// A branch with a commit this recent counts as active.
export const ACTIVE_BRANCH_DAYS = 7

// Projects shown before any are added or opened in the git graph; none by default.
export const DEFAULT_PROJECTS: readonly string[] = []

const lines = (text: string) => text.split(/\r?\n/).filter(line => line.trim().length > 0)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// Windows paths compare without case, and git prints them with forward slashes.
export const pathKey = (path: string) => path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// The defaults, then the repos the git graph has shown, then ones added here; minus hidden ones.
export function projectList(
  defaults: readonly string[],
  recent: readonly string[],
  added: readonly string[],
  hidden: readonly string[],
): string[] {
  const out = new Map<string, string>()
  const gone = new Set(hidden.map(pathKey))
  for (const path of [...defaults, ...recent, ...added]) {
    const key = pathKey(path)
    if (path.trim() && !gone.has(key) && !out.has(key)) out.set(key, path.trim())
  }
  return [...out.values()]
}

// `for-each-ref --format=%(committerdate:unix) refs/heads`
export function branchActivity(stdout: string, nowSec: number): { branches: number; activeBranches: number } {
  const dates = lines(stdout).map(line => Number(line.trim()))
  return {
    branches: dates.length,
    activeBranches: dates.filter(at => Number.isFinite(at) && nowSec - at <= ACTIVE_BRANCH_DAYS * DAY).length,
  }
}

// `worktree list --porcelain`: one block per worktree, the main checkout first.
export function linkedWorktrees(stdout: string): number {
  return Math.max(0, lines(stdout).filter(line => line.startsWith('worktree ')).length - 1)
}

export const LAST_FORMAT = '%ct%x1f%s'

// `log -1 --branches --format=%ct%x1f%s`
export function lastCommit(stdout: string): { lastCommitAt: number | null; lastSubject: string } {
  const [at = '', ...subject] = stdout.trim().split('\x1f')
  const time = Number(at)
  return at && Number.isFinite(time)
    ? { lastCommitAt: time, lastSubject: subject.join('\x1f').trim() }
    : { lastCommitAt: null, lastSubject: '' }
}

export function age(seconds: number): string {
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < DAY) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 60 * DAY) return `${Math.floor(seconds / DAY)}d ago`
  return `${Math.floor(seconds / (30 * DAY))}mo ago`
}

export function statusOf(facts: ProjectFacts, nowSec: number): ProjectStatus {
  const reasons: string[] = []
  if (facts.unpushed !== null && facts.unpushed > 0) reasons.push(`${plural(facts.unpushed, 'commit')} not pushed`)
  if (facts.dirty >= DIRTY_ATTENTION) reasons.push(`${plural(facts.dirty, 'uncommitted file')}`)
  if (reasons.length > 0) return { kind: 'attention', label: 'Needs attention', reasons }

  if (facts.commits24h > 0) {
    return { kind: 'active', label: 'Active', reasons: [`${plural(facts.commits24h, 'commit')} in the last 24h`] }
  }
  if (facts.lastCommitAt === null) return { kind: 'idle', label: 'No commits yet', reasons: [] }
  const days = Math.max(0, Math.floor((nowSec - facts.lastCommitAt) / DAY))
  return { kind: 'idle', label: days === 0 ? 'Idle today' : `Idle ${plural(days, 'day')}`, reasons: [] }
}

export const errorStatus = (message: string): ProjectStatus => ({ kind: 'error', label: "Can't read", reasons: [message] })

const RANK: Record<ProjectStatus['kind'], number> = { attention: 0, active: 1, idle: 2, error: 3 }

// Needs attention first, then active, then idle; most recent commit first within each.
export function sortCards(cards: readonly ProjectCard[]): ProjectCard[] {
  return [...cards].sort(
    (a, b) =>
      RANK[a.status.kind] - RANK[b.status.kind] ||
      (b.facts?.lastCommitAt ?? -1) - (a.facts?.lastCommitAt ?? -1),
  )
}

// The card's facts line by line, without the name and the chip.
export function factLines(facts: ProjectFacts, nowSec: number): string[] {
  const push = !facts.hasRemote
    ? 'no remote'
    : [
        facts.unpushed ? `${facts.unpushed} not pushed` : 'all pushed',
        !facts.hasUpstream && `${facts.branch} has no upstream`,
      ]
        .filter(Boolean)
        .join(', ')
  return [
    [
      `${facts.commits24h} today`,
      `${plural(facts.branches, 'branch', 'branches')} (${facts.activeBranches} active)`,
      facts.worktrees > 0 && plural(facts.worktrees, 'worktree'),
    ]
      .filter(Boolean)
      .join(' · '),
    `${facts.dirty} uncommitted · ${push}`,
    facts.lastCommitAt === null
      ? 'No commits yet'
      : `${age(Math.max(0, nowSec - facts.lastCommitAt))}: ${facts.lastSubject || '(no subject)'}`,
  ]
}
