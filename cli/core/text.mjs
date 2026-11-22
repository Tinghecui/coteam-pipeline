// Every user-visible English string of the engine, so another language can be added later by
// swapping this module. `T` holds the wording of spec.mjs, prompts.mjs and the pull request
// body; further down, one object per module that has wording of its own (LEDGER_TEXT,
// DECIDE_TEXT, ITEMS_TEXT, REVIEW_TEXT, PLAN_TEXT, TICK_TEXT, FIX_TEXT), which that module
// re-exports as `TEXT`. Not here: the command line's usage text (cli/main.mjs) and the doctor's
// (cli/roles/doctor.mjs). Prompt text for the models lives in prompts/*.md; only the small
// fillers that code inserts into a prompt are here (T.prompt).
// Nothing in this file may use anything but its own arguments and the helpers defined in it
// (test/text.test.mjs calls every entry to make sure).

const list = (items) => items.join(", ")
// Why the agent could not be used, for the codes that do not explain themselves (ledger.mjs, cli/io/machine.mjs).
const unavailableWhy = (code) => (code === "runner" ? "runner: the agent's machine refused to run it, the agent job's log says why" : code)

export const T = {
  // ---- spec issue format (docs/spec-format.md) ----
  spec: {
    // Section names. Matched case-insensitively, ignoring extra spaces.
    headings: {
      summary: "Summary",
      requirement: "Requirement",
      criteria: "Acceptance criteria",
      decisions: "Decisions",
      open: "Open questions",
      outOfScope: "Out of scope",
      current: "Current state",
      split: "PR split",
      risks: "Risks",
    },
    // Split table columns. A header cell matches when it contains one of the words (lower case).
    columns: {
      n: ["#", "row", "no", "no."],
      what: ["what"],
      where: ["where"],
      deps: ["depends", "depend", "after"],
      verify: ["verify", "verif"],
    },
    // Bold labels inside "## Summary": the full brief, and the short one for a small fix.
    briefFull: ["In one sentence", "Background", "Why", "Options considered", "Who decided", "If it goes wrong", "How to verify"],
    briefShort: ["Problem", "Cause", "Fix", "Risk and how to verify"],
    chosenWord: "chosen",
    onlyOneOption: "only one option",
    problems: {
      notSpec: 'Not a spec issue: there is no "## PR split" table. An issue without one is a single task (one PR) and does not need this format.',
      criteriaEmpty: '"## Acceptance criteria" is missing or empty.',
      openNotEmpty: (first) => `"## Open questions" is not empty: ${first}. Settle it, move the answer to "## Decisions", and write "none".`,
      noTable: '"## PR split" has no table (it needs a header row, a separator row and at least one row).',
      badHeader: 'The split table header needs the columns "#", "What" and "Depends on".',
      badNumber: (cell) => `A split table row has a "#" that is not a positive integer: "${cell}".`,
      duplicate: (n) => `Row # ${n} appears twice in the split table.`,
      depRange: (n, range) => `Row ${n}: "Depends on" has a range "${range}". List every row (1, 2, 3); a range is not understood.`,
      depText: (n, text) => `Row ${n}: "Depends on" may only hold row numbers (1, 2) and issue or PR numbers (#123), or "none". It says "${text}".`,
      depSelf: (n) => `Row ${n}: "Depends on" names the row itself.`,
      depMissing: (n, d) => `Row ${n}: "Depends on" names row ${d}, which does not exist.`,
      cycle: (rows) => `"Depends on" forms a cycle: rows ${list(rows)}.`,
      sectionMissing: (name) => `"## ${name}" is missing or empty (write "none" if there is nothing to say).`,
      forbiddenPath: (n, path) => `Row ${n}: "Where" names \`${path}\`, which the executor may not touch (risk.forbidden). Take that part out of the split table and do it by hand.`,
      briefMissing: '"## Summary" is missing: put it first. It is the plain-language brief for people who do not read code (docs/spec-format.md).',
      briefShape: (full, short) => `"## Summary" needs either the full brief (${full.join(" / ")}) or the short one (${short.join(" / ")}), each item starting with its **bold** label.`,
      briefItems: (missing) => `"## Summary" lacks: ${list(missing)}.`,
      briefChosen: 'The options table in "## Summary" must mark the option that was picked (write "chosen" in that row).',
      briefOptions: 'The options in "## Summary" must be a table (option / pros / cons, at least two options) or say "only one option".',
      briefCode: (found) => `"## Summary" contains code-like text (${list(found)}). It is for people who do not read code: say it in plain words.`,
      briefLong: (len, max) => `"## Summary" is too long (${len} characters without the table, limit ${max}): two or three sentences per item.`,
    },
    backtick: "backticks",
  },

  // ---- progress of a spec issue (why the next row is not dispatched) ----
  progress: {
    unreadable: (problem) => `the spec has problems: ${problem}`,
    waits: (n, what) => `row ${n} waits for ${list(what)}`,
    row: (n) => `row ${n}`,
    ref: (n) => `#${n}`,
    closed: (n, pr, label) => `row ${n}: PR #${pr} was closed without merging, so the row is not redone automatically; put the "${label}" label on PR #${pr} to redo it`,
  },

  // ---- pull request body ----
  pr: {
    fixes: (issue) => `Fixes #${issue}`,
    partOf: (issue, row, rows) => `Part of #${issue} (row ${row} of ${rows} in the PR split)`,
    summaryTitle: "Summary",
    noBrief: (issue) => `(#${issue} has no "Summary" section; for the background and the reason, read #${issue}.)`,
    what: "What this PR does",
    step: (row, rows) => ` (row ${row} of ${rows})`,
    decidedTitle: "Decided by the executor",
    decidedHint: " (not in the issue; it chose these itself)",
    decidedNone: "nothing; it followed the issue as written.",
    risk: "If it goes wrong",
    verify: "How to verify",
    notVerifiedTitle: "Not run or not verified",
    notVerifiedNone: "nothing reported.",
    notWritten: "(the executor did not say)",
    notGiven: "(not given)",
    // A CLI that reports no cost records 0: "cost not reported", not "$0.00".
    byline: ({ model, turns, usd }) => `Written by the pipeline executor (${model || "model unknown"}, ${turns ?? "?"} turns, ${Number(usd) > 0 ? `about $${Number(usd).toFixed(2)}` : "cost not reported"}).`,
    draft: " Draft: a person has to look at it and mark it ready.",
    attempt: (n) => `Rework ${n}: changed again after review or CI feedback. This description was rewritten for the whole PR.`,
    detailsTitle: "Technical details (for the reviewer: files changed, evidence)",
    changed: "What changed",
    noWhy: "(the executor did not say why it changed this file)",
    noFiles: "(no files listed)",
    evidence: "Evidence (red, then green)",
    red: "Before the change, the new test fails:",
    green: "After the change, the same test passes:",
    checks: "Checks run:",
    checkOk: "passed",
    checkFailed: "FAILED",
    noChecks: "(none reported)",
    run: (url) => `Run: ${url}`,
  },

  // ---- small fillers that code puts into a prompt ----
  prompt: {
    none: "(none)",
    noneConfigured: "(none configured)",
    notWritten: "(not written)",
    emptyBody: "(the body is empty)",
    noFeedback: "(no specific feedback was collected)",
    noPreviousBody: "(could not be read)",
    truncated: (shown, total) => `[truncated: this is the first ${shown} of ${total} characters. The rest was NOT shown to you; say so in your output instead of guessing what it says.]`,
    commentBy: (login) => `@${login}:`,
    commentSeparator: "-----",
  },

  errors: {
    templateVar: (name) => `prompt template uses {{${name}}} but no value was given`,
    templateBlock: (tag) => `prompt template has an unbalanced block tag ${tag}`,
  },
}

