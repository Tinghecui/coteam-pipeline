# Installing the pipeline by hand

> **Status: `v0.2.0` is the current release, and it is young.** The engine has run end to
> end on a small demonstration repository, and the installer once from an empty start.
> Expect corrections.

**The quick way** is the installer skill for Claude Code, which does everything below for
you and asks where a person has to decide. In a checkout of your repository:

```text
/plugin marketplace add Tinghecui/coteam-pipeline
/plugin install coteam-pipeline@coteam-pipeline
/coteam-pipeline:init
```

Its mechanical steps are commands you can also run yourself (`node cli/main.mjs init`
lists them): `init scan` reports what it finds in a checkout, `init files` writes the
three workflows and the starter config with the engine pinned, `init check` checks those
files before they are merged, and `init app` creates the GitHub App of step 1 in your
browser with the right permissions and stores its key and id (steps 1 to 3) without the
key ever being shown or saved to a file.

The rest of this page is the installation by hand, step by step. It should take about
half an hour. At the end the pipeline runs in **record** mode: it writes code, opens pull
requests and reviews them, but merges nothing.

Everything runs in your own repository's GitHub Actions, with your own Anthropic API key and
your own GitHub App. The engine has no server and its authors see nothing of yours.

You need:

- a repository on GitHub where you are an admin, with GitHub Actions enabled;
- tests that can be run with one command, and ideally a CI workflow that runs them on pull requests;
- an Anthropic API key;
- the `gh` command line tool, logged in (`gh auth status`), for the commands below.

In the commands, `ORG/REPO` is your repository, and `Tinghecui/coteam-pipeline@v0.2.0` stands
for the engine repository and the release you install.

## 1. Create the GitHub App (the bot's identity)

The pipeline acts as a GitHub App that you create and that only you hold the key of. An App
is used instead of the workflow's built-in token because a pull request opened with the
built-in token does not start your CI, and instead of a personal token because the bot's
work should be told apart from a person's.

