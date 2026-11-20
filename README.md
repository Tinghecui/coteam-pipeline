# coteam-pipeline

An issue-to-merge development pipeline for small product teams, run by coding agents inside
the team's own GitHub repository and CI.

You write an issue and put a label on it. An agent writes the change and opens a pull
request, a second agent reviews it, and a set of risk rules decides whether the pull
request is merged without a person, waits for a default, or is put in front of an owner.

Everything runs in your repository's GitHub Actions, with your own Anthropic API key and a
GitHub App that you create and hold the key of. There is no server; the authors of this
project see nothing of your code or credentials.

## Status

**0.1 is in development and has not yet been run on a real repository.**

What exists is the engine (`cli/`), the reusable workflows, the templates and the documents
below, with a test suite that drives the three roles against an in-memory GitHub, a
scripted agent and local git repositories. No run with the real Claude Code CLI and no run
against the real GitHub API has happened yet. Expect things to break on first contact;
there is no release tag to install.

## Who it is for

A small team with its own product, one person who can say yes or no, and the habit of
shipping small changes that can be rolled back. The code must be on GitHub and the
repository must be allowed to run GitHub Actions on GitHub-hosted runners. Tests and
deployment can live anywhere. In 0.1 the agent is Claude Code only, and everything the
pipeline writes is in English.

It is not meant for teams that need several human approvals per change, or that cannot use
GitHub Actions.

## How it works

1. An issue carrying the work label (`pipeline`) is work. A plain issue is one pull
   request; a spec issue with a "PR split" table is one pull request per row, in order.
2. The **dispatcher** (`tick`) runs on repository events and on a schedule. It reads the
   issues, pull requests, checks and decisions, and starts whatever is due. It never runs
   an agent.
3. The **executor** (`fix`) runs the agent in a checkout of your repository. The agent is
   given the model key and no GitHub token; the engine, not the agent, commits, pushes and
   opens the pull request.
4. The **reviewer** (`review`) is a second agent with read-only tools. It approves,
   rejects (the pull request goes back to the executor, a limited number of times) or asks
   for a person, and gives the change a risk level from 0 to 3. The paths a change touches
   set the lowest level it can get.
5. Low levels merge once the review and your CI are green. A level-2 change opens a
   decision item with options, and takes the recommended one after a set time if nobody
   answers. Level 3 always waits for an owner.
6. Limits on runs, reworks and spend, per issue and per day, stop the work and ask an
   owner instead of looping.
7. All state lives in your GitHub: labels, hidden marks in comments, commit statuses and
   one ledger branch. `mode: record` does everything except merge, and is where you start.

Read [Threat model and known gaps](docs/install.md#threat-model-and-known-gaps) before
pointing it at a repository where people you do not know can write issues: the agent is
limited in what it is handed, not sandboxed.

## Documents

- [docs/install.md](docs/install.md): installing by hand, step by step, what runs where,
  the threat model, and the known limits of 0.1.
- [docs/spec-format.md](docs/spec-format.md): how to write a spec issue.
- [docs/design-0.1.md](docs/design-0.1.md): the contract between the engine's modules
  (config, marks, ledger, review decision, dispatcher plan, roles).
  They describe the direction beyond 0.1 and are not a description of what exists.

## Development

Node 20 or newer, no dependencies.

```sh
npm test        # node --test test/*.test.mjs
```

## License

[MIT](LICENSE)