// ---------------------------------------------------------------------------------------
// Wording of the other modules
// ---------------------------------------------------------------------------------------

const money = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`
// "#5", "#5 row 2": how an issue or one row of a spec issue is named in a sentence.
export const taskName = (issue, row) => `#${issue}${row ? ` row ${row}` : ""}`

// ---- cli/core/ledger.mjs ----
// User-visible wording of budget refusals.
export const LEDGER_TEXT = {
  dailyCap: ({ day, spent, cap }) => `${money(spent)} spent today (UTC ${day}), the daily limit is ${money(cap)}`,
  dailyRuns: ({ day, runs, cap }) => `the agents have run ${runs} times today (UTC ${day}), the daily limit is ${cap} (limits.daily_runs)`,
  runCap: ({ what, runs, max, usd }) => `${what}: the executor has already run ${runs} times (limit ${max}), spending ${money(usd)}`,
  usdCap: ({ what, runs, max, usd }) => `${what}: the executor has already spent ${money(usd)} (limit ${money(max)}) over ${runs} runs`,
  item: ({ issue, row }) => `#${issue}${row ? ` row ${row}` : ""}`,
}

// ---- cli/core/decide.mjs ----
// User-visible wording. Status descriptions are cut to GitHub's 140 characters.
export const DECIDE_TEXT = {
  approved: (level) => `Approved, level ${level}`,
  rejected: (n) => `Rejected: ${n} problem${n === 1 ? "" : "s"}, see the review comment`,
  needsHuman: "Waiting for an owner: the reviewer could not decide, see the review comment",
  waitsOwner: (level, label) => `Approved, level ${level}: waiting for an owner (label "${label}" releases it)`,
  waitsDefault: (level, hours) => `Approved, level ${level}: decision item opened, the recommended option applies after ${hours} h`,
  waitsDecision: (level) => `Approved, level ${level}: decision item opened, waiting for an owner`,
  reviewFailed: (reason) => `Review did not run: ${reason}`,
  // Why an approval was not taken as written (validateReview).
  invalid: {
    intro: (level) => `the reviewer approved at level ${level}, where an owner has to choose, but`,
    ask: "did not write the question to answer",
    options: "did not give at least two options",
    recommend: "did not recommend one of its options",
    join: (parts) => parts.join(", "),
  },
  why: {
    mode: (mode) => `mode is "${mode}": nothing is merged unless mode is "on"`,
    closed: "the PR is not open",
    draft: "the PR is a draft",
    notReviewed: "the PR has not been reviewed",
    stale: "the head commit changed after the review",
    state: (state) => `the review status is "${state}"`,
    conflict: "the PR conflicts with the base branch",
    unknownMergeable: "GitHub has not computed mergeability yet",
    noChecks: "no checks have reported on the head commit yet",
    checkPending: (name) => `check "${name}" has not finished`,
    checkFailed: (name, result) => `check "${name}" is ${result}`,
  },
}