Go to **Settings > Developer settings > GitHub Apps > New GitHub App** (for an organisation:
the organisation's settings, same path).

- **Name**: anything, e.g. `acme-pipeline`. The bot will comment as `acme-pipeline[bot]`.
- **Homepage URL**: your repository's URL (it is not used).
- **Webhook**: untick **Active**. The App receives no events.
- **Where can this GitHub App be installed?**: Only on this account.
- **Repository permissions**: exactly the following, everything else **No access**.

| Permission | Access | Why |
|---|---|---|
| Metadata | Read-only | Mandatory for every App; GitHub selects it for you. |
| Contents | Read and write | Push the work branches (`pipeline/...`), keep the ledger on the branch `pipeline/ledger`, read the config from the base branch, and merge pull requests (merging is a write to contents). |
| Issues | Read and write | Read the issues you hand over and their comments, write progress marks, open and close decision items, add and remove labels. |
| Pull requests | Read and write | Open pull requests, comment on them, label them with their level, mark drafts ready, close and merge them. |
| Commit statuses | Read and write | Post the review verdict as the commit status `pipeline/review`, and read the statuses your CI posts. |
| Checks | Read-only | Read the check runs of your CI on a pull request before merging. The pipeline creates no check runs. |
| Actions | Read and write | Start the executor and the reviewer (`workflow_dispatch` needs write) and see which runs are going. |
| Workflows | No access | Deliberately not granted: without it GitHub refuses any push from the bot that changes a file under `.github/workflows/`, whatever else went wrong. |

  No organisation permissions, no account permissions, no event subscriptions. In
  particular the App gets no access to **Secrets**, **Variables**, **Administration** or
  **Environments**.

Create the App, then on its page:

1. Note the **App ID** (a number).
2. **Generate a private key**. A `.pem` file is downloaded. It is the bot's password: keep
   it out of the repository and delete the file once it is stored as a secret (step 3).

## 2. Install the App on the repository

On the App's page: **Install App**, choose your account, **Only select repositories**, pick
the one repository. The token the engine mints is limited to the repository it runs in
even if you later install the App on more.

## 3. Add the secrets and variables

```sh
gh secret set PIPELINE_APP_KEY --repo ORG/REPO < path/to/the-key.pem
gh secret set ANTHROPIC_API_KEY --repo ORG/REPO          # paste the key when asked
gh variable set PIPELINE_APP_ID --repo ORG/REPO --body 123456
gh variable set PIPELINE_BOT --repo ORG/REPO --body "acme-pipeline[bot]"   # optional, see below
```

| Name | Kind | What it is |
|---|---|---|
| `PIPELINE_APP_KEY` | secret | The App's private key, the whole PEM file. |
| `ANTHROPIC_API_KEY` | secret | Your Anthropic API key. It is the only credential the agent is given. Set a spend limit on it in the Anthropic console as a second brake. |
| `PIPELINE_APP_ID` | variable | The App ID from step 1. |
| `PIPELINE_BOT` | variable, optional | The login the App writes as: `<app-slug>[bot]`, where the slug is the last part of the App's public page, `github.com/apps/<app-slug>`. Used for one thing: `pipeline-tick.yml` skips the events caused by the bot's own comments and labels, which would otherwise each start a dispatcher round that finds nothing to do. |

The pipeline keeps its state in hidden marks inside comments, and believes a mark only when
its own login wrote it. It does not need `PIPELINE_BOT` for that: the engine asks GitHub
for the App's login itself, with the App's key, every time it starts. If the variable names
other logins (separated by commas), marks written by them are believed as well; that is
only useful when the repository's history holds marks from an earlier bot account. A
mistyped value costs some runner minutes and nothing else; the doctor compares it with the
App's real login when it is run with the App's key (step 6).

Do not store deploy keys, cloud credentials or package registry tokens under names the
pipeline workflows read; they read only the four names above.

## 4. Copy the three workflows and the config

From the engine repository, at the release you install:

| Copy | To |
|---|---|
| `templates/workflows/pipeline-tick.yml` | `.github/workflows/pipeline-tick.yml` |
| `templates/workflows/pipeline-fix.yml` | `.github/workflows/pipeline-fix.yml` |
| `templates/workflows/pipeline-review.yml` | `.github/workflows/pipeline-review.yml` |
| `templates/pipeline.yml` | `.coteam/pipeline.yml` |

Keep the file names: the engine starts the workflows by these names.

In each workflow, replace `Tinghecui/coteam-pipeline` with the engine repository and `v0.2.0`
with the release, in **both** places (`uses: ...@v0.2.0` and `engine_ref: v0.2.0`). The two
must be equal: the first picks the workflow, the second the code it runs. Use a release tag
or a full commit SHA, not a branch, so that the pipeline changes only when you change it.

In `pipeline-tick.yml`, add the `name:` of your own CI workflows to the `workflow_run` list:

```yaml
  workflow_run:
    workflows: ["pipeline-fix", "pipeline-review", "CI"]
```

GitHub does not send a `check_suite` event when its own Actions runs finish, so without
this line a pull request whose CI just went green waits for the half-hourly schedule before
the pipeline looks at it again. CI that runs outside GitHub Actions needs nothing here.

In `.coteam/pipeline.yml`, every field is explained in the file. Set at least:

- `base`: your default branch;
- `stack.setup`, `stack.test`, `stack.check`: how to install, test and lint your project;
- `owners`: the GitHub logins who answer the pipeline's questions;
- `risk.level3`: the paths where a mistake is expensive (login, payments, migrations, secrets);
- leave `mode: record`.

Commit the four files to the default branch (through a pull request if the branch is
protected). Scheduled, `workflow_run` and `workflow_dispatch` triggers only work for
workflow files on the default branch, and the config is only ever read from the base branch.

If Actions for the repository is limited to selected actions and reusable workflows
(**Settings > Actions > General**), allow `Tinghecui/coteam-pipeline/*`, `actions/checkout@*`
and `actions/setup-node@*`.

## 5. Create the labels

```sh
gh label create 'pipeline'          --repo ORG/REPO --color 1d76db --description 'Hand this issue to the pipeline'
gh label create 'pipeline:decide'   --repo ORG/REPO --color d93f0b --description 'A decision the pipeline needs from an owner'
gh label create 'pipeline:approved' --repo ORG/REPO --color 0e8a16 --description 'An owner released this pull request'
gh label create 'pipeline:redo'     --repo ORG/REPO --color 5319e7 --description "Do the closed pull request's work again"
gh label create 'pipeline:followup' --repo ORG/REPO --color c5def5 --description 'Noted in a review, not blocking'
gh label create 'level:0' --repo ORG/REPO --color 0e8a16 --description 'Risk level 0'
gh label create 'level:1' --repo ORG/REPO --color fbca04 --description 'Risk level 1'
gh label create 'level:2' --repo ORG/REPO --color d93f0b --description 'Risk level 2'
gh label create 'level:3' --repo ORG/REPO --color b60205 --description 'Risk level 3'
```

If you renamed labels in the config, the doctor (next step) prints the lines for your names.

## 6. Run the doctor

The doctor checks the installation and prints one line per check with what to do about it.
Run it on your machine, in a checkout of your repository, with a checkout of the engine next to it:

```sh
git clone --depth 1 --branch v0.2.0 https://github.com/Tinghecui/coteam-pipeline ../coteam-pipeline
GITHUB_REPOSITORY=ORG/REPO PIPELINE_TOKEN="$(gh auth token)" node ../coteam-pipeline/cli/main.mjs doctor
```

The doctor reads the repository through the GitHub API and fetches the config from the
base branch; it changes nothing, except that `doctor --fix` creates the labels that are
missing. A config that is missing or does not load is reported like any other problem.

With your own login as the token, the doctor can see the labels, the workflows, the names
of the secrets and variables (never the value of a secret), your CI and the branch
protection. What it cannot see from there is whether the *App* has the right permissions.
To check those exactly, run it once as the App, before you delete the key file:

```sh
GITHUB_REPOSITORY=ORG/REPO PIPELINE_APP_ID=123456 PIPELINE_APP_KEY="$(cat path/to/the-key.pem)" \
  node ../coteam-pipeline/cli/main.mjs doctor
```

GitHub then tells the engine what the App's token may do, and the doctor compares that
with the table in step 1 (a permission that is missing fails; `Workflows`, `Secrets` or
`Administration` granted by mistake is a warning). As the App it usually cannot list
secrets and variables; those lines then say "cannot check".

Fix every `FAIL`. A `warn` is worth reading; `skip` means the token was not allowed to
look, and tells you where to look yourself.

## 7. Write the first issue

Pick something small and real: a bug with a clear reproduction, or a missing test. Write an
ordinary issue that says what is wrong, what should happen instead, and how one can tell it
is fixed. Then put the label `pipeline` on it.

Only people who can label issues can hand work to the pipeline, and that is the point: an
issue written by a stranger is not given to the agent until one of you labels it. Read an
outsider's issue before you label it; its text becomes instructions to the agent.

If one of you would rather do a labelled issue yourself, open your own pull request and
write `Fixes #<issue>` in its description (or title). While that pull request is open the
pipeline leaves the issue alone: no run, no comment; the `pipeline-tick` log says so in one
line per round. If you close it without merging, the pipeline takes the issue up again.

Larger work goes in a spec issue with a PR split table, one pull request per row. The
format is in [spec-format.md](spec-format.md); check a draft with
`node ../coteam-pipeline/cli/main.mjs spec check draft.md`.

## 8. Run in `record` first

In record mode the pipeline does everything except merge and take decisions for you.
Within a minute of the label, **Actions** shows a `pipeline-tick` run, then
`pipeline-fix #<issue>`, then a pull request from a `pipeline/...` branch, then
`pipeline-review PR #<number>`.

Look at these before you trust it:

- **The pull request's description**: is the summary true, and does the "not run or not
  verified" section admit what was not checked?
- **The evidence**: the new test failing before the change and passing after it.
- **The review comment**: its verdict and its risk level. Would you have assigned the same
  level? If a risky path came out as level 0 or 1, add it to `risk.level3` or `risk.level2`.
- **Your CI on the pull request**: it must have started (it does when the App opened the
  pull request) and it must be green.
- **The `pipeline-tick` log**: in record mode it prints "skipped: merge PR #n (mode is
  "record")" for every merge it would have made. Would you have merged each of those?
