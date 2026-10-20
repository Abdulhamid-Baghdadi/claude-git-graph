import { describe, expect, test } from 'claude-code/testing'

import {
  DIRTY_ATTENTION,
  branchActivity,
  factLines,
  lastCommit,
  linkedWorktrees,
  projectList,
  sortCards,
  statusOf,
} from '../hooks/portfolio'
import type { ProjectCard, ProjectFacts } from '../types'

const NOW = 1_800_000_000
const DAY = 86_400

const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  root: 'C:/Users/you/Desktop/repo',
  branch: 'main',
  commits24h: 0,
  branches: 1,
  activeBranches: 0,
  worktrees: 0,
  dirty: 0,
  hasRemote: true,
  unpushed: 0,
  hasUpstream: true,
  lastSubject: 'Fix it',
  lastCommitAt: NOW - 3 * DAY,
  ...over,
})

describe('portfolio status', () => {
  test('unpushed commits need attention, even on an active project', async () => {
    const status = statusOf(facts({ unpushed: 2, commits24h: 5, lastCommitAt: NOW - 60 }), NOW)
    expect(status.kind).toBe('attention')
    expect(status.label).toBe('Needs attention')
    expect(status.reasons).toEqual(['2 commits not pushed'])
  })

  test('lots of uncommitted work needs attention; a little does not', async () => {
    expect(statusOf(facts({ dirty: DIRTY_ATTENTION }), NOW).reasons).toEqual([`${DIRTY_ATTENTION} uncommitted files`])
    expect(statusOf(facts({ dirty: DIRTY_ATTENTION - 1 }), NOW).kind).toBe('idle')
  })

  test('no remote is not a reason by itself', async () => {
    expect(statusOf(facts({ hasRemote: false, unpushed: null }), NOW).kind).toBe('idle')
  })

  test('commits in the last 24h make it active', async () => {
    const status = statusOf(facts({ commits24h: 1, lastCommitAt: NOW - 3600 }), NOW)
    expect(status.kind).toBe('active')
    expect(status.reasons).toEqual(['1 commit in the last 24h'])
  })

  test('otherwise idle for whole days since the last commit', async () => {
    expect(statusOf(facts({ lastCommitAt: NOW - 3 * DAY - 10 }), NOW).label).toBe('Idle 3 days')
    expect(statusOf(facts({ lastCommitAt: NOW - DAY }), NOW).label).toBe('Idle 1 day')
    expect(statusOf(facts({ lastCommitAt: null }), NOW).label).toBe('No commits yet')
  })

  test('sorts attention, active, idle, then unreadable; newest first within each', async () => {
    const card = (path: string, f: ProjectFacts | null): ProjectCard => ({
      path,
      facts: f,
      error: f ? null : 'missing',
      status: f ? statusOf(f, NOW) : { kind: 'error', label: "Can't read", reasons: ['missing'] },
    })
    const sorted = sortCards([
      card('old', facts({ lastCommitAt: NOW - 9 * DAY })),
      card('gone', null),
      card('new', facts({ lastCommitAt: NOW - 2 * DAY })),
      card('busy', facts({ commits24h: 3, lastCommitAt: NOW - 60 })),
      card('risky', facts({ unpushed: 1 })),
    ])
    expect(sorted.map(c => c.path)).toEqual(['risky', 'busy', 'new', 'old', 'gone'])
  })
})

describe('portfolio parsing', () => {
  test('merges the project list without duplicates and drops hidden ones', async () => {
    const list = projectList(
      ['C:\\Users\\you\\Desktop\\website', 'C:\\Users\\you\\Desktop\\Hidden'],
      ['C:/Users/you/Desktop/website', 'C:/Users/you/Desktop/Other'],
      ['D:\\work\\x\\'],
      ['c:/users/you/desktop/hidden'],
    )
    expect(list).toEqual(['C:\\Users\\you\\Desktop\\website', 'C:/Users/you/Desktop/Other', 'D:\\work\\x\\'])
  })

  test('counts branches active in the last week', async () => {
    expect(branchActivity(`${NOW - DAY}\n${NOW - 30 * DAY}\n${NOW}\n`, NOW)).toEqual({ branches: 3, activeBranches: 2 })
  })

  test('counts linked worktrees, not the main checkout', async () => {
    const out = 'worktree C:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/r/.claude/worktrees/x\nHEAD def\nbranch refs/heads/claude/x\n'
    expect(linkedWorktrees(out)).toBe(1)
    expect(linkedWorktrees('')).toBe(0)
  })

  test('reads the last commit, or none', async () => {
    expect(lastCommit(`${NOW}\x1fAdd the thing\n`)).toEqual({ lastCommitAt: NOW, lastSubject: 'Add the thing' })
    expect(lastCommit('')).toEqual({ lastCommitAt: null, lastSubject: '' })
  })

  test('describes push state on the card', async () => {
    expect(factLines(facts({ unpushed: 3, hasUpstream: false, branch: 'feat' }), NOW)[1]).toBe(
      '0 uncommitted · 3 not pushed, feat has no upstream',
    )
    expect(factLines(facts({ hasRemote: false, unpushed: null }), NOW)[1]).toBe('0 uncommitted · no remote')
    expect(factLines(facts({ lastCommitAt: NOW - 2 * 3600 }), NOW)[2]).toBe('2h ago: Fix it')
  })
})