// ---- cli/core/items.mjs ----
// Every user-visible string of a decision item and of the comments that record an answer.
export const ITEMS_TEXT = {
  titlePrefix: "[decide]",
  heading: {
    defaults: (key, when) => `**Needs a decision.** If nobody answers, option ${key} (the recommended one) is applied after ${when}.`,
    waits: "**Needs a decision.** Nothing happens until an owner answers: this never resolves on its own.",
  },
  ask: "**What is being asked:**",
  why: "**Why you are asked:**",
  optionsTitle: "**Options**",
  table: { head: "| | Option | What the pipeline does | Pros | Cons |", sep: "|---|---|---|---|---|" },
  recommended: "recommended",
  none: "–",
  recommendLine: (key) => `**Recommended:** ${key}.`,
  noRecommend: "**Recommended:** none: the pipeline has no basis to prefer one option here.",
  howTitle: "**How to answer:**",
  how: (who) =>
    `comment on this issue with the letter of an option, for example \`A\`. To add an instruction, write it after a colon: \`B: keep the old default\`. Lower case works too. Only an answer from ${who} counts; any other comment is ignored.`,
  needsTextNote: "write what to do after the colon",
  owners: (list) => (list.length ? list.map((o) => `@${o}`).join(", ") : "a repository admin or maintainer"),
  ifNothingTitle: "**If nobody answers:**",
  ifNothing: {
    defaults: (key, when) => `option ${key} is applied after ${when}.`,
    pr: (n) => `PR #${n} stays open and is not merged; nothing is lost.`,
    issue: (n) => `#${n} stays open and the executor does not touch it again.`,
  },
  whereTitle: "**Where to look:**",
  background: "Background",
  backgroundCut: "… (cut here; the rest is at the top of the pull request)",
  footer: "<sub>Opened by the pipeline's scheduler.</sub>",
  // What each action does, for the "What the pipeline does" column.
  does: {
    merge: (draft) => (draft ? "Marks the PR ready and merges it once its checks are green" : "Merges the PR once its checks are green"),
    rework: "Sends the PR back to the executor with this instruction (rework counts restart)",
    close: "Closes the PR without merging; the work is not redone on its own",
    review: "Runs the reviewer again",
    retry: "Lets the executor try again (run and spend counts restart)",
    drop: "Removes the work label; the issue stays open for a person",
  },
  subject: {
    prAsk: (n, title) => `PR #${n} needs a product choice: ${title}`,
    prRelease: (n, title) => `PR #${n} waits for an owner: ${title}`,
    prStuck: (n, title) => `PR #${n} is stuck: ${title}`,
    stuck: (n, row, title) => `The executor is stuck on #${n}${row ? ` row ${row}` : ""}: ${title}`,
  },
  prAsk: {
    askFallback: (n) => `The reviewer approved PR #${n} but it carries a product trade-off the issue did not decide. Should it be merged as it is?`,
    why: "Both ways are reasonable and the issue did not say which one is wanted, so the pipeline does not choose for you.",
    keep: (what) => `Keep what the PR does now: ${what}`,
    change: (what) => `Change it: ${what}`,
    mergeAsIs: "Merge the PR as it is",
    reworkText: "Change it: say how",
    close: (n) => `Drop it: close PR #${n}`,
    closePros: "Nothing changes for users",
    closeCons: "The work is thrown away",
    notSaid: "(the reviewer did not say)",
  },
  prRelease: {
    release: (draft) => (draft ? "Release it as it is (the draft is marked ready)" : "Release it as it is"),
    releasePros: "Done now, no more waiting",
    rework: "Send it back with an instruction",
    reworkPros: "The executor changes it the way you say",
    reworkCons: "Another executor run (time and money)",
    close: (n) => `Close PR #${n}`,
    closePros: "Nothing is merged",
    closeCons: "The work is thrown away; the task is not redone on its own",
    reReview: "Run the reviewer again",
    reReviewPros: "A real review before anything is merged",
    reReviewCons: "It may fail the same way again",
    cause: {
      level3: {
        ask: (n) => `PR #${n} touches something only an owner may let through (level 3). Release it?`,
        why: "It changes something sensitive or hard to undo (for example sign-in, data migration, payments or secrets). The pipeline never merges such a change on its own.",
        releaseCons: "If it is wrong it may be hard to undo",
      },
      needs_human: {
        ask: (n) => `The reviewer could not tell whether PR #${n} is right. Please look at it.`,
        why: "The answer depends on something neither the issue nor the repository says (usually product intent), or the change was too large to read completely.",
        releaseCons: "Nobody has confirmed that it is right",
      },
      draft: {
        ask: (n) => `PR #${n} is a draft. Release it?`,
        why: "A draft is never merged by the pipeline. The executor opens a draft when it had to touch level-3 paths; a person may also have turned the PR into a draft.",
        releaseCons: "If it is wrong it may be hard to undo",
      },
      "review-failed": {
        ask: (n) => `The reviewer could not run on PR #${n}. What should happen to it?`,
        why: "The review was started several times and never produced a verdict, so nothing vouches for this change.",
        releaseCons: "It is merged without any review",
      },
      "rework-cap": {
        ask: (n) => `PR #${n} was sent back as often as the limits allow and still does not pass. What now?`,
        why: "The executor and the reviewer (or the checks) are going in circles; a person has to give a direction.",
        releaseCons: "It is merged although the reviewer's objections (see its latest review comment) still stand",
      },
      "rework-failed": {
        ask: (n) => `The last rework of PR #${n} produced no new commit. What now?`,
        why: "Sending the same commit back again would end the same way, so the pipeline stopped.",
        releaseCons: "It is merged although the reviewer's objections (see its latest review comment) still stand",
      },
    },
    look: (n) => `PR #${n}: the latest review comment says what the reviewer found and why it set this level.`,
    reasonLine: (reason) => `What happened: ${reason}`,
  },
  stuck: {
    ask: (n, row) => `The executor cannot finish #${n}${row ? ` (row ${row})` : ""}. Try again or drop it?`,
    why: {
      budget: "It used up the runs or the money allowed for this task without getting it merged.",
      "gave-up": "It looked at the task and said it cannot do it.",
      refused: "It would not start on the task as the task stands now.",
    },
    retry: "Try again (add a hint after `A:` if you have one)",
    retryPros: "A fresh set of attempts; a hint often unblocks it",
    retryCons: "Costs more runs; without a hint it may fail the same way",
    drop: "Drop it: the pipeline stops working on this issue",
    dropPros: "No more money spent on it",
    dropCons: "The task is not done; someone has to do it by hand or rewrite the issue",
    look: (n) => `#${n}: the executor's comments and the linked runs.`,
  },
  decision: {
    title: (key) => `**Decided${key ? ` (option ${key})` : ""}:**`,
    by: { answer: (who, item) => `Answered by @${who} in #${item}.`, default: (item) => `Nobody answered #${item} in time, so its recommended option was applied.`, label: (who, label) => `@${who} put the "${label}" label on this pull request.` },
    said: {
      merge: "release it: merge once the checks are green.",
      rework: (text) => `rework it. ${text}`,
      close: "close this pull request without merging.",
      review: "run the reviewer again.",
      retry: (text) => `try again.${text ? ` ${text}` : ""}`,
      drop: "drop it: the pipeline stops working on this issue.",
    },
    reworkAsReviewed: "Follow the reviewer's latest feedback on this pull request.",
  },
  receipt: {
    applied: (key, what) => `Option ${key} applied: ${what} Closing this item. To overrule it, say so on the pull request or issue itself.`,
    stale: (why) => `No decision is needed any more: ${why}. Closing this item.`,
    refreshed: (pr, sha, when) =>
      `PR #${pr} has new commits (now at \`${sha}\`) and was reviewed again. The question above was rewritten for them: please read it again. An answer given before this comment was about the old commits and does not count.${when ? ` Without an answer, the recommended option applies ${when}.` : ""}`,
    needsText: (key) => `Option ${key} needs a sentence saying what to do. Answer again as \`${key}: <what to change>\`.`,
  },
}

