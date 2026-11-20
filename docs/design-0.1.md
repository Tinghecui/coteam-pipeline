# 0.1 engine contract

This file is the contract between the modules of the engine. It was ported from a
private pipeline that has merged several hundred unattended PRs; where this file is
silent, the behaviour of that pipeline is the reference. The port itself has only been
run by its test suite so far: not yet against the real GitHub API or the real agent CLI.

## Ground rules

- Node >= 20, ES modules, **no npm dependencies**. Tests use `node:test` and live in `test/<module>.test.mjs`.
- All logic lives under `cli/`. Workflow files only call `node cli/main.mjs <command>`.
- `cli/core/*` is pure: no network, no child processes, no `process.env`, no file reads
  except where a function takes text as an argument. Everything there is unit-tested.
- `cli/io/*` wraps `gh`, `git`, `claude`. `cli/roles/*` wires core + io into one command each.
- Code, comments, prompts, labels, comment templates: English. Every user-visible string
  comes from `cli/core/text.mjs` so another language can be added later.
- Nothing may name a specific repository, owner, product, stack or model vendor outside
  `presets/` and `docs/`.
- State lives in the user's GitHub: labels, hidden HTML marks in comments
  (`<!-- pipeline-<kind> {json} -->`, one line), and one branch `pipeline/ledger`
  holding `ledger.jsonl`.

## Config: `.coteam/pipeline.yml` in the user's repo

Parsed by `cli/core/yaml.mjs` (a small subset: maps, lists, scalars, inline lists,
quoted strings, comments). `cli/core/config.mjs` exports
`loadConfig(text, presetText) -> config` (deep-merge user over preset, validate,
throw one Error listing every problem) and `DEFAULTS`.

```yaml
version: 1
preset: startup
mode: record                 # off | record | on.  record = open PRs and review, never merge
base: main
owners: []                   # logins allowed to answer decisions; empty = repo admins/maintainers
stack:
  setup: ["npm ci"]          # run once in the executor's checkout before the agent starts
  test: "npm test"           # how to run tests (the agent may narrow it to files)
  check: ["npm run lint"]    # must pass before the PR is opened
  ui_paths: ["src/**/*.tsx", "src/**/*.css"]
models:
  executor: claude-opus-5-5
  reviewer: claude-opus-5-5
risk:
  forbidden: [".github/**", ".coteam/**", "CLAUDE.md", "AGENTS.md"]   # executor may not touch
  level3: ["**/auth/**", "**/migrations/**"]
  level2: []
  level1: []
  # anything else: level 0 by path; the reviewer may raise it
merge:
  method: squash             # squash | merge | rebase
  auto_max_level: 1          # levels <= this merge without a human once reviewed and CI is green
  default_after_hours: 24    # level-2 decisions take the recommended option after this long; 0 = wait forever
limits:
  max_parallel: 2            # executor runs at the same time
  max_rework: 4              # per PR, counted since the last human decision
  issue_max_runs: 5          # per issue or per row
  issue_max_usd: 20
  daily_usd: 30
  executor_minutes: 120
  reviewer_minutes: 20
labels:
  work: pipeline             # put on an issue = hand it to the pipeline
  decide: "pipeline:decide"  # decision items
  approved: "pipeline:approved"   # owner puts it on a level-3 PR to release it
  redo: "pipeline:redo"
  followup: "pipeline:followup"
  level_prefix: "level:"
status_context: pipeline/review
branch_prefix: pipeline/
```

## Risk (`cli/core/policy.mjs`)

- `globRe(glob)`, `classifyPaths(config.risk, files)`, `forbiddenHits(config.risk, files)`,
  `pathLevel(config.risk, files) -> 0..3`.
- Final level of a PR = max(path level, reviewer level).
- A PR that touches a forbidden path is discarded by the executor before pushing.

## Work items

An issue carrying `labels.work` is work. If its body has a split table it is a **spec
issue**: one PR per row, in dependency order. Otherwise it is a **single task**: one PR.

Spec issue format (English headings, fixed in 0.1; see `docs/spec-format.md`):
`## Summary`, `## Requirement`, `## Acceptance criteria`, `## Decisions`,
`## Open questions` (must be empty or "none"), `## Out of scope`, `## Current state`,
`## PR split` (table: `#` | `What` | `Where` | `Depends on` | `How to verify`), `## Risks`.

`cli/core/spec.mjs`: `parseSpec(body) -> {sections, rows:[{n, what, where, deps:[n|{pr}], verify}], problems:[]}`,
`checkSpec(body) -> problems[]`, `specProgress(spec, {openPrs, closedPrs, comments}) -> {done, open, next, blocked, closed}`.