- **The cost**: the ledger (`ledger.jsonl` on the branch `pipeline/ledger`) has one line
  per run with turns and dollars. Compare with `limits.issue_max_usd` and `limits.daily_usd`.
- **Decision items**: issues labelled `pipeline:decide`. Answer with the option's letter
  (`A`, or `B: do it this way`) and see that the answer is applied.
  A question about a pull request stays in one item across reworks: when new commits
  raise the same kind of question, the item is rewritten for them and says so in a comment,
  and answers given before that comment do not count.

Merge the pull requests yourself for now. When a week of them needed nothing from you
that the pipeline did not already ask, switch on:

```yaml
mode: on
```

and run the doctor again. It warns if the repository has no CI checks at all: then the
review would be the only thing between the agent and your base branch.

Recommended at that point: protect the base branch, require pull requests, and require your
CI checks plus the status `pipeline/review`. If the rule requires approving reviews from
people, the bot cannot merge by itself; either leave that requirement out or add the App to
the rule's bypass list. The ledger branch `pipeline/ledger` must stay pushable by the App.

**How late things can be.** The pipeline moves when GitHub sends it an event (a label, a
comment, a finished run) and otherwise twice an hour, on a schedule. Things that happen by
the clock alone, such as a level-2 question taking its default after
`merge.default_after_hours`, happen at the first scheduled round after their time. GitHub
does not promise scheduled runs: under load it starts them late and sometimes drops one,
so "after 24 hours" can mean 24 hours and half an hour, occasionally an hour more. Nothing
is lost when a round is dropped; the next one reads the whole state again. To run a round
now, start `pipeline-tick` by hand from the Actions tab.

