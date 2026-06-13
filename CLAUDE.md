# feature-cycle — operator guide (for Claude)

This repo is a **single self-contained Claude Code Workflow** (`feature-cycle.mjs`) that builds
**ONE bounded feature** — a new endpoint/component/MCP tool, a contained enhancement, or a
design-needing bugfix — from a plan **you (the orchestrating agent) author and the user approves**,
driving it to a production-ready, test-green, *wired-in* state across one target git repo.

Your job when a user invokes this: decide whether the feature even needs the plan front-end,
**author the plan in plan mode** (asking the up-front decisions), optionally have the engine
adversarially review it, get the user's approval, run the build, then **verify ground truth
yourself**. Below is what is NOT obvious from the prompts inside the engine.

## The division of labour that makes this work

Discovery, spec-writing, and the human approval gate live **OUTSIDE the engine**, in native **plan
mode** — which you drive, and which Anthropic keeps current. The engine consumes an *approved* plan;
it does not decompose a goal or discover a spec. That is the deliberate difference from the sibling
`upgrade-cycle` (which owns its own decomposition because it manages breadth across many call sites).

**A Workflow runs autonomously in the background — it cannot prompt the user mid-run.** So anything
that needs a human answer is YOUR job, done interactively before/around the run:
- **Clarify the spec up front.** If the request is under-specified, use `AskUserQuestion` to nail the
  acceptance criteria BEFORE you write the plan. Building the wrong thing is the #1 feature risk.
- **Decide the testing approach up front** (bake it into the plan's Test Strategy), e.g.:
  - Backend / API / MCP tool / data logic → **unit tests** (often TDD: write failing tests first).
  - Frontend → usually **not** unit tests; decide the verification method *with the user*: Chrome
    DevTools MCP, MCP inspector, Playwright, manual `curl` against a running server, or none.
- **Relay the engine's questions.** If `phase:"refine"` returns questions, ask the user, fold the
  answers into the plan, and only then run `phase:"build"`.

## The orchestrating-agent protocol (do this)

1. **Read the request.** If it's a genuinely large or breadth-spanning change, stop — that's
   `upgrade-cycle`'s job, not this one. This engine is for ONE bounded feature (~1–6 files, one
   develop pass). If it's clearly more, tell the user to split it into multiple runs.
2. **Enter plan mode** (`EnterPlanMode`). Explore the codebase, and if anything material is
   ambiguous, ask the user (`AskUserQuestion`) — especially acceptance criteria and the testing
   approach. Author the plan in the **standard shape** (below).