Branch: `<branch_prefix><issue>[-r<row>]-<slug>`. `rowOfBranch`, `issueOfBranch` in `cli/core/marks.mjs`.

## Marks (`cli/core/marks.mjs`)

One generic pair `mark(kind, obj) -> string` / `findMarks(kind, comments) -> [{...obj, at, by, id}]`,
JSON escaped so `-->` cannot close the comment early. Kinds used in 0.1:

| kind | where | meaning |
|---|---|---|
| `claim` | issue comment | an executor run took this issue/row; stale after 3 h; `released:true` when done |
| `row-done` | issue comment | row n merged as PR p |
| `row-closed` | issue comment | PR for row n closed unmerged; not redone unless `labels.redo` |
| `rework` | PR comment | a rework was dispatched for head sha (why, attempt) |
| `review` | PR comment | reviewer verdict for head sha: `{sha, verdict, level, by}` |
| `item` | decision issue body | `{kind, pr|issue, level, options:[{key,what,pros,cons,action,needsText}], recommend, due}` |
| `decision` | PR or issue comment | a human decision was applied: `{item, key, by, at}`; resets rework counts |

Plus helpers ported from the source: `activeClaims`, `reworks`, `reworkObsolete`,
`countSince` (rework and run counts start again after the latest `decision`).

Kinds added when the roles were wired together (who writes, who reads):

| kind | written by | where | read by | meaning |
|---|---|---|---|---|
| `claim` | fix | issue | tick, fix | as above; `{run, row, released?}` |
| `result` | fix | issue | tick | how a run that opened a PR or pushed nothing ended: `{outcome, row, run, pr?}`. The tick counts these when the ledger has fewer lines (the ledger is not being written) |
| `skip` | fix | issue (rework: PR) | tick | the executor did not start, or (`why: "unavailable"`, rework only) the agent could not be used: `{why, permanent, run, row, sha?, until?, other?}`. permanent = an owner is asked; otherwise the same run is dispatched again after 30 min or `until`. `why: "open_pr"` carries `other` (the PR that is open for the issue) and is one comment per such PR, renewed in place; the 30 min count from the comment's last edit |
| `rework` | tick, then fix | PR | tick, fix | tick: `{sha, attempt, why, send?}` (sent back; `send` = dispatch number when the same head is sent again). fix: `{sha, attempt, head, run, done: true}` or `{sha, attempt, run, failed: true, why}`. An attempt = one earlier head with any rework mark since the latest decision; both roles count that way |
| `review` | review | PR | tick, review, fix | a verdict `{sha, verdict, level, state, waits, ...}` or a review that did not run `{sha, failed: true, attempt, reason, unavailable?}` |
| `decision` | tick | PR (stuck items: issue) | tick, fix | `{item, key, by, how, action, sha?, row?, text?}` |
| `row-done`, `row-closed`, `finished` | tick | issue | tick, fix | spec progress; a single task is row 0 |
| `receipt`, `nudge` | tick | decision item | tick | the item was applied or closed / an answer needs a sentence |

Whose marks count. Every role reads comments through `trustedComments(comments, authors)`:
a comment that carries a mark counts only when the pipeline's own account posted it
(`markAuthors(io.botLogin, PIPELINE_BOT)`). When that login is not known, marks are read
whoever wrote them, with one exception that is never relaxed: a `review` comment counts only
if the pipeline's commit status on that head names it (`believedReviews`: the reviewer sets
the status with the comment's address as `target_url`). Merging depends on the commit status
alone in both cases. Order of comments is `isAfter` (time, then comment id) for every role.

## Ledger (`cli/core/ledger.mjs`)

`ledger.jsonl`, one JSON object per line:
`{at, role: "executor"|"reviewer", issue, row, pr, run, outcome, turns, usd, model, merged?}`.
Executor outcomes: `pr`, `rework`, `cannot_fix`, `forbidden`, `checks_failed`, `conflict`, `failed`,
`unavailable`. `unavailable` (and `skipped` / `dry`, for which no line is written today) never
count against an issue: `countedRuns(entries, {issue,row,since})` is the one count the tick and
the executor share. Reviewer outcomes: the verdict, `failed`, `unavailable`.
`parseLedger(text)`, `budget(entries, {issue,row,limits,now}) -> {ok, reason}`,
`claudeCooldown(entries, now)` (30 min after an "unavailable" outcome), `unavailableReason(msgs, {rc, stderr})`.

## Review decision (`cli/core/decide.mjs`)

Reviewer output schema (`prompts/reviewer.schema.json`):
`{verdict: "approve"|"reject"|"needs_human", level: 0..3, problems:[{kind:"logic"|"criteria"|"security"|"tests_missing", where, what}], followups:[{kind, what}], ask?, options?:[{what,pros,cons}], recommend?, summary}`.

