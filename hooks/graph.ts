import type { Commit, Snapshot } from '../types'

const FIELD = '\x1f'
const RECORD = '\x1e'

export const LOG_FORMAT = ['%H', '%P', '%D', '%an', '%cr', '%ci', '%s'].join('%x1f') + '%x1e'

export function parseLog(stdout: string): Commit[] {
  return stdout
    .split(RECORD)
    .map(record => record.replace(/^\s+/, ''))
    .filter(record => record.length > 0)
    .map(record => {
      const [hash = '', parents = '', refs = '', author = '', when = '', date = '', ...subject] =
        record.split(FIELD)
      return {
        hash,
        parents: parents.split(' ').filter(Boolean),
        refs: refs.split(', ').map(ref => ref.trim()).filter(Boolean),
        author,
        when,
        date,
        subject: subject.join(FIELD).trim(),
      }
    })
}

// Each commit gets a lane; each parent link is an edge that leaves its child's
// lane, travels down `via`, and lands in the parent's lane at the parent's row.
export type Edge = { fromRow: number; fromLane: number; via: number; toRow: number; toLane: number }
export type Layout = { lanes: number[]; edges: Edge[]; width: number }

export function layout(commits: readonly Commit[]): Layout {
  const open: (string | null)[] = []
  const lanes: number[] = []
  const pending: { fromRow: number; fromLane: number; via: number; parent: string }[] = []
  const rowOf = new Map(commits.map((commit, row) => [commit.hash, row]))
  let width = 1

  const claim = (hash: string) => {
    const free = open.indexOf(null)
    const lane = free === -1 ? open.length : free
    open[lane] = hash
    return lane
  }

  commits.forEach((commit, row) => {
    let lane = open.indexOf(commit.hash)
    if (lane === -1) lane = claim(commit.hash)
    open.forEach((hash, other) => {
      if (other !== lane && hash === commit.hash) open[other] = null
    })
    lanes[row] = lane

    if (commit.parents.length === 0) open[lane] = null
    commit.parents.forEach((parent, index) => {
      let via = lane
      if (index === 0) open[lane] = parent
      else {
        via = open.indexOf(parent)
        if (via === -1) via = claim(parent)
      }
      pending.push({ fromRow: row, fromLane: lane, via, parent })
    })
    width = Math.max(width, open.length)
  })

  const edges = pending.map(({ fromRow, fromLane, via, parent }) => {
    const toRow = rowOf.get(parent)
    return toRow === undefined
      ? { fromRow, fromLane, via, toRow: commits.length, toLane: via }
      : { fromRow, fromLane, via, toRow, toLane: lanes[toRow] ?? via }
  })

  return { lanes, edges, width }
}

const COLORS = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#D4537E', '#BA7517', '#639922', '#888780']
const ROW = 24
const LANE = 14
const PAD = 12
const CHAR = 6.6
const TIP_MAX = 160

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clip = (text: string, room: number) => {
  const chars = Math.max(0, Math.floor(room / CHAR))
  return text.length <= chars ? text : text.slice(0, Math.max(0, chars - 1)) + '…'
}

// "3 hours ago" -> "3h"; git's relative dates are English whatever the locale.
export function shortWhen(when: string): string {
  const match = /^(\d+) (second|minute|hour|day|week|month|year)s? ago/.exec(when)
  if (!match) return when
  const unit = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' }[match[2] ?? '']
  return `${match[1]}${unit ?? ''}`
}

type Pill = { text: string; kind: 'head' | 'local' | 'remote' | 'tag' | 'worktree' }

export function pills(refs: readonly string[], branches: readonly string[], worktrees: readonly string[]): Pill[] {
  const here = new Set(refs.map(ref => (ref.startsWith('HEAD -> ') ? ref.slice(8) : ref)))
  const out: Pill[] = []
  for (const ref of refs) {
    if (ref === 'HEAD') out.push({ text: 'HEAD', kind: 'head' })
    else if (ref.startsWith('HEAD -> ')) out.push({ text: ref.slice(8), kind: 'head' })
    else if (ref.startsWith('tag: ')) out.push({ text: ref.slice(5), kind: 'tag' })
    else if (branches.includes(ref)) out.push({ text: ref, kind: worktrees.includes(ref) ? 'worktree' : 'local' })
    else {
      // A remote branch sitting on the same commit as its local twin adds nothing.
      const name = ref.slice(ref.indexOf('/') + 1)
      if (name !== 'HEAD' && !here.has(name)) out.push({ text: ref, kind: 'remote' })
    }
  }
  return out
}

export function withWorkingRow(snapshot: Snapshot): Commit[] {
  if (snapshot.dirty === 0 || !snapshot.commits.some(commit => commit.hash === snapshot.head)) {
    return snapshot.commits
  }
  const files = snapshot.dirty === 1 ? '1 file' : `${snapshot.dirty} files`
  return [
    {
      hash: '',
      parents: [snapshot.head],
      refs: [],
      author: '',
      when: 'now',
      date: '',
      subject: `Uncommitted changes (${files})`,
      isWorking: true,
    },
    ...snapshot.commits,
  ]
}