3. **(Optional) Adversarial plan review.** For non-trivial features, save the plan to a file and run
   `Workflow` with `phase:"refine"`. It greps the real repo, verifies your file list + integration
   points, and returns `gaps`/`questions`/`too_big` + writes `PLAN-REVIEW.md`. Relay questions to the
   user, fix the gaps in the plan. **Skip refine for small, obvious features** ("add a dark-mode
   toggle") — the in-loop review will catch anything small.
4. **Get approval.** Present the (refined) plan and `ExitPlanMode`. The user approves.
5. **Build.** Run `Workflow` with `phase:"build"` and the approved plan (`planPath` or inline `plan`).
   The plan's own final step should literally be *"invoke feature-cycle phase:build with this plan
   file"* — so approval flows straight into execution.
6. **Verify ground truth YOURSELF** (see below), read `ACCEPTANCE.md`, surface anything in
   `NEEDS-DECISION.md`, and tell the user what to review. **Never commit.**

## The plan-file shape (you write this; the engine parses it)

Plain markdown with these headers (the loader extracts them; missing fields are inferred
conservatively, gate defaults to `green`). Keep it tight.

```markdown
## Feature
One paragraph: WHAT this bounded feature is and why. (the WHAT)

## Acceptance Criteria
- Observable, testable statements of "done". (the WHAT — the spec the reviewer judges against)

## Integration Points
- Where it must be WIRED IN / reachable: route mounted, tool registered in <file>, export added,
  DI binding, feature flag, menu entry. (the WHAT — unreached code is an incomplete feature)

## Implementation Steps
1. Ordered, minimal steps. (the HOW — only the developer + acceptance verifier see this)

## Files
- likely-touched paths (the HOW)

## Test Strategy
kind: tdd | tests-after | manual | none
unit: true|false
method: unit | curl | chrome-devtools-mcp | mcp-inspector | playwright | manual
details: exactly how to run/scope it — commands, selectors, how to start a server, what to assert.

## Gate
green   # build + the required verification pass  (or: build-only)
```

## The visibility split (a deliberate de-biasing — keep it)

- **Developer** and **acceptance verifier** see the FULL plan (the HOW).
- **Reviewer** and **triage** are deliberately **BLIND to the HOW** — they see only the WHAT
  (feature + acceptance criteria + integration points) and the diff. So the review judges the code
  *on its own merits against the spec*, and catches what the PLAN itself got wrong — it can't be
  anchored into rubber-stamping "the code matches the plan." This also saves context.

## The five generic roles (all in the engine)

Plan Loader (parses your plan), Plan Critic (`refine` only — adversarial, read-only), Developer
(implements + tests + **wires it in**, leaves work UNSTAGED), Reviewer (adversarial, diff-only,
plan-blind), Planner/Triage (routes findings, **owns git staging**, regression check), Acceptance
Verifier (whole-feature completeness, sees the plan), Scribe (persists progress). The conductor (JS)
sequences them. (`upgrade-cycle`'s separate Research role is gone — discovery happened in plan mode.)

## The contracts that make it safe — keep them intact

- **Staging = the cycle boundary.** Staged index/HEAD = accepted baseline; the unstaged working tree
  = this feature's work (the reviewer's scope). The Developer never stages; the Planner stages on
  accept. **Nothing is ever committed — the user commits.** This is the regression guard.
- **Gates are the per-stack adapter.** `args.gates.build` and `args.gates.test` are literal shell
  commands the agents run — the only thing that changes between a PHP app and a TS app. `build`
  (lint/compile) must ALWAYS pass.
- **Gate semantics** (no intentionally-red phase — a feature is additive): `green` = build + the
  required verification (unit and/or the frontend/MCP/curl method) pass, *and the existing suite
  isn't reddened* (a new feature that breaks existing tests is a regression). `build-only` = build
  green only.
- **Frontend/MCP testing runs in DEVELOP** (inside the fix loop) so failures get repaired in-round —
  then the acceptance verifier re-confirms once at the end. If a configured MCP/tool isn't available
  in the run environment, the developer reports `not-run` rather than faking a pass; triage decides.
- **Lean review policy** (deliberate, to save tokens): the reviewer flags only INTRODUCED,
  production-blocking defects + testing blockers + incomplete-feature/wiring gaps. Easy obvious wins
  are fixed; mediums/lows/pre-existing are dropped (a SEPARATE code-review pass handles those). Do
  NOT lower `reviewSeverity` to surface more — it caused non-converging churn in the sibling engine.
  Floors default to `high`.

## Running it — the playbook

1. **Author + approve the plan** (plan mode). Optionally `phase:"refine"` first.
2. **`phase:"build"`.** Pass `runId`, `target.repo`, `gates`, and `planPath` (best — beside the tool,
   gitignored) **or** inline `plan` text. `root` is auto-detected from `pwd` if omitted; BEST
   PRACTICE: pass the tool's own directory (the `scriptPath` the Workflow result echoes) as `root` so
   run-state lands beside the tool, not inside the target repo. One feature ≈ 250–350k tokens.
3. **Verify ground truth YOURSELF — do not trust the ledger blindly.** Run the gates in the real
   environment, inspect `git diff --cached`, confirm the feature is reachable (grep the integration
   point), and confirm the existing suite is still green. Read `ACCEPTANCE.md` — it's evidence, not a
   substitute for your check.
4. **Resume** after any stop by re-invoking the same `build` args (the loader skips a feature whose
   `progress.json` status starts with `done`), or `resumeFromRunId` for same-session cache replay.
   Baseline prep auto-skips whenever a prior `progress.json` exists (an `in-progress` marker is
   written at run start), so a resumed run's unstaged in-progress work stays reviewable instead of
   being folded into the accepted baseline. Delete `progress.json` to force a fresh run + baseline.

## Gotchas burned in from real runs (shared with the sibling engine)

- **Verify what the test runner actually ran.** Some runners silently mislead (e.g. PHPUnit 4.x runs
  only the FIRST path arg). The engine fails the gate when `tests_run_count` is 0 for a unit
  selector, but sanity-check the count yourself. For manual/MCP verification, `tests_run_count` is
  `-1` (no count) — confirm the behavior was actually observed.
- **`git diff` omits brand-new files.** When verifying, also use `git status --porcelain` and read
  new files. (The engine handles this for the reviewer via `git add -N`; you must too.)
- **Custom `agentTypes` must exist in the user's agent registry.** Defaults use the standard workflow
  subagent, which always works. Only pass agentTypes the user actually has.
- **A configured frontend/MCP tool may be absent in a headless run.** The developer reports
  `not-run`; if the build is green and the existing suite isn't reddened, triage MAY accept with
  **verification deferred** (status `done (verification deferred …)`, `verificationDeferred:true` in
  the result, an entry in NEEDS-DECISION.md). That acceptance is CONDITIONAL: run the configured
  verification yourself (or with the user) before blessing the feature. Unit tests are never
  deferrable — an unmet unit gate always means fix rounds or a blocker.
- **Blocker halts are recovery loops, not failures.** Read `BLOCKERS.md`, fix the root cause (usually
  a bad gate command, a missing dependency the plan assumed, or a real design question for the user),
  then resume.
- **Stray `runs/` inside the target repo** = `root` auto-detected to a cwd you didn't expect. Pass
  `root` explicitly (the tool's directory), relocate the state, re-run.
- **Too big?** If `refine` returns `too_big:true`, or you realize mid-plan the work is really several
  features, split it: run this engine once per bounded feature, or hand the whole thing to
  `upgrade-cycle`.

## State files (under `runs/<runId>/`, gitignored)

`PLAN-REVIEW.md` (refine: gaps + questions for you) · `progress.json` (drives resume) ·
`FEATURE.md` (human summary of what changed) · `NEEDS-DECISION.md` (flagged majors awaiting the
user) · `BLOCKERS.md` (hard-stop reason) · `ACCEPTANCE.md` (the whole-feature acceptance check:
per-criterion table + reachability + full-gate result + any gaps).

## When you're done

Report: status, suite result (run it yourself), that the feature is actually wired in/reachable,
what's staged, anything in `NEEDS-DECISION.md` / `ACCEPTANCE.md`, and any "reads-oddly-but-tests-pass"
item worth the user's eye. **Never commit** — tell the user what to review (`git diff --cached`) and
let them commit.
