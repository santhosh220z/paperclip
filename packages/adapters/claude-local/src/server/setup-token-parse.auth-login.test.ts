import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SETUP_TOKEN_AFTER_ANCHOR,
  SETUP_TOKEN_BEFORE_ANCHOR,
  parseSetupTokenCredential,
  parseSetupTokenPrompt,
} from "./setup-token-parse.js";

// Characterization guard for GitHub #15958. The local Anthropic subscription
// login switched from `claude auth login` to `claude setup-token` in #14970
// (9f7057e12, 2026-10-06). `setup-token` mints a non-expiring `user:inference`
// token, so it cannot reproduce the ~8h expiry the issue reported. These tests
// pin the two facts that decide whether the refresh-token design is viable:
//
//   1. `auth login` shares the browser-code prompt shape, so the existing
//      in-app runner can still collect a code without new PTY plumbing.
//   2. `auth login` does not print the setup-token success record, so the
//      stdout credential sink cannot work and a post-exit credential read is
//      required.
//
// The transcript below is a shape fixture, not a capture. No authorization
// URL, browser code, or token in it is real.

const here = path.dirname(fileURLToPath(import.meta.url));
const authLoginCredentialFixture = JSON.parse(
  readFileSync(path.join(here, "__fixtures__", "claude-auth-login-credential.json"), "utf8"),
) as { claudeAiOauth: Record<string, unknown> };

// Same browser authorization flow as `setup-token`: the URL preamble, the
// authorization URL, then the dedicated code-prompt line. The URL below is the
// pinned redirect_uri plus a synthetic query that satisfies every key and length
// floor the parser requires — notably a 43+ character PKCE `code_challenge` and
// an S256 `code_challenge_method`. It authorizes nothing.
const AUTH_LOGIN_TRANSCRIPT = [
  "Welcome to Claude Code v2.1.226",
  "",
  "Opening browser to sign in…",
  "Browser didn't open? Use the url below to sign in (c to copy)",
  "",
  "https://claude.ai/oauth/authorize?client_id=REDACTED&code=REDACTED" +
    "&code_challenge=REDACTED_challenge_value_0123456789abcdef0123456789abcdef" +
    "&code_challenge_method=S256" +
    "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
    "&response_type=code&scope=user%3Ainference%20user%3Aprofile" +
    "&state=REDACTED_state_value_0123456789abcdef",
  "",
  "Paste code here if prompted > ",
  "",
  "✓ Login successful.",
  "",
].join("\n");

describe("claude auth login transcript (characterization, #15958)", () => {
  it("binds the shared browser-code prompt so the in-app runner still works", () => {
    const prompt = parseSetupTokenPrompt(AUTH_LOGIN_TRANSCRIPT);
    expect(prompt).not.toBeNull();
    // The parser returns a constant prompt, never a caller-controlled value.
    expect(prompt!.prompt).toBe("Paste code here if prompted");
    expect(prompt!.url).toContain("code_challenge_method=S256");
  });

  it("does not bind a credential from stdout, so a post-exit credential read is required", () => {
    expect(parseSetupTokenCredential(AUTH_LOGIN_TRANSCRIPT)).toBeNull();
  });

  it("still fails closed on the setup-token success record anchors", () => {
    // Guards against a future relaxation that would let `auth login` output
    // satisfy the setup-token sink.
    const record = [
      SETUP_TOKEN_BEFORE_ANCHOR,
      "sk-ant-oat01-REDACTED-token-value-not-real",
      SETUP_TOKEN_AFTER_ANCHOR,
    ].join("\n");
    expect(parseSetupTokenCredential(record)).toBe(
      "sk-ant-oat01-REDACTED-token-value-not-real",
    );
  });
});

describe("claude auth login credential fixture (#15958)", () => {
  it("carries the refresh fields the current reader discards", () => {
    const oauth = authLoginCredentialFixture.claudeAiOauth;
    expect(typeof oauth.accessToken).toBe("string");
    expect(typeof oauth.refreshToken).toBe("string");
    expect(typeof oauth.expiresAt).toBe("number");
    expect(typeof oauth.refreshTokenExpiresAt).toBe("number");
    expect(Array.isArray(oauth.scopes)).toBe(true);
  });

  it("carries synthetic placeholders rather than a usable secret", () => {
    // The prefix is kept because the parsers and the redaction gates key on it.
    // Only the opaque tail is replaced, so a reader cannot mistake this fixture
    // for a captured credential.
    const oauth = authLoginCredentialFixture.claudeAiOauth;
    expect(oauth.accessToken).toMatch(/^sk-ant-oat01-REDACTED-/);
    expect(oauth.refreshToken).toMatch(/^sk-ant-ort01-REDACTED-/);
  });

  it("records an access-token lifetime near the 8h expiry the issue reported", () => {
    // The two lifetimes that made the pre-#14970 flow unusable: Paperclip stored
    // accessToken only, so the connection died at expiresAt even though a refresh
    // token stayed valid for roughly four more weeks. Assert the delta, not the
    // absolute epoch, so the fixture does not need to be re-dated.
    const oauth = authLoginCredentialFixture.claudeAiOauth;
    const lifetimeMs = (oauth.refreshTokenExpiresAt as number) - (oauth.expiresAt as number);
    const lifetimeDays = lifetimeMs / 86_400_000;
    expect(lifetimeDays).toBeGreaterThan(27);
    expect(lifetimeDays).toBeLessThan(29);
    // Epoch milliseconds, not seconds. A seconds-valued fixture would look
    // expired to every expiry check in this repo.
    expect(oauth.expiresAt as number).toBeGreaterThan(1_700_000_000_000);
  });
});