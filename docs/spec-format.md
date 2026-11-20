# How to write a spec issue

You talk a feature through, write down what was settled as one issue, and put the work label on it
(`labels.work`, `pipeline` by default). From there the pipeline writes the code, opens the pull
requests, reviews and merges them, one pull request per row of the issue's split table. This page
says how to write that issue.

The format is fixed in 0.1: the section names below are what the scripts look for (upper or lower
case does not matter). Check a draft before you label it:

```bash
coteam-pipeline spec check issue.md
```

## Spec issue or single task?

- **Single task**: an issue with no `## PR split` table. One pull request. Use it for a bug you can
  describe in a sentence or two: say what happens and what you expected. The executor writes a
  failing test first, then fixes it. Nothing on this page is required.
- **Spec issue**: an issue with a `## PR split` table. Use it for anything that needs more than one
  pull request, has a decision in it, or that you want reviewed against written criteria.

Some things the executor is never allowed to change (`risk.forbidden` in `.coteam/pipeline.yml`:
by default CI workflows, the pipeline's own configuration, and instruction files for coding agents).
Do those by hand, in your own pull request, and keep them out of the split table.

## Template

Write "none" in a section that has nothing to say. Do not rename the sections.

```markdown
## Summary

**In one sentence**: what a user will see differently when this is done.
**Background**: how it is today, as a user sees it (not the code).
**Why**: who ran into what, and what happens if nothing changes.
**Options considered**

| | Option | Pros | Cons |
| --- | --- | --- | --- |
| **A (chosen)** | … | … | … |
| B | … | … | … |

**Who decided**: who, when, in which discussion; and which details the writer of this issue settled alone.
**If it goes wrong**: the worst a user would see, and how to get back to today's behaviour.
**How to verify**: where to go, what to click, what you should see.

## Requirement

Who wants what, and why. Quote the person's own words where you can.

## Acceptance criteria

1. One checkable result per item, with how to check it (which test, which command, what appears on screen).
2. …

## Decisions

1. What was settled in discussion, with the date and who settled it.

## Open questions

none

## Out of scope

1. Things that are tempting to do along the way and are not part of this.

## Current state

1. How the code does it today, with file and line (`src/settings/store.ts:120`, `saveDraft`).

## PR split

| # | What | Where | Depends on | How to verify |
| --- | --- | --- | --- | --- |
| 1 | Server: … | `src/server/…` | none | unit tests for …; criteria 1, 2 |
| 2 | Screen: … | `src/app/settings/…` | 1 | component test …; criterion 3 |
| 3 | Docs: … | `docs/…` | 1, 2, #123 | criterion 4 |

## Risks

1. Where it is easy to get wrong; other issues that touch the same files.
```

## Section by section

### Summary

The brief for humans. It comes first and is written for the person who owns the product and will
open a pull request, or a decision that waits for them, with none of today's context. From this
one section they must be able to tell what this is, why it is being done, and which way was picked.
The pipeline copies it, as written, to the top of **every pull request of the issue**, so write it
once and write it here.

- Plain words throughout. No file names, function names, endpoints or commands, no backticks. Talk
  about what a user sees. Two or three sentences per item; about 4000 characters at most, not
  counting the table.
- The seven items, each starting with its bold label:
  1. **In one sentence**: the visible change.
  2. **Background**: how it is today.
  3. **Why**: who needs it, and what happens if nothing changes.
  4. **Options considered**: a table of option / pros / cons with every option that was really
     compared, and the word "chosen" in the row that was picked. Take the pros and cons from the
     discussion; do not make them up afterwards. If nothing else was compared, write one line
     instead of a table: `**Options considered**: only one option; nothing else was compared.`
  5. **Who decided**: keep apart what the owner decided and what the writer of the issue decided
     alone. Do not present something the owner never commented on as their decision.
  6. **If it goes wrong**: the worst case for a user, and how to roll back. If a rollback does not
     undo everything (data was changed), say so.
  7. **How to verify**: steps a person can follow, and what counts as correct.
- A small change (one pull request, no trade-off) may use the short brief instead, four items:
  **Problem** / **Cause** / **Fix** / **Risk and how to verify**.
- The Summary **is not the spec**. The executor builds from "Acceptance criteria" and "Decisions",
  and the reviewer checks against the same two. A technical requirement that appears only in the
  Summary will not be built. Write it out in full further down.

### Requirement

Who wants what and why, in a short paragraph. Quote the request if you have it.

### Acceptance criteria

This is what the whole pipeline goes by: the executor writes its tests from it, and the reviewer
checks the diff against it item by item. Each item is one sentence that can be judged true or
false, with how to check it. "Feels faster" is not a criterion; "the list opens in under a second
with 1000 entries (test `opens_large_list`)" is. Number the items so the split table can refer to
them. There is no length limit to worry about: the criteria are passed on in full.

### Decisions

What people settled, with date and name. The executor follows these and does not swap in another
approach; the reviewer rejects a pull request that departs from them, even for something that
looks better.

### Open questions

**Must be empty (or "none") before work starts.** While anything is listed here, nothing is
dispatched. Take the question back to whoever can answer it, then move the answer to "Decisions".

### Out of scope

What will not be done this time. The executor leaves these alone; the reviewer rejects a pull
request that does them anyway.

### Current state

How the code works today, with files and lines, written after actually reading the code. If it is
wrong, the executor goes by the code and says so, but it costs time.

### PR split

One row is one pull request.

- Keep a row small: one layer of the work (server, client, screen, documentation) and a diff of a
  few hundred lines. The executor has a fixed time budget per run (`limits.executor_minutes`).
- **`#`**: whole numbers starting at 1. **Never renumber once work has started**; progress is
  recorded by row number. To add work, add rows at the end.
- **What**: what this row delivers.
- **Where**: the main paths, each in backticks. None of them may be a forbidden path.
- **Depends on**: what must be merged before this row starts. Only these are allowed:
  - row numbers of this table: `1` or `1, 2`
  - another issue or pull request: `#123` (done when the issue is closed or the pull request merged)
  - `none` (a single `-` also means none)

  Anything else belongs in "Risks". **Do not write a range.** `1-3`, `1~3`, `1..3` and `1 to 3` are
  all refused; write `1, 2, 3`. (A range was once silently read as "rows 1 and 3".) A row may not
  depend on itself, on a row that does not exist, or on a cycle.
- **How to verify**: the tests or steps for this row and the acceptance criteria it covers.
- Order of work: one row of an issue at a time. When a row's pull request is merged, the next row
  is the first one, top to bottom, whose dependencies are all merged. Later rows are built on top
  of earlier ones.
- Rows that touch high-risk paths (`risk.level3`: sign-in, data migrations and the like) are only
  opened as drafts and wait for the owner. Give such work its own row and put it late.

### Risks

Where the work is easy to get wrong, and anything else the executor should know that fits nowhere
above.

## After you label it

- **Progress** is on the issue: a comment for every merged row, and the issue is closed when all
  rows are merged.
- **The executor says a row cannot be done** (spec and code do not fit, it does not fit in one pull
  request), or a row keeps failing: you get a decision item. Edit the issue, then answer the item.
- **To stop**: remove the work label. Open pull requests stay as they are; close them yourself.
- **You do not want a row's pull request**: close it. That row stops and is **not redone
  automatically**; rows that depend on it wait, the others carry on. To have it done again from the
  latest base branch, put the redo label (`labels.redo`, `pipeline:redo` by default) on the closed
  pull request. If you want it done differently, change the spec first.

## What the check looks at

`spec check` reports every problem at once:

- the split table can be read: header with `#`, `What` and `Depends on`; positive, unique row
  numbers; dependencies that exist; no ranges; no cycles
- "Acceptance criteria" is not empty and "Open questions" is empty
- "Summary" is there, has all its items, marks the chosen option, has no code in it and is not too long
- "Requirement", "Decisions", "Out of scope" and "Current state" are there ("none" is fine)
- no row's "Where" names a forbidden path

The first two groups also hold at dispatch time: an issue that fails them is not worked on, and the
reason is shown instead of a guess.
