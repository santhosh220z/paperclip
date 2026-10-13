#!/usr/bin/env node

// Anthropic subscription credential-store characterization for GitHub #15958.
//
// What this decides: Paperclip ships an Anthropic subscription connection as a
// bare `CLAUDE_CODE_OAUTH_TOKEN`. That env var takes precedence over any stored
// login, so the Claude CLI can never refresh it, and the connection dies at the
// access token's expiry. The proposed fix is to stop injecting the env var, seed
// the disposable managed `CLAUDE_CONFIG_DIR` with the full credential, and let
// the CLI refresh natively.
//
// That fix is only safe if three things are true. This harness measures them
// against a real Claude Code CLI:
//
//   A. `claude auth login` shares the browser-code prompt shape, so the existing
//      in-app PTY runner can still collect a code.
//   B. `claude auth login` spends a refresh token from
//      `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` headlessly, so Paperclip never has to
//      implement Anthropic's OAuth client itself.
//   C. The CLI persists a refreshed credential somewhere Paperclip can read it
//      back — a file, or a per-directory macOS Keychain item.
//
// Probe C is the one that cannot be assumed. Upstream documents that macOS
// stores credentials in the Keychain and deletes the plaintext file once the
// Keychain write succeeds, so a cleanup read that checks the file first will miss
// most rotations. Run this on a Mac before trusting the managed-home design.
//
// Usage:
//   node scripts/smoke/claude-credential-store.mjs --allow-destructive
//   node scripts/smoke/claude-credential-store.mjs A --allow-destructive
//   ANTHROPIC_OAUTH_REFRESH_TOKEN=... node scripts/smoke/claude-credential-store.mjs B,C --allow-destructive
//
// Safety: no credential value is ever written to evidence. Callers receive
// presence booleans and expiry classes only, and `assertSanitizedEvidence` is the
// final gate before the summary is written.

import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CLAUDE_CREDENTIAL_STORE_OUTCOMES,
  ClaudeCredentialStorePreflightError,
  assertSanitizedEvidence,
  classifyRefreshPath,
  claudeOauthKeychainService,
  credentialRotated,
  detectAuthLoginTranscript,
  parseClaudeCredentialStoreArguments,
  preflightClaudeCredentialStore,
  summarizeLocations,
  supportsConfigDirNamespacing,
} from "./claude-credential-store-lib.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 90_000;

