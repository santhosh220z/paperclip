// Claude subscription credential-store characterization library.
//
// Purpose: answer, against a real Claude Code CLI, the questions that decide the
// GitHub #15958 design. The issue reports that Anthropic subscription connections
// die after ~8h because Paperclip stores only `claudeAiOauth.accessToken` and
// discards the refresh token.
//
// Everything here is either pure or takes its side effects through injected
// parameters, so the whole library is unit-testable without the CLI, a browser,
// a Keychain, or a real credential. Nothing in this module returns, logs, or
// serializes a credential value. Callers get presence booleans and expiry
// classes; the raw bytes never leave the orchestrator.

import { createHash } from "node:crypto";

export const CLAUDE_CREDENTIAL_STORE_PROBES = ["A", "B", "C", "D", "E"];

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32", "other"]);

/**
 * The outcome of the spike. Each value is a different implementation plan, so
 * the classification is the deliverable rather than a pass/fail.
 *
 * - `managed_home_keychain_first`: `claude auth login` refreshes headlessly and
 *   the CLI persists to a per-directory Keychain item. Ship the full managed-home
 *   design with a Keychain-first cleanup read.
 * - `managed_home_file_first`: `claude auth login` refreshes headlessly and every
 *   supported platform persists to a file. Ship the same design, but the
 *   Keychain branch can land later in a smaller first pull request.
 * - `refresh_token_path_blocked`: the non-interactive refresh does not work, or
 *   `auth login` cannot be driven by the in-app runner. Keep `setup-token` as the
 *   default and offer `auth login` as a copy-command path only to obtain a
 *   refresh token.
 */
export const CLAUDE_CREDENTIAL_STORE_OUTCOMES = [
  "managed_home_keychain_first",
  "managed_home_file_first",
  "refresh_token_path_blocked",
];

export class ClaudeCredentialStorePreflightError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ClaudeCredentialStorePreflightError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Parses harness arguments. Supports `--probes A,B`, `--platform <name>`,
 * `--keep-home`, and `--allow-destructive`. A bare probe list is accepted so a
 * developer can rerun one probe in isolation.
 */
export function parseClaudeCredentialStoreArguments(args = []) {
  const options = {
    probes: [...CLAUDE_CREDENTIAL_STORE_PROBES],
    platform: null,
    keepHome: false,
    allowDestructive: false,
  };
  let index = 0;
  // A leading bare list (`A,C`) selects probes before any flag.
  if (args.length > 0 && !args[0].startsWith("-")) {
    options.probes = args[0].split(",").map((entry) => entry.trim().toUpperCase());
    index = 1;
  }
  while (index < args.length) {
      const flag = args[index];
      const value = args[index + 1];
      if (flag === "--allow-destructive") {
        options.allowDestructive = true;
        index += 1;
        continue;
      }
      if (flag === "--keep-home") {
        options.keepHome = true;
        index += 1;
        continue;
      }
      if (flag === "--probes" && typeof value === "string") {
        options.probes = value.split(",").map((entry) => entry.trim().toUpperCase());
        index += 2;
        continue;
      }
      if (flag === "--platform" && typeof value === "string") {
        options.platform = value.trim().toLowerCase();
        index += 2;
        continue;
      }
      throw new ClaudeCredentialStorePreflightError("invalid_arguments");
    }

  const unknown = options.probes.filter(
    (probe) => !CLAUDE_CREDENTIAL_STORE_PROBES.includes(probe),
  );
  if (options.probes.length === 0 || unknown.length > 0) {
    throw new ClaudeCredentialStorePreflightError("unknown_probe", {
      unknown: unknown.length > 0 ? unknown : options.probes,
    });
  }
  return options;
}

/**
 * Validates the harness configuration. Fails closed on a missing destructive
 * opt-in, because the probes spawn the real CLI against a real credential store.
 */
