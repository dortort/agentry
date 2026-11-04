# Releasing

Agentry uses [Changesets](https://github.com/changesets/changesets). All seven
publishable packages — `agentry-test`, `@agentry/core`, `@agentry/claude`,
`@agentry/codex`, `@agentry/gemini`, `@agentry/antigravity`, and `@agentry/mcp` —
version and publish together at one shared version. The `fixed` group in
`.changeset/config.json` bumps all seven even when only one changed. Private
example workspaces are excluded.

## Day-to-day flow

1. Add a changeset for changes that affect a published package:

   ```bash
   pnpm changeset
   ```

   Select any affected package and the largest bump the change warrants. The
   summary becomes a changelog entry. Commit the generated `.changeset/*.md` file
   alongside the code. Use `pnpm changeset --empty` for changes that intentionally
   need no release, such as pre-release package metadata.

   CI rejects package changes without a changeset. The version PR opened by
   `github-actions[bot]` from this repository's `changeset-release/main` branch is
   exempt from this check because versioning consumes its changesets. Typecheck,
   tests, installation, and build still run for version PRs.

2. Merge to `main`. The Release workflow opens or updates a version PR that bumps
   package versions and writes changelogs. Empty changesets alone do not open a
   version PR or publish packages.

   The workflow uses `GITHUB_TOKEN`. GitHub may require a maintainer to select
   **Approve workflows to run** on the generated PR before its CI runs. See
   [GitHub's workflow trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).
   Wait for CI to pass before merging the version PR.

3. Once publishing is enabled, merge the version PR. The next Release run builds
   and publishes all seven packages with npm provenance, then pushes tags and
   creates GitHub releases.

When there are no pending changesets, an enabled Release run attempts to publish
any package versions missing from npm. This also lets a later run retry a partial
publish. It is not limited to commits that merge version PRs.

## Repository setup

- In **Settings → Actions → General → Workflow permissions**, enable **Allow
  GitHub Actions to create and approve pull requests**. The workflow declares its
  required token permissions; the repository's default can remain read-only.
- Publishing is **disabled by default**. Until the repository variable
  `NPM_PUBLISH_ENABLED` equals `true`, the workflow can manage version PRs but does
  not invoke the publish command. This permits merging the release infrastructure
  before npm setup is complete.

## Before enabling npm publishing

1. Confirm ownership or availability of `agentry-test` and create or obtain access
   to the `@agentry` npm scope. The CLI package is `agentry-test`; its installed
   command remains `agentry` (`npm i -D agentry-test`, then `npx agentry-test …`).
2. Add the **`NPM_TOKEN` repository secret** with publish rights for all seven
   package names. Use an npm [granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens/)
   with package/scope read-write permission and **Bypass two-factor
   authentication** enabled. Ensure its permissions allow creating the initial
   package names, and rotate it before expiry. Organization-management permission
   alone does not grant permission to publish packages.
3. Keep each published package's `repository.url` set to
   `git+https://github.com/dortort/agentry.git` and `repository.directory` set to
   its package directory. npm [requires matching repository metadata](https://docs.npmjs.com/generating-provenance-statements/#prerequisites)
   for provenance.
4. Build and inspect the packed CLI:

   ```bash
   pnpm build
   pnpm --filter agentry-test pack --pack-destination /tmp/agentry-pack
   ```

   The packed CLI must reference
   `dist/bin.js`, which must start with `#!/usr/bin/env node`; exports must point
   to the built JavaScript and declarations.
5. Set the **`NPM_PUBLISH_ENABLED` repository variable** to `true` once setup is
   complete. If enabled without `NPM_TOKEN`, the workflow fails with an explicit
   setup error. Setting the variable alone does not start a workflow; the next
   push to `main` uses the new setting. Remove it or set it to `false` to disable
   publishing again.

No first release is included in this infrastructure PR; packages remain at
`0.0.0`. Configure publishing before merging the first version PR.

## First release (0.0.0 → 0.1.0)

After completing npm setup, add the initial minor changeset on a feature branch:

```bash
pnpm changeset            # choose "minor" for any publishable package
git add .changeset/*.md
git commit -m "chore(release): initial 0.1.0 changeset"
```

Merge that changeset PR to `main`, wait for the generated version PR's CI, and
merge the version PR. All seven packages will release at `0.1.0`.

## Files

- `.changeset/config.json` — lockstep configuration and public access.
- `.github/workflows/release.yml` — version PR and publish automation.
- `.github/workflows/ci.yml` — package checks, build, and changeset gate.
- Root `package.json` — `changeset`, `version-packages`, and `release` scripts.
