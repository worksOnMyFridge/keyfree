# Contributing

Keyfree has one maintainer. Issues and pull requests are welcome. For a security problem, do not open an issue:
follow [SECURITY.md](SECURITY.md).

## Run the checks

The commands are in the README, under [Run the tests](README.md#run-the-tests). CI runs them on every push and pull
request, with the dependency audits and a secret scan of the whole history.

## Pull requests

- One pull request, one purpose. Branch from `main`.
- `main` changes only through a pull request with green CI. With one maintainer nobody else reviews it: the pull
  request records what changed and that the checks passed. It is not a second opinion.
- Pull requests are merged with a merge commit, never squashed or rebased, and the history of `main` is never
  rewritten. The live contract names the exact commit it was built from, so that commit must stay reachable.

## Commits

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `feat`, `fix`, `docs`, `test`, `ci`,
  `build`, `chore`, `refactor`, with a scope when it helps, such as `fix(contract): ...`.
- The subject is in the imperative, about 50 characters and never over 72, with no full stop.
- The body, after a blank line, says why, wrapped at 72 characters.
- One logical change per commit, and each commit leaves the tests passing. Commit when a piece of work is finished,
  not after every edit. Run `git diff --check` first.
- Older commits have long descriptive subjects. They stay as they are, for the reason above.

## Changing the contract

1. Add the change with its tests in `contract/src/tests.rs`.
2. Raise the version in `contract/Cargo.toml`, the build name in the workflows, and add a row to
   `contract/CHANGELOG.md`.
3. The `build` workflow prints the sha256 and the code hash. Set them in `sandbox.yml`; the `sandbox` workflow must pass.
4. Only after that, install it through the keyless upgrade (`v14/upgrade.mjs`), and repeat the live runs.
5. Update the README, `CLAIMS.md`, the explorer's pinned build, `setup/config.example.json`, the same values in
   `start/index.html` and `challenge/setup.mjs`, and the page tests in `explorer/`.

## Claims must hold

Every claim in the documents has a transaction, a test or a log behind it. Run `npm run check:claims` before a pull
request that touches them, and do not state anything that was not run.

## Keep it clean

- No keys in the repository. `*_key.json` is ignored, and CI scans the history with gitleaks. The one exception is
  `challenge/published-agent-key.json`, a testnet function-call key published on purpose.
- No personal data or machine paths in code, logs or commit messages. Use your GitHub noreply address as the commit
  email.

By contributing you agree that your work is licensed under [Apache-2.0](LICENSE).
