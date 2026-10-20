import { describe, expect, mock, test } from 'claude-code/testing'

const DAY = 86_400

// Answers the pane's git commands for four fake projects; no real repo is read.
function fakeGit(argv: readonly string[], cwd: string, nowSec: number) {
  const args = argv.slice(9).filter(arg => arg !== '--no-optional-locks')
  const root = cwd.replace(/\\/g, '/')
  const name = root.split('/').pop() ?? ''
  const result = (exitCode: number, stdout: string, stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
  const ok = (stdout: string) => result(0, stdout)
  const has = (...words: string[]) => words.every(word => args.includes(word))

  if (has('--show-toplevel')) {
    return name === 'notes'
      ? result(128, '', 'fatal: not a git repository (or any of the parent directories): .git')
      : ok(`${root}\n`)
  }
  const last = { 'website': nowSec - 3600, 'robot-arm': nowSec - 5 * DAY }[name] ?? nowSec - 9 * DAY
  if (has('--symbolic-full-name')) return ok('origin/main\n')
  if (has('--abbrev-ref', 'HEAD')) return ok('main\n')
  if (has('--since=@' + (nowSec - DAY))) return ok(name === 'website' ? '4\n' : '0\n')
  if (has('--not', '--remotes')) return ok(name === 'thesis' ? '2\n' : '0\n')
  if (args[0] === 'for-each-ref') return ok(`${last}\n${nowSec - 40 * DAY}\n`)
  if (args[0] === 'worktree') {
    const linked = name === 'website' ? `\nworktree ${root}/.claude/worktrees/x\nHEAD b\nbranch refs/heads/claude/x\n` : ''
    return ok(`worktree ${root}\nHEAD a\nbranch refs/heads/main\n${linked}`)
  }
  if (args[0] === 'status') return ok(name === 'robot-arm' ? ' M f\n'.repeat(12) : '')
  if (args[0] === 'remote') return ok('origin\n')
  if (args[0] === 'log' && has('-1')) return ok(`${last}\x1fWork on ${name}\n`)
  return ok('')
}

describe('portfolio pane', () => {
  test('draws one card per project, needs-attention first, and a click switches the git graph', async ($, on) => {
    const nowSec = 1_800_000_000
    mock.clock(on, { now: nowSec * 1000 })
    mock.store(on, {
      'portfolio.added': ['robot-arm', 'website', 'notes', 'thesis'].map(name => `C:\\Users\\you\\Desktop\\${name}`),
    })
    const ran: string[][] = []
    on('process.run', async (_$, e) => {
      ran.push([...e.argv])
      return { value: fakeGit(e.argv, e.init?.cwd ?? '', nowSec) }
    })
    const opened: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })

    const ui = await $.ui.mount({
      plugin: 'git-graph',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'portfolio',
      props: { title: 'Portfolio', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    await ui.press({ key: 'refresh' })

    const chips = await ui.findAll({ type: 'Text', text: /^(Needs attention|Active|Idle|Can't read)/ })
    expect(chips.map(chip => chip.text)).toEqual(['Needs attention', 'Needs attention', 'Active', "Can't read"])
    expect((await ui.findAll({ type: 'Button', text: /^(robot-arm|thesis|website)$/ })).map(button => button.text)).toEqual([
      'robot-arm',
      'thesis',
      'website',
    ])
    expect(await ui.find({ type: 'Text', text: '12 uncommitted files' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 commits not pushed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4 today · 2 branches (1 active) · 1 worktree' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /not a git repository/ })).toBeDefined()

    // Read-only: every git call is one of the pane's queries, none that writes.
    const writes = ran.filter(argv => /^(commit|push|fetch|pull|checkout|switch|reset|add|stash|merge|rebase)$/.test(argv.find(arg => !arg.startsWith('-') && arg !== 'git') ?? ''))
    expect(writes).toEqual([])

    await ui.press({ key: 'open-2' })
    expect(opened).toEqual(['git-graph'])
    const graph = await $.ui.mount({
      plugin: 'git-graph',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'git-graph',
      props: { title: 'Git graph', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect((await graph.find({ type: 'Text', text: 'website' }))?.text).toBe('website')
  })

  test('buttons above the prompt open each pane', async ($, on) => {
    mock.clock(on, { now: 1_800_000_000_000 })
    mock.store(on)
    on('process.run', async (_$, e) => ({ value: fakeGit(e.argv, e.init?.cwd ?? '', 1_800_000_000) }))
    const opened: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    const band = await $.ui.mount({
      plugin: 'git-graph',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
    })
    await band.press({ key: 'show-graph' })
    await band.press({ key: 'show-portfolio' })
    expect(opened).toEqual(['git-graph', 'portfolio'])
  })
})
