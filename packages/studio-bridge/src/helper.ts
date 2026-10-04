import { randomUUID } from "node:crypto";
import { StudioBridge } from "./bridge.ts";
import { BridgeError } from "./protocol.ts";
import type { BridgeCapability, BridgeErrorCode, BridgeTransport, Discovery, DispatchOutcome, JsonObject, StudioSession, StudioTarget } from "./protocol.ts";
import { StdioTransportError } from "./transport/stdio.ts";
import type { StdioFailure } from "./transport/stdio.ts";

export interface HelperTransport extends BridgeTransport {
  start(): Promise<void>;
  waitForClose(): Promise<void>;
  validateInput(schema: JsonObject, input: JsonObject): boolean;
  readonly failureCode?: StdioFailure;
}
type HelperCode = BridgeErrorCode | StdioFailure | "busy" | "duplicate_request" | "selection_required" | "helper_failed";
type Failure = { code: HelperCode; outcome: DispatchOutcome };
export interface HelperStatus {
  state: "idle" | "connecting" | "connected" | "disconnected" | "closed";
  mode: "fixture" | "owner";
  connected: boolean;
  realStudioConnected: boolean;
  connectionId: string;
  sessions: StudioSession[];
  selected: StudioTarget | null;
  readCapability: Pick<BridgeCapability, "version" | "inputSchema"> | null;
  canInspect: boolean;
  activeRequestId: string | null;
  lastCheckedAt: string | null;
  lastError: Failure | null;
}
export type HelperRequest =
  | { id: string; operation: "status" }
  | { id: string; operation: "close" }
  | { id: string; operation: "connect"; timeoutMs?: number }
  | { id: string; operation: "discover"; timeoutMs?: number }
  | { id: string; operation: "select"; studioId: string }
  | { id: string; operation: "inspect"; selectionId: string; input?: JsonObject; timeoutMs?: number }
  | { id: string; operation: "cancel"; requestId: string };
export interface HelperResponse {
  id: string | null;
  ok: boolean;
  status: HelperStatus;
  result?: StudioTarget | { actionId: string; target: StudioTarget; result: JsonObject } | { cancelled: boolean; requestId: string };
  error?: Failure;
}
const KEYS: Record<string, string[]> = {
  status: [], close: [], connect: ["timeoutMs"], discover: ["timeoutMs"],
  select: ["studioId"], inspect: ["selectionId", "input", "timeoutMs"], cancel: ["requestId"],
};
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function failure(error: unknown): Failure {
  if (error instanceof BridgeError) return { code: error.code, outcome: error.outcome };
  if (error instanceof StdioTransportError) return { code: error.code, outcome: "not_dispatched" };
  return { code: "helper_failed", outcome: "not_dispatched" };
}

/** Local trusted controller, not an authenticated hosted endpoint or model tool.
 * Owns one injected channel for its lifetime. No reconnect or write operations.
 */
export class StudioReadHelper {
  #transport: HelperTransport;
  #bridge: StudioBridge;
  #mode: HelperStatus["mode"];
  #state: HelperStatus["state"] = "idle";
  #snapshot: Discovery | undefined;
  #selected: StudioTarget | undefined;
  #checkedAt: string | null = null;
  #lastError: Failure | null = null;
  #seen = new Set<string>();
  #active: { id: string; controller: AbortController; timedOut: boolean } | undefined;
  #unsubscribe: () => void;