// Rows `from` up to `to` of the whole graph (all of it by default): a long history is drawn as
// several of these stacked, since the engine refuses one Svg past 131072 characters.
export function renderSvg(snapshot: Snapshot, width: number, from = 0, to = Infinity): { source: string; height: number } {
  const commits = withWorkingRow(snapshot)
  const { lanes, edges, width: laneCount } = layout(commits)
  const height = Math.max(1, commits.length) * ROW + 8
  const top = from <= 0 ? 0 : 4 + from * ROW
  const bottom = to >= commits.length ? height : 4 + to * ROW
  const x = (lane: number) => PAD + lane * LANE
  const y = (row: number) => 4 + row * ROW + ROW / 2
  const color = (lane: number) => COLORS[lane % COLORS.length]
  const textX = PAD + laneCount * LANE + 4
  const parts: string[] = []

  for (const edge of edges) {
    const x0 = x(edge.fromLane)
    const y0 = y(edge.fromRow)
    const xv = x(edge.via)
    const xt = x(edge.toLane)
    const yt = edge.toRow >= commits.length ? height : y(edge.toRow)
    if (yt < top || y0 > bottom) continue
    const half = ROW / 2
    let d = `M${x0},${y0}`
    if (edge.toRow === edge.fromRow + 1 && edge.toRow < commits.length) {
      d += x0 === xt ? ` L${xt},${yt}` : ` C${x0},${y0 + half} ${xt},${yt - half} ${xt},${yt}`
    } else {
      if (xv !== x0) d += ` C${x0},${y0 + half} ${xv},${y0 + half} ${xv},${y0 + ROW}`
      d += ` L${xv},${yt - ROW}`
      d += xt === xv ? ` L${xt},${yt}` : ` C${xv},${yt - half} ${xt},${yt - half} ${xt},${yt}`
    }
    const isWorking = commits[edge.fromRow]?.isWorking === true
    parts.push(
      `<path d="${d}" stroke="${color(edge.via)}" stroke-width="2" fill="none"${isWorking ? ' stroke-dasharray="3 3"' : ''}/>`,
    )
  }

  commits.forEach((commit, row) => {
    if (row < from || row >= to) return
    const lane = lanes[row] ?? 0
    const cy = y(row)
    // Tooltips are most of the markup, and the engine refuses an Svg past 131072 characters: keep each short.
    const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
    const tip = [
      commit.isWorking ? commit.subject : `${commit.hash.slice(0, 8)}  ${short(commit.subject, TIP_MAX)}`,
      commit.author && `${commit.author} · ${commit.date}`,
      commit.refs.length > 0 && short(commit.refs.join(', '), TIP_MAX),
    ]
      .filter(Boolean)
      .join('\n')
    parts.push(`<g><title>${escape(tip)}</title>`)
    parts.push(`<rect class="hit" x="0" y="${cy - ROW / 2}" width="${width}" height="${ROW}"/>`)
    if (commit.isWorking) {
      parts.push(`<circle cx="${x(lane)}" cy="${cy}" r="5" fill="none" stroke="${color(lane)}" stroke-width="2" stroke-dasharray="2 2"/>`)
    } else if (commit.parents.length > 1) {
      parts.push(`<circle cx="${x(lane)}" cy="${cy}" r="5" class="bg" stroke="${color(lane)}" stroke-width="2.5"/>`)
    } else {
      parts.push(`<circle cx="${x(lane)}" cy="${cy}" r="5" fill="${color(lane)}"/>`)
    }

    const when = shortWhen(commit.when)
    const whenX = width - PAD
    let cursor = textX
    for (const pill of pills(commit.refs, snapshot.branches, snapshot.worktreeBranches)) {
      const label = clip(pill.kind === 'worktree' ? `${pill.text} ⎇` : pill.text, 150)
      const w = label.length * 6.1 + 10
      if (cursor + w > whenX - 120) break
      const stroke = pill.kind === 'remote' || pill.kind === 'tag' ? 'var(--muted)' : color(lane)
      const fill = pill.kind === 'remote' || pill.kind === 'tag' ? 'none' : color(lane)
      parts.push(
        `<rect x="${cursor}" y="${cy - 8}" width="${w}" height="16" rx="4" fill="${fill}" fill-opacity="${fill === 'none' ? 0 : 0.18}" stroke="${stroke}" stroke-width="${pill.kind === 'head' ? 1.5 : 0.75}"/>`,
        `<text x="${cursor + 5}" y="${cy + 4}" class="pill${pill.kind === 'head' ? ' strong' : ''}">${escape(label)}</text>`,
      )
      cursor += w + 4
    }
    const room = whenX - 34 - cursor
    parts.push(
      `<text x="${cursor}" y="${cy + 4}" class="${commit.isWorking ? 'msg working' : 'msg'}">${escape(clip(commit.subject, room))}</text>`,
      `<text x="${whenX}" y="${cy + 4}" class="when" text-anchor="end">${escape(when)}</text>`,
      `</g>`,
    )
  })

  const style = [
    'svg{--fg:#2c2c2a;--muted:#888780;--bg:#ffffff;--hover:rgba(0,0,0,0.05)}',
    '@media (prefers-color-scheme:dark){svg{--fg:#e8e6df;--muted:#9c9a92;--bg:#262624;--hover:rgba(255,255,255,0.07)}}',
    'text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12px;fill:var(--fg)}',
    '.pill{font-size:11px}.strong{font-weight:600}.when{fill:var(--muted);font-size:11px}',
    '.working{fill:var(--muted);font-style:italic}.bg{fill:var(--bg)}',
    '.hit{fill:transparent}g:hover .hit{fill:var(--hover)}',
  ].join('')

  const h = bottom - top
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 ${top} ${width} ${h}">` +
    `<style>${style}</style><rect class="bg" y="${top}" width="${width}" height="${h}"/>${parts.join('')}</svg>`
  return { source, height: h }
}

export type FileChange = { kind: 'new' | 'deleted' | 'renamed' | 'modified'; path: string }

// One `git status --porcelain` line ("XY path", or "R  old -> new").
export function fileChange(line: string): FileChange {
  const code = line.slice(0, 2)
  const path = line.slice(3)
  if (code === '??' || code.includes('A')) return { kind: 'new', path }
  if (code.includes('D')) return { kind: 'deleted', path }
  if (code.includes('R')) return { kind: 'renamed', path }
  return { kind: 'modified', path }
}
