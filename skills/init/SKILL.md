---
description: Install coteam-pipeline in the current repository. Reads the codebase, writes the config and the three workflows, creates the GitHub App that acts as the bot, opens the installation pull request and runs the doctor. Use when the user asks to install or set up coteam-pipeline here.
disable-model-invocation: true
argument-hint: "[anything you already know: owners, budget, risky paths]"
---

# Install coteam-pipeline in this repository

You are installing coteam-pipeline for the person you are talking to, in the repository of
the current directory. They may have said something up front: $ARGUMENTS

## What you are installing

coteam-pipeline turns a labelled issue into a merged pull request. An executor agent writes
the change, a reviewer agent reviews it and gives it a risk level from 0 to 3, and rules in
`.coteam/pipeline.yml` decide whether it merges without a person, waits for a default, or
waits for an owner. All of it runs in this repository's GitHub Actions, with the person's
own Anthropic API key and a GitHub App they own. Nobody else sees their code or keys.

The person is typically the lead of a small team. They know their product; they may not
know GitHub Apps, workflow triggers or this pipeline's vocabulary. Explain each step in a
sentence before you take it, in plain words, and say what they will see.

The installation ends with the pipeline in `record` mode: it opens and reviews pull
requests but merges nothing. The person switches it on themselves, later, after watching it.

## Rules for the whole installation

- Never ask for, print or read a key or a secret's value. The App's private key never
  leaves the `init app` command, and the person types the Anthropic key into their own
  terminal. If they paste a key into the chat anyway, do not repeat it, do not use it, and
  tell them to revoke it and make a new one.
- Never write `mode: on`, and never merge the installation pull request. Both are the
  person's decisions.
- Never weaken `risk.forbidden`. The workflows and `.coteam/` stay in it.
- Ask before each step that creates something on GitHub: the App, the pull request, the
  first issue. Labelling the first issue starts spending their money. The labels of step 7
  are the exception: say that the doctor will create them, and run it.
- Commit only the four files this installation writes, staged by name, on a new branch.
  Leave everything else in the working tree alone.
- When a step fails, show the person the message and what it means. Do not work around a
  refusal (missing admin rights, an organisation policy) by another route.

## The engine's commands

The mechanical steps are commands of the engine, which ships inside this plugin:

```sh
node "${CLAUDE_PLUGIN_ROOT}/cli/main.mjs" init scan
```

Below, `init <step>` and `doctor` are short for that command line with other arguments.
They need Node 20 or newer, `git`, and the `gh` command line tool logged in as the person.
The reference documents are `${CLAUDE_PLUGIN_ROOT}/docs/install.md` (the same installation
by hand, the threat model, the known limits) and `${CLAUDE_PLUGIN_ROOT}/docs/spec-format.md`.
Read `docs/install.md` once before you start: the person will ask about what it covers.

## Step 1. Look at the repository

Run `init scan`. It prints JSON: the repository on GitHub, what the person's login may do
there, the likely install, test and lint commands, the repository's own CI workflows, how
many test files there are, paths whose names suggest a mistake there is expensive, and
which of the four files already exist.

Then check the proposals against the truth. The commands the CI workflow runs are the
truth: read the workflow files under `.github/workflows/`, the README and the manifest
(`package.json` or its equivalent). Where the scan and the CI disagree, the CI wins.

Stop and explain, instead of continuing, when:

- `repo` is empty: the code is not on GitHub, and the pipeline only runs there.
- `github.admin` is false: storing secrets needs an admin. Someone who is one has to run this.
- `github.actions_enabled` is false: the pipeline is GitHub Actions workflows.
- `private_registry` is true and the project cannot install without that registry: the
  agent is given no registry token in this version (see "Known limits" in `docs/install.md`).
- `installed` is not empty: the pipeline is already (partly) installed. Ask whether they
  want to repair that installation; if so run the doctor (step 7) and fix what it reports.

Tell the person what you found, honestly. Two findings need saying in so many words:

