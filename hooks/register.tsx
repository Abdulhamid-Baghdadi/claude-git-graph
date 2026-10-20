import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GitAction, ProjectCard, ProjectFacts, ProjectStatus, Snapshot } from '../types'
import { LOG_FORMAT, fileChange, parseLog, renderSvg, shortWhen, withWorkingRow } from './graph'
import type { FileChange } from './graph'
import {
  DEFAULT_PROJECTS,
  LAST_FORMAT,
  age,
  branchActivity,
  errorStatus,
  factLines,
  lastCommit,
  linkedWorktrees,
  pathKey,
  projectList,
  sortCards,
  statusOf,
} from './portfolio'

const PANE = 'git-graph'
// Commits loaded at first, and how many more each "Show more" adds, up to MAX_LIMIT.
const LIMIT = 150
const MAX_LIMIT = 3000
// Rows per Svg: a long graph is a stack of them, each under SVG_MAX.
const CHUNK = 50
// Uncommitted files listed in the changes box.
const MAX_FILES = 200
const REFRESH_MS = 30_000
const SVG_MAX = 131_072

const repo = atom({ plugin: 'git-graph', key: 'repo' } as const, '')
const repos = atom({ plugin: 'git-graph', key: 'repos' } as const, [] as string[])
const snapshot = atom({ plugin: 'git-graph', key: 'snapshot' } as const, null as Snapshot | null)
const error = atom({ plugin: 'git-graph', key: 'error' } as const, null as { repo: string; message: string } | null)
const isPicking = atom({ plugin: 'git-graph', key: 'isPicking' } as const, false)
const limit = atom({ plugin: 'git-graph', key: 'limit' } as const, LIMIT)
const action = atom({ plugin: 'git-graph', key: 'action' } as const, null as GitAction | null)

// A repo's own config must not run programs when the pane reads it: no fsmonitor hook, no external diff or pager.
// Not covered: clean/smudge filters a repo's own config defines; only open repos you got by cloning or made yourself.
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'log.showSignature=false']

const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
const lines = (text: string) => text.split(/\r?\n/).filter(line => line.trim().length > 0)

async function git($: EngineInterface, cwd: string, args: string[]) {
  return $.process.run(['git', ...SAFE, ...args], { cwd, timeoutMs: 15_000 })
}

async function toplevel($: EngineInterface, path: string): Promise<string> {
  const top = await git($, path, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) throw new Error(top.stderr.trim() || `${path} is not a git repository`)
  return top.stdout.trim()
}