**When the daily budget is used up** (`limits.daily_usd`), nothing new starts until
midnight UTC. The pipeline says so once a day, in a comment on each issue or pull request
that is waiting, so that waiting does not look like a pipeline that stopped.

To stop everything at once, set `mode: off`, or disable the three workflows in the Actions tab.

## What runs where and what it can access

The executor and the reviewer each run as **three jobs on three separate runners**. The
job that runs the agent never holds the bot's key, and the jobs that hold the bot's key
never run the agent or any code from your repository. (This came with `v0.2.0`: `v0.1.0`
still runs each of them as one job. See "Known gaps" below for what that means.)

| What | Where it runs | What it holds |
|---|---|---|
| Dispatcher (`pipeline-tick`) | A GitHub-hosted runner in your repository's Actions | The App key. No model key. Never runs the agent and never checks out a pull request's code. |
| Executor and reviewer, job 1: `prepare` | Its own runner | The App key. No model key. Reads the issue and the pull request, decides whether the run may start, writes the work order (the prompt, the commits to start from). Runs the engine and git; nothing from your repository is executed. |
| Executor and reviewer, job 2: the agent | Its own runner | The Anthropic key, and the workflow's built-in token limited to reading this repository's contents (that is how it fetches the code). **No App key**: this job has nothing it could push, comment or merge with. Runs `stack.setup`, the agent and `stack.check`. |
| Executor and reviewer, job 3: `publish` | Its own runner | The App key. No model key. Takes what job 2 left, checks it, and writes to GitHub. Runs the engine and git; never the agent, never your code. |
| The engine's code | Checked out from the engine repository at the ref you pinned | Nothing of its own. No server, no telemetry. |