Reject only for: logic that will go wrong, an acceptance criterion not met, a security
problem, or no tests for a behaviour change. Everything else goes to `followups`.

`reviewDecision({config, out, pathLevel}) -> {state: "success"|"failure"|"pending", level, waits: null|"owner", description}`:
- reject -> failure (tick dispatches a rework)
- approve and level <= auto_max_level -> success
- approve and level 2 -> pending, decision item opened, default after `default_after_hours`
- level 3 or needs_human -> pending, waits for owner, never defaults
- reviewer failed to run -> pending with reason; tick re-dispatches up to 3 times

`mergeable({config, pr, review, checks}) -> {ok, why}`: mode is `on`, not draft, head sha
equals reviewed sha, state success (or released by a `decision`), every check run and
status other than our own is completed and successful (none at all counts as green only
if the repo has no checks), no merge conflict.

"Our own" is the status `status_context` and the check runs of the pipeline's own jobs.
The dispatcher's caller workflow is started by `pull_request` events, so its check run
(`<caller job> / pipeline-tick`) sits on PR heads; a round that failed, was cancelled or is
still running is not CI. `OWN_CHECK` / `ciRuns(runs, context)` in `cli/core/decide.mjs` is
the one place that knows the job names (`pipeline-tick`, `pipeline-fix`,
`pipeline-review`, fixed in `.github/workflows/`); the tick's gather, `mergeable`, the
plan's failed-check rule, the executor's rework feedback and the doctor all go through it.

## Tick (`cli/core/plan.mjs`, `cli/roles/tick.mjs`)

`planTick(state, config, now) -> plan` is pure. `state` = open work issues with comments,
open and recently closed PRs on `branch_prefix` with comments/statuses/checks, decision
items, ledger entries, running workflow runs. `plan` = lists of actions:
`dispatchFix[{issue,row}]`, `dispatchRework[{pr,why}]`, `dispatchReview[{pr}]`, `merge[{pr}]`,
`openItems[...]`, `applyAnswers[{item,key,text,by}]`, `applyDefaults[{item}]`, `markRows[...]`,
`closeIssues[...]`, `notes[]`. `tick.mjs` gathers state, calls `planTick`, executes the
plan (or prints it with `--dry`). In `mode: record` it executes everything except
`merge` and `applyDefaults`.

