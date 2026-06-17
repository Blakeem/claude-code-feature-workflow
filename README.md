# feature-cycle

**An autonomous workflow for Claude Code that builds ONE bounded feature from a plan you approve —
safely, test-verified, wired-in, and mostly unattended.**

You (with Claude) write a short plan for a single feature — a new MCP tool, an API endpoint, a new
page or form, a contained enhancement, or a design-needing bugfix — in plan mode, and **you approve
it**. Claude then **adversarially reviews that plan against your real repo** (a required step) and
folds in the gaps before building. Then the workflow drives the feature through a **develop → blind
code review → acceptance** loop until it's implemented, tested, *actually wired in*, and
production-safe — pausing only when it genuinely needs your decision — and stages it for you to commit.

> **Design:** the engine is built to a small set of rules — lean, file-based messaging between agents,
> no busy-work agents. See [`WORKFLOW-PRINCIPLES.md`](./WORKFLOW-PRINCIPLES.md). `CLAUDE.md` is the
> operator guide Claude follows when driving it.

### Is this the right tool? (scope)

The workflow has real overhead — plan mode, a mandatory plan review, and a multi-round build loop
(a couple hundred k tokens). It's worth it only for a feature **big enough to deserve a written plan**:

- ✅ **Right size:** one bounded feature, roughly **10–100+ lines**, integrated into an existing
  codebase — a new MCP tool, API endpoint, page, form, or similarly-scoped enhancement / bugfix.
- ❌ **Too small** (one-line change, rename, config flip): skip the workflow and just make the edit.
  If it's too small to review a plan for, it's too small for this.
