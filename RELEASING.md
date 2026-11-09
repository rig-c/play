# Releasing

The cut is a deliberate version tag (`vX.Y.Z`) pushed on a `main` commit whose
`package.json` carries `X.Y.Z`. Everything after that tag push is
`.github/workflows/release.yml`, and no npm credential exists on any machine —
the publish authenticates to the registry over OIDC (npm trusted publishing),
so there is no token to leak and no 2FA prompt to answer.

## The loop

Pushing a version tag matching `v*` triggers `release.yml`:

- **Release preparation on `main`** → land the `package.json` version bump and
  `CHANGELOG.md` entry on `main` through a normal pull request with green CI.
  Pushes to `main` do not run `release.yml` or open automated release pull
  requests.
- **Version tag pushed (`vX.Y.Z`)** → `release.yml` validates the tag (strict
  `vX.Y.Z` semver without prerelease suffixes or leading zeroes), confirms that
  `@rig-c/play@X.Y.Z` is not yet served on npm, resolves `refs/tags/vX.Y.Z` to a
  full 40-character commit SHA matching `GITHUB_SHA`, checks out that immutable
  commit, verifies that it is an ancestor of `origin/main` and matches the
  post-checkout `HEAD` and `package.json` version, and publishes the package
  under all three of its names (*Three names, one tarball*, below).
- **No pre-existing GitHub Release dependency** → publication does not require
  a GitHub Release to exist first, so a failed publish can be retried via
  `workflow_dispatch` before release notes are created.

## Three names, one tarball

