import type { CapabilityRequirements, ModelId, NormalizedUsage, ProviderId } from "../types.ts";

/** Attributable final protocol evidence, not a ledger receipt or permission to execute tools. */
export type AdapterEvidence = {
  provider: ProviderId; adapterVersion: string; requestFormatVersion: string; requestHash: string;
  submittedAt: string; reportedModelId: string; providerMessageId: string;
  pricingProfile: "standard-global-text-v1"; terminalEvent: "completed";
};
export type AttemptBinding = { expectedRequestHash: string; submittedAt: string };

export type AnthropicModelId = Extract<ModelId, `claude-${string}`>;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ToolCall = { id: string; name: string; input: { [key: string]: JsonValue } };
export type AnthropicOutputBlock = { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: { [key: string]: JsonValue } }
  | { type: "thinking"; thinking: ""; signature: string }
  | { type: "redacted_thinking"; data: string };
/** Trusted server history only: preserve opaque signatures and exact order, never display/log them. */
export type AnthropicContinuation = {
  provider: "anthropic"; modelId: AnthropicModelId; prefixHash: string; content: AnthropicOutputBlock[];
};
export type InputPart = { type: "text"; text: string } | {
  type: "image"; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string;
};
export type ProviderMessage =
  | { role: "user"; content: string | readonly InputPart[] }
  | { role: "assistant"; content: string; toolCalls?: readonly ToolCall[]; continuation?: AnthropicContinuation }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };
export type ProviderTool = { name: string; description: string; inputSchema: { [key: string]: JsonValue } };
export type AnthropicRequest = {
  modelId: AnthropicModelId; system?: string; messages: readonly ProviderMessage[];
  tools?: readonly ProviderTool[]; maxTokens: number;
  /** Trusted integration's conservative bound including tools, framing, history and vision. */
  maxInputTokens: number; stream?: boolean; cacheTtl?: "5m" | "1h";
  capabilities?: CapabilityRequirements;
};
export type AdapterErrorCode = "execution_disabled" | "missing_key" | "invalid_request" | "unsupported_capability"
  | "unsupported_model" | "cancelled" | "timeout" | "network_error" | "provider_unavailable" | "provider_busy"
  | "provider_error" | "invalid_response" | "model_mismatch" | "incomplete_stream" | "response_limit" | "consumer_error";
/** Observed adapter operation, not an inferred DNS/TCP/TLS wire phase. */
export type ProviderFailurePhase = "pre_dispatch" | "fetch" | "response_headers" | "response_body"
  | "response_validation" | "response_consumer";
export type ProviderFailureCauseClass = "dns" | "connect" | "tls" | "connection_reset" | "transport_timeout"
  | "aborted" | "deadline" | "provider_status" | "adapter_rejected" | "consumer" | "unknown";
export type ProviderTransportCode = "ENOTFOUND" | "EAI_AGAIN" | "ECONNREFUSED" | "ENETUNREACH" | "EHOSTUNREACH"
  | "UND_ERR_CONNECT_TIMEOUT" | "ERR_TLS_CERT_ALTNAME_INVALID" | "CERT_HAS_EXPIRED" | "CERT_NOT_YET_VALID"
  | "DEPTH_ZERO_SELF_SIGNED_CERT" | "SELF_SIGNED_CERT_IN_CHAIN" | "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  | "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" | "ERR_SSL_WRONG_VERSION_NUMBER" | "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE"
  | "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION" | "ECONNRESET" | "EPIPE" | "UND_ERR_SOCKET" | "ETIMEDOUT"
  | "UND_ERR_HEADERS_TIMEOUT" | "UND_ERR_BODY_TIMEOUT" | "ABORT_ERR";
