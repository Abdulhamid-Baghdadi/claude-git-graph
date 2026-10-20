import { describe, expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:/Users/you/Desktop/demo'
const HASH = 'a'.repeat(40)
const PROPS = { title: 'Git graph', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

// A repo with two uncommitted files and two commits not pushed; records every git call.
function fakeRepo(commits: number) {
  const ran: string[] = []
  const result = (exitCode: number, stdout: string, stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
  const log = Array.from({ length: commits }, (_, i) => {
    const hash = i === 0 ? HASH : String(i).padStart(40, '0')
    const parent = i < commits - 1 ? String(i + 1).padStart(40, '0') : ''
    return `${hash}\x1f${parent}\x1f${i === 0 ? 'HEAD -> main' : ''}\x1fAli\x1f${i} hours ago\x1f2026-10-18\x1fCommit ${i}\x1e\n`
  }).join('')
  const answer = (argv: readonly string[]) => {
    const args = argv.slice(9).join(' ')
    ran.push(args)
    if (args === 'rev-parse --show-toplevel') return result(0, `${ROOT}\n`)
    if (args.startsWith('log ')) {
      const n = Number(argv[argv.indexOf('-n') + 1])
      return result(0, log.split('\n').slice(0, n).join('\n'))
    }
    if (args === 'status --porcelain') return result(0, ' M src/app.ts\n?? notes.md\n')
    if (args === 'rev-parse --abbrev-ref HEAD') return result(0, 'main\n')
    if (args === 'rev-parse HEAD') return result(0, `${HASH}\n`)
    if (args.startsWith('rev-list --left-right')) return result(0, '0\t2\n')
    if (args.startsWith('worktree')) return result(0, `worktree ${ROOT}\nHEAD ${HASH}\nbranch refs/heads/main\n`)
    if (args.startsWith('for-each-ref')) return result(0, 'main\n')
    if (args === 'add -A') return result(0, '')
    if (args.startsWith('commit -m')) return result(0, '[main 1234abc] Fix the header\n 2 files changed\n')
    if (args === 'push') return result(0, '', 'To github.com:me/demo.git\n   1234abc..5678def  main -> main\n')
    return result(1, '', `unmocked: ${args}`)
  }
  return { ran, answer }
}

describe('changes box', () => {
  test('lists uncommitted files, commits them with my message, and pushes', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const repo = fakeRepo(3)
    on('process.run', async (_$, e) => ({ value: repo.answer(e.argv) }))
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    on('session.cwd', async () => ({ value: ROOT }))

    const ui = await $.ui.mount({ plugin: 'git-graph', surface: 'desktop', component: 'Pane', requestId: 'git-graph', props: PROPS })
    await ui.press({ key: 'cwd' })

    expect((await ui.find({ type: 'Text', text: '2 uncommitted files' }))?.text).toBe('2 uncommitted files')
    expect(await ui.find({ type: 'Text', text: /src\/app\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /notes\.md/ })).toBeDefined()
    expect((await ui.find({ key: 'push' }))?.text).toBe('Push 2 commits')

    // Nothing writes until the person acts.
    expect(repo.ran.filter(args => /^(add|commit|push)\b/.test(args))).toEqual([])

    await ui.input({ key: 'commit-message', text: 'Fix the header' })
    expect(repo.ran.filter(args => /^(add|commit)\b/.test(args))).toEqual(['add -A', 'commit -m Fix the header'])
    expect(await ui.find({ type: 'Text', text: '[main 1234abc] Fix the header' })).toBeDefined()

    await ui.press({ key: 'push' })
    expect(repo.ran.filter(args => /^push\b/.test(args))).toEqual(['push'])
    expect(await ui.find({ type: 'Text', text: /main -> main/ })).toBeDefined()
  })

  test('an empty message commits nothing', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const repo = fakeRepo(3)
    on('process.run', async (_$, e) => ({ value: repo.answer(e.argv) }))
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    on('session.cwd', async () => ({ value: ROOT }))
    const ui = await $.ui.mount({ plugin: 'git-graph', surface: 'desktop', component: 'Pane', requestId: 'git-graph', props: PROPS })
    await ui.press({ key: 'cwd' })
    await ui.input({ key: 'commit-message', text: '   ' })
    expect(repo.ran.filter(args => /^(add|commit)\b/.test(args))).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'Write a commit message first.' })).toBeDefined()
  })

  test('a long history is drawn as several Svgs and Show more loads more', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const repo = fakeRepo(400)
    on('process.run', async (_$, e) => ({ value: repo.answer(e.argv) }))
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    on('session.cwd', async () => ({ value: ROOT }))
    const ui = await $.ui.mount({ plugin: 'git-graph', surface: 'desktop', component: 'Pane', requestId: 'git-graph', props: PROPS })
    await ui.press({ key: 'cwd' })

    // 150 commits plus the uncommitted row, 50 rows per Svg.
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(4)
    expect(await ui.find({ type: 'Text', text: /Showing the latest 150 commits/ })).toBeDefined()
    await ui.press({ key: 'more' })
    expect(await ui.find({ type: 'Text', text: /Showing the latest 300 commits/ })).toBeDefined()
    await ui.press({ key: 'more' })
    expect(await ui.find({ type: 'Text', text: /All 400 commits/ })).toBeDefined()
    expect(await ui.find({ key: 'more' })).toBeUndefined()
  })
})
