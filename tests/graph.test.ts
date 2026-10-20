import { describe, expect, test } from 'claude-code/testing'

import { fileChange, layout, parseLog, pills, renderSvg, shortWhen } from '../hooks/graph'
import type { Commit, Snapshot } from '../types'

const commit = (hash: string, parents: string[], refs: string[] = []): Commit => ({
  hash,
  parents,
  refs,
  author: 'A',
  when: '2 hours ago',
  date: '2026-10-18',
  subject: `commit ${hash}`,
})

describe('graph', () => {
  test('parses git log records', async () => {
    const out = 'a1\x1fb2 c3\x1fHEAD -> main, origin/main\x1fAli\x1f3 days ago\x1f2026-10-15\x1fMerge it\x1e\nb2\x1f\x1f\x1fAli\x1f4 days ago\x1f2026-10-14\x1fFirst\x1e\n'
    const commits = parseLog(out)
    expect(commits.length).toBe(2)
    expect(commits[0]?.parents).toEqual(['b2', 'c3'])
    expect(commits[0]?.refs).toEqual(['HEAD -> main', 'origin/main'])
    expect(commits[1]?.parents).toEqual([])
  })

  test('puts a side branch in its own lane and merges it back', async () => {
    // m merges f into b; f and b both come from a.
    const commits = [commit('m', ['b', 'f']), commit('f', ['a']), commit('b', ['a']), commit('a', [])]
    const { lanes, width } = layout(commits)
    expect(lanes).toEqual([0, 1, 0, 0])
    expect(width).toBe(2)
  })

  test('labels refs, hiding a remote that matches a local branch', async () => {
    const out = pills(['HEAD -> main', 'origin/main', 'origin/feature', 'tag: v1', 'claude/fix'], ['main', 'claude/fix'], ['claude/fix'])
    expect(out.map(pill => `${pill.kind}:${pill.text}`)).toEqual([
      'head:main',
      'remote:origin/feature',
      'tag:v1',
      'worktree:claude/fix',
    ])
  })

  test('shortens relative dates', async () => {
    expect(shortWhen('12 minutes ago')).toBe('12m')
    expect(shortWhen('1 day ago')).toBe('1d')
  })

  test('draws an uncommitted row above HEAD and escapes text', async () => {
    const snapshot: Snapshot = {
      repo: 'C:/r',
      branch: 'main',
      head: 'b',
      commits: [{ ...commit('b', ['a'], ['HEAD -> main']), subject: 'Fix <bom> & co' }, commit('a', [])],
      dirty: 2,
      files: [' M a.ts', '?? b.ts'],
      ahead: 0,
      behind: 0,
      branches: ['main'],
      worktreeBranches: [],
      isTruncated: false,
      loadedAt: 0,
    }
    const { source, height } = renderSvg(snapshot, 500)
    expect(source).toContain('Uncommitted changes (2 files)')
    expect(source).toContain('Fix &lt;bom&gt; &amp; co')
    expect(height).toBe(3 * 24 + 8)
  })

  test('draws a slice of rows on its own, with the same total height', async () => {
    const commits = Array.from({ length: 10 }, (_, i) => commit(`c${i}`, i < 9 ? [`c${i + 1}`] : []))
    const snapshot: Snapshot = {
      repo: 'C:/r', branch: 'main', head: 'c0', commits, dirty: 0, files: [], ahead: 0, behind: 0,
      branches: ['main'], worktreeBranches: [], isTruncated: false, loadedAt: 0,
    }
    const whole = renderSvg(snapshot, 500)
    const top = renderSvg(snapshot, 500, 0, 4)
    const rest = renderSvg(snapshot, 500, 4, 10)
    expect(top.height + rest.height).toBe(whole.height)
    expect(top.source).toContain('commit c3')
    expect(top.source).not.toContain('commit c4')
    expect(rest.source).toContain('viewBox="0 100 500')
  })

  test('reads porcelain status lines', async () => {
    expect(fileChange('?? new.ts')).toEqual({ kind: 'new', path: 'new.ts' })
    expect(fileChange(' D gone.ts').kind).toBe('deleted')
    expect(fileChange('R  a.ts -> b.ts')).toEqual({ kind: 'renamed', path: 'a.ts -> b.ts' })
    expect(fileChange(' M x.ts').kind).toBe('modified')
  })
})