// ---- cli/core/review-comment.mjs ----
// User-visible wording of the review comment, and of what the role says outside it
// (commit status descriptions it sets itself, why a run was skipped).
export const REVIEW_TEXT = {
  title: "Pipeline review",
  verdict: { approve: "approved", reject: "changes needed", needs_human: "an owner has to look" },
  heading: (verdict, level) => `${verdict}, level ${level}`,
  failedHeading: "did not run",
  noSummary: "(the reviewer wrote no summary)",
  level: (level, byPath, byReviewer) => `**Level ${level}** (by path: ${byPath}; by the reviewer: ${byReviewer}; the higher one counts)`,
  pathRule: (path, level, glob) => `\`${path}\` is level ${level} (rule \`${glob}\`)`,
  morePaths: (n) => `and ${n} more file${n === 1 ? "" : "s"}`,
  downgraded: (why) => `**Not taken as an approval**: ${why}. An owner has to look instead.`,
  ask: "**For the owner to decide**",
  noAsk: "(the reviewer did not say what to look at; read its summary above and the changes)",
  options: "**Options**",
  recommended: " (recommended by the reviewer)",
  pros: "For",
  cons: "Against",
  notWritten: "(not written)",
  problems: "**Problems** (these block the merge)",
  problemKind: { logic: "logic", criteria: "acceptance criteria", security: "security", tests_missing: "no tests" },
  followups: "**Follow-ups** (these do not block the merge)",
  followupKind: { test: "tests", existing: "already there", summary: "summary", evidence: "evidence", other: "other" },
  more: (n) => `(${n} more not shown)`,
  cut: " [...]",
  next: {
    title: "**Next**",
    success: "merges on its own once every check is green.",
    record: (mode) => `nothing is merged automatically while mode is "${mode}"; this verdict is on record only.`,
    failure: "goes back to the executor for a rework with the problems above.",
    defaults: (hours) => `a decision item is opened for the owner. Without an answer, the recommended option applies after ${hours} h.`,
    decision: "a decision item is opened; it waits until an owner answers it.",
    owner: (label) => `waits for an owner: answer the decision item, or put the label "${label}" on this PR to release it. It never proceeds on its own.`,
  },
  failed: {
    attempt: (n) => `This was failed attempt ${n} on this commit.`,
    retry: (max) => `The review is started again automatically (at most ${max} retries).`,
    noRetry: (max) => `It was already retried ${max} times: it is not started again automatically. Start the review workflow by hand, or push a new commit.`,
    unavailable: "The cause is outside this pull request (the agent's quota, overload or login, or the daily budget), so this does not count as an attempt; the review is started again when that has passed.",
  },
  footer: {
    reviewed: (head, base, baseSha) => `Reviewed: commit \`${head}\` merged into ${base}${baseSha ? ` \`${baseSha}\`` : ""}`,
    notReviewed: (head) => `Commit \`${head}\``,
    model: (model) => `model ${model}`,
    cost: (turns, cost) => `${turns} turns, ${cost}`,
    run: (url) => `[run](${url})`,
    again: "A new commit on this PR is reviewed again.",
  },
  // ---- used by the role (cli/roles/review.mjs) ----
  status: {
    reviewing: "Review in progress",
    conflict: (base) => `Not reviewed: the PR conflicts with ${base} and has to be reworked first`,
  },
  skip: {
    off: 'mode is "off"',
    notOpen: (state) => `the PR is ${state}, not open`,
    notOurs: (ref, prefix) => `the head branch "${ref}" is not on "${prefix}": not a pipeline PR`,
    fork: (repo) => `the head branch lives in another repository (${repo}): not a pipeline PR`,
    base: (ref, base) => `the PR targets "${ref}", the pipeline works on "${base}"`,
    reviewed: (sha, verdict) => `commit ${sha} was already reviewed (${verdict})`,
    moved: (was, now) => `the head moved from ${was} to ${now} while the review was starting; the new commit gets its own review`,
  },
  failure: {
    budget: (reason) => `budget: ${reason}`,
    noMergeRef: "GitHub did not provide a merge commit for this head",
    checkout: (detail) => `could not check out the merged code: ${detail}`,
    unavailable: (code) => `the agent is unavailable (${unavailableWhy(code)})`,
    timeout: (minutes) => `the reviewer did not finish within ${minutes} minutes`,
    noOutput: (rc) => `the reviewer gave no structured result (exit code ${rc})`,
    crashed: (detail) => `the reviewer could not be started: ${detail}`,
    noResult: "the job that runs the reviewer left no usable result (it may have been cancelled, or run out of time)",
  },
  synthetic: {
    empty: "After merging, this pull request changes nothing: everything it does is already on the base branch. It was not given to the reviewer.",
    emptyAsk: "The changes are already on the base branch. Close this pull request, or check why it was opened.",
    big: (files, bytes, max) => `This pull request changes ${files} files and its diff is ${bytes} bytes, more than a reviewer can read completely (${max} bytes). It was not given to the reviewer.`,
    bigAsk: "The change is too large for an automatic review. Read it yourself, or close it and split the work into smaller pull requests.",
  },
  label: (level) =>
    [
      "Pipeline review: level 0 (fix, tests, docs, refactor)",
      "Pipeline review: level 1 (visible change)",
      "Pipeline review: level 2 (a product choice an owner decides)",
      "Pipeline review: level 3 (sensitive: only an owner releases it)",
    ][level] || "Pipeline review",
}