export function preflightClaudeCredentialStore(options = {}, context = {}) {
  const platform =
    typeof options.platform === "string" && options.platform
      ? options.platform
      : (context.platform ?? "other");
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new ClaudeCredentialStorePreflightError("unsupported_platform", { platform });
  }
  if (options.allowDestructive !== true) {
    throw new ClaudeCredentialStorePreflightError("destructive_opt_in_required");
  }
  // Default rather than crash: a caller that omits `probes` means "run them all".
  const probes = [...(options.probes ?? CLAUDE_CREDENTIAL_STORE_PROBES)];
  const unknown = probes.filter((probe) => !CLAUDE_CREDENTIAL_STORE_PROBES.includes(probe));
  if (probes.length === 0 || unknown.length > 0) {
    throw new ClaudeCredentialStorePreflightError("unknown_probe", { unknown });
  }
  // Probe C reads and writes a macOS Keychain item. On every other platform the
  // Keychain half cannot run, so record the limit rather than silently passing.
  const keychainProbesSupported = platform === "darwin";
  return {
    probes,
    platform,
    keepHome: options.keepHome === true,
    keychainProbesSupported,
    // Probes B, D, and E need a real refresh token to spend. Probe A needs a
    // human to finish the browser authorization. Probe C needs a credential.
    requiresRefreshToken: probes.some((probe) => ["B", "D", "E"].includes(probe)),
    requiresBrowserSignIn: probes.includes("A"),
  };
}

/**
 * The per-directory macOS Keychain service name for a Claude config dir.
 *
 * Mirrors `isolatedKeychainService` in
 * `packages/adapters/claude-local/src/server/quota.ts:169-171` exactly. The
 * harness computes it independently so a drift between the reader under test and
 * the production reader shows up as a mismatch rather than passing silently.
 * Namespacing exists only from Claude Code 2.1.121; see MIN_NAMESPACING_VERSION.
 */
export const CLAUDE_KEYCHAIN_SERVICE_PREFIX = "Claude Code-credentials-";
export const MIN_NAMESPACING_VERSION = "2.1.121";

