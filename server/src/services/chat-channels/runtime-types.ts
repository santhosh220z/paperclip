import type { Db, chatEndpoints } from "@paperclipai/db";
import type { ToolCredentialSecretRef, ChatEndpointSetupState, ChatEndpointCallbackSurfaces } from "@paperclipai/shared";
import type { ChatEndpointRuntime } from "../voice/voice-runtime.js";

export type EndpointRow = typeof chatEndpoints.$inferSelect;

export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DbOrTransaction = Db | DbTransaction;

export type RuntimeContext = {
  credentialFingerprint: string;
  discordGatewayEventQueue?: Promise<void>;
  discordGatewaySequence?: number;
  discordGatewayOwned?: boolean;
  /** Cache identity only; durable command admission rechecks ownership. */
  discordCommandId?: string;
  endpointRuntime?: ChatEndpointRuntime;
  generation: number;
  localEpoch: number;
  version: string;
};

export type LifecycleRuntimeFence = Pick<
  RuntimeContext,
  "credentialFingerprint" | "generation"
>;

export type InboundRuntimeContext = LifecycleRuntimeFence &
  Pick<RuntimeContext, "discordGatewayOwned" | "endpointRuntime">;

export type EndpointRecord = {
  endpoint: EndpointRow;
  assignedAgentName: string;
  connectionName: string;
  applicationId: string;
  credentialSecretRefs: ToolCredentialSecretRef[];
};

export type SlackCallbackSurface = keyof ChatEndpointCallbackSurfaces;

export type SlackCallbackObservation = { url: string; observedAt: string };

export type InternalSetupState = ChatEndpointSetupState & {
  photonIntakeAfter?: string;
  runtimeGeneration?: number;
  /** Binds pre-install URL verification to the signing secret later configured. */
  slackVerificationSigningFingerprint?: string;
  slackCallbackSurfaces?: Partial<
    Record<SlackCallbackSurface, SlackCallbackObservation>
  >;
};

export type VerifiedProviderIdentity = {
  githubOwnerType?: "personal" | "organization";
  githubOwnerLogin?: string;
  providerAccountId?: string | null;
  providerAccountLabel?: string | null;
  botExternalId?: string | null;
  botUsername?: string | null;
  botLabel?: string | null;
};

export type PreparedProviderInventory = {
  credentials: Record<string, string>;
  inventory: import("../chat-provider-inventory.js").ChatProviderInventoryResult | null;
  managementUrl?: string;
};