  constructor(transport: HelperTransport, options: { mode: HelperStatus["mode"] }) {
    if (options.mode !== "fixture" && options.mode !== "owner") throw new BridgeError("invalid_input");
    this.#transport = transport;
    this.#mode = options.mode;
    // Enforce the read-only surface at the actual dispatch boundary as well.
    this.#bridge = new StudioBridge({
      send(message) {
        if (message.method === "tools/call" && !["list_roblox_studios", "get_studio_state"].includes(message.params.name)) throw new BridgeError("write_denied");
        transport.send(message);
      },
      onMessage: listener => transport.onMessage(listener),
      onClose: listener => transport.onClose(listener),
      close: () => transport.close(),
    }, { validateInput: (schema, input) => transport.validateInput(schema, input) });
    this.#unsubscribe = transport.onClose(() => {
      if (this.#state !== "closed") {
        this.#state = "disconnected";
        this.#lastError = { code: transport.failureCode ?? "disconnected", outcome: "not_dispatched" };
      }
      this.#snapshot = undefined;
      this.#selected = undefined;
    });
  }

  status(): HelperStatus {
    const connected = this.#state === "connected";
    const read = this.#snapshot?.capabilities.find(item => item.name === "get_studio_state");
    return structuredClone({
      state: this.#state, mode: this.#mode, connected,
      realStudioConnected: connected && this.#mode === "owner",
      connectionId: this.#bridge.connectionId,
      sessions: this.#snapshot?.sessions ?? [], selected: this.#selected ?? null,
      readCapability: read ? { version: read.version, inputSchema: read.inputSchema } : null,
      canInspect: connected && !!this.#selected && !!read && !this.#active,
      activeRequestId: this.#active?.id ?? null, lastCheckedAt: this.#checkedAt, lastError: this.#lastError,
    });
  }

  async handle(raw: unknown): Promise<HelperResponse> {
    let request: HelperRequest;
    const responseId = object(raw) && identifier(raw.id) ? raw.id : null;
    try {
      // Copy before any await: caller mutations cannot change a claimed request.
      const text = JSON.stringify(raw);
      if (!text || Buffer.byteLength(text) > 64 * 1024) throw new BridgeError("limit_exceeded");
      const copy: unknown = JSON.parse(text);
      if (!object(copy) || !identifier(copy.id) || typeof copy.operation !== "string" || !Object.hasOwn(KEYS, copy.operation)) throw new BridgeError("invalid_input");
      const allowed = ["id", "operation", ...KEYS[copy.operation]];
      if (Object.keys(copy).some(key => !allowed.includes(key))) throw new BridgeError("invalid_input");
      if (copy.timeoutMs !== undefined && (!Number.isInteger(copy.timeoutMs) || (copy.timeoutMs as number) < 1 || (copy.timeoutMs as number) > 30_000)) throw new BridgeError("invalid_input");
      if (copy.operation === "select" && (typeof copy.studioId !== "string" || !copy.studioId || copy.studioId.length > 200)) throw new BridgeError("invalid_input");
      if (copy.operation === "inspect" && (!identifier(copy.selectionId) || (copy.input !== undefined && !object(copy.input)))) throw new BridgeError("invalid_input");
      if (copy.operation === "cancel" && !identifier(copy.requestId)) throw new BridgeError("invalid_input");
      request = copy as HelperRequest;
    } catch (error) { return { id: responseId, ok: false, status: this.status(), error: error instanceof BridgeError ? failure(error) : failure(new BridgeError("invalid_input")) }; }
    const reject = (code: HelperCode): HelperResponse => ({ id: request.id, ok: false, status: this.status(), error: { code, outcome: "not_dispatched" } });
    if (this.#seen.has(request.id)) return reject("duplicate_request");
    if (this.#seen.size >= 1_024) return reject("limit_exceeded");
    this.#seen.add(request.id); // No request ID may dispatch again, even after failure.
    if (request.operation === "status") return { id: request.id, ok: true, status: this.status() };
    if (request.operation === "cancel") {
      const cancelled = this.#active?.id === request.requestId;
      if (cancelled) this.#active!.controller.abort();
      return { id: request.id, ok: true, status: this.status(), result: { cancelled, requestId: request.requestId } };
    }
    if (request.operation === "close") {
      try { await this.close(); return { id: request.id, ok: true, status: this.status() }; }
      catch (error) { return { id: request.id, ok: false, status: this.status(), error: failure(error) }; }
    }
    if (this.#active) return reject("busy");
    if (request.operation === "connect" ? this.#state !== "idle" : this.#state !== "connected") return reject(this.#state === "closed" || this.#state === "disconnected" ? "disconnected" : "not_ready");
    if (request.operation === "select") {
      if (!this.#snapshot) return reject("not_ready");
      try {
        this.#selected = this.#bridge.selectStudio(request.studioId);
        return { id: request.id, ok: true, status: this.status(), result: { ...this.#selected } };
      } catch (error) { return { id: request.id, ok: false, status: this.status(), error: failure(error) }; }
    }
    if (request.operation === "inspect" && (!this.#selected || request.selectionId !== this.#selected.selectionId)) return reject("selection_required");
    const active = { id: request.id, controller: new AbortController(), timedOut: false };
    this.#active = active;
    const timeoutMs = request.timeoutMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => { active.timedOut = true; active.controller.abort(); }, timeoutMs);
    // Cancelling startup must also close the child, before it can initialize.
    const onAbort = () => { if (this.#state === "connecting") this.#bridge.close(); };
    active.controller.signal.addEventListener("abort", onAbort, { once: true });
    const options = () => {
      if (active.controller.signal.aborted) throw new BridgeError(active.timedOut ? "timeout" : "cancelled");
      const remaining = deadline - Date.now();
      if (remaining < 1) throw new BridgeError("timeout");
      return { signal: active.controller.signal, timeoutMs: remaining };
    };
    let result: HelperResponse["result"];
    let error: Failure | undefined;
    try {
      if (request.operation === "connect") {
        this.#state = "connecting";
        await this.#transport.start();
        await this.#bridge.initialize(options());
        this.#state = "connected";
      }
      if (request.operation === "connect" || request.operation === "discover") {
        const fresh = await this.#bridge.discover(options());
        if (this.#selected && !fresh.sessions.some(session => session.studioId === this.#selected!.studioId && session.placeId === this.#selected!.placeId && session.name === this.#selected!.name)) this.#selected = undefined;
        this.#snapshot = fresh;
        this.#checkedAt = new Date().toISOString();
      } else {
        const target = { ...this.#selected! };
        const capability = this.#snapshot?.capabilities.find(item => item.name === "get_studio_state");
        if (!capability) throw new BridgeError("unknown_tool");
        const action = this.#bridge.prepareAction({ actionId: `helper:${randomUUID()}`, target, tool: "get_studio_state", version: capability.version, input: request.input ?? {} });
        result = { actionId: action.actionId, target, result: await this.#bridge.execute(action.actionId, options()) };
        this.#checkedAt = new Date().toISOString();
      }
      this.#lastError = null;
    } catch (caught) {
      error = failure(caught);
      if (active.timedOut) error.code = "timeout";
      else if (active.controller.signal.aborted) error.code = "cancelled";
      if (request.operation === "connect") {
        this.#bridge.close();
        try { await this.#transport.waitForClose(); } catch (cleanup) { error = failure(cleanup); }
      }
      if (request.operation !== "inspect" || ["wrong_studio", "capability_changed", "unknown_tool", "disconnected"].includes(error.code)) {
        this.#snapshot = undefined;
        this.#selected = undefined;
      }
      this.#lastError = error;
    } finally {
      clearTimeout(timer);
      active.controller.signal.removeEventListener("abort", onAbort);
      this.#active = undefined;
    }
    return { id: request.id, ok: !error, status: this.status(), ...(result ? { result } : {}), ...(error ? { error } : {}) };
  }

  async close(): Promise<void> {
    this.#state = "closed";
    this.#selected = undefined;
    this.#snapshot = undefined;
    this.#active?.controller.abort();
    this.#bridge.close();
    this.#unsubscribe();
    try { await this.#transport.waitForClose(); }
    catch (error) { this.#lastError = failure(error); throw error; }
  }
}
