import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({
  connectionAttempts: 0,
  sentMethods: [] as string[],
  abortParams: [] as Array<Record<string, unknown> | undefined>,
  agentStatus: "accepted",
  abortAccepted: true,
  emitTerminalAfterAbort: true,
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;

    constructor() {
      super();
      gateway.connectionAttempts++;
      queueMicrotask(() => {
        this.emit("open");
        this.emit("message", JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "test-nonce" },
        }));
      });
    }

    send(payload: string) {
      const request = JSON.parse(payload) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      gateway.sentMethods.push(request.method);
      const respond = (body: unknown) => {
        queueMicrotask(() => {
          this.emit("message", JSON.stringify({
            type: "res",
            id: request.id,
            ok: true,
            payload: body,
          }));
        });
      };

      if (request.method === "connect") return respond({ protocol: 4 });
      if (request.method === "agent") {
        return respond({ status: gateway.agentStatus, runId: "remote-run-1" });
      }
      if (request.method === "chat.abort") {
        gateway.abortParams.push(request.params);
        respond({
          ok: true,
          aborted: gateway.abortAccepted,
          runIds: gateway.abortAccepted ? ["remote-run-1"] : [],
        });
        if (gateway.abortAccepted && gateway.emitTerminalAfterAbort) {
          // A real gateway emits a terminal lifecycle frame once the aborted
          // run finishes, which is the proof Paperclip waits for.
          queueMicrotask(() => {
            this.emit("message", JSON.stringify({
              type: "event",
              event: "agent",
              payload: {
                runId: "remote-run-1",
                stream: "lifecycle",
                data: { phase: "cancelled" },
              },
            }));
          });
        }
        return;
      }
      if (request.method === "agent.wait") {
        // Never answered, so an operator stop is what settles the wait.
        return;
      }
      return respond({});
    }

    close() {}
  }

  return { WebSocket: FakeWebSocket };
});

import { execute } from "./execute.js";

function createContext(input: {
  signal?: AbortSignal;
  onCancellationReady?: () => Promise<void>;
  onDispatch?: () => void;
  onLog?: AdapterExecutionContext["onLog"];
} = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      url: "ws://127.0.0.1:18789",
      disableDeviceAuth: true,
      timeoutSec: 1,
    },
    context: {
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "manual",
    },
    onLog: input.onLog ?? (async () => {}),
    ...(input.onDispatch ? { onDispatch: input.onDispatch } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onCancellationReady ? { onCancellationReady: input.onCancellationReady } : {}),
  };
}

/** Resolves once the adapter has sent chat.abort, which needs no timer advance. */
function abortIssuedProbe(): { promise: Promise<void>; ctx: (stream: "stdout" | "stderr", chunk: string) => Promise<void> } {
  let mark!: () => void;
  const promise = new Promise<void>((resolve) => {
    mark = resolve;
  });
  return {
    promise,
    ctx: async (_stream, chunk) => {
      if (chunk.includes("chat.abort runId=")) mark();
    },
  };
}