async function load($: EngineInterface, path: string, count: number): Promise<Snapshot> {
  const root = await toplevel($, path)
  const [log, status, branch, head, counts, worktrees, heads] = await Promise.all([
    git($, root, ['log', '--branches', '--remotes', '--tags', 'HEAD', '--date-order', '-n', String(count + 1), `--format=${LOG_FORMAT}`]),
    git($, root, ['status', '--porcelain']),
    git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, root, ['rev-parse', 'HEAD']),
    git($, root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    git($, root, ['worktree', 'list', '--porcelain']),
    git($, root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const commits = log.exitCode === 0 ? parseLog(log.stdout) : []
  const [behind, ahead] = counts.exitCode === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : []
  const worktreeBranches = worktrees.stdout
    .split(/\r?\n\r?\n/)
    .slice(1)
    .flatMap(block => lines(block).filter(line => line.startsWith('branch refs/heads/')))
    .map(line => line.slice('branch refs/heads/'.length))

  return {
    repo: root,
    branch: branch.exitCode === 0 ? branch.stdout.trim() : '(no commits yet)',
    head: head.exitCode === 0 ? head.stdout.trim() : '',
    commits: commits.slice(0, count),
    dirty: lines(status.stdout).length,
    files: lines(status.stdout).slice(0, MAX_FILES),
    ahead: ahead ?? null,
    behind: behind ?? null,
    branches: lines(heads.stdout).map(line => line.trim()),
    worktreeBranches,
    isTruncated: commits.length > count,
    loadedAt: await $.clock.now(),
  }
}

const sameGraph = (a: Snapshot | null, b: Snapshot) =>
  a !== null && JSON.stringify({ ...a, loadedAt: 0 }) === JSON.stringify({ ...b, loadedAt: 0 })

let isLoading = false

async function remember($: EngineInterface, path: string) {
  const list = await update($, repos, list => [path, ...list.filter(other => other !== path)].slice(0, 12))
  await $.store.set('repos', list)
}

// Draws `path` (or the current repo) and makes it the current one when it loads.
async function refresh($: EngineInterface, path?: string): Promise<string | undefined> {
  const target = path ?? (await read($, repo))
  if (!target || (isLoading && path === undefined)) return
  isLoading = true
  try {
    const next = await load($, target, await read($, limit))
    if (path !== undefined || (await read($, repo)) !== next.repo) {
      await update($, repo, () => next.repo)
      await remember($, next.repo)
    }
    await update($, snapshot, current => (sameGraph(current, next) && current?.repo === next.repo ? current : next))
    await update($, error, () => null)
    return next.repo
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, error, () => ({ repo: target, message }))
    return undefined
  } finally {
    isLoading = false
  }
}

const open = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Git graph' })

// The pane's own write commands, run only when the person presses Commit or Push.
// No terminal prompt: a push that needs credentials fails instead of hanging.
async function gitWrite($: EngineInterface, cwd: string, args: string[], timeoutMs: number) {
  return $.process.run(['git', ...SAFE, ...args], { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } })
}

const lastLine = (text: string) => lines(text).pop()?.trim() ?? ''

let isActing = false

const CHANGE_COLOR: Record<FileChange['kind'], string> = { new: 'success', deleted: 'error', renamed: 'suggestion', modified: 'warning' }

async function act($: EngineInterface, busy: string, work: (root: string) => Promise<GitAction>) {
  const snap = await read($, snapshot)
  if (!snap || isActing) return
  isActing = true
  await update($, action, () => ({ kind: 'busy', text: busy }))
  try {
    const result = await work(snap.repo)
    await update($, action, () => result)
  } catch (err) {
    await update($, action, () => ({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
  } finally {
    isActing = false
    await refresh($)
  }
}

// Stages everything (new, changed and deleted files) and commits it with `message`.
function commitAll($: EngineInterface, message: string) {
  const text = message.trim()
  if (!text) return update($, action, () => ({ kind: 'error', text: 'Write a commit message first.' }))
  return act($, 'Committing…', async root => {
    const add = await gitWrite($, root, ['add', '-A'], 60_000)
    if (add.exitCode !== 0) return { kind: 'error', text: lastLine(add.stderr) || 'git add failed' }
    const commit = await gitWrite($, root, ['commit', '-m', text], 60_000)
    if (commit.exitCode !== 0) return { kind: 'error', text: lastLine(commit.stderr || commit.stdout) || 'git commit failed' }
    return { kind: 'ok', text: lines(commit.stdout)[0]?.trim() || 'Committed.' }
  })
}

// Pushes the checked-out branch; one with no upstream is published to the first remote.
function push($: EngineInterface) {
  return act($, 'Pushing…', async root => {
    const snap = await read($, snapshot)
    let args = ['push']
    if (snap && snap.ahead === null) {
      const remotes = await git($, root, ['remote'])
      const remote = lines(remotes.stdout)[0]?.trim()
      if (!remote) return { kind: 'error', text: 'This repo has no remote to push to.' }
      args = ['push', '-u', remote, snap.branch]
    }
    const out = await gitWrite($, root, args, 120_000)
    if (out.exitCode !== 0) return { kind: 'error', text: lastLine(out.stderr) || 'git push failed' }
    return { kind: 'ok', text: lastLine(out.stderr) || 'Pushed.' }
  })
}

async function showMore($: EngineInterface) {
  await update($, limit, count => Math.min(MAX_LIMIT, count + LIMIT))
  await refresh($)
}

// Switches the git graph pane to `path` and brings it up; false when it isn't a repo.
async function showInGraph($: EngineInterface, path: string): Promise<boolean> {
  const found = await refresh($, path)
  if (!found) return false
  await update($, isPicking, () => false)
  await open($)
  return true
}

// Portfolio: one card per local project.

const PORTFOLIO_PANE = 'portfolio'
const PORTFOLIO_REFRESH_MS = 60_000
// Repos read at once; each runs about ten git commands.
const PARALLEL = 3

const portfolio = atom({ plugin: 'git-graph', key: 'portfolio' } as const, [] as ProjectCard[])
const portfolioAt = atom({ plugin: 'git-graph', key: 'portfolioAt' } as const, 0)
const isPortfolioLoading = atom({ plugin: 'git-graph', key: 'isPortfolioLoading' } as const, false)
const isPortfolioEditing = atom({ plugin: 'git-graph', key: 'isPortfolioEditing' } as const, false)

const unquote = (path: string) => path.trim().replace(/^["']|["']$/g, '')
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

// Read-only git only: `--no-optional-locks` keeps `status` from refreshing the index.
async function readOnlyGit($: EngineInterface, cwd: string, args: string[]) {
  return $.process.run(['git', ...SAFE, '--no-optional-locks', ...args], { cwd, timeoutMs: 15_000 })
}

async function readFacts($: EngineInterface, path: string, nowSec: number): Promise<ProjectFacts> {
  const top = await readOnlyGit($, path, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) throw new Error(top.stderr.trim().split(/\r?\n/)[0] || 'Not a git repository')
  const root = top.stdout.trim()
  const [branch, recent, heads, worktrees, status, remotes, unpushed, upstream, last] = await Promise.all([
    readOnlyGit($, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    readOnlyGit($, root, ['rev-list', '--count', '--branches', `--since=@${nowSec - 86_400}`]),
    readOnlyGit($, root, ['for-each-ref', '--format=%(committerdate:unix)', 'refs/heads']),
    readOnlyGit($, root, ['worktree', 'list', '--porcelain']),
    readOnlyGit($, root, ['status', '--porcelain']),
    readOnlyGit($, root, ['remote']),
    readOnlyGit($, root, ['rev-list', '--count', '--branches', '--not', '--remotes']),
    readOnlyGit($, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    readOnlyGit($, root, ['log', '-1', '--branches', `--format=${LAST_FORMAT}`]),
  ])
  const hasRemote = remotes.exitCode === 0 && remotes.stdout.trim().length > 0
  return {
    root,
    branch: branch.exitCode === 0 ? branch.stdout.trim() : '(no commits yet)',
    commits24h: recent.exitCode === 0 ? Number(recent.stdout.trim()) || 0 : 0,
    ...branchActivity(heads.stdout, nowSec),
    worktrees: worktrees.exitCode === 0 ? linkedWorktrees(worktrees.stdout) : 0,
    dirty: status.stdout.split(/\r?\n/).filter(line => line.trim()).length,
    hasRemote,
    unpushed: hasRemote && unpushed.exitCode === 0 ? Number(unpushed.stdout.trim()) || 0 : null,
    hasUpstream: upstream.exitCode === 0,
    ...(last.exitCode === 0 ? lastCommit(last.stdout) : { lastCommitAt: null, lastSubject: '' }),
  }
}

async function listed($: EngineInterface): Promise<{ paths: string[]; hidden: string[] }> {
  const [recent, added, hidden] = await Promise.all([
    $.store.get('repos'),
    $.store.get('portfolio.added'),
    $.store.get('portfolio.hidden'),
  ])
  return { paths: projectList(DEFAULT_PROJECTS, strings(recent), strings(added), strings(hidden)), hidden: strings(hidden) }
}

let isPortfolioRunning = false

async function reloadPortfolio($: EngineInterface) {
  if (isPortfolioRunning) return
  isPortfolioRunning = true
  await update($, isPortfolioLoading, () => true)
  try {
    // A deleted folder drops off the list; it comes back if the folder does.
    const listedPaths = (await listed($)).paths
    const present = await Promise.all(listedPaths.map(path => $.fs.exists(path).catch(() => true)))
    const paths = listedPaths.filter((_, index) => present[index])
    const nowSec = Math.floor((await $.clock.now()) / 1000)
    const out: ProjectCard[] = new Array(paths.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < paths.length) {
        const index = cursor++
        const path = paths[index] ?? ''
        try {
          const facts = await readFacts($, path, nowSec)
          out[index] = { path, facts, error: null, status: statusOf(facts, nowSec) }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          out[index] = { path, facts: null, error: message, status: errorStatus(message) }
        }
      }
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker))
    // Two listed folders inside one repo show as one card.
    const seen = new Set<string>()
    const unique = out.filter(card => {
      const key = pathKey(card.facts?.root ?? card.path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    await update($, portfolio, () => sortCards(unique))
    await update($, portfolioAt, () => nowSec)
  } finally {
    await update($, isPortfolioLoading, () => false)
    isPortfolioRunning = false
  }
}

async function addProject($: EngineInterface, raw: string) {
  const path = unquote(raw)
  if (!path) return
  const key = pathKey(path)
  const added = strings(await $.store.get('portfolio.added')).filter(other => pathKey(other) !== key)
  const hidden = strings(await $.store.get('portfolio.hidden')).filter(other => pathKey(other) !== key)
  await $.store.set('portfolio.added', [...added, path])
  await $.store.set('portfolio.hidden', hidden)
  await reloadPortfolio($)
}

async function removeProject($: EngineInterface, card: ProjectCard) {
  const keys = new Set([pathKey(card.path), card.facts ? pathKey(card.facts.root) : ''])
  const added = strings(await $.store.get('portfolio.added')).filter(other => !keys.has(pathKey(other)))
  const hidden = strings(await $.store.get('portfolio.hidden')).filter(other => !keys.has(pathKey(other)))
  await $.store.set('portfolio.added', added)
  await $.store.set('portfolio.hidden', [...hidden, card.path])
  await update($, portfolio, list => list.filter(other => other.path !== card.path))
}

async function restoreProject($: EngineInterface, path: string) {
  const hidden = strings(await $.store.get('portfolio.hidden')).filter(other => pathKey(other) !== pathKey(path))
  await $.store.set('portfolio.hidden', hidden)
  await reloadPortfolio($)
}

const isShown = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PORTFOLIO_PANE && pane.isShown)

const CHIP: Record<ProjectStatus['kind'], string> = {
  attention: 'warning',
  active: 'success',
  idle: 'inactive',
  error: 'error',
}

// From the plugin's `session.start`: the command, and a refresh while the pane is shown.
async function startPortfolio($: EngineInterface) {
  await $.command.register({
    name: 'portfolio',
    description: 'Show one card per local project: commits today, branches, uncommitted and unpushed work',
  })
  $.clock.every(PORTFOLIO_REFRESH_MS, () => {
    void isShown($).then(shown => {
      if (shown) void reloadPortfolio($)
    })
  })
}

// From the plugin's `turn.complete`.
async function portfolioAfterTurn($: EngineInterface) {
  const nowSec = Math.floor((await $.clock.now()) / 1000)
  if (nowSec - (await read($, portfolioAt)) > 30 && (await isShown($))) void reloadPortfolio($)
}

export const register: Register = on => {
  // Two buttons above the prompt, so neither pane needs a typed command.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        <Button
          key="show-graph"
          dimColor
          label="⎇ Git graph"
          onPress={() => {
            void open($)
            void refresh($)
          }}
        />
        <Button
          key="show-portfolio"
          dimColor
          label="▦ Portfolio"
          onPress={() => {
            void $.ui.open({ id: PORTFOLIO_PANE, title: 'Portfolio' })
            void reloadPortfolio($)
          }}
        />
      </Box>
    )
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-graph',
      description: 'Show the git graph pane; pass a repo path to switch to it',
      argumentHint: '[repo path]',
    })
    const stored = await $.store.get('repos')
    if (Array.isArray(stored)) await update($, repos, () => stored.filter(item => typeof item === 'string'))

    void (async () => {
      const cwd = await $.session.cwd()
      const found = await refresh($, cwd)
      if (found) void open($)
      else {
        await update($, error, () => null)
        const [last] = await read($, repos)
        if (last && !(await read($, repo))) await refresh($, last)
      }
    })()
    $.clock.every(REFRESH_MS, () => void refresh($))
    await startPortfolio($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    void portfolioAfterTurn($)
    return result
  })

  on('command.run', { command: 'git-graph' }, async ($, e) => {
    const path = e.args.trim().replace(/^["']|["']$/g, '')
    await open($)
    if (!path) {
      void refresh($)
      return { text: 'Git graph pane opened.' }
    }
    const found = await refresh($, path)
    if (found) await update($, isPicking, () => false)
    return { text: found ? `Git graph now shows ${found}.` : `Couldn't read a git repo at ${path}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const current = await read($, repo)
    const snap = await read($, snapshot)
    const problem = await read($, error)
    const picking = (await read($, isPicking)) || !current
    const known = await read($, repos)
    const shown = snap && snap.repo === current ? snap : null

    const choose = async (path: string) => {
      const found = await refresh($, path)
      if (found) await update($, isPicking, () => false)
    }

    const picker = (
      <Box flexDirection="column" gap={1} marginBottom={1}>
        {known.length > 0 && 'Select' in table && (
          <table.Select
            key="recent"
            label="Recent repos"
            value={known.includes(current) ? current : undefined}
            options={known.map(path => ({ value: path, label: `${basename(path)}  ${path}` }))}
            onSelect={path => void choose(path)}
          />
        )}
        {'Input' in table && (
          <table.Input
            key="path"
            label="Repo folder"
            placeholder="C:\Users\you\Desktop\my-project"
            submitLabel="show"
            onSubmit={path => void choose(path.trim().replace(/^["']|["']$/g, ''))}
          />
        )}
        <Box flexDirection="row" gap={1}>
          <Button key="cwd" label="Use this session's folder" onPress={() => void $.session.cwd().then(choose)} />
          {current && <Button key="cancel" label="Cancel" onPress={() => void update($, isPicking, () => false)} />}
        </Box>
      </Box>
    )

    const last = await read($, action)
    const canPush = !!shown && !!shown.head && (shown.ahead === null || shown.ahead > 0)
    const changes = shown && (shown.dirty > 0 || canPush || last) && (
      <Box flexDirection="column" borderStyle="round" borderColor={shown.dirty > 0 ? 'warning' : 'inactive'} paddingX={1} marginBottom={1}>
        {shown.dirty > 0 ? (
          <Box flexDirection="column">
            <Text bold>
              {shown.dirty === 1 ? '1 uncommitted file' : `${shown.dirty} uncommitted files`}
            </Text>
            {shown.files.slice(0, 12).map(line => {
              const change = fileChange(line)
              return (
                <Text wrap="truncate-middle">
                  <Text color={CHANGE_COLOR[change.kind]}>{change.kind}</Text> {change.path}
                </Text>
              )
            })}
            {shown.dirty > 12 && <Text dimColor>…and {shown.dirty - 12} more</Text>}
            {'Input' in table && (
              <table.Input
                key="commit-message"
                label="Commit message"
                placeholder="What did you change?"
                submitLabel="Commit all"
                onSubmit={message => void commitAll($, message)}
              />
            )}
          </Box>
        ) : (
          <Text dimColor>No uncommitted changes.</Text>
        )}
        {canPush && (
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button
              key="push"
              variant="primary"
              label={
                shown.ahead === null
                  ? `Publish ${shown.branch}`
                  : `Push ${shown.ahead === 1 ? '1 commit' : `${shown.ahead} commits`}`
              }
              onPress={() => void push($)}
            />
          </Box>
        )}
        {last && (
          <Text color={last.kind === 'error' ? 'error' : last.kind === 'ok' ? 'success' : undefined} dimColor={last.kind === 'busy'} wrap="wrap">
            {last.text}
          </Text>
        )}
      </Box>
    )

    const header = shown && (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text bold>{basename(shown.repo)}</Text>
          <Text dimColor>on {shown.branch}</Text>
          <Box flexGrow={1} />
          <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />
          <Button key="switch" label="Switch repo" onPress={() => void update($, isPicking, () => true)} />
        </Box>
        <Text dimColor wrap="wrap">
          {[
            `${shown.branches.length} ${shown.branches.length === 1 ? 'branch' : 'branches'}`,
            shown.worktreeBranches.length > 0 && `${shown.worktreeBranches.length} worktrees (⎇)`,
            shown.dirty > 0 && `${shown.dirty} uncommitted`,
            shown.ahead !== null && shown.ahead > 0 && `${shown.ahead} not pushed`,
            shown.behind !== null && shown.behind > 0 && `${shown.behind} to pull`,
            shown.ahead === null && shown.head && 'no upstream',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </Box>
    )

    const columns = e.props.bodyColumns
    let graph
    const shownCount = shown?.commits.length ?? 0
    if (!shown) graph = !picking && <Text dimColor>Loading…</Text>
    else if (shown.commits.length === 0) graph = <Text dimColor>No commits yet.</Text>
    else if ('Svg' in table) {
      const width = Math.round(Math.min(1100, Math.max(360, columns * 7.5)))
      // The engine refuses an Svg past SVG_MAX characters, and with it the whole pane: draw the graph
      // as a stack of row ranges, halving any range that is still too big.
      const rows = withWorkingRow(shown).length
      const pieces: { source: string; height: number; from: number }[] = []
      const draw = (from: number, to: number) => {
        const piece = renderSvg(shown, width, from, to)
        if (piece.source.length > SVG_MAX && to - from > 1) {
          const mid = from + Math.floor((to - from) / 2)
          draw(from, mid)
          draw(mid, to)
        } else if (piece.source.length <= SVG_MAX) pieces.push({ ...piece, from })
      }
      for (let from = 0; from < rows; from += CHUNK) draw(from, Math.min(rows, from + CHUNK))
      graph = (
        <Box flexDirection="column">
          {pieces.map(piece => (
            <table.Svg
              source={piece.source}
              alt={`Commit graph of ${basename(shown.repo)}, from row ${piece.from + 1}`}
              width={width}
              height={piece.height}
              isInteractive
            />
          ))}
        </Box>
      )
    } else {
      const room = Math.max(1, (e.viewport?.rows ?? 30) - 6)
      graph = (
        <Box flexDirection="column">
          {withWorkingRow(shown)
            .slice(0, room)
            .map(commit => (
              <Text wrap="truncate-end">
                {commit.isWorking ? '◌' : '●'} {commit.subject} <Text dimColor>{shortWhen(commit.when)}</Text>
              </Text>
            ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {problem && (
          <Text color="error" wrap="wrap">
            {problem.message}
          </Text>
        )}
        {picking && picker}
        {changes}
        {graph}
        {shown && (
          <Box flexDirection="row" gap={1} alignItems="center" marginTop={1}>
            <Text dimColor>
              {shown.isTruncated ? `Showing the latest ${shownCount} commits.` : `All ${shownCount} commits.`} Hover a commit for details.
            </Text>
            {shown.isTruncated && shownCount < MAX_LIMIT && (
              <Button key="more" label={`Show ${LIMIT} more`} onPress={() => void showMore($)} />
            )}
          </Box>
        )}
      </Box>
    )
  })

  on('command.run', { command: 'portfolio' }, async $ => {
    await $.ui.open({ id: PORTFOLIO_PANE, title: 'Portfolio' })
    void reloadPortfolio($)
    return { text: 'Portfolio pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PORTFOLIO_PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const list = await read($, portfolio)
    const at = await read($, portfolioAt)
    const loading = await read($, isPortfolioLoading)
    const editing = await read($, isPortfolioEditing)
    const nowSec = Math.floor((await $.clock.now()) / 1000)
    const hidden = editing ? (await listed($)).hidden : []

    const count = (kind: ProjectStatus['kind']) => list.filter(card => card.status.kind === kind).length
    const summary = [
      count('attention') > 0 && `${count('attention')} need attention`,
      count('active') > 0 && `${count('active')} active`,
      count('idle') > 0 && `${count('idle')} idle`,
      count('error') > 0 && `${count('error')} unreadable`,
    ]
      .filter(Boolean)
      .join(' · ')

    const columns = Math.max(30, e.props.bodyColumns)
    const perRow = Math.max(1, Math.floor(columns / 40))
    const width = Math.floor((columns - (perRow - 1)) / perRow)

    const open = async (card: ProjectCard) => {
      const ok = await showInGraph($, card.facts?.root ?? card.path)
      if (!ok) $.ui.toast(`Couldn't open ${basename(card.path)} in the git graph.`)
    }

    const card = (item: ProjectCard, index: number) => {
      const color = CHIP[item.status.kind]
      const name = basename(item.facts?.root ?? item.path)
      return (
        <Box
          key={`card-${index}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={color}
          paddingX={1}
          width={width}
          hover={{ borderColor: 'claude' }}
        >
          <Box flexDirection="row" gap={1}>
            <Button key={`open-${index}`} plain label={name} onPress={() => void open(item)} />
            <Box flexGrow={1} />
            <Text color={color} bold>
              {item.status.label}
            </Text>
            <Button key={`untrack-${index}`} plain dimColor label="✕" onPress={() => void removeProject($, item)} />
          </Box>
          {item.status.kind === 'attention' && (
            <Text color={color} wrap="wrap">
              {item.status.reasons.join(' · ')}
            </Text>
          )}
          {item.facts ? (
            factLines(item.facts, nowSec).map(line => (
              <Text dimColor wrap="truncate-end">
                {line}
              </Text>
            ))
          ) : (
            <Text dimColor wrap="wrap">
              {item.error}
            </Text>
          )}
          <Text dimColor wrap="truncate-middle">
            {item.facts?.root ?? item.path}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text bold>{list.length === 1 ? '1 project' : `${list.length} projects`}</Text>
          <Text dimColor>
            {loading ? 'reading…' : at > 0 ? `updated ${age(Math.max(0, nowSec - at))}` : ''}
          </Text>
          <Box flexGrow={1} />
          <Button key="refresh" label="Refresh" onPress={() => void reloadPortfolio($)} />
          <Button key="edit" label={editing ? 'Done' : 'Edit list'} onPress={() => void update($, isPortfolioEditing, value => !value)} />
        </Box>
        {summary && <Text>{summary}</Text>}
        {editing && (
          <Box flexDirection="column" gap={1}>
            {'Input' in table && (
              <table.Input
                key="add"
                label="Add a repo folder"
                placeholder="C:\Users\you\Desktop\my-project"
                submitLabel="add"
                onSubmit={path => void addProject($, path)}
              />
            )}
            {hidden.length > 0 && (
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                <Text dimColor>Removed:</Text>
                {hidden.map((path, index) => (
                  <Button key={`restore-${index}`} dimColor label={`↺ ${basename(path)}`} onPress={() => void restoreProject($, path)} />
                ))}
              </Box>
            )}
          </Box>
        )}
        {list.length === 0 && <Text dimColor>{loading ? 'Reading your projects…' : 'No projects listed.'}</Text>}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          {list.map(card)}
        </Box>
        <Text dimColor>Click a project's name to show it in the git graph · ✕ untracks it (restore under Edit list).</Text>
      </Box>
    )
  })
}