// ---- cli/core/plan.mjs ----
// User-visible wording: comments the scheduler writes and the notes of a round.
export const PLAN_TEXT = {
  off: 'mode is "off": nothing is planned',
  record: {
    merge: (n, level) => `record mode: PR #${n} (level ${level}) would have been merged now`,
    default: (item, key) => `record mode: item #${item} is past its time, option ${key} would have been applied`,
  },
  why: {
    owner: (text) => `an owner asked for a change: ${text}`,
    rejected: "the reviewer rejected it",
    check: (name, result) => `check "${name}" ${result}`,
    conflict: "it conflicts with the base branch",
  },
  reason: {
    cap: (n, max, why) => `It was sent back ${n} time${n === 1 ? "" : "s"} (the limit is ${max}) and still: ${why}.`,
    budget: (reason, why) => `${reason}; and still: ${why}.`,
    unrecorded: (runs, max) => `the executor has already run ${runs} times on this (limit ${max}), and the ledger has no line for some of those runs: check that the pipeline can write to its ledger branch`,
    failed: (attempt, said, why) => `Rework ${attempt} pushed no new commit${said ? ` (${said})` : ""}; and still: ${why}.`,
    lost: (attempt, minutes, why) => `Rework ${attempt} was started ${minutes} minutes ago and left no result; and still: ${why}.`,
    review: (n) => `The reviewer was started ${n} times for this commit and never produced a verdict.`,
    gaveUp: "The executor's last run ended with it saying it cannot do this; its comment on the issue says why.",
    refused: (why) => `The executor refused to start (${why}) and says this will not change by itself; its comment says why.`,
  },
  comment: {
    rework: (attempt, max, why) => `Sent back to the executor (rework ${attempt} of at most ${max}): ${why}.`,
    budgetWait: (reason) =>
      `Waiting for the daily budget: ${reason}. Nothing is wrong and nothing is lost: this starts by itself after midnight UTC. To start it sooner, an owner can raise the limit named here (\`limits.daily_usd\` or \`limits.daily_runs\`) in \`.coteam/pipeline.yml\` on the base branch.`,
    reworkAgain: (attempt, max, why, send, skipped) => `Sent back to the executor again (rework ${attempt} of at most ${max}, sent ${send} times: the run before did not start, ${skipped}): ${why}.`,
    rowDone: (row, pr) => `Row ${row} is done: PR #${pr} was merged.`,
    taskDone: (pr) => `PR #${pr} was merged.`,
    rowClosed: (row, pr, label) =>
      `PR #${pr}${row ? ` (row ${row})` : ""} was closed without merging, so this ${row ? "row" : "task"} is not done again on its own. To have it redone from the current base branch, put the "${label}" label on this issue.`,
    rowRedo: (row, pr) => `PR #${pr}${row ? ` (row ${row})` : ""} was closed without merging; a redo was asked for, so the ${row ? "row" : "task"} is dispatched again.`,
    finished: (rows) => `Every row of the PR split is merged (${rows.map((r) => (r.pr ? `row ${r.row}: PR #${r.pr}` : `row ${r.row}: already in place`)).join(", ")}). Closing this issue. If something is not right, reopen it or open a new issue.`,
    finishedTask: (pr) => `PR #${pr} was merged. Closing this issue. If something is not right, reopen it or open a new issue.`,
  },
  status: { released: (who, item) => `Released by ${who ? `@${who}` : "default"}${item ? ` (#${item})` : ""}` },
  // One sentence per piece of work on the status board (core/board.mjs): where it is and what it waits for.
  board: {
    nothing: "nothing to do right now",
    reworking: "the executor is reworking it",
    reworkSent: (attempt, max, why) => `sent back to the executor now (rework ${attempt} of at most ${max}): ${why}`,
    reworkWaits: (why) => `a rework was dispatched (${why}); waiting for the new commit`,
    reworkHeld: (why, wait) => `to be sent back (${why}); ${wait}`,
    skipWait: (why, until) => `the executor did not start (${why}); tried again after ${until}`,
    claimed: (run) => `claimed by run ${run || "?"}`,
    reviewing: "the review is running",
    reviewSent: (attempt) => `the review is dispatched now${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
    reviewHeld: (wait) => `needs a review; ${wait}`,
    merging: (by) => `approved; merged now${by ? ` (released by @${by})` : ""}`,
    recordMerge: 'approved; would be merged now, but mode is "record"',
    notMerged: (why) => `approved; not merged yet: ${why}`,
    statusLag: "approved; waiting for the review status to catch up",
    item: (n, due) => `waits for an owner: decision item #${n}${due ? `; the recommended option applies ${due}` : ""}`,
    itemOpened: "waits for an owner: a decision item is opened now",
    asked: "asked before, and the item was closed without an answer; nothing happens until someone acts",
    answered: (by) => `an owner's answer is applied now${by ? ` (@${by})` : ""}`,
    dropped: (by) => `dropped by an owner${by ? ` (@${by})` : ""}`,
    specProblem: (problem) => `not started, the spec has a problem: ${problem}`,
    finished: "everything is merged; the issue is closed now",
    reopened: "reopened, but every row is merged: nothing to do",
    inProgress: (pr) => `in progress in PR #${pr}`,
    blocked: (why) => `waits: ${why}`,
    closedNotRedone: (pr, label) => `PR #${pr} was closed without merging; put the "${label}" label on the issue to have it redone`,
    taken: (pr) => `taken by PR #${pr}, which is not the pipeline's`,
    working: "the executor is working on it",
    started: "the executor is dispatched now",
    slot: (max) => `waits for a free slot (at most ${max} executor runs at a time)`,
    budget: (reason) => `waits for the daily budget: ${reason}`,
    cooling: (reason, until) => `waits: the agent cannot be used (${unavailableWhy(reason)}) until ${until}`,
    probe: "waits: after a pause, one probe run goes first",
    runsUnknown: "waits: the pipeline's runs could not be read this round",
    unattributed: "waits: a run is starting that does not say yet what it works on",
  },
  stale: {
    prGone: (n, merged) => `PR #${n} was ${merged ? "merged" : "closed"}`,
    prMissing: (n) => `PR #${n} is no longer open`,
    newHead: (n) => `new commits were pushed to PR #${n}; it is looked at again from scratch`,
    applied: "the answer was already applied",
    duplicate: (other) => `#${other} asks the same thing`,
    issueGone: (n, label) => `#${n} is closed or no longer carries the "${label}" label`,
    changed: (n) => `the state of PR #${n} changed; a new item says what needs deciding now`,
    notNeeded: (n) => `PR #${n} no longer needs a decision`,
    issueNotNeeded: (n) => `#${n} is no longer stuck the way this item says`,
  },
  note: {
    noOwners: "nobody can answer decision items: config.owners is empty and no admin or maintainer was found",
    notOwner: (item, login) => `item #${item}: the answer by @${login} does not count (not an owner)`,
    needsText: (item, key) => `item #${item}: option ${key} needs a sentence; asked for one`,
    runsUnknown: (what) => `could not read the ${what} runs: no ${what} is dispatched this round`,
    ghost: (id, minutes) => `run ${id} has been queued for ${minutes} minutes without a job (a ghost run): ignored`,
    unattributed: (ids) => `nothing is dispatched this round: run ${ids.join(", ")} is queued or starting and does not say yet which issue it is for`,
    cooling: (reason, until) => `the agent cannot be used right now (${unavailableWhy(reason)}): nothing is dispatched until ${until}`,
    probeWait: (ids) => `the cooldown is over; waiting for the probe run (${ids.join(", ")}) before dispatching more`,
    probe: "the cooldown is over; one probe run is dispatched first",
    probeOk: (id, minutes) => `probe run ${id} has been going for ${minutes} minutes: the agent works again`,
    daily: (reason) => `nothing is dispatched: ${reason}`,
    heldAnswer: (item, pr) => `item #${item}: PR #${pr} is being reworked or reviewed again; the answer is not applied to the old commit`,
    queued: (what, limit) => `${what} waits for a free slot (at most ${limit} executor runs at a time)`,
    fixRunning: (what) => `${what}: an executor run is going`,
    skipWait: (what, why) => `${what}: the executor did not start (${why}); it is dispatched again later`,
    reworkPending: (n) => `PR #${n}: a rework of this commit was dispatched; waiting for its result`,
    reviewRunning: (n) => `PR #${n}: the review is running`,
    reviewBlocked: (n) => `PR #${n} needs a review; not dispatched this round`,
    notMerged: (n, why) => `PR #${n} is approved but not merged yet: ${why}`,
    statusLag: (n, state) => `PR #${n}: the review comment says approved but the "${state.context}" status is "${state.state || "missing"}"; waiting for the reviewer to set it`,
    labelNotOwner: (n, login, label) => `PR #${n}: the "${label}" label was put on by @${login || "?"}, who is not an owner; ignored`,
    labelOld: (n, label) => `PR #${n}: the "${label}" label does not release the current commit: it was put on before this commit was reviewed; remove it and put it on again after the review`,
    redoNothing: (n, label) => `#${n}: the "${label}" label is on the issue but no closed PR waits to be redone; the label is removed`,
    asked: (what) => `${what}: already asked (the item was closed without an answer); nothing more is done until someone acts`,
    specProblem: (n, problem) => `#${n} is not dispatched: ${problem}`,
    inProgress: (n, row, pr, draft) => `#${n}${row ? ` row ${row}` : ""} is in progress: PR #${pr}${draft ? " (a draft: an owner has to release it)" : ""}`,
    blocked: (n, why) => `#${n} is not dispatched: ${why}`,
    noRow: "no row can be started",
    claimed: (n, run) => `#${n} is claimed by run ${run || "?"}`,
    taken: (n, pr) => `#${n} is not dispatched: PR #${pr}, which is not the pipeline's, says it closes this issue; the pipeline leaves the issue alone while that pull request is open`,
    reopened: (n) => `#${n} was reopened but every row of its PR split is merged: nothing to do (add rows or open a new issue)`,
    closedNotRedone: (n, pr, label) => `#${n} is not dispatched: PR #${pr} was closed without merging; put the "${label}" label on the issue to redo it`,
  },
}

// ---- cli/core/board.mjs ----
// The status board issue.
export const BOARD_TEXT = {
  title: "Pipeline status",
  summary: ({ mode, spent, cap, runs, maxRuns, running, parallel }) =>
    `**Mode:** \`${mode}\` · **Today (UTC):** ${spent} of ${cap}, ${runs} agent run${runs === 1 ? "" : "s"}${maxRuns ? ` of ${maxRuns}` : ""} · **Executor runs going:** ${running} of ${parallel}`,
  record: 'Mode "record": the pipeline writes code, opens pull requests and reviews them, but merges nothing and takes no decision by default.',
  held: (why) => `Nothing new starts right now. ${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
  failures: (n) => `${n} step${n === 1 ? "" : "s"} of the last round failed; the run's log says which.`,
  empty: (label) => `Nothing is in progress. Put the "${label}" label on an issue to hand it to the pipeline.`,
  group: { person: "Needs a person", moving: "Moving", waiting: "Waiting", idle: "Nothing to do" },
  col: { what: "What", status: "Where it is" },
  pr: (pr, issue, row) => `PR #${pr}${issue ? ` (#${issue}${row ? ` row ${row}` : ""})` : ""}`,
  issue: (issue, row) => `#${issue}${row ? ` row ${row}` : ""}`,
  notes: (n) => `Notes from the round that wrote this (${n})`,
  footer: (at, url) => `Written by the pipeline at ${at}${url ? ` ([run](${url}))` : ""}. It rewrites this issue when something changes; edits and comments here are not read.`,
}

// ---- cli/roles/tick.mjs ----
export const TICK_TEXT = {
  off: 'tick: mode is "off", nothing to do',
  gathered: (c) => `tick: ${c.issues} work issue${c.issues === 1 ? "" : "s"}, ${c.prs} open pipeline PR${c.prs === 1 ? "" : "s"}, ${c.items} open decision item${c.items === 1 ? "" : "s"}, ${c.running} executor run${c.running === 1 ? "" : "s"} going`,
  planned: (mode, c) =>
    `tick (${mode}): fix ${c.dispatchFix}, rework ${c.dispatchRework}, review ${c.dispatchReview}, merge ${c.merge}, new items ${c.openItems}, answers ${c.applyAnswers}, defaults ${c.applyDefaults}, items closed ${c.closeItems}, rows marked ${c.markRows}, issues closed ${c.closeIssues}`,
  note: (line) => `  note: ${line}`,
  did: (what) => `  done: ${what}`,
  failed: (what, error) => `  FAILED: ${what}: ${error}`,
  skipped: (what, why) => `  skipped: ${what} (${why})`,
  result: (done, failed) => `tick: ${done} done, ${failed} failed`,
  dryRun: "tick: dry run, nothing was changed",
  gatherFailed: (error) => `tick: could not read the repository state, nothing was done: ${error}`,
  noBot: "the pipeline's own login is not known (set PIPELINE_BOT): marks in comments are read whoever wrote them, and a review comment counts only when the commit status names it; merging still depends on the commit status only",
  noEvents: (n) => `could not read who labelled PR #${n}; its release label is ignored this round`,
  why: {
    record: 'mode is "record"',
    answerFailed: "the decision it follows from could not be recorded",
    markFailed: "its row marks could not be written",
  },
  what: {
    markRows: (e) => `mark #${e.issue}${e.row ? ` row ${e.row}` : ""} ${e.kind === "done" ? "done" : e.redo ? "to be redone" : "closed"} (PR #${e.pr})`,
    applyAnswers: (e) => `apply ${e.how === "label" ? "the release label" : `answer ${e.key}`} by @${e.by} (${e.effect}) to ${e.pr ? `PR #${e.pr}` : `#${e.issue}`}${e.item ? `, item #${e.item}` : ""}`,
    applyDefaults: (e) => `apply the default ${e.key} (${e.effect}) of item #${e.item} to PR #${e.pr}`,
    nudges: (e) => `ask for a sentence on item #${e.item} (option ${e.key})`,
    closeItems: (e) => `close item #${e.item}: ${e.why}`,
    refreshItems: (e) => `rewrite item #${e.item} for the new commits of PR #${e.pr}`,
    notices: (e) => `say on #${e.on} that it waits for the daily budget`,
    labels: (e) => `remove the label "${e.remove}" from #${e.on}`,
    closeIssues: (e) => `close #${e.issue}: everything is merged`,
    openItems: (e) => `open a decision item (${e.kind}, ${e.cause}) for ${e.pr ? `PR #${e.pr}` : `#${e.issue}`}`,
    merge: (e) => `merge PR #${e.pr} (${e.by})`,
    dispatchReview: (e) => `dispatch the review of PR #${e.pr} (attempt ${e.attempt})`,
    dispatchRework: (e) => `dispatch rework ${e.attempt} of PR #${e.pr}: ${e.why}`,
    dispatchFix: (e) => `dispatch the executor for #${e.issue}${e.row ? ` row ${e.row}` : ""}`,
  },
  decideLabel: "A decision the pipeline needs from an owner",
  boardLabel: "The pipeline's status board",
  boardTitle: "Pipeline status",
  board: (what) => `tick: status board ${what}`,
  boardFailed: (error) => `could not be written: ${error}`,
  boardUnreadable: (error) => `the status board could not be looked up (${error}); it is not written this round`,
}

// ---- cli/roles/fix.mjs ----
// User-visible wording.
export const FIX_TEXT = {
  // skip reasons
  off: 'mode is "off"',
  prClosed: (pr, merged) => `PR #${pr} is already ${merged ? "merged" : "closed"}`,
  notOurs: (pr, ref) => `PR #${pr} (branch ${ref}) was not opened by the pipeline for this issue, so it is not reworked`,
  notIssue: (n) => `#${n} is a pull request, not an issue`,
  closed: (n) => `#${n} is closed`,
  noLabel: (n, label) => `#${n} does not carry the "${label}" label`,
  openPr: (n, pr) => `PR #${pr} is already open for #${n}`,
  specProblems: (n, problems) => `the spec in #${n} cannot be worked on: ${problems.join("; ")}`,
  specOpen: (n) => `"Open questions" in #${n} is not empty`,
  noRow: (n, row) => `the PR split table of #${n} has no row ${row}`,
  rowDone: (n, row, pr) => `${taskName(n, row)} is already done (${pr ? `PR #${pr} is merged` : "it was found on the base branch"})`,
  allDone: (n) => `every row of #${n} is merged`,
  rowWaits: (n, row, rows) => `${taskName(n, row)} waits for row ${rows.join(", ")} to be merged`,
  noNext: (n, why) => `no row of #${n} can be started now${why ? `: ${why}` : ""}`,
  maxRework: (pr, done, max) => `PR #${pr} has been reworked ${done} time${done === 1 ? "" : "s"} (limit ${max})`,
  headReworked: (pr, sha) => `head ${sha.slice(0, 9)} of PR #${pr} was already sent back once`,
  headMoved: (pr) => `PR #${pr} got new commits after this rework was dispatched`,
  cooldown: (reason, until) => `the agent was unavailable (${reason}); waiting until ${until}`,
  claimed: (run) => `run ${run || "?"} is already working on it`,
  skipped: (reason) => `The pipeline executor did not start: ${reason}.`,
  skippedPermanent: "It will not be dispatched again for this until an owner decides.",
  // claim
  claim: (what, runUrl) => `The pipeline executor is working on ${what}.${runUrl ? ` Run: ${runUrl}` : ""}`,
  lostClaim: (run) => `(run ${run || "?"} claimed it first; this run does nothing)`,
  released: {
    pr: (pr) => `(opened PR #${pr}; released)`,
    rework: (pr) => `(pushed the rework to PR #${pr}; released)`,
    unavailable: "(the agent could not be used; released, this attempt is not counted)",
    skipped: "(did not start; released)",
    other: "(no pull request this time; released)",
  },
  // failures
  noMergeBase: (pr, base) => `cannot find where PR #${pr} left ${base} (is the checkout's history too shallow?)`,
  conflict: (base, files) => `${base} could not be merged into the PR branch; conflicts in: ${files.join(", ") || "(unknown)"}`,
  mergeFailed: (base) => `merging ${base} into the PR branch failed without a conflict to resolve`,
  conflictMarkers: (files) => `the merge conflict was not resolved: conflict markers are still in ${files.join(", ")}`,
  conflictLost: (base, files) => `the merge would throw away changes from ${base} in ${files.join(", ")}; nothing was pushed`,
  setupFailed: (line) => `setup command failed: ${line}`,
  unavailable: (reason) => `the agent cannot be used right now (${unavailableWhy(reason)})`,
  noOutput: (rc, note) => `the agent gave no structured result (exit code ${rc}${note ? `; ${note}` : ""})`,
  badOutput: (problems) => `the agent's result does not match the schema: ${problems.slice(0, 5).join("; ")}`,
  noChanges: "the agent reported success but changed nothing",
  forbidden: (paths) => `the change touches paths the executor may not touch (${paths.join(", ")}); it was discarded`,
  checkFailed: (line) => `check failed: ${line}`,
  pushFailed: (branch) => `could not push to ${branch} (someone else may have pushed to it)`,
  prFailed: (branch, why) => `the branch ${branch} was pushed but the pull request could not be opened: ${why}`,
  crashed: (why) => `the run broke off: ${why}`,
  baseGone: (base) => `the commit of ${base} this run was planned on could not be fetched`,
  noResult: "the job that runs the agent left no usable result (it may have been cancelled, or run out of time)",
  noReason: "no reason was given",
  noBundle: "the job that runs the agent reported a change but handed none over",
  badBundle: "the change handed over by the job that runs the agent could not be read",
  badTree: "the change handed over by the job that runs the agent is not a tree git accepts (a path such as .git in it, or a malformed tree)",
  // comments
  opened: (pr, what, draft) => `The pipeline executor opened #${pr} for ${what}${draft ? " as a draft: it touches level 3 paths, a person has to look at it" : ""}.`,
  result: {
    cannot_fix: "The pipeline executor looked at this and did not make the change",
    forbidden: "The pipeline executor's change was thrown away",
    checks_failed: "The pipeline executor's change did not pass the configured checks, so nothing was pushed",
    conflict: "The pipeline executor could not start the rework",
    failed: "The pipeline executor did not finish",
  },
  output: "Output (end):",
  run: (url) => `Run: ${url}`,
  reworked: (attempt, max, summary) => `The pipeline executor reworked this pull request (attempt ${attempt} of at most ${max}): ${summary}`,
  reworkedNote: "The description was rewritten for the whole pull request.",
  previousBody: "Previous description",
  reworkFailed: (attempt, max, reason) => `Rework attempt ${attempt} (of at most ${max}) pushed nothing, and it counts: ${reason}`,
  // commit
  defaultTitle: (n) => `Work on #${n}`,
  reworkTitle: (attempt, textOnly) => (textOnly ? `Rewrite the description and evidence after review (rework ${attempt}, no code change)` : `Address review feedback (rework ${attempt})`),
  mergeTitle: (base, branch) => `Merge ${base} into ${branch}`,
  commitNote: "Written by the pipeline executor; the evidence is in the pull request description.",
  // feedback for a rework prompt
  fb: {
    review: (verdict) => `## Reviewer verdict on this head: ${verdict}`,
    noReview: (sha) => `## Reviewer\n\nThere is no review of this head commit${sha ? ` (the last review was of ${sha.slice(0, 9)})` : ""}.`,
    people: "## Decisions by people",
    checks: "## Failed checks on this head",
    check: (name, result) => `### ${name}: ${result}`,
    noFailed: "## Checks\n\nNo failed check on this head.",
    unreadable: "## Checks\n\nThe checks of this head could not be read.",
    merged: (base) => `## Base branch\n\n${base} was merged into this branch before you started, so the diff against ${base} is the whole pull request.`,
    conflict: (base, files) =>
      `## Merge conflict with ${base} (resolve this first)\n\n${base} was merged into this branch and the merge stopped with conflicts in: ${files.join(", ")}. Those files contain conflict markers. Resolve every one, keeping what both sides meant (in a list such as a changelog that usually means keeping both entries), and make sure the tests still pass. Leave the result in the working tree: do not run \`git merge --abort\`, \`git commit\`, \`git reset\` or \`git checkout\` on these files; the scripts record the merge. Then deal with the rest of the feedback below, if any.`,
  },
}