A person's own PR for a work issue: `state.otherPrs` holds every open PR that is not the
pipeline's (same list call, title and body only). If one of them names the issue with a
closing keyword in its body or title (`Fixes #n`, `Closes #n`, `Resolves #n`;
`marks.takesIssue`, the test the executor's precheck uses too), a person has taken the
issue: no executor is dispatched for it and nothing is asked while that PR is open, and the
round's notes say so in one line. The issue's timeline (cross-references) is not read: it
would cost one more call per issue per round and say nothing a closing keyword does not.

Only comments by `owners` (or, if empty, users with admin/maintain permission) count as answers.
An answer is a comment on the decision item starting with an option letter (`A`, `B: text`).

## Roles

- `fix`: precheck (budget, claim, cooldown) -> claim -> checkout base, new branch -> run
  `stack.setup` -> run `claude -p` with the executor prompt, tools unrestricted, **no GitHub
  token in its environment** -> validate structured output (`prompts/executor.schema.json`)
  -> forbidden-path check -> run `stack.check` -> push with the bot token, open PR (draft if
  path level is 3) -> ledger line -> release claim. Rework mode: same on the existing branch.
- `review`: checkout the PR merge ref read-only -> run `claude -p` with read-only tools ->
  `reviewDecision` -> post the `review` mark comment, commit status, level label -> ledger line.
- `tick`: above.
- `doctor [--fix]`: `cli/roles/doctor.mjs`, the installation check (config, labels, the
  three caller workflows, secret and variable names, what the token can read and may
  write, CI, branch protection). Read-only; `--fix` creates missing labels. It is the one
  role whose io is built with `makeIo({ tolerateConfig: true })`.
- `spec check <file|issue>`, `app-token <app-id> <owner/repo>` (PEM on stdin).

## Not in 0.1

Red-check, responder and rule learning, follow-up digest, acceptance on preview URLs,
project boards, a second reviewer model, conflict auto-merge, other languages.

Isolation of the agent from the bot's credentials. In 0.1 the agent runs in the same job
and as the same OS user as the engine, which holds the App's private key; on GitHub-hosted
runners that user has passwordless sudo, so an agent that was prompt-injected and actively
digs (reading the engine process's memory, replacing a binary the engine runs) can reach
the key. Planned: run the agent in a separate job (or as a separate unprivileged OS user)
that holds no GitHub credential at all, with a second job that validates and publishes its
output. What 0.1 does instead, and what it recommends until then, is in docs/install.md,
"Threat model and known gaps".

## Roles and io (added after the core landed)

Every role is `cli/roles/<name>.mjs` exporting `async function run(opts, io) -> {ok, ...}`.
A role never imports `node:child_process`, never reads `process.env` and never calls
`Date.now()`: everything outside comes through `io`, so tests pass a fake.

```
io = {
  env,                      // plain object (process.env in production)
  now(),                    // Date
  log(line),                // one line to the job log
  gh,                       // cli/io/gh.mjs makeGh(): get, list, post, patch, put, del, graphql, dispatch(workflow, ref, inputs)
  makeGit({cwd}),           // cli/io/git.mjs: git, try, remote, tryRemote  (token already bound)
  proc: {run, must, shell}, // cli/io/proc.mjs
  fs: {read(path), write(path, text), exists(path), mkdtemp(prefix)},
  claude(opts),             // cli/io/claude.mjs runClaude, below
  ledger: {read() -> entries[], append(entry)},   // cli/io/ledger-io.mjs, branch pipeline/ledger
  home,                     // absolute path of this engine's checkout (prompts/, presets/)
  repoDir,                  // absolute path of the user's repo checkout (cwd)
  config,                   // loaded and validated .coteam/pipeline.yml (always read from the base branch, never from a PR head).
                            // A config that does not load is an error in makeIo for every role but the doctor, whose io
                            // has config = null and configError = the reason
  tokenPermissions,         // what the bot token may do, as GitHub reported it when an app's token was minted
                            // ({contents: "write", ...}); null for a plain token. Read by the doctor
  botLogin,                 // the login(s) whose marks are believed, comma separated; "" = not known. cli/io/real.mjs
                            // works it out on first use: the account the token writes as ("<app-slug>[bot]" for an
                            // app's token, read with GET /app when the token is minted; else the token's user,
                            // GET /user), preceded by whatever PIPELINE_BOT names. PIPELINE_BOT is optional: it can
                            // add logins and stands in when the account cannot be found; it cannot take the real
                            // one out. (The tick caller template also uses the variable to skip the bot's own events.)
}
```

`runClaude({tag, prompt, cwd, model, minutes, schema, tools: "all"|"readonly", maxTurns}) ->
{ok, output /* structured output or null */, usage: {turns, usd, models, unavailable?, resets_at?}, rc, rawPath}`.
It runs `claude -p --output-format stream-json` in its own session, kills leftovers when
it ends, and passes the agent **only** the model credential: every `GITHUB_*`, `ACTIONS_*`,
`GH_*`, `PIPELINE_*` variable is removed from its environment.

Environment in CI: `GITHUB_REPOSITORY`; the bot token as `PIPELINE_TOKEN`, or
`PIPELINE_APP_ID` + `PIPELINE_APP_KEY` from which `cli/io/real.mjs` mints one (installation
token for this repository only, renewed after 40 minutes); `ANTHROPIC_API_KEY` (or
`CLAUDE_CODE_OAUTH_TOKEN`).

No code from disk after the agent. The agent runs as the engine's OS user and can rewrite
the engine's checkout, so nothing under `cli/` may be loaded once a role has started:
`cli/main.mjs` imports every module statically, no module uses a dynamic `import()`, and
the token renewal runs `node --input-type=module -e <text>` where the text is
`cli/io/app-token.mjs` as read when `cli/io/real.mjs` was loaded (the request and the PEM go
in on stdin). `cli/io/app-token.mjs` therefore imports Node built-ins only.
`test/main.test.mjs` checks all of this. Prompts, schemas and presets are text and are read
before the agent starts.

Workflows in the user's repo that the tick dispatches: `pipeline-fix.yml`
(inputs `issue`, `row`, `pr`), `pipeline-review.yml` (input `pr`). The tick itself is
`pipeline-tick.yml`. The run title (`run-name`) of a fix run must carry `#<issue>` (and
`#<pr>` for a rework), that of a review run `#<pr>`: the tick tells from it what a run is for.

Decision items (`cli/core/items.mjs`): kinds `pr-ask` (level 2: A = the reviewer's
recommended option … last = close the PR), `pr-release` (level 3 or needs_human:
A = release as is, B = rework with the text after `B:`, C = close), `stuck`
(the executor gave up or ran out of budget: A = try again, counts restart; B = drop,
remove the work label). `renderItem`, `parseItem`, `parseAnswer(comment, item)`.
