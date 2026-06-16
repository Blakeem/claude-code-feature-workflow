export const meta = {
  name: 'feature-cycle',
  description: 'Plan-driven feature build: implement ONE bounded feature from an approved plan → develop+test → adversarial diff review → triage → verify acceptance, looped per round until done, blocked, or flagged',
  whenToUse: 'Build ONE bounded, mostly-additive, NON-TRIVIAL feature (~10–100+ LoC: a new MCP tool/API endpoint/page/form, a contained enhancement, a design-needing bugfix) integrated into an existing codebase. NOT for one-line/trivial changes (make those directly — too small for a plan is too small for this) and NOT for breadth-spanning migrations/upgrades/refactors (use upgrade-cycle). The orchestrating agent authors the plan in PLAN MODE (EnterPlanMode → plan mode\'s own ~/.claude/plans/<name>.md file), the user approves it (ExitPlanMode), then the agent runs the MANDATORY phase:"refine" with planPath = that plan-mode file\'s full absolute path (no copy; abs() does not expand ~) — adversarial plan review vs the real repo, run AFTER approval, NOT inside read-only plan mode — folds in the gaps, and runs phase:"build" (reuse the same runId + planPath throughout).',
  phases: [
    { title: 'Refine', detail: 'MANDATORY first pass: an independent critic greps the repo, verifies the plan against real code, and flags gaps + blocking questions (refine phase only)' },
    { title: 'Load', detail: 'Parse the approved plan + read prior progress (resume)' },
    { title: 'Develop', detail: 'Developer implements the plan minimally, writes/runs tests + any frontend/MCP/curl verification, leaves changes UNSTAGED' },
    { title: 'Review', detail: 'Adversarial reviewer reads ONLY the unstaged diff + the acceptance criteria — deliberately BLIND to the plan steps, so it judges the code on its own merits' },
    { title: 'Triage', detail: 'Planner routes findings via the decision matrix, checks for regressions, stages on accept, hard-stops on a blocker' },
    { title: 'Verify', detail: 'Acceptance check (sees the plan): every criterion satisfied + the feature is wired/reachable + full gates green' },
    { title: 'Record', detail: 'Scribe persists progress + a human FEATURE summary' },
  ],
};

// =============================================================================
// Config — everything app/feature-specific arrives via args so the engine stays general.
// The PLAN is produced OUTSIDE this engine: the orchestrating agent authors it in PLAN MODE
// (EnterPlanMode → writes it into plan mode's own ~/.claude/plans/<name>.md) → the user approves
// (ExitPlanMode, which lifts read-only) → the agent runs phase:"refine" with planPath pointing at
// that plan-mode file directly (no copy; pass its FULL absolute path — abs() does not expand ~). It
// is the MANDATORY plan review; it writes, so it CANNOT run inside read-only plan mode → folds in the
// gaps/answers → phase:"build" implements it, reusing the same runId + planPath. This engine CONSUMES
// that plan; it does not decompose or discover a goal.
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId || !(A.planPath || (A.plan && typeof A.plan !== 'object'))) {
  throw new Error('args must include at least { runId, planPath | plan (markdown string), target, gates }; got typeof=' + (typeof args));
}