- ❌ **Too big** (migration, version upgrade, framework port, broad refactor across many files): use
  the sibling [`upgrade-cycle`](https://github.com/Blakeem/claude-code-upgrade-workflow), or split it
  and run this once per bounded feature.

It is **one file** (`feature-cycle.mjs`) plus a plan and a small config. Everything project- and
stack-specific lives in the config; the engine itself knows nothing about your language or framework.

> **Sibling project:** [`upgrade-cycle`](https://github.com/Blakeem/claude-code-upgrade-workflow) is
> for the *big* changes — migrations, version upgrades, framework ports, subsystem refactors — where
> the work spans many files and needs decomposition. **`feature-cycle` is for ONE bounded feature.**
> If a change is really several features, run this once per feature, or use `upgrade-cycle`.

---

## How it's different: the plan comes from *plan mode*, and travels verbatim

The smart part — discovery, writing the spec, and the human approval gate — happens **outside the
engine**, in Claude Code's native **plan mode**, which Anthropic keeps current. Claude explores your
code, asks you the decisions that matter (acceptance criteria; whether the feature wants unit/TDD
tests or a frontend verification method like Chrome DevTools MCP), and writes the plan into plan
mode's own plan file (`~/.claude/plans/<name>.md`). You approve it. Then — once plan mode's read-only
gate is lifted — the plan goes through the engine's **mandatory `refine` pass**: an independent critic
greps your repo, returns gaps + questions, and Claude folds them in (asking you about anything
blocking) *before* the build runs.

The plan you approved is read **verbatim** by the agents that build and verify it — never parsed into
fields and rebuilt — so nothing about your spec is lost or reinterpreted on the way in.

A Workflow runs unattended and **can't ask you questions mid-run**, so anything needing a human
answer is settled before the build — by Claude, interactively, while writing/refining the plan.

### What the build loop actually does

For the one feature, it runs a tight loop (up to a few rounds):

1. **Develop** — an agent implements the approved plan, writes/runs tests (or drives the configured
   frontend/MCP/curl verification), and **wires the feature in** so it's actually reachable. It runs
   your build/test gate to green and leaves changes **unstaged**.
2. **Blind code review** — a reviewer reads **only the unstaged diff**, with **no plan, spec, or
   goal** — judging the code purely on its own merits for production-blocking defects. Being blind, it
   can't rubber-stamp "the code matches the plan"; it catches real bugs. This stage must be clean
   before the next one runs, and any code change re-enters here.
3. **Acceptance review** — a plan-aware agent (this one *does* see the plan) confirms every acceptance
   criterion is met, the feature is reachable from the app's entry points, the full gates are green,
   and **nothing regressed**. On pass, it stages the feature for you.

The developer owns a **decision matrix**: it fixes what's real, and for any reviewer finding it
declines it records a one-line reason in `DISMISSED.md` so the blind reviewer doesn't re-flag it round
after round. A reviewer that thinks a dismissal is wrong can contest it once; the developer must then
fix or escalate it — so the loop converges without silently burying a real defect. Anything only you
can decide goes to `NEEDS-USER.md`, and a hard blocker pauses the run for you.

### Safety model — why it won't cause regressions

- **It uses git staging as the boundary.** Already-staged work is the known-good baseline;
  work-in-progress stays unstaged (what the reviewers scrutinise). Anything that disturbs earlier
  accepted work shows up immediately in the diff and is caught as a regression by the acceptance gate.
- **There is exactly one staging, at the end, and it never commits.** Only the acceptance gate stages,
  and only on pass. Every change lands **staged, not committed** — you review and commit.
- **A feature that reddens the existing suite is treated as a regression** — `green` means the whole
  gate passes, not just the new tests.
- **It only touches what the plan requires.** Pre-existing issues in untouched code are left alone —
  run a normal code review for those.

---

## Requirements

- **Claude Code** with the Workflow capability (this runs as a Claude Code *workflow*).
- The target is a **git repository.** Staging is how regressions are caught — non-negotiable.
- A **clean unstaged working tree** before a build run (Claude handles this as setup): the blind
  reviewer treats the unstaged diff as "this feature's work."
- **A way to run the project's build + tests locally** — whatever your stack uses. You provide the
  exact commands; the workflow runs them and reads pass/fail.
- For frontend features: optionally an MCP-based browser driver (e.g. **Chrome DevTools MCP**) or
  **MCP inspector** connected in your session — or it falls back to `curl`/manual verification. If the
  configured method turns out to be unavailable inside the workflow's run environment, the acceptance
  gate records that and returns *not passed* (it won't fake it) — so you run that check yourself,
  interactively, before committing.

---

## Using it in Claude Code

### 1. Ask Claude, and include the word **“workflow”**

The Workflow tool only activates when you opt in, so include **“workflow”** in your message:

> "Use the feature-cycle **workflow** in `~/tools/feature-cycle` to add a `search_docs` MCP tool to
> `~/work/my-mcp-server`. Plan it first so I can approve it."

### 2. Claude writes the plan (plan mode) — you approve it

Claude enters **plan mode**, explores your repo, asks you the up-front decisions (acceptance
criteria, testing approach), and drafts a plan in the standard shape (`## Feature / ## Acceptance
Criteria / ## Integration Points / ## Implementation Steps / ## Files / ## Test Strategy / ## Gate`)
into plan mode's own plan file (`~/.claude/plans/<name>.md`). You review and approve it — that
approval lifts plan mode's read-only gate.

### 3. Mandatory plan review (`refine`), then build

Now out of read-only mode, Claude runs the **mandatory `phase:"refine"`** pass with `planPath`
pointing straight at the approved plan-mode file (`~/.claude/plans/<name>.md` — no copy) — an
independent critic greps your repo, verifies the plan against real code, and **returns** gaps +
questions in the result. Claude fixes the gaps and relays any blocking questions to you *before
building*. Then, after making sure the target repo's unstaged tree is clean, it runs
**`phase:"build"`** with the same `runId` and the same `planPath`. One feature is roughly a couple
hundred k tokens and a few minutes. Claude drives the `Workflow` tool; you watch progress
(`/workflows`) and review the result.

---

## Reviewing the changes

When a run finishes, **nothing is committed** — it's all staged in your target repo. Review it like a
PR:

```bash
cd /path/to/target-repo
git diff --cached            # everything the workflow staged
git diff --cached --stat     # the file-level summary
<your build + test command>  # confirm green yourself
```

Then read the run's files under `runs/<runId>/` (the numbered review files are the full, transparent
trail — one per round, per stage):

- **`acceptance-review-<N>.md`** — the final, plan-aware check: per-criterion table, reachability,
  regression, full-gate result, and any gaps. Read the latest one before committing.
- **`quality-review-<N>.md`** — what the blind code critic found (or "No production-blocking defects
  found.") each round.
- **`DISMISSED.md`** — every reviewer finding the developer chose *not* to act on, with a one-line
  reason. **Audit this** — it's the developer's judgment calls in one place.
- **`NEEDS-USER.md`** — anything the workflow flagged for *you* (a blocker, question, or decision).
  If a run hard-stopped, the reason is here.

**Always confirm the feature is actually reachable yourself** (grep the integration point) and that
the existing suite still passes. If the acceptance file says the configured frontend/MCP/manual check
couldn't run in the workflow environment, run it yourself first. When satisfied: commit.

---

## Config field reference

| field | required | meaning |
|------|:--:|---------|
| `phase` |  | `"refine"` (review the plan, stop) or `"build"` (implement it). Default `"build"`. Run `refine` FIRST (it's required), then `build` — reuse the same `runId` for both. |
| `runId` | ✓ | names the state dir `runs/<runId>/`; reuse the SAME id for the `refine` and `build` phases of one feature |
| `plan` / `planPath` | ✓ | the approved plan: inline markdown (`plan`) or a file path (`planPath`). One is required. `planPath` is normally the plan-mode file itself — its **full absolute path** (`~` is not expanded), e.g. `C:/Users/you/.claude/plans/<name>.md`. Read verbatim; no copy needed. |
| `target` | ✓ | `{ repo, lang, framework }` — `repo` is the target git repo |
| `gates` | ✓ | `{ build, test, testSetup }` — your stack's commands |
| `gate` |  | `"green"` (build + the required verification pass) or `"build-only"` (build/lint only — for a feature with no test/verification). Derive it from the plan's `## Gate` section. Default `"green"`. |
| `root` | ✓ | absolute base the run-state hangs off (normally the workflow tool's own directory, so `runs/` lands beside the tool). Required — the engine errors if it's missing rather than spawning an agent to guess the cwd. |
| `stateDir` |  | override the `runs/<runId>/` location |
| `reference` |  | a completed example to mirror |
| `conventions` |  | coding rules the **developer** follows (the blind reviewer is not shown them) |
| `maxRounds` |  | develop→quality→acceptance round cap (default `4`) |
| `models` |  | per-role tier (defaults: `plan` / `develop` / `acceptance` = `opus`, `quality` = `sonnet`) |
| `agentTypes` |  | per-role custom subagent types — **only set ones that exist in your agent registry** |

### The plan shape

```markdown
## Feature            one paragraph: WHAT and why
## Acceptance Criteria observable, testable "done" statements (the spec the acceptance gate judges against)
## Integration Points where it must be wired in / reachable (registered, exported, routed, flagged)
## Implementation Steps ordered minimal steps (the HOW)
## Files              likely-touched paths
## Test Strategy      kind: tdd|tests-after|manual|none · unit: bool · method: unit|curl|chrome-devtools-mcp|mcp-inspector|playwright|manual · details: how to run it
## Gate               green (build + verification) | build-only
```

The agents read this file **verbatim** — there's no parser, so write it for a human. See `examples/`
for a backend TDD example (`add-mcp-tool.json`) and a frontend browser-verified example
(`add-dark-mode-frontend.json`), plus `TEMPLATE.json`. **`CLAUDE.md`** is the operator guide Claude
follows when driving this; **`WORKFLOW-PRINCIPLES.md`** is the design law the engine is built to.
