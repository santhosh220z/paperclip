import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectCredentialStore,
  probeCredentialLocations,
  probeInPlaceRefresh,
} from "./claude-credential-store.mjs";
import {
  ClaudeCredentialStorePreflightError,
  assertSanitizedEvidence,
  classifyRefreshPath,
  claudeOauthKeychainService,
  credentialRotated,
  detectAuthLoginTranscript,
  parseClaudeCredentialStoreArguments,
  parseClaudeOauthCredential,
  preflightClaudeCredentialStore,
  redactTranscript,
  summarizeCredential,
  summarizeLocations,
  supportsConfigDirNamespacing,
} from "./claude-credential-store-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(
    path.join(
      here,
      "..",
      "..",
      "packages",
      "adapters",
      "claude-local",
      "src",
      "server",
      "__fixtures__",
      "claude-auth-login-credential.json",
    ),
    "utf8",
  ),
);

// Matches packages/adapters/claude-local/src/server/quota.ts:169-171. A drift
// here means the harness and the production reader name different Keychain items,
// which would make probe C report a false "absent".
const productionService = (dir) =>
  `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;

test("the Keychain service name matches the production reader's derivation", () => {
  const dir = "/var/folders/paperclip/ai-local-logins/abc";
  assert.equal(claudeOauthKeychainService(dir), productionService(dir));
});

test("config-dir namespacing is version-gated at 2.1.121", () => {
  assert.equal(supportsConfigDirNamespacing("2.1.121 (Claude Code)"), true);
  assert.equal(supportsConfigDirNamespacing("2.1.226"), true);
  assert.equal(supportsConfigDirNamespacing("3.0.0"), true);
  assert.equal(supportsConfigDirNamespacing("2.1.120"), false);
  assert.equal(supportsConfigDirNamespacing("2.1.19"), false);
  // Below the floor every config dir shares one Keychain entry, which is the
  // account-crossing failure in anthropics/claude-code#20553.
  assert.equal(supportsConfigDirNamespacing("2.0.0"), false);
  assert.equal(supportsConfigDirNamespacing("not-a-version"), null);
});

test("arguments select probes and fail closed on an unknown one", () => {
  assert.deepEqual(parseClaudeCredentialStoreArguments(["A", "--allow-destructive"]).probes, ["A"]);
  assert.deepEqual(parseClaudeCredentialStoreArguments(["--probes", "b, d"]).probes, ["B", "D"]);
  assert.equal(parseClaudeCredentialStoreArguments(["--keep-home"]).keepHome, true);
  assert.equal(parseClaudeCredentialStoreArguments(["--platform", "Darwin"]).platform, "darwin");
  assert.throws(
    () => parseClaudeCredentialStoreArguments(["--probes", "A,Z"]),
    (error) => error instanceof ClaudeCredentialStorePreflightError && error.code === "unknown_probe",
  );
  assert.throws(
    () => parseClaudeCredentialStoreArguments(["--nope"]),
    (error) => error.code === "invalid_arguments",
  );
});

test("preflight requires an explicit destructive opt-in", () => {
  assert.throws(
    () => preflightClaudeCredentialStore({ probes: ["A"] }, { platform: "linux" }),
    (error) => error instanceof ClaudeCredentialStorePreflightError && error.code === "destructive_opt_in_required",
  );
  const config = preflightClaudeCredentialStore(
    { probes: ["A", "B"], allowDestructive: true },
    { platform: "linux" },
  );
  assert.equal(config.probes.length, 2);
  assert.equal(config.keychainProbesSupported, false);
  assert.equal(config.requiresRefreshToken, true);
  assert.equal(config.requiresBrowserSignIn, true);
  assert.equal(
    preflightClaudeCredentialStore({ probes: ["C"], allowDestructive: true }, { platform: "darwin" })
      .keychainProbesSupported,
    true,
  );
});

test("the full credential parser recovers the refresh fields the reader drops", () => {
  const parsed = parseClaudeOauthCredential(JSON.stringify(FIXTURE));
  assert.equal(typeof parsed.refreshToken, "string");
  assert.equal(typeof parsed.expiresAt, "number");
  assert.equal(typeof parsed.refreshTokenExpiresAt, "number");
  assert.deepEqual(parsed.scopes, ["user:inference", "user:profile"]);
  assert.equal(parsed.subscriptionType, "max");
});

test("the credential parser fails closed on a payload without an access token", () => {
  assert.equal(parseClaudeOauthCredential("not json"), null);
  assert.equal(parseClaudeOauthCredential("[]"), null);
  assert.equal(parseClaudeOauthCredential("{}"), null);
  assert.equal(parseClaudeOauthCredential(JSON.stringify({ claudeAiOauth: {} })), null);
  assert.equal(parseClaudeOauthCredential(JSON.stringify({ claudeAiOauth: { accessToken: "" } })), null);
});

test("summaries expose presence and expiry class but never a value", () => {
  // Just past the fixture's access-token expiry, and well inside its refresh
  // token's window. This is the state a Paperclip connection is in when it dies.
  const now = FIXTURE.claudeAiOauth.expiresAt + 100_000_000;
  const summary = summarizeCredential(JSON.stringify(FIXTURE), now);
  assert.deepEqual(summary, {
    hasAccessToken: true,
    hasRefreshToken: true,
    accessTokenExpiry: "past",
    refreshTokenExpiry: "beyond_8d",
    scopeCount: 2,
    canReadUsage: true,
    fingerprint: summary.fingerprint,
  });
  assert.match(summary.fingerprint, /^[0-9a-f]{16}$/);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /REDACTED/);
  // The fingerprint is a one-way digest, the same 16-char generation shape the
  // control plane already stores, so it carries no token material.
  assert.doesNotMatch(summary.fingerprint, /sk-ant/);
});

test("async credential readers are awaited, not mistaken for raw values", async () => {
  // Regression: the readers return Promises. A synchronous classifier saw a
  // Promise, never equal to null, failed to parse it, and reported every
  // location as "unparsable" — which would have made probes C and D silently
  // useless on every platform.
  const locations = await summarizeLocations({
    dotfile: async () => JSON.stringify(FIXTURE),
    credentials: async () => null,
    keychain: async () => {
      throw new Error("keychain_unreadable");
    },
  });
  assert.equal(locations.dotfile.state, "present");
  assert.equal(locations.dotfile.summary.hasRefreshToken, true);
  assert.equal(locations.credentials.state, "absent");
  assert.equal(locations.keychain.state, "unreadable");
});

test("a failing reader does not hide the state of the other locations", async () => {
  const locations = await summarizeLocations({
    dotfile: async () => JSON.stringify(FIXTURE),
    credentials: async () => {
      throw new Error("boom");
    },
    keychain: async () => "not json",
  });
  assert.equal(locations.dotfile.state, "present");
  assert.equal(locations.credentials.state, "unreadable");
  // Present but not parseable is its own state, not a silent null.
  assert.equal(locations.keychain.state, "unparsable");
});

test("rotation is detected even when the expiry class does not move", () => {
  const before = summarizeCredential(
    JSON.stringify({ claudeAiOauth: { ...FIXTURE.claudeAiOauth, expiresAt: 1_800_000_000_000 } }),
  );
  // Same "beyond_8d" bucket on both sides, but a different token.
  const after = summarizeCredential(
    JSON.stringify({
      claudeAiOauth: {
        ...FIXTURE.claudeAiOauth,
        accessToken: "sk-ant-oat01-a-different-access-token-value",
        expiresAt: 1_800_000_100_000,
      },
    }),
  );
  assert.equal(before.accessTokenExpiry, after.accessTokenExpiry);
  // An expiry class alone cannot see this; the fingerprint can.
  assert.equal(credentialRotated(before, after), true);
  assert.equal(credentialRotated(before, before), false);
  assert.equal(credentialRotated(null, after), null);
});

test("redaction is idempotent", () => {
  const capture = [
    "https://claude.ai/oauth/authorize?client_id=abc&code=SECRETCODE",
    "sk-ant-oat01-REALLOOKINGTOKENVALUE",
  ].join("\n");
  const once = redactTranscript(capture);
  const twice = redactTranscript(once);
  assert.equal(twice, once);
  assert.match(once, /<REDACTED_AUTHORIZATION_URL>/);
  assert.match(once, /<REDACTED_TOKEN>/);
  // The trailing-opaque-value rule must not chew the placeholders themselves.
  assert.doesNotMatch(once, /REDACTED_OPAQUE_VALUE/);
});

test("preflight defaults to every probe rather than crashing", () => {
  const config = preflightClaudeCredentialStore({ allowDestructive: true }, { platform: "linux" });
  assert.deepEqual(config.probes, ["A", "B", "C", "D", "E"]);
  assert.equal(config.requiresRefreshToken, true);
  assert.equal(config.requiresBrowserSignIn, true);
  assert.throws(
    () => preflightClaudeCredentialStore({ allowDestructive: true, probes: ["A", "Z"] }, { platform: "linux" }),
    (error) => error.code === "unknown_probe" && error.details.unknown.includes("Z"),
  );
});

test("an inference-only credential is reported as unable to read usage", () => {
  const inferenceOnly = JSON.stringify({
    claudeAiOauth: { accessToken: "sk-ant-oat01-synthetic", scopes: ["user:inference"] },
  });
  // This is exactly what `claude setup-token` mints, and why an Anthropic
  // subscription connection on master has no quota probe.
  assert.equal(summarizeCredential(inferenceOnly).canReadUsage, false);
});

test("expiry classes distinguish a rotated credential from a stale one", () => {
  const now = 1_755_000_000_000;
  const build = (expiresAt) =>
    summarizeCredential(JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt } }), now);
  assert.equal(build(now - 1).accessTokenExpiry, "past");
  assert.equal(build(now + 3_600_000).accessTokenExpiry, "within_24h");
  assert.equal(build(now + 3 * 86_400_000).accessTokenExpiry, "within_8d");
  assert.equal(build(now + 90 * 86_400_000).accessTokenExpiry, "beyond_8d");
  assert.equal(
    summarizeCredential(JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x" } }), now)
      .accessTokenExpiry,
    "absent",
  );
});

test("an unreadable Keychain is distinguishable from a missing credential", async () => {
  const locations = await summarizeLocations({
    dotfile: () => null,
    keychain: () => {
      throw new Error("keychain_unreadable");
    },
  });
  // anthropics/claude-code#19456 makes this a real state: an ACL failure reads
  // as "nothing changed" if it is collapsed into "absent".
  assert.equal(locations.keychain.state, "unreadable");
  assert.equal(locations.dotfile.state, "absent");
  assert.equal(locations.credentials.state, "unsupported");
});

test("transcript detection separates the shared prompt from the setup-token sink", () => {
  const authLogin = [
    "Opening browser to sign in…",
    "Browser didn't open? Use the url below to sign in (c to copy)",
    "https://claude.ai/oauth/authorize?client_id=REDACTED",
    "Paste code here if prompted > ",
    "✓ Login successful.",
  ].join("\n");
  const shape = detectAuthLoginTranscript(authLogin);
  assert.equal(shape.urlPreamble, true);
  assert.equal(shape.codePrompt, true);
  assert.equal(shape.setupTokenSuccessRecord, false);
  assert.equal(shape.authLoginSuccess, true);

  const setupToken = "✓ Long-lived authentication token created successfully!";
  assert.equal(detectAuthLoginTranscript(setupToken).setupTokenSuccessRecord, true);

  const failure = "Login failed: invalid refresh token";
  assert.equal(detectAuthLoginTranscript(failure).failureSignal, true);
});

test("transcript detection reports no credential for an empty capture", () => {
  const shape = detectAuthLoginTranscript("");
  assert.equal(shape.urlPreamble, false);
  assert.equal(shape.codePrompt, false);
  assert.equal(shape.byteLength, 0);
});

test("redaction removes tokens, authorization URLs, and OAuth query values", () => {
  const capture = [
    "https://claude.ai/oauth/authorize?client_id=abc&code=SECRETCODE&state=SECRETSTATE",
    "sk-ant-oat01-REALLOOKINGTOKENVALUE",
    "sk-ant-ort01-ANOTHERSECRETREFRESHVALUE",
    "done",
  ].join("\n");
  const redacted = redactTranscript(capture);
  assert.doesNotMatch(redacted, /SECRETCODE|SECRETSTATE/);
  assert.doesNotMatch(redacted, /sk-ant-/);
  assert.match(redacted, /<REDACTED_AUTHORIZATION_URL>/);
  assert.match(redacted, /<REDACTED_TOKEN>/);
});

test("sanitized evidence rejects credential fields and token-shaped values", () => {
  assert.doesNotThrow(() =>
    assertSanitizedEvidence({ hasRefreshToken: true, refreshTokenExpiry: "beyond_8d" }),
  );
  assert.throws(() => assertSanitizedEvidence({ accessToken: "x" }), /unsafe_evidence_key/);
  assert.throws(
    () => assertSanitizedEvidence({ nested: { refreshToken: "x" } }),
    /unsafe_evidence_key/,
  );
  assert.throws(
    () => assertSanitizedEvidence({ note: "sk-ant-oat01-real" }),
    /unsafe_evidence_token/,
  );
  assert.throws(
    () => assertSanitizedEvidence({ note: "callback?code=secret" }),
    /unsafe_evidence_query/,
  );
  // The real summary keys must stay legal, since they carry the finding.
  assert.doesNotThrow(() =>
    assertSanitizedEvidence(
      summarizeCredential(JSON.stringify(FIXTURE)),
      "$.probes.C.locations.keychain.summary",
    ),
  );
});

test("outcome classification maps the measured facts to a design decision", () => {
  assert.equal(
    classifyRefreshPath({ refreshPathWorked: true, keychainFirst: true }),
    "managed_home_keychain_first",
  );
  assert.equal(
    classifyRefreshPath({ refreshPathWorked: true, keychainFirst: false }),
    "managed_home_file_first",
  );
  // A TTY requirement means Paperclip would have to own the OAuth exchange.
  assert.equal(
    classifyRefreshPath({ refreshPathWorked: true, refreshRequiresTty: true }),
    "refresh_token_path_blocked",
  );
  // An undrivable PTY means the in-app browser-code sign-in is unavailable.
  assert.equal(
    classifyRefreshPath({ refreshPathWorked: true, ptyDrivable: false }),
    "refresh_token_path_blocked",
  );
  assert.equal(classifyRefreshPath({}), "refresh_token_path_blocked");
});

// --- Probe C / D against the real filesystem --------------------------------
// These exercise the harness's own reader path, not a re-implementation. The
// async-read defect lived here, so a unit test over the library alone would not
// have caught it.

test("probe C reads a real credentials file off disk and prefers it", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-credential-store-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, ".credentials.json"), JSON.stringify(FIXTURE), { mode: 0o600 });

  const store = await inspectCredentialStore(dir);
  assert.equal(store.locations.dotfile.state, "present");
  assert.equal(store.locations.dotfile.summary.hasRefreshToken, true);
  assert.equal(store.locations.credentials.state, "absent");
  assert.equal(store.preferred, "dotfile");
  // Off darwin the Keychain reader returns null rather than throwing, so a
  // non-Mac run reports "absent" instead of a spurious ACL failure.
  assert.equal(store.locations.keychain.state, "absent");
  assert.match(store.keychainService, /^Claude Code-credentials-[0-9a-f]{8}$/);
});

test("probe C reports usage capability from the stored scopes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-credential-store-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // What `claude setup-token` mints: inference only, so the Anthropic usage API
  // 403s and the connection has no quota probe.
  await writeFile(
    path.join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-synthetic", scopes: ["user:inference"] },
    }),
    { mode: 0o600 },
  );
  const result = await probeCredentialLocations(dir, { keychainProbesSupported: false });
  assert.equal(result.usageProbeCapable, false);
  assert.equal(result.preferred, "dotfile");
});

test("probe D detects a real in-place credential rotation on disk", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-credential-store-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".credentials.json");

  await writeFile(file, JSON.stringify(FIXTURE), { mode: 0o600 });
  const baseline = (await inspectCredentialStore(dir)).locations.dotfile.summary;

  // A refresh that leaves the expiry class unchanged but rotates the token. This
  // is the case an expiry-class comparison alone cannot see.
  await writeFile(
    file,
    JSON.stringify({
      claudeAiOauth: {
        ...FIXTURE.claudeAiOauth,
        accessToken: "sk-ant-oat01-ROTATED-access-token-value",
      },
    }),
    { mode: 0o600 },
  );

  const result = await probeInPlaceRefresh(dir, { baselineSummary: baseline });
  assert.equal(result.rotatedInPlace, true);
  assert.equal(result.readBackLocation, "dotfile");
  assert.notEqual(result.baselineFingerprint, result.currentFingerprint);
  // Regression: these keys used to be `accessToken`/`refreshToken`, which the
  // harness's own redaction gate rejects — so a real run threw at the very end
  // and wrote no evidence at all.
  assert.ok(result.baselineExpiry.accessTokenExpiry);
  assert.ok(result.currentExpiry.refreshTokenExpiry);
  assert.doesNotThrow(() => assertSanitizedEvidence(result));
  assert.doesNotMatch(JSON.stringify(result), /sk-ant/);
});

test("probe D reports no baseline instead of claiming an unchanged credential", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-credential-store-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // An absent baseline must read as "not measured", never as "unchanged" — the
  // latter would silently endorse a write-back that never happened.
  const result = await probeInPlaceRefresh(dir, { baselineSummary: null });
  assert.equal(result.rotatedInPlace, null);
  assert.equal(result.reason, "no_baseline_credential");
});

test("a complete five-probe summary survives the final redaction gate", async (t) => {
  // The last line of defence before evidence is written. If any probe's shape
  // trips it, `runProbes` throws and the whole characterization is lost with no
  // file on disk. This asserts the full document the way runProbes builds it.
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-credential-store-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, ".credentials.json"), JSON.stringify(FIXTURE), { mode: 0o600 });

  const store = await inspectCredentialStore(dir);
  const baseline = store.locations.dotfile.summary;
  const probeC = await probeCredentialLocations(dir, { keychainProbesSupported: false });
  const probeD = await probeInPlaceRefresh(dir, { baselineSummary: baseline });

  const summary = {
    schemaVersion: 1,
    smoke: "claude_credential_store",
    platform: process.platform,
    node: process.version,
    claude: {
      available: true,
      version: "2.1.226 (Claude Code)",
      supportsConfigDirNamespacing: true,
      supportsIsolatedKeychain: true,
    },
    python: "python3",
    outcome: "managed_home_file_first",
    outcomeValid: true,
    probes: {
      A: {
        urlPreamble: true,
        codePrompt: true,
        setupTokenSuccessRecord: false,
        ptyDrivable: true,
        observedBytes: 412,
      },
      B: {
        exitCode: 0,
        authLoginSuccess: true,
        failureSignal: false,
        requiresTty: false,
        workedHeadlessly: true,
        durationMs: 4210,
        credentialLanded: "fresh",
      },
      C: probeC,
      D: probeD,
      E: { parsed: true, loggedIn: true, authMethod: "oauth-token", envTokenWins: true, conclusive: true },
    },
    failure: null,
  };

  assert.doesNotThrow(() => assertSanitizedEvidence(summary));
  // And a genuine leak still fails, so the gate is not vacuous.
  assert.throws(
    () => assertSanitizedEvidence({ ...summary, probes: { B: { refreshToken: "leak" } } }),
    /unsafe_evidence_key/,
  );
  assert.throws(
    () => assertSanitizedEvidence({ ...summary, probes: { B: { note: "sk-ant-oat01-leak" } } }),
    /unsafe_evidence_token/,
  );
});