- **What crosses from the agent's job to the publishing job** is two files, and the
  publishing job treats both as written by a stranger:
  - for the executor, a git bundle. Only the *tree* (the files) is taken from it. The
    commit, its parents, its author and its message are made by the publishing job; the
    changed paths are read from that tree there, and the forbidden paths are checked there.
    Nothing from the bundle is checked out or run.
  - a small JSON result (the agent's summary, the usage figures, or why it stopped). It is
    cut down to the known fields, validated against the schema, and its text can not write
    one of the pipeline's hidden marks.
  For the reviewer there is no bundle, only the reviewer's structured output; the risk
  level by path, the list of changed paths and the base commit are measured by job 1.
- **The work order** goes from job 1 to job 3 as a file that the agent's runner could have
  replaced. Job 1 reports the file's SHA-256 through its job outputs, which other jobs
  cannot change, and job 3 refuses an order that does not match.
- **The built-in `GITHUB_TOKEN`** has `contents: read` in all three workflows. It checks
  out your repository and the engine, and in the agent's job the engine fetches the code
  with it. It cannot write anywhere.
- **Inside the agent's job** the engine still removes every `GITHUB_*`, `ACTIONS_*`, `GH_*`
  and `PIPELINE_*` variable, and anything named like a secret, from the agent's
  environment and from the shell commands of your config (`stack.setup`, `stack.check`).
  The job is **not a sandbox**: the agent can do there whatever your own test suite could.
  What that leaves open is in [Threat model and known gaps](#threat-model-and-known-gaps)
  below. Read it before you point the pipeline at a repository where strangers can write
  issues.
- **Text from issues and comments never reaches a shell.** The workflows pass only numbers
  to the engine, through environment variables, and the engine rejects anything that is not
  a whole number. Issue text goes to the agent inside the prompt, marked as untrusted.
- **Who can start work**: people who can label issues (triage access and up). **Who can
  answer decisions and release level-3 pull requests**: the `owners` in the config, or the
  repository's admins and maintainers if that list is empty.
- **What the agent cannot change**: the paths in `risk.forbidden` (by default the
  workflows, `.coteam/` and the agent instruction files). A change that touches them is
  refused by the publishing job before anything is pushed, and the App has no Workflows
  permission as a second lock.
- **Pull requests from forks** are ignored by all three workflows.
- **Where your code goes**: to Anthropic's API, as part of the agent's work, under your API
  key and your agreement with Anthropic. Between the jobs, the work order (issue text and
  the prompt) and the result (the change) are stored for one day as artifacts of the
  workflow run, readable by whoever can read the repository's Actions. Nowhere else.
- **Third-party actions**: only `actions/checkout`, `actions/setup-node`,
  `actions/upload-artifact` and `actions/download-artifact`, referenced by major version.
  To pin them, and the engine, by commit SHA, fork the engine repository, pin them in its
  three reusable workflows, and point your callers (and `engine_repository`) at the fork.
  The Claude Code CLI is installed from npm at the exact version given by the
  `claude_code_version` input, in the agent's job only.

## Threat model and known gaps

Read this as a statement of design, not of experience: the pipeline has run on one
demonstration repository, and nobody has tried to attack it.

**What is assumed.** The agent reads text that an attacker may have written: an issue, a
comment, a file in the repository, the output of a test. Such text can talk the agent into
doing something else than the task (prompt injection). So the agent is treated as code that
may turn hostile in the middle of a run, and so is **the whole runner it ran on**: on
GitHub-hosted runners the job's user has passwordless `sudo`, so anything on that machine
(the engine's files, its memory, `git`, `node`) may have been read or replaced by the time
the job ends. The people who can label issues, the `owners`, the repository's admins, the
engine at the ref you pinned, GitHub and Anthropic are trusted.

**What the pipeline has to protect.**

1. The App's private key (`PIPELINE_APP_KEY`) and the tokens made from it. They can push
   to branches of this repository, comment, label, open, close and merge pull requests, set
   commit statuses (including the pipeline's own `pipeline/review`) and start workflows.
2. The model key (`ANTHROPIC_API_KEY`).
3. The base branch: nothing should reach it that was not reviewed.

**What is in place.**

- *Only issues your team labelled are worked on.* A stranger's issue is not given to the
  agent until someone with triage access puts the work label on it. Comments by strangers
  are never taken as answers to decisions, and marks in comments are believed only from the
  pipeline's own login.
- *The bot's key is never on a machine the agent has touched.* The agent runs in a job of
  its own that holds no GitHub credential at all beyond a token that can read this
  repository's contents. The App key is given to two other jobs, on other runners, which
  never run the agent, never install its CLI and never execute anything from the
  repository. A job cannot read another job's secrets or memory.
- *The publishing job believes nothing the agent's job says.* It takes a git tree and a
  few fields of text. It makes the commit itself, with the parents the work order names;
  it rebuilds the tree through git's index, which refuses a tree no checkout may contain
  (a `.git` directory in it, a malformed tree); it reads the changed paths from the tree
  and applies the forbidden paths and the risk levels to them; it validates the structured output against the schema; it never checks
  the tree out, so no file of the change exists on that runner, let alone runs. A result
  that is missing or malformed ends the run as failed.
- *The work order cannot be swapped.* Its SHA-256 travels through the job outputs of the
  job that wrote it.
- *The agent's environment is scrubbed*, inside its own job as well: no `GITHUB_*`,
  `ACTIONS_*`, `GH_*`, `PIPELINE_*` variable and nothing named like a secret reaches the
  agent or the `stack.*` commands.
- *No token on a command line, in git's config or left on disk.* Tokens reach `git`
  through the environment of that child process only; the checkouts are made with
  `persist-credentials: false`.
- *A deny list in the agent's tools.* `git push`, `git commit`, `gh`, `curl`, `wget` and
  web access are refused by name. This stops accidents, not an attacker: any interpreter on
  the runner can open a network connection.
- *The bot key is scoped.* The App is installed on one repository, every token is minted
  for that repository only, and the App has no **Workflows**, **Secrets** or
  **Administration** permission: even with the key, workflow files cannot be changed and
  secrets cannot be read.
- *Forbidden paths.* A change that touches `risk.forbidden` (by default the workflows,
  `.coteam/` and the agent instruction files) is refused before anything is pushed. The
  config is always read from the base branch, never from a pull request.
- *Review and CI before a merge.* A second agent with read-only tools reviews the pull
  request; the paths decide the lowest risk level and the reviewer can only raise it; with
  `mode: on` nothing merges while a check of your CI has failed or is still running. The
  pipeline's own jobs are not counted as CI.

**Known gaps.**

- **The agent holds the model key, by necessity**, and the runner has network access. An
  agent that was talked into it can send the key anywhere. Use a key that is only for the
  pipeline, set a spend limit on it, and rotate it if a run looks wrong.
- **The agent's job can read your code and send it anywhere.** It has the checkout and a
  network. On a private repository, a successful prompt injection can leak the source.
- **What the agent's job reports about itself cannot be checked.** That the checks of
  `stack.check` passed, how many turns the agent took and what the run cost are its own
  word. So: your CI on the pull request is the test run that counts, not the executor's;
  and a hostile run could under-report its cost to the pipeline's budget. The spend limit
  on the key at Anthropic does not depend on the pipeline's arithmetic.
- **The reviewer reads what the executor wrote.** The pull request's text and code are
  input to the reviewing agent and can try to talk it into approving. The path levels, your
  CI and (if you set them up) branch protection rules do not depend on the reviewer's opinion.
- **The agent's job shares what every job of a workflow run shares.** It can replace the
  run's artifacts (which is why the order is checked by digest and the result is treated
  as hostile) and it can write to the repository's Actions cache from a run on the base
  branch. If your own CI restores caches, a hostile run could plant one. The pipeline's
  own jobs use no cache.
- **`v0.1.0` does not have the three jobs.** There the agent runs in the same job and as
  the same OS user as the engine, which holds the App key in memory, and that user has
  passwordless `sudo`: an agent that digs for the key can get it. If you installed
  `v0.1.0`, change `v0.1.0` to `v0.2.0` in your three workflow files (twice in each:
  `uses: ...@` and `engine_ref`). Nothing else has to change.
- **A self-hosted runner undoes the separation** if the three jobs land on the same
  machine and that machine is not wiped between jobs. Use GitHub-hosted runners, or
  ephemeral ones. (The lighter alternative to separate jobs, running the agent as a
  separate unprivileged OS user on one machine, was not built: with passwordless `sudo`
  on the hosted runners it would have protected nothing there.)

**What to do with this:**

- On a **public repository**, read an outsider's issue before you label it: its text
  becomes instructions to the agent, which holds your model key and a copy of your code.
- Protect the base branch and require pull requests and your CI checks. Then nothing the
  pipeline pushes reaches the base branch without passing your CI. (A rule that requires
  an approving review from a person goes further, at the price of the bot no longer merging
  by itself.)
- Keep `mode: record` until you have watched the pipeline work, and do not add deploy
  keys, cloud credentials or production access to the pipeline's workflows.
- If a run looks wrong, rotate the Anthropic key. The App key was not on that machine.

## Known limits of 0.1

- **The code must be on GitHub**, and the repository must be allowed to run GitHub
  Actions on GitHub-hosted runners. Tests and deployment can live anywhere.
- **Private dependency registries**: the agent cannot see registry tokens. Secrets are
  kept out of the agent's environment and out of `stack.setup`, so a private npm, PyPI or
  container registry cannot be reached by the commands the pipeline runs. If your project
  cannot install without one, 0.1 is not for it yet.
- **Only Claude Code.** The executor and the reviewer are both the Claude Code CLI with
  your Anthropic API key. No other agent or model vendor, and no second reviewer model.
- **English only.** Spec headings, labels, comments and prompts are English.
- **No acceptance testing yet.** The pipeline stops at the merge. Nothing checks the
  deployed result against the acceptance criteria; that is planned for a later version.
- **Conflicts go back to the agent.** A pull request that conflicts with the
  base branch is sent back to the executor, which resolves the conflict in a merge commit;
  when that does not work the pull request is put in front of an owner.
- **One repository per installation.** Work that spans repositories is not coordinated.
- **Cost**: model usage is billed to your Anthropic key and runner minutes to your GitHub
  plan (private repositories). The limits in the config cap the first, not the second.
- **Base branch = default branch** is the tested setup. Workflow files must be on the
  default branch for their triggers to work, and on `base` to be dispatched.
