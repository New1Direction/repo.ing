# Fork guard

Buyers must never mistake a copy for a launched original. A fork that carries an abandoned project forward should still be able to have a market. Code: `src/repo-lineage.mjs`. Data: migration `0058_repository_lineage`.

## Rules

| Repository | Launch |
|---|---|
| A **GitHub fork** whose parent or source already has a market | Refused |
| Any other GitHub fork | Allowed, labelled **Fork of &lt;parent&gt;** |
| **Not a fork**, but its first commit is the first commit of an **older** launched repository owned by **another** account | Refused |
| Not a fork, sharing a first commit with a launched repository owned by the **same** account | Allowed |

- **Parent and source.** GitHub reports both on its single-repository endpoints. The parent is the repository it was forked from; the source is the root of its fork network.
  - A sibling fork that launched first does not block another fork of an unlaunched original. Only the parent and the source count.
- **What counts as a market.** Any market row except a `failed` one, including a launch in progress.
- **Same account.** That case covers moving your own project to a new repository, for example renaming the old one and pushing its history to a new one. It is not a copy.
- **"Older".** Decided by GitHub's creation time, so an original that launches after its copy is never refused.
  - A creation time GitHub omits counts as the newer one.
- **The first commit.** It is the last page of `GET /repos/{owner}/{name}/commits?per_page=1`, two GitHub calls.
  - It is read only for repositories that are not forks and have no market yet.
  - It does not catch a copy whose history was squashed into a new first commit.

## Where it is checked

- **`POST /api/launch` (prepare).** This check is authoritative. It covers the site, the CLI and MCP drafts, because every launch is prepared here.
  - A refusal comes back with code `COPY_OF_LAUNCHED_REPOSITORY` and `canRetry: false`.
- **`POST /api/resolve`.** When a repository URL is pasted, a refusal is a 409 with the launched original's name and mint.
- **`/launch/<repo id>`.** A refused repository gets a "Launch unavailable" card with a link to the original's market.
- **MCP `resolve_repo` / `create_launch_draft`.** These return `copyOf` and `forkOf`, and a draft is refused for a copy.

When GitHub cannot list the commits, the copy check is skipped rather than blocking the launch. The lineage stays unchecked, so the worker reads it again later.

## Labels

**Fork of &lt;parent&gt;** appears in four places:
- the launch page;
- the token page;
- market rows (home and explore), from the stored `repositories.fork_parent_full_name`;
- trending launches, from the observed repository.

## Stored data

| Column on `repositories` | Meaning |
|---|---|
| `root_commit` | The repository's first commit, once read |
| `fork_parent_id`, `fork_parent_full_name` | The repository GitHub says it was forked from |
| `lineage_checked_at` | When those were read; null means not yet |

The worker (`createLineageBackfill`, five repositories a minute through the GitHub App) fills these in for markets launched before 0058. It also covers any repository whose first commit could not be read at launch.
- A repository GitHub no longer serves publicly (archived, private or deleted) is marked checked as it is.
- Any other failure is retried on a later run.