const PHASE       = A.phase ?? 'build';                     // 'refine' (review the plan, stop) | 'build' (implement it)
const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const REFERENCE   = A.reference ?? '';                      // optional: a completed example to diff against
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup }
const MAX_ROUNDS  = A.maxRounds ?? 3;                       // develop→review→triage fix rounds before "needs-attention"

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so
// every role runs as the harness's standard workflow subagent (always available). Only set an
// agentType that exists in YOUR agent registry. Scribe work is mechanical (verbatim JSON/markdown
// writes) — the cheaper tier is deliberate. There is no separate research role: discovery happened
// in plan mode before this engine ran.
const M  = { planner: 'opus', develop: 'opus', review: 'sonnet', scribe: 'sonnet', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

// Resolve ROOT to an ABSOLUTE path so every agent + `git -C` call is cwd-independent. Priority:
//   1. explicit args.root  →  2. AUTO-DETECT the working directory at runtime.
// Run-state lands in `<ROOT>/runs/<runId>` unless args.stateDir overrides it.
let ROOT = (A.root ? String(A.root) : '').replace(/\\/g, '/').replace(/\/+$/, '');
if (!ROOT) {
  const loc = await agent(
    'Output ONLY the absolute current working directory: run `pwd` and return its path verbatim, nothing else. Read-only — change nothing.',
    roleOpts('scribe', { label: 'locate-root',
      schema: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' } } } }),
  );
  ROOT = String(loc?.cwd ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  log(`root auto-detected: ${ROOT || '(detection failed — falling back to cwd-relative paths)'}`);
}
// Normalize EVERY incoming path (Windows backslashes included) BEFORE the absolute-path test —
// otherwise `E:\foo\bar` fails the test and gets wrongly prefixed with ROOT.
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const REFERENCE_P = REFERENCE ? abs(REFERENCE) : '';
const REPO        = abs(TARGET.repo ?? '.');               // absolute path to the target git repo
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);   // <root>/runs/<runId> unless overridden
// Plan source has a PRECEDENCE: planPath wins; inline `plan` (markdown string) is the fallback. Only
// one is ever non-empty, so the loader/critic prompts are handed exactly one plan (no ambiguity).
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
const PLAN_INLINE = (!A.planPath && A.plan && typeof A.plan !== 'object') ? String(A.plan) : '';

// Review surfaces everything >= REVIEW_SEV; the in-loop fix bar (fixSeverity) is applied inside the
// decision matrix prose, not in JS. Floors default HIGH (lean policy — see MATRIX).
const SEV_RANK    = { low: 1, medium: 2, high: 3, critical: 4 };
const REVIEW_SEV  = SEV_RANK[A.reviewSeverity ?? (A.fixSeverity ?? 'high')];
// Findings in these categories BYPASS the severity floor — the decision matrix routes them (testing
// blockers and wiring/completeness gaps are ALWAYS triaged, whatever severity the reviewer assigned).
const FLOOR_EXEMPT = new Set(['testing', 'wiring', 'incomplete']);
// Agent-driven verification methods that can be legitimately UNAVAILABLE in a headless run
// environment — eligible for a triage-approved DEFERRAL (unit tests never are).
const ENV_METHODS  = new Set(['curl', 'chrome-devtools-mcp', 'mcp-inspector', 'playwright', 'manual']);

// Gate semantics for an ADDITIVE feature (no intentionally-red phase — a feature that breaks the
// existing suite IS a regression, so 'green' means the whole gate passes):
//   green       -> build passes AND the required verification (unit tests and/or the frontend/MCP/
//                  curl check named in the test strategy) passes
//   build-only  -> build passes; no test pass/fail requirement
// Build (lint/compile) must ALWAYS pass.
function gateOk(gate, tstrat, dev) {
  if (!dev) return false;
  if (GATES.build && dev.build_passed !== true) return false;          // build/lint must always pass
  if (gate === 'build-only') return true;
  // A new feature that reddens the EXISTING suite is a regression, regardless of its own verification.
  if (dev.full_suite_outcome === 'failed') return false;
  if (!tstrat || tstrat.kind === 'none') return true;                  // green, nothing to verify beyond build
  // Verification was expected. tests_run_count === 0 means the runner executed NOTHING — a FALSE green
  // (a unit selector that matched zero tests). Compliant manual/MCP/curl runs report -1 (N/A), which
  // passes this guard, so we apply it unconditionally regardless of the `unit` flag.
  if (dev.tests_run_count === 0) return false;
  return dev.test_outcome === 'passed';
}

// =============================================================================
// Structured-output schemas
// =============================================================================
const TEST_STRATEGY_SHAPE = {
  type: 'object',
  properties: {
    kind:    { type: 'string', enum: ['tdd', 'tests-after', 'manual', 'none'], description: 'tdd = write failing tests first then implement to green; tests-after = implement then test; manual = human/agent-driven verification (e.g. frontend); none = build-only' },
    unit:    { type: 'boolean', description: 'true if automated unit/integration tests are part of the gate for this feature' },
    method:  { type: 'string', description: 'the verification METHOD: "unit" | "curl" | "chrome-devtools-mcp" | "mcp-inspector" | "playwright" | "manual" | "" — drives how the developer proves the feature works' },
    details: { type: 'string', description: 'exactly how to run/scope the verification: commands, test selectors, how to start a server, what behavior to assert' },
  },
};

// The parsed plan. WHAT (feature, acceptance_criteria, integration_points) is shared with every
// role. HOW (steps, files, test_strategy) is shown ONLY to the developer + the acceptance verifier
// — the reviewer and triage stay blind to it so their judgement is not anchored to the plan.
const PLAN_SHAPE = {
  type: 'object',
  required: ['feature', 'acceptance_criteria', 'steps'],
  properties: {
    feature:             { type: 'string', description: 'one-paragraph WHAT: the bounded feature and why' },
    acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'observable, testable definitions of done' },
    integration_points:  { type: 'array', items: { type: 'string' }, description: 'where the feature must be WIRED IN / reachable: route mounted, tool registered, export added, DI binding, feature flag, menu entry' },
    steps:               { type: 'array', items: { type: 'string' }, description: 'ordered, minimal implementation steps (the HOW)' },
    files:               { type: 'array', items: { type: 'string' }, description: 'likely-touched source paths (repo-relative)' },
    test_strategy:       TEST_STRATEGY_SHAPE,
    gate:                { type: 'string', enum: ['green', 'build-only'], description: 'green = build + required verification pass; build-only = build green only' },
    notes:               { type: 'string' },
  },
};

const LOADER_SCHEMA = {
  type: 'object',
  required: ['plan', 'done', 'plan_missing'],
  properties: {
    plan: PLAN_SHAPE,
    done: { type: 'object', properties: { status: { type: 'string', description: 'prior progress status, or "" if none' } } },
    plan_missing: { type: 'boolean', description: 'true if no plan text/file could be read' },
    plan_review_exists: { type: 'boolean', description: 'true if a PLAN-REVIEW.md (output of the mandatory refine phase) already exists in the state dir' },
  },
};

const DEVELOP_SCHEMA = {
  type: 'object',
  required: ['results', 'build_passed', 'test_outcome', 'full_suite_outcome', 'unstaged_confirmed'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'status', 'summary'],
        properties: {
          file: { type: 'string' },
          status: { type: 'string', enum: ['CHANGED', 'ADDED', 'SKIPPED', 'FAILED'] },
          summary: { type: 'string' },
        },
      },
    },
    tests_written:    { type: 'boolean' },
    build_passed:     { type: 'boolean' },
    test_outcome:     { type: 'string', enum: ['passed', 'failed', 'not-run'], description: 'passed = the required verification (unit and/or frontend/MCP/curl) ran and PASSED. failed = it ran and failed. not-run = no verification executed.' },
    verification_method: { type: 'string', description: 'what was actually run to verify (e.g. "npm test", "curl localhost:3000/health", "chrome-devtools-mcp"); note here if a configured MCP/tool was UNAVAILABLE in this environment' },
    tests_run_count:  { type: 'integer', description: 'unit/integration tests the runner ACTUALLY executed (0 = selector matched nothing = a FALSE green; -1 = N/A or the runner prints no count, e.g. manual/MCP verification)' },
    full_suite_outcome: { type: 'string', enum: ['passed', 'failed', 'not-run', 'scoped-skip'], description: 'result of running the FULL test gate to confirm the EXISTING suite is not reddened: passed | failed | not-run (could not run it) | scoped-skip (the test strategy deliberately scopes verification)' },
    unstaged_confirmed: { type: 'boolean', description: 'true if changes were left UNSTAGED (git add NOT run on content)' },
    gate_output:      { type: 'string', description: 'tail of failing gate/verification output, or "" if green' },
    notes:            { type: 'string' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'category', 'severity', 'title', 'detail', 'introduced_by_this_change', 'business_logic'],
        properties: {
          file: { type: 'string' },
          line: { type: 'string' },
          category: { type: 'string', enum: ['correctness', 'security', 'error-handling', 'regression', 'api-contract', 'data-integrity', 'types', 'testing', 'wiring', 'incomplete', 'performance', 'maintainability', 'convention'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string', description: 'short, specific, stable across rounds' },
          detail: { type: 'string' },
          introduced_by_this_change: { type: 'boolean', description: 'true if THIS cycle\'s unstaged diff introduced it; false if it pre-exists in the staged/committed baseline' },
          business_logic: { type: 'boolean', description: 'true if it touches existing domain/business logic whose behavior could regress' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
};

const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['verdicts', 'accepted', 'staged', 'has_blocker'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['finding_id', 'is_real', 'decision', 'blocking', 'rationale'],
        properties: {
          finding_id: { type: 'string' },
          is_real: { type: 'boolean' },
          decision: { type: 'string', enum: ['ACTIONABLE', 'DEFER', 'NEEDS_USER', 'REJECT'] },
          blocking: { type: 'boolean', description: 'true ONLY if this prevents all further progress on the feature' },
          matrix: {
            type: 'object',
            properties: {
              clarity: { type: 'string', enum: ['clear', 'ambiguous'] },
              effort: { type: 'string', enum: ['small', 'large'] },
              blast_radius: { type: 'string', enum: ['local', 'cross-cutting'] },
              scope: { type: 'string', enum: ['in-scope', 'scope-creep'] },
              architectural: { type: 'boolean' },
            },
          },
          rationale: { type: 'string' },
          fix_instruction: { type: 'string', description: 'precise minimal instruction (ACTIONABLE only)' },
        },
      },
    },
    accepted: { type: 'boolean', description: 'true if the round is accepted (gate met, zero ACTIONABLE) and was staged' },
    staged: { type: 'boolean', description: 'true if you ran `git add` on the feature files this round' },
    regression_found: { type: 'boolean', description: 'true if the unstaged diff regressed previously-staged/accepted work' },
    verification_deferred: { type: 'boolean', description: 'true ONLY when accepting a round whose configured non-unit verification method was UNAVAILABLE in this environment — the verification is deferred to the user/orchestrating agent via NEEDS-DECISION.md' },
    has_blocker: { type: 'boolean', description: 'true if any verdict.blocking is true; conductor halts the whole run' },
    next_fix_plan: {
      type: 'object',
      properties: { steps: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } } },
      description: 'develop-plan for the next round (present when accepted=false and not blocked)',
    },
    wrote_logs: { type: 'boolean' },
    summary: { type: 'string' },
  },
};

