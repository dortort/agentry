# Releasing

Agentry publishes with [Changesets](https://github.com/changesets/changesets).
All four packages — `agentry`, `@agentry/core`, `@agentry/claude`, `@agentry/mcp` —
version and publish **together at one shared version** (Playwright-style lockstep,
configured via `fixed` in `.changeset/config.json`). Every release bumps and
publishes all four, even if only one changed.

## Day-to-day flow

1. **Add a changeset** with each change that affects a published package:

   ```bash
   pnpm changeset
   ```

   Pick the bump (`patch` / `minor` / `major`) and write a one-line summary — it
   becomes the changelog entry. Because the packages are `fixed`, selecting any one
   bumps them all by the same amount; pick the largest bump your change warrants.
   Commit the generated `.changeset/*.md` file alongside your code.

   CI enforces this: the `changeset` job on pull requests fails if a package under
   `packages/*` changed without a changeset.

2. **Merge the PR to `main`.** The `Release` workflow opens (or updates) a
   **"version packages"** PR that consumes the pending changesets, bumps every
   package version, and rewrites `CHANGELOG.md` files.

3. **Merge the "version packages" PR.** That triggers the workflow again, which runs
   `pnpm release` (build + `changeset publish`) and publishes all four packages to
   npm with [provenance](https://docs.npmjs.com/generating-provenance-statements),
   then pushes the git tags.

You never run `npm publish` by hand — merging the version PR is the only publish path.

## One-time setup (before the first publish)

- [ ] **Resolve the `agentry` npm name.** It is already taken by an unrelated
      `agentry@0.1.0`. Options: publish the CLI as scoped `@agentry/cli` (users run
      `npx @agentry/cli`), pick a different unscoped name, or acquire `agentry`. Until
      this is settled, `changeset publish` will 403 on the `agentry` package. The
      package name lives in `packages/cli/package.json`; if it changes, update the
      `fixed` array in `.changeset/config.json` to match.
- [ ] **Create the `@agentry` npm org** (or user scope) so `@agentry/*` can publish.
- [ ] **Add the `NPM_TOKEN` repo secret** — an npm **automation** token (bypasses 2FA
      on publish) for an account with publish rights to all package names.
- [ ] **Confirm the published CLI is executable** — verify `dist/bin.js` carries a
      `#!/usr/bin/env node` shebang after `pnpm --filter agentry build`.

## First release (0.0.0 → 0.1.0)

All packages sit at `0.0.0` and have never been published. Once the setup above is
done, cut the initial pre-1.0 release:

```bash
pnpm changeset            # choose "minor" → 0.1.0, describe the initial release
git commit -am "chore(release): initial 0.1.0 changeset"
```

Merge to `main`, then merge the "version packages" PR the workflow opens.

## Files

- `.changeset/config.json` — lockstep (`fixed`) config, `access: public`.
- `.github/workflows/release.yml` — the publish pipeline.
- `.github/workflows/ci.yml` — the `changeset` PR gate.
- Root `package.json` — `changeset`, `version-packages`, `release` scripts.