describe("openclaw_gateway operator cancellation", () => {
  beforeEach(() => {
    gateway.connectionAttempts = 0;
    gateway.sentMethods = [];
    gateway.abortParams = [];
    gateway.agentStatus = "accepted";
    gateway.abortAccepted = true;
    gateway.emitTerminalAfterAbort = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers cancellation ownership before reporting dispatch", async () => {
    const order: string[] = [];
    gateway.agentStatus = "ok";

    const result = await execute(createContext({
      onCancellationReady: async () => {
        order.push("cancellation-ready");
      },
      onDispatch: () => {
        order.push("dispatch");
      },
    }));

    expect(result).toMatchObject({ exitCode: 0 });
    expect(order).toEqual(["cancellation-ready", "dispatch"]);
  });

  it("never starts a remote run when the stop already arrived", async () => {
    const controller = new AbortController();
    controller.abort();
    const onDispatch = vi.fn();

    const result = await execute(createContext({
      signal: controller.signal,
      onDispatch,
      onCancellationReady: async () => {},
    }));

    expect(gateway.sentMethods).toEqual(["connect"]);
    expect(onDispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      errorCode: "cancelled",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
  });

  it("stops the remote run through chat.abort and acknowledges a verified cancel", async () => {
    const controller = new AbortController();
    const probe = abortIssuedProbe();

    const resultPromise = execute(createContext({
      signal: controller.signal,
      onCancellationReady: async () => {},
      onLog: probe.ctx,
    }));
    // Abort once the gateway has accepted the run.
    await vi.waitFor(() => expect(gateway.sentMethods).toContain("agent"));
    controller.abort();

    const result = await resultPromise;

    expect(gateway.sentMethods).toContain("chat.abort");
    expect(gateway.abortParams).toHaveLength(1);
    expect(gateway.abortParams[0]).toMatchObject({ runId: "remote-run-1" });
    expect(gateway.abortParams[0]?.sessionKey).toEqual(expect.any(String));
    expect(result.resultJson?.executionCancellation).toMatchObject({
      state: "acknowledged",
      proof: "openclaw_gateway_terminal_aborted",
    });
  });

  it("issues chat.abort at most once per run", async () => {
    const controller = new AbortController();
    const probe = abortIssuedProbe();

    const resultPromise = execute(createContext({
      signal: controller.signal,
      onCancellationReady: async () => {},
      onLog: probe.ctx,
    }));
    await vi.waitFor(() => expect(gateway.sentMethods).toContain("agent"));
    controller.abort();
    // A duplicate operator Stop must not produce a second remote stop.
    controller.abort();

    await resultPromise;

    expect(gateway.abortParams).toHaveLength(1);
  });

  it("does not acknowledge when the gateway declines to abort the run", async () => {
    gateway.abortAccepted = false;
    const controller = new AbortController();
    const probe = abortIssuedProbe();

    vi.useFakeTimers();
    const resultPromise = execute(createContext({
      signal: controller.signal,
      onCancellationReady: async () => {},
      onLog: probe.ctx,
    }));
    await vi.waitFor(() => expect(gateway.sentMethods).toContain("agent"));
    controller.abort();
    await probe.promise;
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await resultPromise;

    expect(result.errorCode).toBe("openclaw_gateway_cancel_unverified");
    expect(result.resultJson?.executionCancellation).toBeUndefined();
    expect(result.resultJson?.chatAbortAccepted).toBe(false);
  });

  it("does not acknowledge when the run never reports a terminal state", async () => {
    gateway.emitTerminalAfterAbort = false;
    const controller = new AbortController();
    const probe = abortIssuedProbe();

    vi.useFakeTimers();
    const resultPromise = execute(createContext({
      signal: controller.signal,
      onCancellationReady: async () => {},
      onLog: probe.ctx,
    }));
    await vi.waitFor(() => expect(gateway.sentMethods).toContain("agent"));
    controller.abort();
    await probe.promise;
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await resultPromise;

    expect(result.errorCode).toBe("openclaw_gateway_cancel_unverified");
    expect(result.resultJson?.executionCancellation).toBeUndefined();
    expect(result.resultJson?.chatAbortAccepted).toBe(true);
  });

  it("does not stop the remote run when cancelled after the run finished", async () => {
    gateway.agentStatus = "ok";
    const controller = new AbortController();

    const result = await execute(createContext({
      signal: controller.signal,
      onCancellationReady: async () => {},
    }));
    expect(result).toMatchObject({ exitCode: 0 });
    // The listener is removed once execution settles, so a later stop is inert.
    controller.abort();

    expect(gateway.sentMethods).not.toContain("chat.abort");
  });

  it("leaves a normally completed run unacknowledged", async () => {
    gateway.agentStatus = "ok";

    const result = await execute(createContext({ onCancellationReady: async () => {} }));

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.resultJson?.executionCancellation).toBeUndefined();
  });
});
