# feature-cycle

**An autonomous workflow for Claude Code that builds ONE bounded feature from a plan you approve —
safely, test-verified, wired-in, and mostly unattended.**

You (with Claude) write a short plan for a single feature — a new MCP tool, an API endpoint, a UI
component, a contained enhancement, or a design-needing bugfix. Claude can adversarially review that
plan against your real repo first. You approve it. Then the workflow drives the feature through a
**develop → review → triage** loop until it's implemented, tested, *actually wired in*, and
production-safe — pausing only when it genuinely needs your decision — and finishes with an
**acceptance check** against your criteria.

It is **one file** (`feature-cycle.mjs`) plus a plan and a small config. Everything project- and
stack-specific lives in the config; the engine itself knows nothing about your language or framework.

> **Sibling project:** [`upgrade-cycle`](https://github.com/Blakeem/claude-code-upgrade-workflow) is
> for the *big* changes — migrations, version upgrades, framework ports, subsystem refactors — where
> the work spans many files and needs decomposition. **`feature-cycle` is for ONE bounded feature.**
> If a change is really several features, run this once per feature, or use `upgrade-cycle`.

---

## How it's different: the plan comes from *plan mode*

The smart part — discovery, writing the spec, and the human approval gate — happens **outside the
engine**, in Claude Code's native **plan mode**, which Anthropic keeps current. Claude explores your
code, asks you the decisions that matter (acceptance criteria; whether the feature wants unit/TDD
tests or a frontend verification method like Chrome DevTools MCP), and writes a plan. The engine
*consumes* that approved plan and builds it. No worse, home-grown spec engine to maintain.

A Workflow runs unattended and **can't ask you questions mid-run**, so anything needing a human
answer is settled before the build — by Claude, interactively, while writing/refining the plan.

### What the build loop actually does

For the one feature, it runs a tight loop:

1. **Develop** — an agent implements the approved plan, writes/runs tests (or drives the configured
   frontend/MCP/curl verification), and **wires the feature in** so it's actually reachable. It
   leaves changes **unstaged**.
2. **Review** — an adversarial agent reviews **only the unstaged diff**, judged against your
   acceptance criteria. It is **deliberately not shown the plan**, so it assesses the code on its own
   merits and catches what the *plan* got wrong — it can't rubber-stamp "the code matches the plan."
3. **Triage** — a planner agent decides: accept and stage it, do another round, **flag** something
   that needs your call, or **stop** on a true blocker. It also checks for regressions against the
   accepted baseline.

When the feature is accepted, an independent **acceptance check** (this one *does* see the plan)
confirms every criterion is met, the feature is reachable from the app's entry points, and the full
gates are green — writing the verdict to `ACCEPTANCE.md`.

### Safety model — why it won't cause regressions

- **It uses git staging as the boundary.** Accepted work is `git add`-ed (the known-good baseline);
  work-in-progress stays unstaged (what the reviewer scrutinises). Anything that disturbs earlier
  accepted work shows up immediately in the diff.
- **It never commits.** Every change lands **staged, not committed**. You review and commit.
- **A feature that reddens the existing suite is treated as a regression** — `green` means the whole
  gate passes, not just the new tests.
- **It only touches what the plan requires.** Pre-existing issues in untouched code are left alone —
  run a normal code review for those.

---

## Requirements

- **Claude Code** with the Workflow capability (this runs as a Claude Code *workflow*).
- The target is a **git repository.** Staging is how regressions are caught — non-negotiable.
- **A way to run the project's build + tests locally** — whatever your stack uses. You provide the
  exact commands; the workflow runs them and reads pass/fail.
- For frontend features: optionally an MCP-based browser driver (e.g. **Chrome DevTools MCP**) or
  **MCP inspector** connected in your session — or it falls back to `curl`/manual verification that
  Claude/you confirm. If the configured method turns out to be unavailable inside the workflow's run
  environment, the run can still finish with **verification deferred** — flagged loudly in the result
  and `NEEDS-DECISION.md` so that check happens interactively before you commit (unit tests are never
  deferred).

---

## Using it in Claude Code

### 1. Ask Claude, and include the word **“workflow”**

The Workflow tool only activates when you opt in, so include **“workflow”** in your message:

> "Use the feature-cycle **workflow** in `~/tools/feature-cycle` to add a `search_docs` MCP tool to
> `~/work/my-mcp-server`. Plan it first so I can approve it."

### 2. Claude writes the plan (plan mode) — you approve it

Claude enters plan mode, explores your repo, asks you the up-front decisions (acceptance criteria,
testing approach), and drafts a plan in the standard shape (`## Feature / ## Acceptance Criteria /
## Integration Points / ## Implementation Steps / ## Files / ## Test Strategy / ## Gate`). For a
non-trivial feature it can run **`phase:"refine"`** first — an independent critic greps your repo,
verifies the plan, and returns gaps + questions (`PLAN-REVIEW.md`). You approve the final plan.

### 3. Build

Claude runs **`phase:"build"`** with the approved plan. One feature is roughly **250–350k tokens**
and a few minutes. Claude drives the `Workflow` tool; you watch progress (`/workflows`) and review
the result.

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

Then read the run's reports under `runs/<runId>/`:

- **`FEATURE.md`** — a human-readable summary of what changed and how it was verified.
- **`ACCEPTANCE.md`** — the acceptance check: per-criterion table, reachability, full-gate result,
  and any gaps. Read this before committing.
- **`NEEDS-DECISION.md`** — anything the workflow flagged for *you* (usually a business-logic call).
- **`BLOCKERS.md`** — only present if a run hard-stopped; explains why and how to resume.
- **`PLAN-REVIEW.md`** — only if you ran the `refine` phase: the plan critic's gaps + questions.

**Always confirm the feature is actually reachable yourself** (grep the integration point) and that
the existing suite still passes. If the status says **verification deferred**, the configured
frontend/MCP/manual check never ran in the workflow environment — run it yourself first. When
satisfied: commit.

---

## Config field reference

| field | required | meaning |
|------|:--:|---------|
| `phase` |  | `"refine"` (review the plan, stop) or `"build"` (implement it). Default `"build"`. |
| `runId` | ✓ | names the state dir `runs/<runId>/` |
| `plan` / `planPath` | ✓ | the approved plan: inline markdown (`plan`) or a file path (`planPath`). One is required. |
| `target` | ✓ | `{ repo, lang, framework }` — `repo` is the target git repo |
| `gates` | ✓ | `{ build, test, testSetup }` — your stack's commands |
| `root` |  | where state is written + base for relative paths; auto-detected from cwd if omitted |
| `reference` |  | a completed example to mirror |
| `conventions` |  | coding rules the reviewer judges against |
| `baselineNote` |  | expected pre-existing working-tree changes to fold into the baseline |
| `fixSeverity` / `reviewSeverity` |  | severity floors (default `high`) |
| `maxRounds` |  | develop→review→triage fix-round cap (default 3) |
| `prepBaseline` |  | fold pre-existing tracked changes into the staged baseline first (default `true`) |
| `verify` |  | run the acceptance check after accept (default `true`) |
| `models` |  | per-role tier (defaults: planner/develop `opus`, review/scribe `sonnet`) |
| `agentTypes` |  | per-role custom subagent types — **only set ones that exist in your agent registry** |

### The plan shape

```markdown
## Feature            one paragraph: WHAT and why
## Acceptance Criteria observable, testable "done" statements (the spec the reviewer judges against)
## Integration Points where it must be wired in / reachable (registered, exported, routed, flagged)
## Implementation Steps ordered minimal steps (the HOW — only developer + acceptance verifier see it)
## Files              likely-touched paths
## Test Strategy      kind: tdd|tests-after|manual|none · unit: bool · method: unit|curl|chrome-devtools-mcp|mcp-inspector|playwright|manual · details: how to run it
## Gate               green (build + verification) | build-only
```

See `examples/` for a backend TDD example (`add-mcp-tool.json`) and a frontend browser-verified
example (`add-dark-mode-frontend.json`), plus `TEMPLATE.json`. **`CLAUDE.md`** is the operator guide
Claude follows when driving this — it documents the orchestrating-agent protocol, the visibility
split, and the gotchas.
