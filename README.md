# git-graph – a Claude Code mod for the Claude desktop app

Two panes inside the Claude desktop app: a **Git graph** of the repo you're working in, and a **Portfolio** with one activity card per local project.
Two buttons above the prompt open them, so you can see branches, worktrees and unpushed work without leaving the conversation.

<p align="center">
  <img src="docs/git-graph.svg" alt="The Git graph pane drawing the history of a real repository, with branch lanes and merge commits" width="860">
</p>

<sub>Drawn by the mod's own <code>renderSvg()</code> from the history of <a href="https://github.com/Abdulhamid-Baghdadi/double-scara-robot-ros">double-scara-robot-ros</a>. It follows your light or dark theme.</sub>

## Features

**⎇ Git graph** (`/git-graph [repo path]`)
- Commit graph with branch lanes, merge commits, and pills for branches, tags, remotes and worktrees.
- Hover a commit to see its hash, author, date and refs.
- A dashed "working tree" row lists uncommitted files (new, modified, renamed, deleted).
- **Commit all** with your own message, then **Push**. A branch with no upstream is published to the first remote.
- Opens on the session's folder. Switch repo from a recent-repos list or by pasting a path.
- Loads 150 commits at a time, with **Show more** up to 3,000. Refreshes every 30 s and after every Claude turn.

**▦ Portfolio** (`/portfolio`)
- One card per project: commits in the last 24 h, branches (and how many are active), worktrees, uncommitted files, unpushed commits, and the last commit.
- A status chip on each card: **Needs attention** (unpushed commits or 10+ uncommitted files), **Active**, **Idle N days** or **Can't read**. Cards needing attention sort first.
- Projects come from the repos you've opened in the git graph, plus any you add under **Edit list**. ✕ untracks a project, and you can restore it later.
- Click a project's name to open it in the git graph.

## Privacy and safety

- Everything runs **local `git`** through the mod API. Nothing about your repos leaves the machine unless you press **Push**.
- The Portfolio only reads. Its tests check that it never runs `commit`, `push`, `fetch`, `checkout` or any other command that writes.
- Every git call passes `-c core.fsmonitor=false -c diff.external= -c core.pager=cat`, so a cloned repo's own config can't make the pane run programs.
- Pushes run with `GIT_TERMINAL_PROMPT=0`. A push that needs credentials fails with a message instead of hanging.

## Install

1. Clone this repo somewhere permanent, for example `~/.claude/mods/git-graph`:
   ```bash
   git clone https://github.com/Abdulhamid-Baghdadi/claude-git-graph.git ~/.claude/mods/git-graph
   ```
2. Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:
   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\you\\.claude\\mods\\git-graph" } }
   ```
3. Start a new session in the Claude desktop app (Code tab). The **⎇ Git graph** and **▦ Portfolio** buttons appear above the prompt.

## How it's built

| File | Role |
|---|---|
| `hooks/register.tsx` | Everything that talks to the engine (`$`): commands, panes, the buttons above the prompt, git calls, refresh timers |
| `hooks/graph.ts` | Pure helpers: parse `git log`, assign lanes and edges, render the graph as SVG, read `git status` lines |
| `hooks/portfolio.ts` | Pure helpers: merge the project list, parse branch/worktree/log output, decide each card's status |
| `types/index.d.ts` | Shared types (`Snapshot`, `Commit`, `ProjectFacts`, …) |
| `tests/` | 23 tests against a mocked engine and fake git output; no real repo is touched |

A few details:
- **Lane layout:** each commit gets a lane. Each parent link is an edge that leaves its child's lane, runs down a lane of its own, and lands in the parent's lane.
- **Size limit:** the engine refuses an SVG longer than 131,072 characters. Long histories are drawn as a stack of row ranges, and any range still too big is split in half.

## Develop

```bash
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```

All code that calls the engine (`$`) lives in `hooks/register.tsx`, because the engine follows `$` only within one file.

## License

[MIT](LICENSE) © Abdulhamid Baghdadi