// Node has no PTY API. Python's standard-library pty module supplies the
// terminal the Claude login UI needs. This bridge forwards only bytes; the
// provider output is classified and redacted, never stored raw. Mirrors
// PYTHON_PTY_BRIDGE in server/src/services/local-ai-browser-login.ts.
const PYTHON_PTY_BRIDGE = String.raw`
import os, pty, select, sys
pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
def stop(*_args):
    try: os.killpg(pid, 15)
    except ProcessLookupError: pass
    sys.exit(0)
while True:
    readable, _, _ = select.select([master, 0], [], [])
    if 0 in readable:
        data = os.read(0, 4096)
        if data: os.write(master, data)
        else: stop()
    if master in readable:
        try: data = os.read(master, 4096)
        except OSError: break
        if not data: break
        os.write(1, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

class ProbeFailure extends Error {
  constructor(probe, code, details = null) {
    super(`${probe}:${code}`);
    this.name = "ProbeFailure";
    this.probe = probe;
    this.code = code;
    this.details = details;
  }
}

function fail(probe, code, details = null) {
  throw new ProbeFailure(probe, code, details);
}

// --- host inspection ---------------------------------------------------------

async function commandVersion(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, output: String(stdout ?? "").trim() };
  } catch (error) {
    return { ok: false, output: String(error?.stdout ?? "").trim() };
  }
}

async function resolveClaudeCli() {
  const version = await commandVersion("claude", ["--version"]);
  if (!version.ok || !version.output) return null;
  const namespaced = supportsConfigDirNamespacing(version.output);
  return {
    available: true,
    version: version.output,
    supportsConfigDirNamespacing: namespaced,
    // Below 2.1.121 every config dir shares one Keychain entry, which is the
    // account-crossing failure in anthropics/claude-code#20553. A managed-home
    // design must refuse these builds rather than isolate nothing.
    supportsIsolatedKeychain: namespaced === true,
  };
}

async function resolvePython() {
  for (const candidate of ["python3", "python"]) {
    const probe = await commandVersion(candidate, ["-c", "import pty"]);
    if (probe.ok) return candidate;
  }
  return null;
}

// --- credential readers ------------------------------------------------------

async function readFileOrNull(file) {
  try {
    await stat(file);
  } catch {
    return null;
  }
  try {
    return await readFile(file, "utf8");
  } catch {
    const error = new Error("unreadable");
    error.code = "unreadable";
    throw error;
  }
}

/**
 * `security find-generic-password` exits 44 (`errSecItemNotFound`) when the item
 * simply does not exist yet, which is the normal state before a first login. Any
 * other non-zero exit is a real read failure — most often the ACL problem in
 * anthropics/claude-code#19456, where the entry exists but macOS refuses to hand
 * it over. Collapsing those two into "absent" would make a silent write-back
 * failure look like an unchanged credential.
 */
const KEYCHAIN_ITEM_NOT_FOUND_EXIT = 44;

async function readKeychainOrNull(configDir) {
  if (process.platform !== "darwin") return null;
  const service = claudeOauthKeychainService(configDir);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    ));
  } catch (error) {
    if (error?.code === KEYCHAIN_ITEM_NOT_FOUND_EXIT) return null;
    const denied = new Error("keychain_unreadable");
    denied.code = "keychain_unreadable";
    throw denied;
  }
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    const error = new Error("keychain_unreadable");
    error.code = "keychain_unreadable";
    throw error;
  }
  return stdout;
}

function credentialReaders(configDir) {
  return {
    dotfile: () => readFileOrNull(path.join(configDir, ".credentials.json")),
    credentials: () => readFileOrNull(path.join(configDir, "credentials.json")),
    keychain: () => readKeychainOrNull(configDir),
  };
}

/**
 * Reads every credential location and reports which one the CLI would prefer.
 *
 * Upstream documents that macOS reads the Keychain even when a credentials file
 * is also present, and deletes the file once the Keychain write succeeds. So the
 * preferred location is Keychain-first on darwin. Recording this explicitly is
 * the point of probe C.
 */
async function inspectCredentialStore(configDir) {
  const locations = await summarizeLocations(credentialReaders(configDir));
  const keychain = locations.keychain?.state === "present";
  const dotfile = locations.dotfile?.state === "present";
  const credentials = locations.credentials?.state === "present";
  const preferred = keychain ? "keychain" : dotfile ? "dotfile" : credentials ? "credentials" : null;
  return {
    keychainService: claudeOauthKeychainService(configDir),
    locations,
    preferred,
    // macOS deleted the plaintext file after a successful Keychain write
    // (anthropics/claude-code#1414), so a missing file is not evidence of a
    // missing rotation.
    fileAbsentAfterKeychainWrite: keychain && !dotfile && !credentials,
  };
}

function childEnv(base, overrides = {}) {
  const env = { ...base };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
  ]) {
    if (!(key in overrides)) delete env[key];
  }
  return { ...env, ...overrides };
}

// --- probes ------------------------------------------------------------------

/**
 * Probe A: observe `claude auth login` far enough to classify its output shape.
 * Observe-only. It never completes an authorization, so it needs no credential.
 */
async function probeAuthLoginShape(configDir, context) {
  if (!context.python) fail("A", "python_unavailable");
  const controller = new AbortController();
  let child = null;
  let capture = "";
  try {
    await new Promise((resolve, reject) => {
      child = spawn(
        context.python,
        ["-u", "-c", PYTHON_PTY_BRIDGE, "claude", "auth", "login"],
        {
          env: childEnv(process.env, { CLAUDE_CONFIG_DIR: configDir, BROWSER: "true" }),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const timer = setTimeout(() => {
        controller.abort();
        reject(new ProbeFailure("A", "prompt_timeout", { observedBytes: capture.length }));
      }, 45_000);
      child.stdout.on("data", (bytes) => {
        capture += bytes.toString("utf8");
        // Stop as soon as the code prompt appears; the rest needs a human.
        if (detectAuthLoginTranscript(capture).codePrompt) {
          clearTimeout(timer);
          controller.abort();
          resolve();
        }
      });
      child.stderr.resume();
      child.once("error", () => {
        clearTimeout(timer);
        reject(new ProbeFailure("A", "pty_spawn_failed"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (controller.signal.aborted) resolve();
        else reject(new ProbeFailure("A", "exited_before_prompt", { exitCode: code }));
      });
    });
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }

  const shape = detectAuthLoginTranscript(capture);
  return {
    urlPreamble: shape.urlPreamble,
    codePrompt: shape.codePrompt,
    // If this were true the existing stdout credential sink would work and the
    // in-app sign-in would need no new credential read at all.
    setupTokenSuccessRecord: shape.setupTokenSuccessRecord,
    // Production parser behaviour is pinned by
    // packages/adapters/claude-local/src/server/setup-token-parse.auth-login.test.ts
    // rather than duplicated here.
    ptyDrivable: shape.urlPreamble && shape.codePrompt,
    observedBytes: shape.byteLength,
  };
}

/**
 * Probe B: spend a refresh token through `claude auth login` with no browser, no
 * stdin, and no PTY. This is the whole design. If it does not work headlessly,
 * Paperclip would have to implement Anthropic's OAuth client itself.
 */
async function probeRefreshTokenFastPath(configDir, context) {
  if (!context.refreshToken) fail("B", "refresh_token_missing");
  const scopes = context.scopes;
  const startedAt = Date.now();
  let result;
  try {
    const { stdout, stderr } = await execFileAsync("claude", ["auth", "login"], {
      env: childEnv(process.env, {
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: context.refreshToken,
        CLAUDE_CODE_OAUTH_SCOPES: scopes,
      }),
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    result = { exitCode: 0, stdout, stderr };
  } catch (error) {
    result = {
      exitCode: typeof error?.code === "number" ? error.code : null,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
    };
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const shape = detectAuthLoginTranscript(output);
  // A refusal to run without a terminal is the one failure that changes the plan.
  const requiresTty = /(?:not a terminal|requires a (?:tty|terminal)|isatty)/i.test(output);
  return {
    exitCode: result.exitCode,
    authLoginSuccess: shape.authLoginSuccess,
    failureSignal: shape.failureSignal,
    requiresTty,
    // Recorded for the record only, never copied into evidence.
    workedHeadlessly: result.exitCode === 0 && !requiresTty,
    durationMs: Date.now() - startedAt,
  };
}

/** Probe C: where did the credential land, and which location does the CLI read? */
async function probeCredentialLocations(configDir, context) {
  const store = await inspectCredentialStore(configDir);
  const afterSummary =
    store.preferred === "keychain"
      ? store.locations.keychain.summary
      : store.locations[store.preferred]?.summary ?? null;
  return {
    ...store,
    keychainProbesSupported: context.keychainProbesSupported,
    // A setup-token credential grants `user:inference` only, so the Anthropic
    // usage API returns 403 and the connection has no quota probe. This is the
    // observability cost of #14970's login switch.
    usageProbeCapable: afterSummary?.canReadUsage ?? false,
  };
}

/**
 * Probe D: did the refresh rotate the stored credential in place, and in which
 * artifact? Compares the pre- and post-refresh summaries. Never reads a value.
 */
async function probeInPlaceRefresh(configDir, context) {
  const after = await inspectCredentialStore(configDir);
  const baseline = context.baselineSummary;
  const current =
    after.preferred === "keychain"
      ? after.locations.keychain.summary
      : after.locations[after.preferred]?.summary ?? null;
  if (!baseline || !current) {
    return {
      rotatedInPlace: null,
      reason: baseline ? "post_credential_unreadable" : "no_baseline_credential",
      preferred: after.preferred,
    };
  }
  return {
    rotatedInPlace: credentialRotated(baseline, current),
    // The read-back must follow `preferred`, which is Keychain-first on macOS.
    readBackLocation: after.preferred,
    // Field names mirror `summarizeCredential`. They must NOT be `accessToken` /
// `refreshToken`: those are rejected by `assertSanitizedEvidence`, which would
// make this probe's own output fail the harness's final redaction gate and lose
// the entire run.
    baselineExpiry: {
      accessTokenExpiry: baseline.accessTokenExpiry,
      refreshTokenExpiry: baseline.refreshTokenExpiry,
    },
    currentExpiry: {
      accessTokenExpiry: current.accessTokenExpiry,
      refreshTokenExpiry: current.refreshTokenExpiry,
    },
    baselineFingerprint: baseline.fingerprint,
    currentFingerprint: current.fingerprint,
    hasRefreshToken: current.hasRefreshToken,
  };
}

/**
 * Probe E: prove that `CLAUDE_CODE_OAUTH_TOKEN` really does override a stored
 * login. This is the direct explanation of the bug: Paperclip injects that env
 * var, so the CLI never consults the store and never refreshes.
 *
 * Uses a sentinel value and `claude auth status`, which reports the active auth
 * method without making a provider request. No network call, no real credential.
 */
async function probeEnvTokenPrecedence(context) {
  const sentinel = "sk-ant-oat01-characterization-sentinel-not-a-real-token";
  const { stdout } = await execFileAsync("claude", ["auth", "status"], {
    env: childEnv(process.env, { CLAUDE_CODE_OAUTH_TOKEN: sentinel }),
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  }).catch((error) => ({ stdout: error?.stdout ?? "" }));
  let parsed = null;
  try {
    parsed = JSON.parse(String(stdout ?? ""));
  } catch {
    return { parsed: false, envTokenWins: null };
  }
  // `authMethod` values observed in this repo: "claude.ai", "oauth-token".
  const authMethod = typeof parsed?.authMethod === "string" ? parsed.authMethod : null;
  return {
    parsed: true,
    loggedIn: parsed?.loggedIn === true,
    authMethod,
    envTokenWins: authMethod === "oauth-token" || authMethod === null,
    // A null authMethod is not proof, so the outcome classification treats an
    // unparsed status as inconclusive rather than as a positive.
    conclusive: authMethod !== null,
  };
}

// --- orchestration -----------------------------------------------------------

async function runProbes(config) {
  const startedAt = new Date();
  const summary = {
    schemaVersion: 1,
    smoke: "claude_credential_store",
    startedAt: startedAt.toISOString(),
    completedAt: null,
    platform: process.platform,
    node: process.version,
    claude: await resolveClaudeCli(),
    python: null,
    outcome: null,
    probes: {},
    failure: null,
  };

  const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-credential-store-"));
  const configDir = path.join(home, "claude");
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const refreshToken = process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN?.trim() || "";
  const context = {
    python: await resolvePython(),
    refreshToken,
    scopes:
      process.env.ANTHROPIC_OAUTH_SCOPES?.trim() ||
      "user:inference user:profile user:sessions:claude_code",
    keychainProbesSupported: process.platform === "darwin",
    baselineSummary: null,
  };
  summary.python = context.python;

  try {
    if (!summary.claude) fail("preflight", "claude_cli_unavailable");
    if (!context.python) fail("preflight", "python_unavailable");

    const order = ["A", "B", "C", "D", "E"];
    for (const probe of order) {
      if (!config.probes.includes(probe)) continue;
      try {
        if (probe === "A") summary.probes.A = await probeAuthLoginShape(configDir, context);
        if (probe === "B") {
          // Capture the pre-refresh summary before spending the token, so probe D
          // can tell an in-place rotation apart from an unchanged credential.
          const before = await inspectCredentialStore(configDir);
          context.baselineSummary =
            before.locations.dotfile.summary
            ?? before.locations.credentials.summary
            ?? before.locations.keychain.summary
            ?? null;
          summary.probes.B = await probeRefreshTokenFastPath(configDir, context);
          summary.probes.B.credentialLanded = before.preferred === null
            ? "fresh"
            : "replaced_existing";
        }
        if (probe === "C") summary.probes.C = await probeCredentialLocations(configDir, context);
        if (probe === "D") summary.probes.D = await probeInPlaceRefresh(configDir, context);
        if (probe === "E") summary.probes.E = await probeEnvTokenPrecedence(context);
      } catch (error) {
        if (error instanceof ProbeFailure) {
          summary.probes[probe] = { error: error.code, ...(error.details ?? {}) };
          continue;
        }
        throw error;
      }
    }

    // Only claim an outcome the measured probes actually support. A probe that
    // errored contributes `undefined`, which must read as "not demonstrated"
    // rather than as a silent pass.
    summary.outcome = classifyRefreshPath({
      refreshPathWorked: summary.probes.B?.workedHeadlessly === true,
      refreshRequiresTty: summary.probes.B?.requiresTty === true,
      ptyDrivable: config.probes.includes("A")
        ? summary.probes.A?.ptyDrivable === true
        : true,
      keychainFirst: summary.probes.C?.preferred === "keychain",
    });
    summary.outcomeValid = CLAUDE_CREDENTIAL_STORE_OUTCOMES.includes(summary.outcome);
  } catch (error) {
    summary.failure =
      error instanceof ProbeFailure
        ? { probe: error.probe, code: error.code }
        : { probe: "orchestrator", code: "unexpected_error" };
  } finally {
    // The home holds a real credential on probes B through D. Shred it unless the
    // developer explicitly asked to inspect it.
    if (config.keepHome) summary.home = home;
    else await rm(home, { recursive: true, force: true }).catch(() => {});
    summary.completedAt = new Date().toISOString();
  }

  // The final redaction gate. A failure here means a probe serialized something
  // credential-bearing, so no evidence file is written at all.
  assertSanitizedEvidence(summary);
  // Same layout as the other live smokes: one directory per run under a scratch
  // root, so a stray run in the repo root does not litter it with loose files.
  const scratchRoot =
    process.env.PAPERCLIP_CREDENTIAL_STORE_EVIDENCE_DIR
    || process.env.PAPERCLIP_RUN_SCRATCH_DIR
    || process.cwd();
  const outputDirectory = path.join(
    scratchRoot,
    `claude-credential-store-${startedAt.toISOString().replace(/[:.]/g, "-")}`,
  );
  const { writeFile, mkdir: ensureDir } = await import("node:fs/promises");
  await ensureDir(outputDirectory, { recursive: true });
  const summaryPath = path.join(outputDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return { summary, summaryPath };
}

async function main() {
  let config;
  try {
    config = preflightClaudeCredentialStore(
      parseClaudeCredentialStoreArguments(process.argv.slice(2)),
      { platform: process.platform },
    );
  } catch (error) {
    const code = error instanceof ClaudeCredentialStorePreflightError ? error.code : "unknown";
    process.stderr.write(`claude credential-store harness preflight failed: ${code}\n`);
    if (code === "destructive_opt_in_required") {
      process.stderr.write("Pass --allow-destructive. This runs the real claude CLI.\n");
    }
    process.exitCode = 2;
    return;
  }

  const { summary, summaryPath } = await runProbes(config);
  if (summary.failure) {
    process.stderr.write(
      `claude credential-store characterization failed at ${summary.failure.probe} (${summary.failure.code}).\n`,
    );
  } else {
    process.stdout.write(
      `Outcome: ${summary.outcome}\n` +
        `Evidence: ${summaryPath}\n` +
        `Attach this run to #15958.\n`,
    );
  }
  if (!summary.failure) process.exitCode = 0;
  else process.exitCode = 1;
}

// Importable for tests without executing the CLI. `node --test` imports this
// module to exercise probe C's real reader path, which is exactly the code that
// used to mis-classify async reads.
const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) await main();

export { credentialReaders, inspectCredentialStore, probeCredentialLocations, probeInPlaceRefresh };