/** Sanitized server diagnostics only: never raw errors, messages, URLs, payloads or credentials. */
export type ProviderFailureDiagnostic = {
  phase: ProviderFailurePhase; causeClass: ProviderFailureCauseClass; transportCode?: ProviderTransportCode;
};
export type AnthropicStopReason = "end_turn" | "tool_use" | "max_tokens" | "model_context_window_exceeded" | "refusal";
export type AnthropicResult =
  | { status: "completed"; modelId: AnthropicModelId; messageId: string; text: string; toolCalls: ToolCall[];
      stopReason: AnthropicStopReason; truncated: boolean; usage: NormalizedUsage; usageComplete: true;
      continuation: AnthropicContinuation | null; evidence: AdapterEvidence; providerCostNanoUsd: number }
  | { status: "failed"; code: AdapterErrorCode; message: string;
      /** After submission, errors cannot prove that no bill was incurred. Never auto-release/retry. */
      submission: "not_submitted" | "uncertain"; usage: NormalizedUsage | null; usageComplete: boolean;
      diagnostic?: ProviderFailureDiagnostic };
export type AnthropicAdapterOptions = {
  /** Off by default. Trusted review gate only; never take this from request JSON/environment flags. */
  executionEnabled?: boolean; fetch?: typeof globalThis.fetch; getApiKey?: () => string | undefined;
  timeoutMs?: number; now?: () => string;
};
export type AnthropicCallOptions = {
  signal?: AbortSignal;
  /** Trusted durable dispatch timestamp/hash; a binding alone grants no authorization. */
  binding?: AttemptBinding;
  /** Provisional text only; tool calls are returned after the complete message is validated. */
  onText?: (delta: string) => void;
};

export type OpenAIModelId = Extract<ModelId, `gpt-${string}`>;
export type OpenAIOutputItem = Record<string, JsonValue>;
export type OpenAIContinuation = {
  provider: "openai"; modelId: OpenAIModelId; prefixHash: string; content: OpenAIOutputItem[];
};
export type OpenAIMessage = Extract<ProviderMessage, { role: "user" | "tool" }>
  | { role: "assistant"; content: string; toolCalls?: readonly ToolCall[]; continuation?: OpenAIContinuation };
export type OpenAIRequest = {
  modelId: OpenAIModelId; system?: string; messages: readonly OpenAIMessage[]; tools?: readonly ProviderTool[];
  maxTokens: number; maxInputTokens: number; cacheTtl?: "30m";
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  capabilities?: CapabilityRequirements;
};
export type OpenAIResult =
  | { status: "completed"; modelId: OpenAIModelId; messageId: string; text: string; toolCalls: ToolCall[];
      stopReason: "end_turn" | "tool_use" | "max_output_tokens" | "content_filter" | "refusal";
      truncated: boolean; usage: NormalizedUsage; usageComplete: true; continuation: OpenAIContinuation | null;
      evidence: AdapterEvidence; providerCostNanoUsd: number }
  | Extract<AnthropicResult, { status: "failed" }>;
export type OpenAIAdapterOptions = AnthropicAdapterOptions;
export type OpenAICallOptions = { signal?: AbortSignal; binding?: AttemptBinding };

export type DeepSeekModelId = Extract<ModelId, "deepseek-v4-pro">;
export type DeepSeekOutputMessage = {
  role: "assistant"; content: string | null; reasoning_content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
};
/** Invocation-local provider output only; never accept this from browser history. */
export type DeepSeekContinuation = {
  provider: "deepseek"; modelId: DeepSeekModelId; prefixHash: string; content: DeepSeekOutputMessage;
};
export type DeepSeekMessage = Extract<ProviderMessage, { role: "user" | "tool" }>
  | { role: "assistant"; content: string; toolCalls?: readonly ToolCall[]; continuation?: DeepSeekContinuation };
export type DeepSeekRequest = {
  modelId: DeepSeekModelId; system?: string; messages: readonly DeepSeekMessage[]; tools?: readonly ProviderTool[];
  maxTokens: number; maxInputTokens: number; reasoningEffort?: "low" | "high" | "max";
  capabilities?: CapabilityRequirements;
};
export type DeepSeekResult =
  | { status: "completed"; modelId: DeepSeekModelId; messageId: string; text: string; toolCalls: ToolCall[];
      stopReason: "end_turn" | "tool_use" | "max_tokens" | "content_filter"; truncated: boolean;
      usage: NormalizedUsage; usageComplete: true; continuation: DeepSeekContinuation | null;
      evidence: AdapterEvidence; providerCostNanoUsd: number }
  | Extract<AnthropicResult, { status: "failed" }>;