const REFINE_SCHEMA = {
  type: 'object',
  required: ['verdict', 'gaps', 'questions'],
  properties: {
    verdict: { type: 'string', enum: ['ready', 'needs-changes', 'needs-answers'], description: 'ready = plan is sound and complete; needs-changes = material gaps to fix; needs-answers = blocking questions only the user can resolve' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence'],
        properties: {
          title: { type: 'string' },
          evidence: { type: 'string', description: 'file:line hits / grep counts proving the gap — no evidence, no gap' },
          suggestion: { type: 'string', description: 'how to fix the plan: add a step | cover a call site | fix file list | adjust test strategy | split into multiple runs' },
        },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question'],
        properties: {
          question: { type: 'string' },
          why_blocking: { type: 'string', description: 'why the plan is not safe to build without an answer' },
        },
      },
    },
    too_big: { type: 'boolean', description: 'true if this is more than ONE bounded feature and should be split across multiple runs (or handed to upgrade-cycle)' },
    notes: { type: 'string' },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['complete', 'criteria', 'gaps'],
  properties: {
    complete: { type: 'boolean', description: 'true if every acceptance criterion is met, the feature is reachable, and gates are green' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'met'],
        properties: {
          criterion: { type: 'string' },
          met: { type: 'boolean' },
          evidence: { type: 'string', description: 'file:line / test name / observed output proving it' },
        },
      },
    },
    reachable: { type: 'boolean', description: 'the feature is actually wired in / reachable from the app entry points (every integration point satisfied)' },
    suite_result: { type: 'string', description: 'observed outcome of running the FULL gates' },
    verification_result: { type: 'string', description: 'outcome of re-running the configured frontend/MCP/curl/manual verification (or why it could not be run)' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence'],
        properties: {
          title: { type: 'string' },
          evidence: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
};

const BASELINE_SCHEMA = {
  type: 'object',
  required: ['clean'],
  properties: {
    clean: { type: 'boolean', description: 'true once `git diff` (unstaged tracked) is empty' },
    staged_files: { type: 'array', items: { type: 'string' } },
    ignored_untracked: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

const RECORD_SCHEMA = { type: 'object', required: ['written'], properties: { written: { type: 'boolean' } } };

// =============================================================================
// Shared prompt fragments
// =============================================================================
// WHAT — the shared context every role sees: the feature, its acceptance criteria, where it must
// wire in, the environment, and the staging contract. Deliberately does NOT include the HOW.
const whatContext = (plan) => `
FEATURE (the WHAT — the single bounded change this run delivers; do NOT exceed it):
${plan.feature}

ACCEPTANCE CRITERIA (the observable spec the code must satisfy — "done" means ALL of these hold):
${(plan.acceptance_criteria || []).map((c, i) => `  ${i + 1}. ${c}`).join('\n') || '  (none specified)'}
${(plan.integration_points || []).length ? `INTEGRATION POINTS (the feature must be WIRED IN / reachable here — unreached code is an incomplete feature):\n${plan.integration_points.map((p) => `  • ${p}`).join('\n')}` : ''}

TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
${REFERENCE_P ? `REFERENCE (a COMPLETED example to mirror — mine it for the canonical pattern): ${REFERENCE_P}` : ''}

CONVENTIONS (match these; deviations are 'convention' findings):
${CONVENTIONS}

GATES (the build/test commands that define "it works"):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}
  ${GATES.testSetup ? `test setup note: ${GATES.testSetup}` : ''}

STAGING CONTRACT (the cycle boundary is git itself):
  • staged index + HEAD  = ACCEPTED baseline (prior blessed work + pre-existing tree). Treat as known-good.
  • unstaged working tree = THIS feature's work — the only thing under review.
  • Developers NEVER stage. The Planner stages (git add, NEVER commit) only on acceptance. Nothing is ever committed — the USER commits.

BE TOKEN-ECONOMICAL (target ~150k tokens for your whole turn): read ONLY the files this feature
touches plus the SPECIFIC reference section you need — do NOT re-read the whole tree. Prefer
targeted grep over broad reads. Don't restate large files back; act on them.
`;

// HOW — the implementation plan. Shown ONLY to the developer and the acceptance verifier.
const howBlock = (plan) => `
APPROVED IMPLEMENTATION PLAN (the HOW — already reviewed + approved by the user; follow it):
STEPS:
${(plan.steps || []).map((s, i) => `  ${i + 1}. ${s}`).join('\n') || '  (none — implement the acceptance criteria minimally)'}
FILES (likely): ${(plan.files || []).join(', ') || '(discover)'}
TEST STRATEGY: kind=${plan.test_strategy?.kind ?? 'none'} · method=${plan.test_strategy?.method || '(none)'} · unit=${plan.test_strategy?.unit ?? false}
  ${plan.test_strategy?.details || '(no extra detail)'}
GATE: ${plan.gate ?? 'green'}
${plan.notes ? `PLAN NOTES: ${plan.notes}` : ''}
`;

const MATRIX = `
SCOPE DISCIPLINE (this is NOT a general code review — a SEPARATE review workflow does that later):
Act ONLY on issues THIS change introduced. Make the feature correct, reachable, testable, and
production-safe, and leave the code we TOUCHED a little better — nothing more. Pre-existing problems
in untouched code are OUT OF SCOPE: never fix them (regression risk) and don't even log them.

DECISION MATRIX — route each finding IN ORDER (first match wins):
  1. is_real == false ............................................ REJECT (drop)
  2. introduced_by_this_change == false (pre-existing) .......... REJECT (out of scope — drop, do NOT log)
  3. prevents tests/build from running or passing .............. ACTIONABLE (testing blockers are ALWAYS fixed)
  4. the diff does NOT satisfy an acceptance criterion, OR the
     feature is not actually wired in / reachable ............... ACTIONABLE (an incomplete feature is not done)
  5. easy & obvious in-scope fix (clear, local, ≤ a few lines) . ACTIONABLE (take the easy win, any severity)
  6. introduced regression of previously-staged/accepted work . ACTIONABLE (you raise this yourself)
  7. severity >= ${A.fixSeverity ?? 'high'} (production-blocking) AND a clear correct in-scope fix ... ACTIONABLE (fix our own breakage)
  8. severity >= ${A.fixSeverity ?? 'high'} but ambiguous / a business-logic judgment / needs a human call
        ... NEEDS_USER → ${STATE_DIR}/NEEDS-DECISION.md (FLAG — must be addressed before production).
            blocking=true ONLY if no further FEATURE progress is possible without the answer.
  9. scope-creep / a different feature outside this plan ........ REJECT (drop, do NOT log)
 10. otherwise (medium/low, non-blocking, not an easy win) ..... REJECT — DO NOT log it. The separate
        code-review workflow will catch it. Conserving context is the priority here.
NET: fix testing blockers + incomplete-implementation/wiring gaps + easy wins + our own
production-blocking breakage; FLAG only the major issues that need a human; silently drop everything
else. Don't chase perfection — that wastes context and rounds.
`;

// =============================================================================
// Role prompts
// =============================================================================
const loaderPrompt = () => `
You are the PLAN LOADER (read-only). Prepare a ${PHASE}-phase run.
1. Obtain the plan text:
${PLAN_PATH ? `   • Read the plan file at ${PLAN_PATH}.` : ''}${PLAN_INLINE ? `   • Use this inline plan text:\n-----\n${PLAN_INLINE}\n-----` : ''}
   If neither yields readable content, set plan_missing=true and return an empty plan.
2. Parse it into the PLAN schema. The plan is human/agent-authored markdown — extract:
   • feature (the WHAT, one paragraph), acceptance_criteria[], integration_points[] (where it must
     wire in / be reachable), steps[] (the HOW), files[], test_strategy{kind,unit,method,details},
     gate ('green' unless the plan clearly says build-only).
   • If a field is absent, infer conservatively: gate='green'. If the plan states a test strategy,
     carry it verbatim; set kind='none' only if the plan EXPLICITLY wants no tests. If the plan has
     NO test-strategy section at all: ${GATES.test ? `a test gate IS configured, so default to {kind:'tests-after', unit:true, method:'unit', details:'run the configured test gate'}` : `no test gate is configured, so default to kind='none'`}.
     Do NOT invent steps — if steps are missing, leave steps=[] (the developer will implement the
     acceptance criteria).
3. Read ${STATE_DIR}/progress.json if it exists → return its status as done.status (else "").
4. Check whether ${STATE_DIR}/PLAN-REVIEW.md exists → set plan_review_exists (true/false). This is the
   artifact the MANDATORY refine phase writes; the conductor uses it to confirm the plan was reviewed.
Do NOT modify anything. Return via the schema.`;

const refinePrompt = () => `
You are an INDEPENDENT PLAN CRITIC (read-only). The orchestrating agent authored the feature plan
below in plan mode. Your ONLY job is to find what it MISSED or got WRONG against the REAL repo —
not to restyle or re-architect it. An empty result (verdict="ready") is a GOOD outcome.
${PLAN_PATH ? `PLAN FILE: ${PLAN_PATH} (read it).` : ''}${PLAN_INLINE ? `PLAN:\n-----\n${PLAN_INLINE}\n-----` : ''}

TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
${REFERENCE_P ? `REFERENCE (a completed example to mirror): ${REFERENCE_P}` : ''}
GATES: build=${GATES.build ?? '(none)'} · test=${GATES.test ?? '(none)'}

PROCEDURE:
1. Read the plan. Verify its FILE LIST and INTEGRATION POINTS against the actual repo (grep for the
   symbols/APIs/registries the feature must touch — e.g. where similar features are registered,
   exported, routed, wired into DI/config). Do NOT trust the plan's lists; confirm them.
2. Report a GAP only for a MATERIAL miss WITHIN this feature: an unaddressed integration/wiring
   point, a missing prerequisite, a wrong/absent file, an acceptance criterion with no implementing
   step, a test strategy that won't actually prove the criteria, or a feature too big for one
   develop pass (set too_big=true and say where to split).
3. Raise a QUESTION only for something that genuinely BLOCKS safe implementation and only a human can
   resolve (an ambiguous contract, an unconfirmed external dependency, a real design choice).
4. Do NOT report style, alternative designs, or anything beyond this feature. Provide file:line
   evidence for every gap — no evidence, no gap. Do NOT modify any files.
Return via the schema (verdict ready/needs-changes/needs-answers).`;

const developPrompt = (plan, repair, fixItems) => {
  const t = plan.test_strategy ?? { kind: 'none' };
  const gate = plan.gate ?? 'green';
  const verifyLine = gate === 'build-only'
    ? 'build-only — no test pass/fail requirement; just keep the build green.'
    : t.kind === 'none'
      ? 'green — keep the build green; no separate verification configured for this feature.'
      : t.kind === 'tdd'
        ? `green (TEST-FIRST) — author the tests for the acceptance criteria FIRST (they should fail), then implement until they PASS. Report test_outcome="passed" once green.`
        : `green — the feature's verification must PASS (test_outcome="passed").`;
  return `
You are the DEVELOPER. Implement the APPROVED PLAN below EXACTLY — minimally and surgically. Match
conventions. NO opportunistic refactors, NO scope creep beyond the plan and acceptance criteria.
${whatContext(plan)}
${howBlock(plan)}
${repair ? `THIS IS A REPAIR ROUND. Address ONLY these items from the prior review/gate failure (do NOT revert your prior good work — build ON it):\n${(fixItems || []).map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : ''}

PROCEDURE (IPO):
0. BASELINE: the accepted baseline is already STAGED, so \`git -C ${REPO} diff\` shows only THIS
   cycle's work: empty on a fresh round 1; on a repair round — or a RESUMED run — it shows your own
   prior work: build ON it, never revert/redo it. Do not stage anything.
1. Implement the steps. Author/extend tests as the test strategy requires. If the test harness is
   missing: ${GATES.testSetup || '(stand up the minimal harness the strategy needs)'}. Leave the
   lines you TOUCH a little better (obvious one-line wins welcome), but do NOT refactor or fix
   unrelated/pre-existing code. SELF-REVIEW your own diff before returning and fix anything obviously
   wrong — catching it here saves a whole review→fix round.
2. WIRE IT IN: satisfy every INTEGRATION POINT so the feature is actually reachable (registered/
   exported/routed/bound/flagged), not just written. A feature that exists but isn't reachable is NOT done.
3. VERIFY (${gate} → ${verifyLine}). Run the gates and the strategy's verification method:
     build: ${GATES.build ?? '(skip — none configured)'}
     verification: ${t.method || '(unit/suite)'} — ${t.details || (GATES.test ?? '(skip — none configured)')}
   • For an ADDITIVE feature, also confirm you did NOT break the existing suite (run the FULL test
     gate unless the strategy scopes it) — a new feature that reddens the suite is a regression.
     Report it in full_suite_outcome: passed | failed | not-run (couldn't run it) | scoped-skip (the
     strategy deliberately scopes verification).
   • Frontend/MCP/curl methods: drive the named tool (e.g. chrome-devtools-mcp, mcp-inspector) or
     start the server and curl it, per the strategy details, and observe the real behavior. If the
     configured tool/MCP is NOT available in this environment, set test_outcome="not-run", explain in
     verification_method + gate_output, and let triage decide — do NOT fake a pass.
   Set build_passed; set test_outcome to passed | failed | not-run; record verification_method.
   SANITY-CHECK the runner REALLY executed your unit tests: set tests_run_count to the count it
   reports (0 = your selector matched NOTHING = a FALSE green — fix it and re-run; -1 if N/A, e.g.
   manual/MCP verification). Some runners silently ignore extra path args — when in doubt run one file
   per invocation or use the runner's filter flag.
4. Never weaken/delete tests or disable checks to get green. Build/lint must always pass; if you
   cannot make it pass within scope, leave it failing and explain in gate_output.
5. LEAVE CONTENT UNSTAGED — do NOT \`git add\` content and do NOT commit. EXCEPTION: for any file you
   CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add) so it shows up in the reviewer's
   \`git diff\` (which otherwise omits brand-new files). Intent-to-add does not stage content. Set
   unstaged_confirmed=true.
Report per-file status + gate results via the schema.`;
};

// The reviewer is deliberately BLIND to the plan's steps/files/test-strategy. It judges the diff
// against the acceptance criteria alone, so it catches what the PLAN itself got wrong — and it
// can't be anchored into rubber-stamping "the code matches the plan".
const reviewPrompt = (plan, handled) => `
You are the ADVERSARIAL REVIEWER. Review ONLY this cycle's work — the UNSTAGED diff — for
production-readiness, judged against the ACCEPTANCE CRITERIA. You are deliberately NOT shown the
implementation plan: assess the code ON ITS OWN MERITS, not whether it "followed a plan". The
staged/committed baseline is KNOWN-GOOD context — read it for intent, but do NOT review it.
${whatContext(plan)}

SCOPE — get the exact diff first:
  \`git -C ${REPO} diff\`            (unstaged tracked changes = part of THIS cycle — review this)
  \`git -C ${REPO} status --porcelain\` then READ every NEW/untracked file (\`??\`/\`A\`) of this feature —
       \`git diff\` OMITS brand-new files, so new test/source files only show up here.
  \`git -C ${REPO} diff --staged\`  (accepted baseline — context only, do NOT review)
THIS CYCLE = the unstaged tracked diff PLUS those new files. Ignore unrelated pre-existing baseline.

This is NOT a general code review — a SEPARATE workflow audits the whole codebase later. Your ONLY
job: did THIS change introduce a problem, or fail to actually deliver the feature? Report ONLY:
  • TESTING BLOCKERS — anything that stops the build/tests/verification from running or passing.
  • INCOMPLETE FEATURE — the diff does NOT satisfy an acceptance criterion, OR the feature is not
    actually wired in / reachable (an integration point left unconnected). Report as incomplete/high.
  • INTRODUCED PRODUCTION-BLOCKING defects (severity >= ${A.reviewSeverity ?? 'high'}): a real
    correctness/security/data-integrity/api-contract bug or a REGRESSION this diff caused.
  • (optional) a genuinely OBVIOUS one-line in-scope improvement to a line THIS diff touched.
Do NOT report — drop silently — anything pre-existing, medium/low, stylistic, speculative, a
redesign, or outside this feature. An empty findings list is the NORMAL, GOOD outcome. For each
finding set introduced_by_this_change (must be TRUE) and business_logic, with a specific file:line.
Do NOT re-report ALREADY HANDLED items:
${handled.length ? handled.map((t) => `  - ${t}`).join('\n') : '  (none yet)'}
Return via the schema (usually an empty array).`;

// Triage is also blind to the plan's HOW — it routes findings by the matrix against the WHAT.
const triagePrompt = (plan, items, round, gateMet, gateDesc, gateOutput, isLastRound, deferrable) => `
You are the PLANNER in TRIAGE mode — and the orchestrator-of-record for the git baseline. Confirm
each finding against the ACTUAL unstaged diff, route it via the decision matrix, and either ACCEPT
(stage) the round or produce the next fix-plan. Reject false positives and scope creep ruthlessly.
You are NOT shown the implementation plan — judge scope against the acceptance criteria.
${whatContext(plan)}
ROUND ${round} of max ${MAX_ROUNDS}.
GATE: ${gateDesc}
GATE OUTCOME: ${gateMet ? 'MET — the gate expectation is satisfied' : 'NOT MET — see detail:'}
${gateMet ? '' : (gateOutput || '(no detail)')}
${deferrable ? `VERIFICATION UNAVAILABLE IN THIS ENVIRONMENT: the build is green and the existing suite is not
reddened, but the configured verification method could not run here (test_outcome="not-run"). You
MAY accept this round with verification DEFERRED if the code is otherwise clean: set
verification_deferred=true, append a "Deferred verification" entry to ${STATE_DIR}/NEEDS-DECISION.md
stating EXACTLY what must be verified manually, then stage and set accepted=true. If the method
SHOULD have worked here (a wrong command, a server that failed to start, fixable setup), do NOT
defer — return a fix-plan instead.
` : ''}
CANDIDATE FINDINGS (finding_id :: file :: category/severity :: introduced/business :: title):
${items.length ? items.map((i) => `  - ${i.id} :: ${i.f.file} :: ${i.f.category}/${i.f.severity} :: introduced=${i.f.introduced_by_this_change} business=${i.f.business_logic} :: ${i.f.title}\n      ${i.f.detail}\n      suggested: ${i.f.suggested_fix || '(none)'}`).join('\n') : '  (none — reviewer returned clean)'}
${MATRIX}

PROCEDURE:
1. Verify each finding against \`git -C ${REPO} diff\`. Route via the matrix. For ACTIONABLE items
   write a precise minimal fix_instruction.
2. REGRESSION CHECK: compare the unstaged diff against the staged baseline
   (\`git -C ${REPO} diff --staged\`). If this cycle regressed previously-accepted behavior, raise
   it yourself as an ACTIONABLE finding (set regression_found=true).
3. DOCUMENT — keep this MINIMAL to conserve context (create headers if missing):
     • NEEDS_USER → append to ${STATE_DIR}/NEEDS-DECISION.md (title, where, what, options, recommendation).
     • any blocking=true → ALSO append a consolidated entry to ${STATE_DIR}/BLOCKERS.md.
     • REJECT / dropped items → write NOTHING (mediums, lows, pre-existing, scope-creep are the
       separate code-review workflow's job). Set wrote_logs=true only if you appended NEEDS_USER/blocker.
4. DECIDE (THIS IS THE FINAL ALLOWED ROUND: ${isLastRound ? 'YES' : 'no'}):
   • GATE MET and ZERO ACTIONABLE: ACCEPT — run \`git -C ${REPO} add <the feature's changed AND
     newly-created files>\` (NEVER commit), set staged=true & accepted=true.
   • LAST-ROUND + GATE MET with only minor ACTIONABLE easy-wins left: ACCEPT ANYWAY — stage and DROP
     the leftovers silently. Only REFUSE if a remaining item is a HIGH/CRITICAL introduced must-fix,
     an incomplete-feature/wiring gap, or a testing blocker.
   • Otherwise (gate NOT met, or a real must-fix remains, not blocked): accepted=false; return a tight
     next_fix_plan (steps+files) addressing ONLY the gate problem + must-fix ACTIONABLE items. Leave
     the tree UNSTAGED.
   • If any verdict.blocking is true: set has_blocker=true (conductor halts); do NOT stage. Leave the
     working tree intact for the user.
Return everything via the schema.`;

// Lean accept — the common happy path (clean review + gate met). Regression spot-check + stage on
// the cheaper review tier; the full planner triage is wasted when there is nothing to triage.
const acceptPrompt = (plan, round, gateDesc) => `
You are finalizing an ACCEPT: the reviewer found NOTHING and the gate expectation is met. Two jobs —
regression spot-check, then stage.
${whatContext(plan)}
ROUND ${round}.  GATE: ${gateDesc}
1. REGRESSION SPOT-CHECK: \`git -C ${REPO} diff --stat\` (this cycle) vs
   \`git -C ${REPO} diff --staged --stat\` (accepted baseline). Confirm the unstaged changes
   plausibly belong to THIS feature and did not clobber previously-staged work. If something looks
   regressed, return accepted=false, regression_found=true, and a tight next_fix_plan instead.
2. STAGE: \`git -C ${REPO} add <the feature's changed AND newly-created files>\` (NEVER commit), then
   confirm \`git -C ${REPO} diff\` is empty for those files.
Return verdicts=[], accepted=true, staged=true, has_blocker=false via the schema.`;

// Acceptance verifier — sees the FULL plan. The single whole-feature completeness check the per-
// round loop (which only ever sees its own diff) cannot do. Read-only except writing ACCEPTANCE.md.
const verifyPrompt = (plan) => `
You are the ACCEPTANCE VERIFIER. The feature's work is STAGED. Verify, against the repo itself, that
the FEATURE is actually fully delivered — every acceptance criterion met, the feature reachable, and
the gates green. Your job is to find what the implementation MISSED, not to re-review accepted style.
${whatContext(plan)}
${howBlock(plan)}

PROCEDURE (read-only except step 4):
1. For EACH acceptance criterion, find concrete evidence it holds (a diff hunk, a passing test, an
   observed behavior). Mark met=true/false with file:line / test-name / output evidence.
2. REACHABILITY: confirm every integration point is satisfied — the feature is registered/exported/
   routed/bound/flagged and reachable from the app's real entry points (grep to prove it). An
   unreachable feature is incomplete.
3. Run the FULL gates once and record the real outcome:
     build: ${GATES.build ?? '(none configured)'}
     test:  ${GATES.test ?? '(none configured)'}
   Then RE-RUN the configured verification method (${plan.test_strategy?.method || 'unit/suite'}:
   ${plan.test_strategy?.details || 'the test gate'}) to confirm the feature behaves as specified.
   If a configured MCP/tool is unavailable here, say so in verification_result (do not fake it).
4. Write ${STATE_DIR}/ACCEPTANCE.md: the suite + verification results, the per-criterion table, and
   each remaining gap (title + file:line evidence + suggested fix) — or "All criteria met." Do NOT
   modify source code, stage, or commit.
Report ONLY material, in-feature gaps. Return via the schema.`;

const baselinePrompt = () => `
You are establishing the git BASELINE for this run in ${REPO}. The staging contract is: staged index
= ACCEPTED baseline, unstaged working tree = the current cycle's work. Right now the tree may carry
PRE-EXISTING local changes that belong to NO task and must not pollute the feature's review diff.
1. Run \`git -C ${REPO} status --porcelain\`.
2. For every MODIFIED or otherwise-tracked-changed file, run \`git -C ${REPO} add\` on it to fold it
   into the accepted baseline. Do NOT commit. Afterwards \`git -C ${REPO} diff\` must be EMPTY.
3. Leave UNTRACKED files untouched — just list them in ignored_untracked.
4. Write ${STATE_DIR}/progress.json (create the directory if needed) with EXACTLY:
   {"id":"${RUN_ID}","status":"in-progress"}
   This marks the run as STARTED so a killed-and-resumed run skips baseline prep instead of folding
   this feature's in-progress work into the accepted baseline.
${A.baselineNote ? `Expected pre-existing changes (normal — stage them as baseline, do not revert): ${A.baselineNote}` : ''}
Do NOT modify any source code. Return the lists + clean=true via the schema.`;

const recorderPrompt = (record, verify) => `
You are the SCRIBE/RECORDER. Persist this feature's outcome durably so a re-run resumes without
redoing it. Do NOT modify source code.
1. Ensure ${STATE_DIR}/ exists.
2. Write this EXACT JSON verbatim to ${STATE_DIR}/progress.json:
${JSON.stringify(record)}
3. Append/refresh a human-readable ${STATE_DIR}/FEATURE.md: the feature, what changed (files, tests
   added, how it was verified), status, rounds, anything flagged to NEEDS-DECISION, and — if an
   acceptance check ran — its result and any gaps:
   ${verify ? JSON.stringify({ complete: verify.complete === true, gaps: (verify.gaps || []).map((g) => g.title), suite: verify.suite_result || '', verification: verify.verification_result || '' }) : '(acceptance check not run)'}
Return written=true.`;

const writePlanReviewPrompt = (critique) => `
You are the SCRIBE. Persist the plan critic's findings for the user + orchestrating agent to act on.
1. Ensure ${STATE_DIR}/ exists.
2. Write ${STATE_DIR}/PLAN-REVIEW.md: verdict=${critique.verdict}; a "Gaps" section (each title +
   evidence + suggestion) and a "Questions for you" section (each question + why it blocks). If both
   are empty, write "Plan looks sound — no gaps or blocking questions." ${critique.too_big ? 'NOTE: the critic judged this is MORE THAN ONE bounded feature — recommend splitting across runs.' : ''}
Write this verbatim data:
${JSON.stringify({ verdict: critique.verdict, gaps: critique.gaps || [], questions: critique.questions || [], too_big: critique.too_big === true, notes: critique.notes || '' })}
Do NOT modify source code. Return written=true.`;

// =============================================================================
// PHASE: refine — adversarially review the supplied plan, write PLAN-REVIEW.md, STOP for the user
// =============================================================================
if (PHASE === 'refine') {
  phase('Refine');
  log(`refine: critiquing the plan${PLAN_PATH ? ` at ${PLAN_PATH}` : ' (inline)'} against ${REPO}`);
  // The one-shot plan critique is the highest-leverage call in this phase — run it on the planner tier.
  const critique = await agent(refinePrompt(), roleOpts('planner', {
    schema: REFINE_SCHEMA, phase: 'Refine', label: 'plan-critic',
  }));
  await agent(writePlanReviewPrompt(critique || { verdict: 'ready', gaps: [], questions: [] }), roleOpts('scribe', {
    schema: RECORD_SCHEMA, phase: 'Refine', label: 'record:plan-review',
  }));
  const gaps = critique?.gaps || [];
  const questions = critique?.questions || [];
  log(`refine: verdict=${critique?.verdict ?? 'ready'} — ${gaps.length} gap(s), ${questions.length} question(s)${critique?.too_big ? ' [TOO BIG — split it]' : ''}`);
  return {
    phase: 'refine',
    runId: RUN_ID,
    verdict: critique?.verdict ?? 'ready',
    tooBig: critique?.too_big === true,
    gaps,
    questions,
    planReviewFile: `${STATE_DIR}/PLAN-REVIEW.md`,
    nextStep: questions.length
      ? 'Relay the questions to the user (AskUserQuestion), fold the answers + gap fixes directly into the plan file (planPath), then re-invoke phase:"build" with this SAME runId + planPath. (The user already approved via ExitPlanMode before this refine ran; just flag any material changes.)'
      : gaps.length
        ? 'Fold the gap fixes directly into the plan file (planPath) (flag any material change to the user), then re-invoke phase:"build" with this SAME runId + planPath.'
        : 'Plan is sound — re-invoke phase:"build" with this SAME runId + planPath.',
  };
}

// =============================================================================
// PHASE: build — implement ONE feature via the develop → review → triage loop, then verify
// =============================================================================
phase('Load');
const loaded = await agent(loaderPrompt(), roleOpts('scribe', {
  schema: LOADER_SCHEMA, phase: 'Load', label: 'load-plan',
}));
if (loaded?.plan_missing || !loaded?.plan || !(loaded.plan.acceptance_criteria || []).length) {
  throw new Error(`No usable plan (need feature + acceptance_criteria) from ${PLAN_PATH || 'inline plan'}. Author/approve a plan first.`);
}
const plan = loaded.plan;
const priorStatus = String(loaded?.done?.status ?? '');
if (priorStatus.startsWith('done')) {
  log(`resume: feature already ${priorStatus} — nothing to do (delete ${STATE_DIR}/progress.json to force a re-run)`);
  return { phase: 'build', runId: RUN_ID, alreadyDone: true, status: priorStatus, stateDir: STATE_DIR };
}

const tstrat = plan.test_strategy ?? { kind: 'none' };
const gate = plan.gate ?? 'green';
log(`build: "${plan.feature.slice(0, 80)}${plan.feature.length > 80 ? '…' : ''}" → ${REPO} [gate=${gate}, verify=${tstrat.method || tstrat.kind}]`);

// The refine phase is MANDATORY and leaves PLAN-REVIEW.md in the state dir. On a FRESH run (no prior
// progress) with no such artifact, the plan was very likely built without the required review — warn
// loudly (non-blocking; resumes keep the artifact, and an inline-plan caller may have reviewed it out
// of band). Run phase:"refine" with this SAME runId first to satisfy it.
if (!priorStatus && loaded?.plan_review_exists !== true) {
  log(`  ⚠ no PLAN-REVIEW.md in ${STATE_DIR} — the MANDATORY refine pass appears to have been skipped. Run phase:"refine" with this same runId BEFORE build (see CLAUDE.md → canonical flow).`);
}

// One-time baseline prep: fold any pre-existing modified TRACKED files into the staged baseline so
// the feature's UNSTAGED diff is purely this feature's work (keeps the reviewer's git-diff clean).
// SKIPPED when a prior progress.json exists (priorStatus non-empty): on a resumed / blocked /
// needs-attention run the unstaged tree is this feature's IN-PROGRESS work — folding it into the
// baseline would hide it from review. The baseline agent writes an "in-progress" marker for this.
if (A.prepBaseline !== false && !priorStatus) {
  const base = await agent(baselinePrompt(), roleOpts('scribe', {
    schema: BASELINE_SCHEMA, phase: 'Load', label: 'baseline-prep',
  }));
  log(`baseline: staged ${(base?.staged_files || []).length} pre-existing file(s); ignoring ${(base?.ignored_untracked || []).length} untracked`);
} else if (A.prepBaseline !== false) {
  log(`baseline: prep skipped — prior run state "${priorStatus}" exists, so the unstaged tree is this feature's in-progress work (delete ${STATE_DIR}/progress.json to force a fresh run + baseline)`);
}

const record = { id: RUN_ID, feature: plan.feature.slice(0, 120), status: 'pending', rounds: 0, fixed: 0, testWorkRounds: 0, deferred: 0, needsUser: 0, rejected: 0, regression: false, staged: false, verifyDeferred: false, gates: null };
const handled = [];            // titles fed back to the reviewer so it won't re-report
const resolved = new Set();    // finding signatures (file:title) considered done
let halted = false;
let blockerReason = '';
let accepted = false;

// ---- DEVELOP → REVIEW → TRIAGE loop -----------------------------------------
let round = 0;
let repair = false;
let fixItems = [];
while (round < MAX_ROUNDS) {
  round++;
  record.rounds = round;

  phase('Develop');
  const dev = await agent(developPrompt(plan, repair, fixItems), roleOpts('develop', {
    schema: DEVELOP_SCHEMA, phase: 'Develop', label: `develop r${round}`,
  }));
  const gateMet = gateOk(gate, tstrat, dev);
  const gateDesc = `${gate} via ${tstrat.method || tstrat.kind || 'build'} — observed: build=${dev?.build_passed}, test_outcome=${dev?.test_outcome}, count=${dev?.tests_run_count}, suite=${dev?.full_suite_outcome}`;
  // Environmental deferral candidacy: the configured agent-driven verification (browser MCP /
  // inspector / curl / manual) could not run in THIS environment, but the build is green and the
  // existing suite is not reddened. Unit tests are NEVER deferrable.
  const deferrable = !gateMet && dev?.build_passed === true && dev?.test_outcome === 'not-run'
    && tstrat.unit !== true && ENV_METHODS.has(tstrat.method || '') && dev?.full_suite_outcome !== 'failed';
  if (dev?.tests_written) record.testWorkRounds++;
  record.gates = { gate, met: gateMet, build: dev?.build_passed ?? null, test_outcome: dev?.test_outcome ?? null, method: dev?.verification_method ?? '' };

  // Review the unstaged diff — skipped when the developer produced no changes.
  const produced = (dev?.results || []).some((r) => r.status === 'CHANGED' || r.status === 'ADDED');
  if (produced && dev?.unstaged_confirmed !== true) log(`  ⚠ r${round}: developer did not confirm content was left unstaged — staging contract may be violated`);
  let review = null;
  if (produced) {
    phase('Review');
    review = await agent(reviewPrompt(plan, handled), roleOpts('review', {
      schema: REVIEW_SCHEMA, phase: 'Review', label: `review r${round}`,
    }));
  } else {
    log(`  review skipped r${round}: developer reported no changed/added files`);
  }
  const findings = (review?.findings || [])
    .filter((f) => FLOOR_EXEMPT.has(f.category) || (SEV_RANK[f.severity] ?? 1) >= REVIEW_SEV)
    .map((f, i) => ({ id: `r${round}-${i}`, f }))
    .filter((x) => !resolved.has(`${x.f.file}:${x.f.title}`));

  phase('Triage');
  const isLastRound = round >= MAX_ROUNDS;
  // Happy path (clean review + gate met): a LEAN accept on the cheaper review tier. Findings or a
  // missed gate get the full planner triage.
  const lean = findings.length === 0 && gateMet && produced;
  const triage = lean
    ? await agent(acceptPrompt(plan, round, gateDesc), roleOpts('review', {
        schema: TRIAGE_SCHEMA, phase: 'Triage', label: `accept r${round}`,
      }))
    : await agent(triagePrompt(plan, findings, round, gateMet, gateDesc, dev?.gate_output || '', isLastRound, deferrable), roleOpts('planner', {
        schema: TRIAGE_SCHEMA, phase: 'Triage', label: `triage r${round}`,
      }));
  if (triage?.regression_found) record.regression = true;

  // Tally + remember terminal routings so the reviewer won't resurface them.
  const byId = new Map(findings.map((x) => [x.id, x]));
  const actionable = [];
  for (const v of triage?.verdicts || []) {
    const item = byId.get(v.finding_id);
    if (v.decision === 'ACTIONABLE') { actionable.push(v); continue; }
    if (item) { resolved.add(`${item.f.file}:${item.f.title}`); handled.push(item.f.title); }
    if (v.decision === 'DEFER') record.deferred++;
    else if (v.decision === 'NEEDS_USER') record.needsUser++;
    else if (v.decision === 'REJECT') record.rejected++;
  }

  // Hard stop on a true blocker — halt the run for user input.
  if (triage?.has_blocker || (triage?.verdicts || []).some((v) => v.blocking)) {
    halted = true;
    blockerReason = triage?.summary || `Blocker raised during round ${round}.`;
    record.status = 'BLOCKED';
    log(`  ✋ BLOCKER during r${round} → halting (see ${STATE_DIR}/BLOCKERS.md)`);
    break;
  }

  // Accept: the Planner (or lean-accept) is authoritative — but require the gate to be met, OR an
  // explicit triage-approved deferral of an environmentally-unavailable verification method.
  const deferredAccept = deferrable && triage?.verification_deferred === true;
  if (triage?.accepted === true && (gateMet || deferredAccept)) {
    accepted = true;
    record.staged = triage?.staged === true;
    record.verifyDeferred = deferredAccept;
    record.status = deferredAccept
      ? 'done (verification deferred — run the configured check yourself; see NEEDS-DECISION.md)'
      : (record.deferred + record.needsUser > 0) ? 'done (with follow-ups)' : 'done';
    log(`  ✓ accepted after ${round} round(s) [gate=${gate} ${gateMet ? 'met' : 'DEFERRED — verification unavailable here'}] (staged=${record.staged}, fixed=${record.fixed}, flagged=${record.needsUser})`);
    break;
  }

  // Not accepted → next round from the triage's fix-plan.
  record.fixed += actionable.length;
  if (isLastRound) {
    record.status = gateMet ? 'needs-attention (unresolved must-fix)' : 'needs-attention (gate unmet)';
    log(`  ⚠ round budget (${MAX_ROUNDS}) exhausted — ${actionable.length} item(s) open, gate(${gate}) ${gateMet ? 'met' : 'UNMET'}`);
    break;
  }
  fixItems = (triage?.next_fix_plan?.steps || []).length
    ? triage.next_fix_plan.steps
    : actionable.map((v) => v.fix_instruction).filter(Boolean);
  // Never hand the developer an EMPTY repair brief — fall back to the gate/triage detail.
  if (!fixItems.length) {
    fixItems = [gateMet
      ? `Triage did not accept the round: ${triage?.summary || '(no detail given)'} — resolve and re-verify.`
      : `The gate was NOT met (${gateDesc}).${dev?.gate_output ? ` Failing output tail: ${dev.gate_output}` : ''} Diagnose and make the configured verification pass.`];
  }
  if (triage?.next_fix_plan?.files?.length) plan.files = triage.next_fix_plan.files;
  repair = true;
  log(`  ↻ r${round}: ${actionable.length} actionable + gate(${gate}) ${gateMet ? 'met' : 'UNMET'} → repair round`);
}
if (record.status === 'pending') record.status = 'needs-attention (loop end)';

// ---- VERIFY (acceptance) — only when accepted; the whole-feature completeness check -------------
let verify = null;
if (accepted && !halted && A.verify !== false) {
  phase('Verify');
  verify = await agent(verifyPrompt(plan), roleOpts('review', {
    schema: VERIFY_SCHEMA, phase: 'Verify', label: 'acceptance',
  }));
  // Acceptance gaps are ADVISORY (like the sibling engine's final sweep): the per-round loop already
  // accepted + STAGED valid, gate-passing work, so the status stays done-prefixed (a re-run would see
  // the staged work and not target these gaps — closing them needs a human/agent decision or a follow-
  // up plan). We surface them LOUDLY here, in the result, and in ACCEPTANCE.md so they are never silent.
  if (verify && verify.complete !== true) {
    record.status = `${record.status} (acceptance gaps — see ACCEPTANCE.md)`;
    log(`  ⚠ verify: ${(verify?.gaps || []).length} gap(s) / unmet criteria — STAGED but NOT fully done; read ${STATE_DIR}/ACCEPTANCE.md`);
  } else {
    log(`  ✓ verify: all criteria met (suite: ${verify?.suite_result || 'n/a'})`);
  }
}

// ---- RECORD (durable; survives kill/resume) -------------------------------------------------
phase('Record');
const rec = await agent(recorderPrompt(record, verify), roleOpts('scribe', {
  schema: RECORD_SCHEMA, phase: 'Record', label: 'record:progress',
}));
record.recorded = rec?.written === true;

// =============================================================================
// Result
// =============================================================================
return {
  phase: 'build',
  runId: RUN_ID,
  halted,
  blockerReason: halted ? blockerReason : '',
  stateDir: STATE_DIR,
  status: record.status,
  staged: record.staged,
  rounds: record.rounds,
  fixed: record.fixed,
  testWorkRounds: record.testWorkRounds,
  needsUser: record.needsUser,
  regression: record.regression,
  verificationDeferred: record.verifyDeferred === true,
  acceptance: verify ? { complete: verify.complete === true, reachable: verify.reachable === true, gaps: (verify.gaps || []).length, suite: verify.suite_result || '', verification: verify.verification_result || '' } : null,
  followups: halted
    ? `Run halted — see ${STATE_DIR}/BLOCKERS.md. Resolve the root cause, then resume with the same args.`
    : `${record.verifyDeferred ? `VERIFICATION DEFERRED — the configured ${tstrat.method || 'manual'} check could not run in the workflow environment: run it yourself (see ${STATE_DIR}/NEEDS-DECISION.md) before committing. ` : ''}Review the staged diff in ${REPO} (git diff --cached), ${STATE_DIR}/FEATURE.md, ${STATE_DIR}/NEEDS-DECISION.md${verify && verify.complete !== true ? `, and ${STATE_DIR}/ACCEPTANCE.md (gaps!)` : ''}. Nothing is committed — you commit.`,
};