The package is **`@rig-c/play`**, the `name` in `package.json`, from the move to
the `rig-c` organisation (#98). Versions 1.0 to 1.8 shipped as **`rig-play`** and
every version up to 0.8.0 as **`spine-html`**; both names stay published as
**aliases** (#65, #98): every cut publishes all three from one run, with the same
files, because links outside this repository — the npm pages, forum threads,
articles, badges other READMEs copied — point at the earlier names, and nothing
but an alias keeps its npm page current. GitHub redirects the old repository
URLs (`firejune/spine-html`, `firejune/rig-play`); nothing redirects an npm page.

- **One tarball's files.** After `npm publish --access public` has published
  `@rig-c/play` from the checkout — gated by `prepublishOnly`, which builds
  `dist/` from the tagged tree; a scoped package is restricted unless told
  otherwise — the next step runs, once per alias, `node scripts/alias-tarball.mjs
  pack --alias <name> --out "$RUNNER_TEMP/alias-<name>"`: it packs the same
  checkout with scripts ignored (the `dist/` that was just published), extracts
  the tarball into the runner's temp directory, rewrites the one `"name"` line
  of the extracted `package.json` to the alias, packs that again, and prints the
  path only after reading the two tarballs as the same files. `npm publish <that
  tarball> --access public --ignore-scripts` publishes it with provenance. The
  checkout is never modified. The aliases the script accepts are listed once, in
  `ALIASES` at the top of the script.
- **The comparison.** The two tarballs never share a `dist.shasum` — one line of
  one file differs by design, and the tar and gzip headers with it — so "the
  same files" is read off the unpacked tarballs: the same set of paths, every
  file byte-identical, and `package/package.json` identical once the alias's
  `name` line is put back. `node scripts/alias-tarball.mjs compare <a.tgz>
  <b.tgz>` is that reading on its own; it exits 0 and prints `PASS
  ALIAS_SAME_CONTENT: spine-html carries the N file(s) of @rig-c/play, byte
  for byte but for the name line of package/package.json`, or exits 1 naming
  each path that differs. `tests/package.spec.ts` runs the pack over a temp
  build for each alias on every CI run, diffs the two manifests itself, and
  plants a one-byte difference the comparison has to name.
- **The confirmation.** The last step of the release run fetches every name at
  the released version from the registry (retrying for up to 15 minutes each
  while the registry catches up), prints `npm view` for each, and runs
  `compare` on the canonical tarball against each alias's as the registry served
  them — so what is held equal is the published bytes, not this tree's. A version not served in time is a red
  that says the confirmation was not taken; it does not un-publish anything.
- **An alias never has its own version.** No version of `rig-play` or
  `spine-html` is made by hand: it is `@rig-c/play`'s files at its version, or
  nothing. The one step that publishes aliases alone is the `alias` job of
  `release.yml`, run by hand (**Actions → release → Run workflow**, on the
  version's tag with the version and the aliases still missing; see the source
  checks below) when a cut published `@rig-c/play` and
  an alias publish after it failed — the first `rig-play` cut, v1.0.0, did
  exactly that, on a `spine-html` trusted-publisher form that still named the
  repository's old path. The release job cannot be re-run for it (its first
  publish is then refused as an existing version before the alias step is
  reached), so that job takes the registry's own `@rig-c/play@<version>`
  tarball (`rig-c-play-<version>.tgz`), never a rebuild, rewrites the name line
  for each alias named and runs the same confirmation. No lifecycle script runs on it, by design:
  `npm publish <tarball>` runs none, and the alias is the gated publish's files,
  held to them by the comparison before its path is printed.
- **They are kept, not retired.** No `npm deprecate` — a banner on every install
  is a retirement under an alias's name. The README's first paragraph names the
  package's name, and the same file is the alias's npm page. Retiring the alias
  is a separate card, opened only after three answers are written down in it:
  what npm history is lost (download counts, the package page, the provenance
  links of every version under that name), an inventory of the external links
  and where each resolves after a retirement, and what the alias says until
  then (#65).

## Retrying an already-cut release

If the version tag was pushed on `main` and the first `@rig-c/play` publish
failed before reaching npm (for example, a signing-service or registry outage),
with the owner's release approval, use **Actions → release → Run workflow**
on the existing **vX.Y.Z tag**, set **tag** to that tag, and leave **alias_version**
empty. The default **alias_names** belongs to alias repair and is ignored here.
Do not create another tag or publish locally.

The CLI equivalent is `gh workflow run release.yml --repo rig-c/play --ref vX.Y.Z -f tag=vX.Y.Z`.
Only tags carrying the source-context guard described below can be retried this
way. A tag cut before the fix carries its older workflow: dispatching on it does
not run the current main workflow and cannot retroactively gain this safeguard.
Do not use this recovery procedure for those old tags.

On `workflow_dispatch`, the workflow requires exactly one of **tag** and
**alias_version**. Both tag push and tag retry share the same unified
validation: they refuse an invalid or prerelease tag (`RELEASE_TAG_FORM`) and a
canonical version already served by npm (`RELEASE_ALREADY_PUBLISHED`). Only an
explicit registry `E404` permits publication; network, permission and unknown
errors fail closed (`RELEASE_REGISTRY_LOOKUP`). Neither path requires a
pre-existing GitHub Release, so failed publication can recover before release
notes are created. Both resolve the explicit
tag through `commits/refs%2Ftags%2FvX.Y.Z` to a full commit SHA, check out that
immutable SHA, fetch main's full history (unshallowing when needed),
and require that checked-out tag commit to be an ancestor of `origin/main`
(`RELEASE_TAG_NOT_ON_MAIN` otherwise). History queries and fetch errors stop the
run; an unknown result never counts as ancestry. These checks run before
installing dependencies or publishing, then that tree's package name and version
must match the tag (`RELEASE_TAG_VERSION`).
The existing `prepublishOnly` library build gates the canonical publish; the
same steps then publish both aliases with provenance and confirm all three
names from registry tarballs. There is no separate typecheck/smoke gate in this
workflow beyond the build that `prepublishOnly` runs.

Checkout source and workflow execution context are distinct. For **tag push, tag
retry and alias-only repair**, before checkout or enabling publication, the
workflow compares the run's `github.sha` context (the source `GITHUB_SHA` npm
provenance records) with the resolved tag commit. Use the full
`refs%2Ftags%2F` reference to select the tag namespace and resolve a commit,
including an annotated tag. The earlier claim that `tags%2F` also resolved
annotated tags was unsupported: a fresh read-only recording of `git/git`
`v2.45.0` returned HTTP 422 ("No commit found") for that spelling and HTTP 200
with commit `786a3e4b8d754d2b14b1208b98eeb0a554ef19a8` for the full reference.
The lightweight `rig-c/play` `v1.14.0` resolved to
`8b18e0de69e980575535fe8240cbf68667d1f404` with either spelling. These are
recorded observations of those tags, not a claim that both spellings are
interchangeable. API failures, empty or malformed responses refuse with
`RELEASE_TAG_UNRESOLVED`; only a full 40-character
lowercase hexadecimal SHA is accepted. A missing or unequal run SHA refuses
with `PROVENANCE_SHA_MISMATCH`, naming both SHAs and a repository-scoped recovery
command. Successful paths check out the validated SHA, even if the tag moves
after resolution; alias repair receives that SHA through the release job output.
Tag push, tag retry and alias repair also retain the post-checkout `HEAD`
comparison before installing anything or publishing (`PROVENANCE_SHA_LOOKUP` for
a failed HEAD lookup). Alias repair gains no main-ancestry requirement.

On tag push (`on.push.tags: ['v*']`), `release.yml` reads the tag from
`github.ref` (`refs/tags/vX.Y.Z`), ignoring `workflow_dispatch` inputs, and runs
the same pre-checkout and post-checkout SHA, `origin/main` ancestry, and
manifest version checks as `workflow_dispatch` tag retry. If a tag moves after
the push event was created so `GITHUB_SHA` no longer matches the tag commit, the
guard refuses before any of the three publishes; with release approval, recover
using the printed command:
`gh workflow run release.yml --repo rig-c/play --ref vX.Y.Z -f tag=vX.Y.Z`.
These checks apply only to workflow versions containing them: they do not repair
already-published provenance, an old run's stored workflow copy, or tags
carrying an older workflow. The old-tag limitation above still applies.

On `workflow_dispatch`, the workflow requires `github.ref` to be
`refs/tags/<tag>` (`RELEASE_REF_NOT_TAG` otherwise, even when `main` and the tag
point at the same commit), and checking out a tag from a branch-ref dispatch
also does not change `GITHUB_SHA`. No GitHub
metadata is overridden. Live OIDC issuance and the registry's resulting
attestation still require separately authorized verification.
See GitHub's [`workflow_dispatch` context table](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)
and the [npm CLI provenance implementation](https://github.com/npm/cli/blob/latest/workspaces/libnpmpublish/lib/provenance.js#L44-L49).

If `@rig-c/play` already exists and an alias is missing, leave **tag** empty
and use **alias_version** and **alias_names** as described above, dispatching on
that version's tag: `gh workflow run release.yml --repo rig-c/play --ref vX.Y.Z -f alias_version=X.Y.Z -f 'alias_names=rig-play spine-html'`
(name only the missing aliases). The same old-tag limitation applies. That path
continues to derive aliases from the canonical registry tarball, never a rebuild;
the source guard binds its execution context to the checkout used by that path.
An alias mismatch prints an alias-repair command preserving the original
space-separated `alias_names` selection with shell-safe quoting; it never sends
an already-published canonical version to the tag-retry path.
Tag retry does not republish canonical or skip arbitrary aliases.

The isolated decision checks run with `bun test scripts/release-workflow.test.ts`.
They execute the workflow's shell bodies with mocked APIs and publish recorders.
`scripts/fixtures/release-commit-responses.json` preserves fresh live `gh --jq`
stdout/stderr and exits for the two tags above; the offline mock replays the
response matching the actual requested endpoint. The planted old-prefix copy
refuses the annotated tag while the lightweight control still resolves. Other
API, checkout and publish behavior remains synthetic; these checks do not prove
production OIDC, provenance issuance or registry propagation.

## One-time setup (owner, GitHub)

**Settings → Actions → General → Workflow permissions** can stay on the
read-only default: both jobs in `release.yml` declare only `contents: read` and
`id-token: write`, and the workflow opens no pull requests and writes no
repository refs.

## One-time setup (owner, npmjs.com)

Do this once per name, before the first cut that publishes it. It cannot be
done from here — it needs the account. npm keys a trusted publisher to the
package, so there is **one form per name**, and both are filled in the same way.

1. npmjs.com → **@rig-c/play** → **Settings** → **Trusted Publisher** →
   *GitHub Actions*; and again under **rig-play** and **spine-html**, whose
   existing forms named the repository by an earlier path and have to name the
   current one — the OIDC token a run presents carries the repository it ran in,
   `rig-c/play`, and a provenance statement must match `repository.url`.
2. Fill in each, exactly (the fields are case-sensitive, and npm does not
   validate them on save — a typo only surfaces as a failed publish):
   - Organization or user: `rig-c`
   - Repository: `play`
   - Workflow filename: `release.yml`
   - Environment name: *leave blank* (the workflow declares no environment; a
     value here that the workflow does not match rejects the publish)
   - Allowed actions: `npm publish`
3. After the first successful automated publish — not before — set
   **Settings → Publishing access → Require two-factor authentication and
   disallow tokens**. Trusted publishing keeps working under that setting; it
   is what closes the door behind the classic tokens. Setting it first would
   leave no way back if the OIDC path needs a fix. The setting is per package:
   each name gets it once that name has published from the workflow.

Until `@rig-c/play`'s form exists, the first publish of a cut is refused on
authentication and the alias steps after it never run, so a cut waits for that
form rather than going out under fewer names. npmjs.com offers no settings page
for a package that does not exist yet, so a renamed package's first version goes
up by hand — measured twice: `rig-c`'s (rigc RELEASING.md, *The package name is
`rig-c`*) and `rig-play`'s on 2026-10-11, each from the previous name's registry
tarball with the `name` line changed and nothing else, published with
`--ignore-scripts`. A scoped name also needs its npm organisation (`rig-c`) and
`--access public`. `node scripts/alias-tarball.mjs compare` reads such a pair the
same way.

Two properties of that configuration are load-bearing in the workflow:

- Every publish step must live in **`release.yml`**. Renaming the file, or
  moving any publish into another workflow, breaks that name's trusted
  publisher until its form is updated to match.
- It must run on a **GitHub-hosted runner**. npm does not support trusted
  publishing from self-hosted runners, so this job never moves to a private
  machine.

## Cutting a release

0. Once, before the first cut: both setup sections above, with one trusted
   publisher form per name.
1. Land the work on `main` as usual, with conventional-commit subjects. CI runs
   on every push.
2. Prepare the release on `main` (`package.json` version `X.Y.Z` and
   `CHANGELOG.md` updated) and wait for `ci` on that `main` commit to pass.
3. With release approval, push the `vX.Y.Z` tag on that verified `main` commit.
   That tag push is the cut.
4. Watch the `release` run triggered by `vX.Y.Z`: it validates the tag, SHA,
   `origin/main` ancestry and `package.json` version, publishes `@rig-c/play`,
   publishes the two aliases, and confirms every name serves the same files —
   its last step prints one comparison line per alias.
5. Confirm: `npm view @rig-c/play version`, `npm view rig-play version` and
   `npm view spine-html version` print the same version, and each npm page shows
   a provenance attestation of the same workflow run. Create the GitHub Release
   notes for `vX.Y.Z` after publication succeeds.

## What was pre-flighted, and what the first cut proved

A throwaway branch (run 32583528151) exercised everything in the publish path
that does not touch the registry: `id-token: write` mints an OIDC token with
`aud: npm:registry.npmjs.org` and a `workflow_ref` claim naming the workflow
file — which is the claim npm matches against the trusted publisher, so the
filename in the form and the filename in `.github/workflows/` must agree.
`npm install -g npm@latest` produced npm 12, well past the 11.5.1 that speaks
OIDC. `bun install --frozen-lockfile` plus `prepublishOnly` built the tarball
on the runner: 28 files, `dist/` included by the `files` allowlist even though
git ignores it.

One log detail that looks alarming and is not: the `GITHUB_TOKEN Permissions`
group printed at the start of a job never lists `IdToken`, whether or not the
job requested it. The probe requested `id-token: write`, the group showed only
`Contents: read` / `Metadata: read`, and the token minted anyway.

The registry side of the exchange could only be proven by a real cut, because it
needs the trusted publisher to exist — and **v0.5.0 (2026-09-18) proved it**: the
release pull request was merged, the same `release` run tagged, released and
published in one pass, and the registry serves the tarball with a SLSA
provenance attestation. What follows is kept for the day it breaks: if a publish
fails on authentication rather than
on a publisher mismatch, the first thing to try is dropping `registry-url` from
the `setup-node` step: it exists only to write an `.npmrc`, and the `.npmrc` it
writes carries a `NODE_AUTH_TOKEN` placeholder that nothing sets.

## If the automation is unavailable

The old path still works and needs nothing from this workflow: `npm version
<patch|minor|major>`, push the commit and the tag, `npm publish`. It publishes
with a classic token and a 2FA one-time password — which is why it stops being
available the moment "require two-factor authentication and disallow tokens" is
switched on. Fix the workflow instead.
