# DeepSeek Pro transport

The distinct `deepseek-v4-pro` connection uses `POST https://api.deepseek.com/chat/completions`, with thinking enabled and high effort, one sample, JSON completion, and application function tools. Flash retains its existing streaming transport. The Pro adapter factory defaults to disabled. Its server release review currently marks the adapter supported and execution disabled; the parent release integrator owns activation and publishing.

Official sources verified on 2026-10-03:

- [Current model and prices](https://api-docs.deepseek.com/quick_start/pricing/): Pro version V4-Pro-0813, 1M context, text/tools, no vision. Peak USD per million tokens: input cache miss 1.32, cache hit 0.044, output 3.96; off-peak 0.66, 0.022, 1.98. These match the existing rate card, so historical rates and fingerprints remain unchanged.
- [Current change log](https://api-docs.deepseek.com/updates/): API service for V4 Pro continues after September 14 in response to user demand; the earlier retirement announcement is superseded.
- [Thinking guide](https://api-docs.deepseek.com/guides/thinking_mode): reasoning must replay on every subsequent request carrying tools, including after text-only responses. Required/named tool choices are unsupported in thinking mode; this transport sends auto or none.
- [Chat API](https://api-docs.deepseek.com/api/create-chat-completion): prompt tokens equal cache hit plus miss; cached_tokens mirrors the hit counter. Completion tokens already include reasoning. Child reasoning counters are validated, never added again.

The existing normalized usage, peak-ceiling quote, durable dispatch claim and atomic settlement contract cover Pro. A single request reserves the native 1M input window plus at most 16k output at peak rates, retaining the existing 2.5× customer pricing policy and minimum hold. With 16k output this is 347 credits, including the existing extra hold credit. Application admission stays at 200k. Ordinary actual receipts use submitted-time peak/off-peak rates and final counters; no cache hit is assumed to afford the hold. The existing conservative weekday convention does not model Chinese public holidays, and may overstate a holiday's actual provider cost. That inherited rate-card limit is unchanged.

Trusted current-invocation native reasoning and exact tool arguments stay in the bridge's private continuation map. They are bound to the precise prefix, model and tools; never displayed, persisted in wallet evidence, or accepted from client history. Prior saved answers lack trusted reasoning, so the bridge presents them as visible earlier-answer context in user messages. Current tool requests require native continuation rather than inventing reasoning. Crash recovery never replays provider requests or tool effects.

Exact model mismatch (including a Flash response), incomplete/missing/conflicting usage, abort, timeout, malformed tools or unverified response retains the submitted hold for reconciliation with no automatic retry. Length/content-filter responses can settle complete attributable counters but cannot execute tool intents. No schema, credentials, pricing policy or deployment changes are needed.

All new transport tests use synthetic responses. Engine/Ask/queued-worker tests exercise real routing, bounded quotes, parsers and wallet transactions in disposable PGlite fixtures. No paid Pro call, entitlement check, actual cache observation, deployment or production wallet verification has been performed.