export function claudeOauthKeychainService(configDir) {
  const digest = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE_PREFIX}${digest}`;
}

/** True when a semver-ish CLI string is at least `MIN_NAMESPACING_VERSION`. */
export function supportsConfigDirNamespacing(version) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number.parseInt(part, 10));
  const floor = MIN_NAMESPACING_VERSION.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < floor.length; index += 1) {
    if (parts[index] > floor[index]) return true;
    if (parts[index] < floor[index]) return false;
  }
  return true;
}

/**
 * Parses a full `claudeAiOauth` payload. This is the shape characterization is
 * meant to protect: the fields below are what a refreshable subscription
 * credential carries, and what `readVerifiedLocalAiCredential` currently drops.
 *
 * Returns only well-formed fields. A payload without an access token is not a
 * credential, so it returns null rather than a partial record.
 */
export function parseClaudeOauthCredential(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const oauth = parsed.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const text = (value) => (typeof value === "string" && value.length > 0 ? value : null);
  const epoch = (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const accessToken = text(oauth.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: text(oauth.refreshToken),
    expiresAt: epoch(oauth.expiresAt),
    refreshTokenExpiresAt: epoch(oauth.refreshTokenExpiresAt),
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope) => typeof scope === "string")
      : null,
    subscriptionType: text(oauth.subscriptionType),
  };
}

/** Classifies an epoch-millisecond instant without revealing it. */
function expiryClass(epochMs, now) {
  if (typeof epochMs !== "number") return "absent";
  if (epochMs <= now) return "past";
  if (epochMs <= now + 24 * 3_600_000) return "within_24h";
  if (epochMs <= now + 8 * 86_400_000) return "within_8d";
  return "beyond_8d";
}

/**
 * The redaction boundary. Reduces a raw credential payload to presence flags and
 * expiry classes. This is the only shape the orchestrator may put into evidence,
 * so no caller can leak a token by forgetting to redact.
 */
export function summarizeCredential(raw, now = Date.now()) {
  const parsed = typeof raw === "string" ? parseClaudeOauthCredential(raw) : raw;
  if (!parsed) return null;
  return {
    hasAccessToken: Boolean(parsed.accessToken),
    hasRefreshToken: Boolean(parsed.refreshToken),
    accessTokenExpiry: expiryClass(parsed.expiresAt, now),
    refreshTokenExpiry: expiryClass(parsed.refreshTokenExpiresAt, now),
    scopeCount: Array.isArray(parsed.scopes) ? parsed.scopes.length : 0,
    // Whether the granted scopes can read the usage API. `user:profile` is the
    // scope Anthropic requires for `api/oauth/usage`; a `setup-token` credential
    // requests `user:inference` only and therefore cannot show quota.
    canReadUsage:
      Array.isArray(parsed.scopes) && parsed.scopes.includes("user:profile"),
    // An expiry *class* is far too coarse to detect a rotation: a refresh that
    // moves the access token from "in 4h" to "in 8h" leaves both values in the
    // same bucket. This one-way digest is the same 16-character shape the
    // control plane already uses for credential generations
    // (server/src/services/ai-connection-runtime.ts and quotaCredentialHash), so
    // comparing it across two reads answers "did this credential change?" without
    // ever recording a token. It is a hash of a high-entropy secret, so it is not
    // a disclosure risk.
    fingerprint: credentialFingerprint(parsed),
  };
}

/** 16 hex characters of sha256 over the identity-bearing credential fields. */
export function credentialFingerprint(parsed) {
  const material = JSON.stringify({
    accessToken: parsed?.accessToken ?? null,
    refreshToken: parsed?.refreshToken ?? null,
    expiresAt: parsed?.expiresAt ?? null,
    refreshTokenExpiresAt: parsed?.refreshTokenExpiresAt ?? null,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * Whether a refresh actually rotated the stored credential. Compares
 * fingerprints first, then falls back to the expiry classes so a credential with
 * no expiry field still registers a change.
 */
export function credentialRotated(baseline, current) {
  if (!baseline || !current) return null;
  if (baseline.fingerprint !== current.fingerprint) return true;
  return (
    baseline.accessTokenExpiry !== current.accessTokenExpiry ||
    baseline.refreshTokenExpiry !== current.refreshTokenExpiry ||
    baseline.hasRefreshToken !== current.hasRefreshToken
  );
}

/** Where a credential was found. Paperclip must read every one of these. */
export const CREDENTIAL_LOCATIONS = ["dotfile", "credentials", "keychain"];

/**
 * Reports which credential locations exist for a config dir without recording any
 * value. A location is `present`, `absent`, `unreadable`, or `unparsable`, so a
 * macOS Keychain ACL failure (#19456) stays distinguishable from a genuinely
 * missing credential.
 *
 * Readers may be sync or async; both are awaited before classification. Every
 * reader is settled even when an earlier one fails, so one inaccessible location
 * cannot hide the state of the others.
 */
export async function summarizeLocations(readers, now = Date.now()) {
  const settled = await Promise.all(
    CREDENTIAL_LOCATIONS.map(async (location) => {
      const read = readers?.[location];
      if (typeof read !== "function") return [location, { state: "unsupported", summary: null }];
      let raw;
      try {
        raw = await read();
      } catch {
        return [location, { state: "unreadable", summary: null }];
      }
      if (raw === null || raw === undefined) {
        return [location, { state: "absent", summary: null }];
      }
      const summary = summarizeCredential(raw, now);
      return [location, summary ? { state: "present", summary } : { state: "unparsable", summary: null }];
    }),
  );
  return Object.fromEntries(settled);
}

// --- Transcript shape detection (probe A) -------------------------------------

// `claude auth login` and `claude setup-token` share the browser authorization
// flow, so both print this preamble. The production parser lives in
// `setup-token-parse.ts`; these detectors mirror only the success/failure
// discriminators so the harness can classify a capture without importing
// TypeScript. `setup-token-parse.auth-login.test.ts` is what actually pins the
// production parser's behaviour.
const AUTH_LOGIN_URL_PREAMBLE_RE = /the url below to sign in/i;
const AUTH_LOGIN_PROMPT_RE = /^Paste code here if prompted\b[\s *>]*$/;
const SETUP_TOKEN_SUCCESS_RE = /Long-lived authentication token created successfully/i;
const AUTH_LOGIN_SUCCESS_RE = /^\s*(?:✓\s*)?Login successful\.?\s*$/im;
const AUTH_LOGIN_FAILURE_RE = /(?:login failed|authentication failed|invalid refresh token)/i;

/**
 * Classifies a `claude auth login` PTY capture without keeping any secret.
 * Returns which shapes appeared, so a caller can tell "the prompt shape is
 * shared" apart from "the stdout credential sink can work".
 */
export function detectAuthLoginTranscript(text) {
  const clean = String(text ?? "");
  const lines = clean.split("\n").map((line) => line.trim());
  return {
    urlPreamble: AUTH_LOGIN_URL_PREAMBLE_RE.test(clean),
    codePrompt: lines.some((line) => AUTH_LOGIN_PROMPT_RE.test(line)),
    // The setup-token success record. If `auth login` also printed it, the
    // existing stdout credential sink would work unchanged.
    setupTokenSuccessRecord: SETUP_TOKEN_SUCCESS_RE.test(clean),
    authLoginSuccess: AUTH_LOGIN_SUCCESS_RE.test(clean),
    failureSignal: AUTH_LOGIN_FAILURE_RE.test(clean),
    byteLength: clean.length,
  };
}

// --- Redaction ---------------------------------------------------------------

// Redaction is a single pass over an ordered rule list. Existing placeholders are
// lifted out to NUL-delimited sentinels first, so a second pass (or a transcript
// that was already partly redacted) leaves them untouched instead of letting the
// trailing-opaque-value rule rewrite `<REDACTED_AUTHORIZATION_URL>`.
const PLACEHOLDER_RE = /<REDACTED_[A-Z_]+>/g;
const REDACTIONS = [
  [/\bsk-ant-(?:oat01|ort01|api03)-[A-Za-z0-9_-]{4,}/gi, "<REDACTED_TOKEN>"],
  [
    /https?:\/\/[^\s]*(?:claude\.ai|claude\.com|anthropic\.com)[^\s]*/gi,
    "<REDACTED_AUTHORIZATION_URL>",
  ],
  [
    /([?&](?:code|state|access_token|refresh_token|code_challenge)=)[^\s&]*/gi,
    "$1<REDACTED>",
  ],
  [/[A-Za-z0-9_-]{20,}(?=\s*$)/gm, "<REDACTED_OPAQUE_VALUE>"],
];
const SENTINEL_RE = /\u0000(\d+)\u0000/g;

/**
 * Redacts a PTY capture before it can reach an artifact. Redaction is defense in
 * depth: `detectAuthLoginTranscript` already returns no secret, so a capture is
 * only ever redacted when a developer deliberately attaches one.
 *
 * Applying it twice produces the same string, so a transcript that was already
 * partly redacted survives a second pass unchanged.
 */
export function redactTranscript(text) {
  const held = [];
  const masked = String(text ?? "").replace(PLACEHOLDER_RE, (placeholder) => {
    held.push(placeholder);
    return `\u0000${held.length - 1}\u0000`;
  });
  let out = masked;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.replace(SENTINEL_RE, (_match, index) => held[Number(index)] ?? "");
}

// Credential-bearing field names. `code` is deliberately absent: this harness
// uses `code` for its own diagnostic codes, and OAuth query material is caught by
// the value check below (`[?&]code=`), which is the actual leak vector.
const FORBIDDEN_EVIDENCE_KEY =
  /^(?:access_?token|refresh_?token|refresh_?token_?expires_?at|expires_?at|password|client_?secret|authorization|cookie)$/i;

/**
 * Final gate on the evidence document. Rejects a credential-bearing key and any
 * token-shaped or OAuth-query-shaped value, so a future probe cannot serialize a
 * secret by returning a richer object.
 */
export function assertSanitizedEvidence(value, trail = "$") {
  const visit = (candidate, location, seen) => {
    if (typeof candidate === "string") {
      if (/sk-ant-(?:oat01|ort01|api03)-/i.test(candidate)) {
        throw new Error(`unsafe_evidence_token:${location}`);
      }
      if (/[?&](?:code|state|access_token|refresh_token)=/i.test(candidate)) {
        throw new Error(`unsafe_evidence_query:${location}`);
      }
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (FORBIDDEN_EVIDENCE_KEY.test(key) && child !== null && child !== "") {
        throw new Error(`unsafe_evidence_key:${trail}.${key}`);
      }
      visit(child, `${trail}.${key}`, seen);
    }
  };
  visit(value, trail, new Set());
  return value;
}

// --- Outcome classification ---------------------------------------------------

/**
 * Maps probe results to the design outcome. Kept pure and exhaustive so the
 * decision table is unit-testable and reviewable on its own.
 *
 * @param input.refreshPathWorked  `claude auth login` spent the refresh token
 *   without a browser.
 * @param input.refreshRequiresTty The non-interactive fast path demanded a TTY.
 * @param input.ptyDrivable        The in-app runner matched the code prompt.
 * @param input.keychainFirst      The per-directory Keychain item is what the CLI
 *   reads and writes on this platform.
 */
export function classifyRefreshPath(input = {}) {
  const {
    refreshPathWorked = false,
    refreshRequiresTty = false,
    ptyDrivable = true,
    keychainFirst = false,
  } = input;
  if (!refreshPathWorked || refreshRequiresTty || !ptyDrivable) {
    return "refresh_token_path_blocked";
  }
  return keychainFirst ? "managed_home_keychain_first" : "managed_home_file_first";
}
