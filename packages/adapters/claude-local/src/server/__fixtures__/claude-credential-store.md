# Claude subscription credential-store characterization

- Purpose: decide the design for [GitHub #15958](https://github.com/paperclipai/paperclip/issues/15958)
  before writing production code.
- Intended repository path: `packages/adapters/claude-local/src/server/__fixtures__/claude-credential-store.md`
- Companion shape fixture: [`claude-auth-login-credential.json`](./claude-auth-login-credential.json)
- Harness: `scripts/smoke/claude-credential-store.mjs`
- Safety: no authorization URL, browser code, access token, or refresh token is
  recorded here. Every secret is replaced by a `<REDACTED_*>` placeholder. The
  harness's evidence file contains presence booleans and expiry classes only;
  `assertSanitizedEvidence` refuses to write a file that carries a
  credential-shaped key or value.

## Status: NOT YET CHARACTERIZED

No run has been recorded. This file is the template and the reading guide. Run
the harness on a host that has the Claude Code CLI and Python 3:

```sh
# Probes B, C, and D need a real refresh token to spend.
ANTHROPIC_OAUTH_REFRESH_TOKEN=... \
  node scripts/smoke/claude-credential-store.mjs --allow-destructive
```

Attach the emitted `summary.json` to the issue and fill in the section below.

## The bug this must settle

Paperclip ships an Anthropic subscription connection to a run as a bare
`CLAUDE_CODE_OAUTH_TOKEN` environment variable. That variable takes precedence
over any stored login, so the Claude CLI never consults its credential store and
never refreshes. The connection therefore dies at the access token's expiry —
about eight hours after `claude auth login` — even though the refresh token that
`claude auth login` also wrote stayed valid for roughly four more weeks.

Two paths exist today:

| Path | Credential | Lifetime | Refreshable | Quota probe |
| --- | --- | --- | --- | --- |
| `claude auth login` | access + refresh | ~8h access, ~4wk refresh | yes | yes (`user:profile`) |
| `claude setup-token` | access only | ~1 year | no | no (`user:inference` only) |

`master` uses `setup-token`, since `9f7057e12` (#14970, 2026-10-06). The issue
reporter ran `2026.1005.0`, the day before that switch, so their symptom predates
the current flow. The refresh-token design is still the better end state, and it
is only implementable if the measurements below hold.

## Why the harness exists

The candidate fix is to stop injecting `CLAUDE_CODE_OAUTH_TOKEN`, seed the
disposable managed `CLAUDE_CONFIG_DIR` with the full credential, and let the CLI
refresh natively — the same shape Codex and Grok already use. Three facts must
be measured rather than assumed.

### Probe A — is `auth login` drivable by the in-app runner?

`auth login` and `setup-token` share the browser authorization flow, so the
existing `runSetupTokenLogin` PTY driver should still match the URL preamble and
the "Paste code here if prompted" line. It should **not** match
`parseSetupTokenCredential`, because that parser binds the setup-token success
record and `auth login` prints `Login successful.` instead.

That prediction is pinned in the repository's own unit suite, without the CLI:

[`setup-token-parse.auth-login.test.ts`](../setup-token-parse.auth-login.test.ts)

If the harness disagrees with that test, the transcript changed shape and the
test needs updating before the design is trusted.

### Probe B — does the refresh-token fast path work headlessly?

`claude auth login` reads `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and
`CLAUDE_CODE_OAUTH_SCOPES` and skips the browser exchange entirely. If that works
with no TTY and no stdin, Paperclip never has to implement Anthropic's OAuth
client, and the reporter's proposed fix is a configuration change rather than a
protocol implementation.

This is the single most important result in the spike. A `requiresTty` result
changes the plan.

### Probe C — where does the credential persist, and which location wins?

Upstream documents three behaviors that a naive cleanup read gets wrong:

- macOS stores credentials in the Keychain, and Linux/Windows use
  `~/.claude/.credentials.json` at mode `0600`.
- macOS **deletes** the plaintext file once the Keychain write succeeds
  ([anthropics/claude-code#1414](https://github.com/anthropics/claude-code/issues/1414)):
  *"cleaning up plain text credentials when successfully storing them in macos
  keychain"*.
- The file is **not** consulted in preference to the Keychain
  ([anthropics/claude-code#77697](https://github.com/anthropics/claude-code/issues/77697)).

So a cleanup read that checks the file first will miss most macOS rotations, and
must treat "file absent" as normal rather than as "nothing changed". The harness
records the CLI's preferred location explicitly for this reason.

The Keychain item is namespaced per config dir as
`Claude Code-credentials-<sha256(configDir)[0..8]>` — which is exactly what
[`quota.ts`](../quota.ts) `isolatedKeychainService` already computes. The unit
suite asserts the harness and the production reader derive the same name, so a
drift cannot make this probe report a false "absent".

**This is the section that must be captured on a Mac.** It cannot be answered on
Linux or Windows.

### Probe D — does a refresh rotate the credential in place?

Compares the pre- and post-refresh summaries. The managed-home design depends on
the CLI rewriting its own store and Paperclip capturing that rotation at cleanup.

### Probe E — does the env var really win?

Confirms via `claude auth status` that `CLAUDE_CODE_OAUTH_TOKEN` is the active
credential. This is the direct explanation of the bug, and it proves that
removing the env var is *required* for the fix rather than merely tidy.

## Version constraints

Record `claude --version` in the run. Two upstream facts bound the design:

- Config-dir namespacing exists only from **2.1.121**. Below it, every config dir
  shares one Keychain entry, which is the account-crossing failure in
  [anthropics/claude-code#20553](https://github.com/anthropics/claude-code/issues/20553).
  A managed-home implementation must refuse those builds rather than isolate
  nothing.
- `/login` precedence under a set env token was fixed in 2.1.117–2.1.118.

The harness reports `claude.supportsIsolatedKeychain` so a run on a too-old CLI
fails visibly instead of silently sharing an account.

## Known macOS failure mode to record

[anthropics/claude-code#19456](https://github.com/anthropics/claude-code/issues/19456)
reports that the namespaced Keychain item is created with an ACL that blocks
reads after a reboot. If a write-back finds an unreadable Keychain item, the
harness records `unreadable` rather than `absent`, so a silent no-op is
distinguishable from a genuinely unchanged credential. The implementation must
then fall through to `markAuthenticationFailed`, which already exists.

## Outcome table

`classifyRefreshPath` in the harness library maps the measurements to one of
three plans. Record which one this run produced.

| Outcome | Condition | Plan |
| --- | --- | --- |
| `managed_home_keychain_first` | B headless, C Keychain-first | Full managed-home design, Keychain-first cleanup read |
| `managed_home_file_first` | B headless, C file-first | Same design, Keychain branch deferred to a follow-up |
| `refresh_token_path_blocked` | B needs a TTY, or A undrivable | Keep `setup-token` as default; offer `auth login` as a copy-command path only to obtain a refresh token |

## Results

_Not yet run._

Fill in the table after attaching `summary.json`:

| Probe | Result | Notes |
| --- | --- | --- |
| A — `auth login` PTY shape | | |
| B — refresh-token fast path | | |
| C — credential locations | | |
| D — in-place rotation | | |
| E — env var precedence | | |
| **Outcome** | | |