- **Few or no tests** (`tests.test_files` is small against `tests.source_files`, or there is
  no test command). The executor proves its work with tests and the reviewer rejects a
  change that has none. With few tests the pipeline still works, but nothing catches a
  change that breaks something old. Say so, and suggest their first issues be "add tests
  for X".
- **No CI on pull requests** (no entry of `ci` with `pull_request: true`). Then the review
  is the only thing between the agent and a merge. Suggest adding a workflow that runs the
  tests on pull requests before the pipeline is ever switched on. Offer to write it as a
  separate pull request; it is not part of this installation.

## Step 2. Ask what only the person knows

Ask these together, with your proposed answer for each, and take "fine" for an answer.
Skip any that $ARGUMENTS already settled.

1. **Owners**: the GitHub logins whose answers count when the pipeline asks a question and
   who may release a level-3 pull request. Propose the person's own login (`gh api user --jq .login`).
2. **Level-3 paths**: where a mistake is expensive (login and sessions, payments,
   database migrations, secrets). A change touching them is only ever opened as a draft
   and waits for an owner. Propose globs from `risky_paths` and from what you read; ask
   what you missed. Prefer one directory glob (`src/auth/**`) to many file names.
3. **Daily spending limit** for the model, in US dollars. The starter says 30; a first
   week rarely needs more than 10. A single small change costs well under a dollar.
4. **Merge method**: squash, merge or rebase, from the ones `github.merge_methods` allows.
   The starter says squash.

Do not ask about the mode. It is `record`.

## Step 3. Write the files

Run `init files --ci "<names>"`, where the names are the `name` of every entry of `ci`
that has `pull_request: true`, separated by commas. This is what lets the pipeline notice
that CI went green on a pull request without waiting for its half-hourly schedule. Leave
`--ci` out when there is no such workflow.

It writes `.coteam/pipeline.yml` and the three workflows under `.github/workflows/`, with
the engine pinned to a release or to a commit. It does not overwrite a file that exists.
Do not edit the three workflow files.

Then edit `.coteam/pipeline.yml`. Every key is explained in the file; keep those comments.
Set:

- `stack.setup`, `stack.test`, `stack.check`: from step 1. They run on a GitHub-hosted
  Ubuntu runner with Node 22, in a fresh checkout, without any token. If the project needs
  a tool the runner lacks, its installation goes into `stack.setup`.
- `stack.ui_paths`: globs of the files that change what users see (from `ui_paths` and
  what you read). An empty list is right for a project without a user interface.
- `owners`, `risk.level3`, `limits.daily_usd`, `merge.method`: from step 2.
- `risk.forbidden`: add the agent instruction files the scan found (`agent_instructions`)
  if they are not listed. Remove nothing.

Leave everything else as the starter has it, unless the person asked for something.

Run `init check` and fix what it reports until nothing is marked `FAIL`. Read out the
warnings that remain and what each means.

## Step 4. Create the bot

The pipeline acts as a GitHub App that the person creates and holds the only key of. Say
why in one sentence: a pull request opened with the workflow's built-in token does not
start their CI, and a personal token would make the bot's work look like a person's.

Tell the person what is about to happen, then run `init app` **in the background** (it
waits up to ten minutes for their clicks) and watch its output:

1. It prints a local address and opens it in their browser. The page forwards to GitHub,
   which shows "Create GitHub App for <account>" with the name and permissions filled in.
   They press the green button. (If the name is taken, GitHub lets them change it there.)
2. GitHub hands the App's private key to the command, which stores it as the repository
   secret `PIPELINE_APP_KEY` and the App's id and login as the variables `PIPELINE_APP_ID`
   and `PIPELINE_BOT`. The key is not shown and not saved to a file.
3. The browser lands on the App's installation page. They choose **Only select
   repositories**, pick this repository, press **Install**.
4. The command sees the installation and confirms the App has the access the pipeline needs.

Relay the address as soon as the command prints it, in case no browser opened. When the
command ends, tell the person what its last lines say.

If the person's browser is on another machine than this session (an SSH or remote
session), the local address cannot be reached from it. Then the App is made by hand:
walk them through steps 1 to 3 of `docs/install.md`, one click at a time.

