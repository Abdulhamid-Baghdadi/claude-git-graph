// Draws a repo's commit graph with the mod's own renderSvg, outside the app (used for docs/git-graph.svg).
// npx tsx docs/render-graph.ts <repo> docs/git-graph.svg [rows] [width]
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { LOG_FORMAT, parseLog, renderSvg } from '../hooks/graph'

const [repo, out, rows = '32', width = '900'] = process.argv.slice(2)
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
const commits = parseLog(git('log', '--branches', '--remotes', '--tags', 'HEAD', '--date-order', '-n', rows, `--format=${LOG_FORMAT}`))
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim()
const snapshot = {
  repo, branch, head: git('rev-parse', 'HEAD').trim(), commits, dirty: 0, files: [], ahead: 0, behind: 0,
  branches: git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean),
  worktreeBranches: [], isTruncated: true, loadedAt: Date.now(),
}
const { source } = renderSvg(snapshot as any, Number(width))
writeFileSync(out, source)
console.log(out, commits.length, 'commits', source.length, 'chars')
