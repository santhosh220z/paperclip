## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - Agents run through adapters, and a managed AI connection supplies the credential
> - Codex and Grok already deliver a managed credential as a file in a disposable provider home, so the CLI refreshes it and Paperclip writes the rotation back
> - Anthropic is the exception. The connection ships as a bare `CLAUDE_CODE_OAUTH_TOKEN`, which takes precedence over any stored login, so the CLI can never refresh it
> - Issue #15958 reports the result: the connection dies at the access token expiry, about eight hours after sign-in
> - `readVerifiedLocalAiCredential` keeps only `claudeAiOauth.accessToken`. The refresh token that `claude auth login` also writes is discarded, and `parseClaudeCredential` never reads it
> - The obvious fix is to store the full credential and let the CLI refresh natively, the same shape Codex and Grok already use
> - That fix depends on three facts about the Claude CLI that this repository cannot assume. This pull request measures them instead of guessing, and records the result
> - The benefit is a decision made on evidence, and the missing credential shape now has a fixture so the loss cannot recur unnoticed

## Linked Issues or Issue Description

- Refs #15958
- Refs anthropics/claude-code#1414 (macOS deletes the plaintext credentials file after a successful Keychain write)
- Refs anthropics/claude-code#77697 (the file is not preferred over the Keychain)
- Refs anthropics/claude-code#19456 (the namespaced Keychain ACL can block reads after a reboot)
- Refs anthropics/claude-code#20553 (config dirs shared one Keychain entry before 2.1.121)

**This pull request does not fix #15958.** It adds the measurement needed to choose the fix. No runtime behavior changes here.

## What Changed

- Add `scripts/smoke/claude-credential-store.mjs`, a five-probe live harness following the existing `posthog-live.mjs` conventions: checkpoints, a sanitized `summary.json`, and a throwaway credential home that is removed in `finally`
- Add `scripts/smoke/claude-credential-store-lib.mjs`, holding the pure and testable core: argument parsing, the per-directory Keychain service derivation, a full `claudeAiOauth` parser, presence and expiry-class summarizers, redaction, and the outcome classification
- Add 25 unit tests, including real-filesystem coverage of probes C and D, and a test that a complete five-probe summary passes the final redaction gate
- Add `setup-token-parse.auth-login.test.ts`, which settles probe A against the production parser without needing the CLI
- Add `__fixtures__/claude-auth-login-credential.json`, the first fixture in this repository to carry `refreshToken`, `refreshTokenExpiresAt`, and `scopes`
- Add `__fixtures__/claude-credential-store.md`, recording the open questions, the version constraints, and an empty results table
- Add `pnpm smoke:claude-credential-store` and `pnpm test:claude-credential-store`
- Ignore per-run evidence directories in `.gitignore`

### Probe A is settled

The unit suite confirms both halves of the prediction:

- `claude auth login` **matches** `parseSetupTokenPrompt`, so the existing in-app PTY runner can still collect a browser code. No new PTY plumbing is required.
- `claude auth login` **does not match** `parseSetupTokenCredential`, because that parser binds the setup-token success record. A post-exit credential read is required instead.

### Defects found and fixed while building the harness

These were real bugs in the first draft, found by the tests:

- `summarizeLocations` was synchronous while every reader is asynchronous, so every location resolved to `unparsable`. Probes C and D would have produced confident garbage on every platform.
- Probe D emitted fields named `accessToken` and `refreshToken`, which the harness's own redaction gate rejects. A real run would have thrown at the last step and written no evidence file at all.
- `security` exit 44 (`item not found`) and a real ACL failure were both reported as `unreadable`, collapsing the exact distinction probe C exists to measure.
- Rotation was detected by comparing expiry *classes*, which cannot see a refresh that stays inside one bucket. Replaced with a 16-character sha256 fingerprint, the same generation shape the control plane already uses.
- `preflightClaudeCredentialStore({})` threw a `TypeError` instead of defaulting to every probe.
- Redaction was not idempotent, so a second pass rewrote its own placeholders.

## Verification

Run on Windows, Node v24.21.0:

```sh
node --test scripts/smoke/claude-credential-store.test.mjs      # 25 passed, 0 failed
node scripts/vitest/vitest.mjs run \
  packages/adapters/claude-local/src/server/setup-token-parse.auth-login.test.ts   # 6 passed
```

Also verified:

- `tsc --noEmit` on `@paperclipai/adapter-claude-local`, clean
- `node scripts/check-no-git-push.mjs`, clean
- `node --check` on all three harness files, clean
- The harness end to end, including every preflight gate: `destructive_opt_in_required`, `unknown_probe`, `invalid_arguments`, and the missing-CLI path. Each writes a sanitized `summary.json` and leaves no stray files.

### What is NOT verified

**No probe has produced a result.** The machine used has no Claude Code CLI and no refresh token, so every run stops at `claude_cli_unavailable`. The harness is verified to work. The hypothesis is unverified anywhere.

Specifically unverified:

- Probe B, whether `claude auth login` spends a refresh token from `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` without a TTY. This gates every design option.
- Probe C's macOS Keychain half. It cannot be measured on Linux or Windows by construction.
- Probe D, whether the CLI refreshes mid-run and writes back.
- Probe E, whether the environment variable really overrides a stored login.

I could not establish a green baseline for the wider `packages/adapters/claude-local` suite on this machine. It reports 42 pre-existing failures in files this change does not touch, caused by POSIX assumptions and a missing CLI. The 31 tests added here pass.

`pnpm install` completed but its `postinstall` step fails on Windows with `EPERM: symlink`, so `pnpm -r typecheck`, `pnpm build`, and `pnpm test` were not run in full.

## Risks

- **Low risk to runtime.** No shipped code path changes. The new files are a test harness, a fixture, and a document.
- **The harness spawns the real Claude CLI** against a temporary `CLAUDE_CONFIG_DIR`. It requires an explicit `--allow-destructive` flag and never reads or writes the operator's `~/.claude`.
- **A credential may reach the evidence file if a future probe is careless.** Mitigations: every probe returns presence booleans and expiry classes rather than values, existing placeholders are protected from redaction, and `assertSanitizedEvidence` refuses to write the file at all if any credential-shaped key or value appears. There is a test that injects a deliberate leak and confirms the gate still fires.
- **The macOS Keychain ACL defect (#19456) may make write-back silently fail** after a reboot. The harness reports `unreadable` separately from `absent` so this cannot be mistaken for an unchanged credential.
- **Reading an exact behavior from a closed-source CLI is inherently fragile.** Any upstream release may change the login output. The harness records the CLI version and refuses builds below 2.1.121, where config dirs shared one Keychain entry.
- **The macOS credential read assumes the service name `Claude Code-credentials-<sha256(configDir)[0..8]>`.** A unit test asserts the harness derives the same name as the production reader in `quota.ts`, so drift surfaces as a test failure rather than a silent false "absent".

## Model Used

OpenAI `space-bunny-free` (exact deployment ID and context window were not exposed), running under opencode with repository search, file read, file edit, and shell tools. Used for repository analysis, web search of upstream Claude Code documentation and issues, and all code and test authoring in this pull request.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [ ] I have searched GitHub for duplicate or related PRs and linked them above — not done; `gh` is not authenticated on the machine used
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes: #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass — for the files this change adds. See "What is NOT verified" for what did not run
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green — not verified locally. CI has not run
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups — not verified locally
- [ ] I will address all Greptile and reviewer comments before requesting merge