If `init app` says an App is already set up, ask before passing `--force`: the old App's
key would be replaced.

## Step 5. The model key

The person stores their Anthropic API key themselves, in their own terminal, not through
you. Give them the line, with the repository filled in:

```sh
gh secret set ANTHROPIC_API_KEY --repo OWNER/REPO
```

It asks for the value and shows nothing. Recommend a key made only for the pipeline, with
a spend limit set in the Anthropic console as a second brake. Wait until they say it is
done, then confirm the secret exists by name: `gh secret list --repo OWNER/REPO`.

Two other ways, if the person asks or has no API key (offer them, do not push them):

- **A Claude subscription**: they run `claude setup-token` on their own machine and store
  the result with `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo OWNER/REPO` instead. Tell
  them that an API key, if one is also set, is used first, that the subscription's terms
  are theirs to check, and that `limits.daily_runs` caps the runs a day.
- **A machine of their own for the agent's job**: point them to "Run the agent on your
  own machine" in `docs/install.md`. They register the runner and run
  `doctor --runner --try` on it themselves; you do not log in to their machine. Say that
  the engine refuses it for a public repository unless `self_hosted.allow_public` is set,
  and why.

## Step 6. Open the installation pull request

Create a branch (`coteam-pipeline/install`), stage the four files by name, commit, push,
and open a pull request against the base branch. In its description say, briefly:

- what each of the four files is for;
- that the pipeline starts in `record` mode and merges nothing;
- the choices made in step 2, so a teammate can disagree with them;
- that nothing happens until an issue gets the label `pipeline`.

If the push is refused because the token lacks the `workflow` scope, the person runs
`gh auth refresh -h github.com -s workflow` and you push again.

Do not merge it. Ask the person to read it and merge it, and to tell you when it is merged.
The workflows only work once they are on the default branch.

## Step 7. Run the doctor

After the merge:

```sh
GITHUB_REPOSITORY=OWNER/REPO PIPELINE_TOKEN="$(gh auth token)" node "${CLAUDE_PLUGIN_ROOT}/cli/main.mjs" doctor --fix
```

It reads the installation on the base branch and prints one line per check; `--fix`
creates the labels that are missing and changes nothing else. Fix everything marked
`FAIL` and run it again. Explain each `warn`. A `skip` means the token was not allowed to
look; say where the person can look themselves.

## Step 8. The first issue

Help the person pick something small and real for the first run: a bug with a clear
reproduction, a missing test, a small visible change. Not a refactoring, and nothing under
the level-3 paths. Draft an ordinary issue with them that says what is wrong or missing,
what should happen instead, and how one can tell it is done. Larger work goes in a spec
issue, one pull request per row of its table; the format is in `docs/spec-format.md`, and
`spec check <file>` checks a draft.

Ask before you create the issue and before you put the label `pipeline` on it: the label
is what starts the work and the spending.

Then tell them what to watch, in this order: under **Actions**, a `pipeline-tick` run
within a minute, then `pipeline-fix #<issue>`, then a pull request from a `pipeline/...`
branch, then `pipeline-review PR #<number>`; on the pull request, the description, the
review comment with its risk level, and their own CI. In `record` mode they merge it
themselves.

## Finish

End with a short account, in this order:

1. What now exists: the App (name and where to find it), the secrets and variables by
   name, the merged pull request, the labels, the first issue if one was created.
2. What you did not verify, plainly. A doctor line that said `skip` or `warn` belongs here.
3. How to stop everything at once: set `mode: off`, or disable the three workflows.
4. When to switch on: after about a week of pull requests in which the pipeline asked for
   nothing it should not have and missed nothing it should have asked, they change `mode`
   to `on` themselves and run the doctor again. Recommend protecting the base branch first
   (required pull requests, their CI checks, and the status `pipeline/review`).
5. What to read before pointing it at a repository where strangers can write issues: the
   threat model in `docs/install.md`. The agent's job never holds the bot's key, but it holds the
   model key and a copy of the code, and it is not a sandbox.
