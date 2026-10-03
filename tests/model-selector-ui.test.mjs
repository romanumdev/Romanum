import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { publicModels } from "../src/lib/models/readiness.ts";
import { routeModel } from "../src/lib/models/route.ts";

const componentUrl = new URL("../src/components/models/model-selector.tsx", import.meta.url).href;
const previewUrl = new URL("../src/components/models/model-preview.tsx", import.meta.url).href;
const estimateUrl = new URL("../src/components/models/estimated-model-card.tsx", import.meta.url).href;
const coinUrl = new URL("../src/components/coin.tsx", import.meta.url).href;
const virtual = source => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === coinUrl && specifier === "./wordmark-paths") return nextResolve("./wordmark-paths.ts",context);
    if (context.parentURL === componentUrl) {
      if (specifier === "react") return virtual(`import * as React from ${JSON.stringify(import.meta.resolve("react"))};
        ${["useId", "useState", "useRef", "useEffect", "useCallback"].map(name => `export function ${name}(...args){return globalThis.__selectorHarness ? globalThis.__selectorHarness.${name}(...args) : React.${name}(...args);}`).join("\n")}`);
      if (specifier === "react-dom") return virtual(`import {createPortal as real} from ${JSON.stringify(import.meta.resolve("react-dom"))}; export function createPortal(children,container){return globalThis.__selectorHarness ? children : real(children,container);}`);
      if (specifier === "react/jsx-runtime") return virtual(`import * as runtime from ${JSON.stringify(import.meta.resolve("react/jsx-runtime"))};
        export const Fragment=runtime.Fragment;
        function capture(type,props,key){if(globalThis.__selectorControls && (type==='button'||props.role==='option'||props.role==='listbox'||props.role==='group'||props.role==='dialog'))globalThis.__selectorControls.push({type,props,key});}
        export function jsx(type,props,key){capture(type,props,key);return runtime.jsx(type,props,key);}
        export function jsxs(type,props,key){capture(type,props,key);return runtime.jsxs(type,props,key);}`);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === componentUrl || url === previewUrl || url === estimateUrl || url === coinUrl) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    }).outputText };
    return nextLoad(url, context);
  },
});
const { ModelSelector } = await import(componentUrl);
hooks.deregister();

// No real keys, network, provider clients or fabricated prices: use actual foundation decisions.
const catalog = publicModels({ DEEPSEEK_API_KEY: "fixture-only" }, {
  "deepseek-flash": { adapterSupported: true, executionEnabled: true },
  "deepseek-v4-pro": { adapterSupported: true, executionEnabled: false },
});
const at = "2026-10-02T12:30:00.000Z";
const budget = { inputTokens: 1000, maxInputTokens: 2000, outputTokens: 500, maxOutputTokens: 1000 };
const decide = (selection, extra = {}) => routeModel({ selection, availableCredits: 100, budget, at, ...extra }, catalog.models);
const creditText = value => new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 6 }).format(value);

// Actual handlers with deterministic hook state and narrow layout/event seams. Closed SSR
// uses real React hooks separately; JSX, icons and HTML rendering always use real React.
function render(extra = {}) {
  const { preferences = { subscription: "unknown", scope: null }, storage = new Map(), storageDenied = false, ...componentProps } = extra;
  const state = [], effects = [], changes = [], scrolled = [], listeners = new Map();
  let cursor = 0, markup = "", controls = [], focusCount = 0;
  const browser = { innerWidth: 640, innerHeight: 600, rect: { top: 500, bottom: 544, left: 40 },
    requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {},
    localStorage: { getItem: key => { if (storageDenied) throw new Error("Storage unavailable"); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageDenied) throw new Error("Storage unavailable"); storage.set(key, value); } },
    addEventListener: (name, fn) => listeners.set(`window:${name}`, fn), removeEventListener: name => listeners.delete(`window:${name}`) };
  const triggerNode = { getBoundingClientRect: () => browser.rect, focus: () => focusCount++, contains: target => target === triggerNode };
  const popupNode = { contains: target => target === popupNode, getBoundingClientRect: () => ({ top: 172, left: 40, right: 295 }), querySelector: selector => ({ scrollIntoView: value => scrolled.push({ selector, value }) }) };
  const doc = { body: {}, addEventListener: (name, fn) => listeners.set(`document:${name}`, fn), removeEventListener: name => listeners.delete(`document:${name}`) };
  const props = { catalog, selection: { mode: "auto" }, onChange: selection => { changes.push(selection); props.selection = selection; }, ...componentProps };
  function slot(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return index; }
  const harness = {
    useCallback(fn) { return fn; },
    useId() { return state[slot("fixture-model")]; },
    useRef(initial) { return state[slot({ current: initial })]; },
    useState(initial) { const index = slot(initial); return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; },
    useEffect(effect, deps) {
      const index = slot(null), previous = state[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) effects.push(() => { previous?.cleanup?.(); state[index] = { deps, cleanup: effect() }; });
    },
  };
  function scope(operation) {
    const before = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, harness: globalThis.__selectorHarness, controls: globalThis.__selectorControls };
    globalThis.window = browser; globalThis.document = doc; globalThis.__selectorHarness = harness;
    globalThis.fetch = async () => ({ ok: true, json: async () => preferences });
    try { operation(); } finally {
      for (const [key, value] of [["window", before.window], ["document", before.document], ["fetch", before.fetch], ["__selectorHarness", before.harness], ["__selectorControls", before.controls]]) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    }
  }
  function redraw() {
    cursor = 0; globalThis.__selectorControls = [];
    const tree = ModelSelector(props);
    controls = globalThis.__selectorControls;
    controls.find(control => control.props.role === "combobox").props.ref.current = triggerNode;
    const list = controls.find(control => control.props.role === "listbox");
    if (list) list.props.ref.current = popupNode;
    markup = renderToStaticMarkup(tree);
    while (effects.length) effects.shift()();
  }
  function act(operation) { scope(() => { operation(); redraw(); }); }
  scope(redraw);
  const result = {
    changes, browser, scrolled, storage,
    get markup() { return markup; },
    get trigger() { return controls.find(control => control.props.role === "combobox").props; },
    get list() { return controls.find(control => control.props.role === "listbox")?.props; },
    get details() { return controls.find(control => control.props.role === "dialog")?.props; },
    get buttons() { return controls.filter(control => control.type === "button" && control.props.role !== "combobox").map(control => control.props); },
    get focusCount() { return focusCount; },
    option(value) { return controls.find(control => control.props.role === "option" && control.key === value)?.props; },
    clickTrigger() { act(() => result.trigger.onClick()); },
    choose(value) { if (!result.list) result.clickTrigger(); act(() => result.option(value)?.onClick()); },
    key(key) { const event = { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; act(() => result.trigger.onKeyDown(event)); return event; },
    detailsKey(key) { act(() => result.details?.onKeyDown({ key, target: null, currentTarget: null, preventDefault() {}, stopPropagation() {} })); },
    alternative() { act(() => result.buttons.find(button => React.Children.toArray(button.children).join("").startsWith("Choose "))?.onClick()); },
    button(label) { act(() => result.buttons.find(button => button["aria-label"] === label || React.Children.toArray(button.children).join("") === label)?.onClick()); },
    escapeRecommendation() { act(() => controls.find(control => control.props.role === "group" && control.props["aria-label"] === "Auto recommendation")?.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} })); },
    async ready() { await new Promise(resolve => setImmediate(resolve)); scope(redraw); },
    outside(target = {}) { act(() => listeners.get("document:pointerdown")?.({ target })); },
    inside() { result.outside(popupNode); },
    resize(values) { Object.assign(browser, values); act(() => listeners.get("window:resize")?.()); },
    update(values) { Object.assign(props, values); scope(redraw); },
    dispose() { scope(() => { for (const value of state) value?.cleanup?.(); }); },
  };
  result.clickTrigger();
  return result;
}

test("pill opens a labeled charcoal list above the trigger with checks and disabled reasons", () => {
  const result = render({ id: "fixture-model" });
  assert.match(result.markup, /<label for="fixture-model" class="sr-only">Select model/);
  assert.equal(result.trigger.role, "combobox"); assert.equal(result.trigger["aria-haspopup"], "listbox");
  assert.equal(result.trigger["aria-expanded"], true); assert.equal(result.list.id, result.trigger["aria-controls"]);
  assert.equal(result.list.style.width, 255); assert.ok(result.list.style.bottom > 0); assert.equal(result.list.style.top, undefined);
  assert.equal(result.option("auto")["aria-selected"], true); assert.match(result.markup, /Budget and cache aware/);
  assert.equal((result.markup.match(/romanum-wordmark-compact\.svg/g)??[]).length,4);
  assert.equal(result.option("deepseek-flash")["aria-disabled"], undefined);
  assert.equal(result.option("gpt-6.1-sol")["aria-disabled"], true); assert.match(result.markup, /Not configured/);
  assert.match(result.markup, /Request estimate not available/); assert.doesNotMatch(result.markup, /fixture-only|API_KEY|Estimated cost:/);
  assert.deepEqual(result.changes, []); result.dispose();
});

test("row choices emit typed explicit or Auto selections and reject disabled or unknown choices", () => {
  const result = render();
  result.choose("deepseek-flash"); result.choose("auto");
  for (const value of ["gpt-6.1-sol", "claude-opus-5-5", "unknown", ""]) result.choose(value);
  assert.deepEqual(result.changes, [{ mode: "explicit", modelId: "deepseek-flash" }, { mode: "auto" }]); result.dispose();
});

test("keyboard profile browsing includes unavailable models without changing the selection", () => {
  for (const models of [catalog, { ...catalog, models: catalog.models.map(model => ({ ...model, executionEnabled: false, selectable: false, reason: "execution_disabled" })) }]) {
  const result = render({ catalog: models }); result.key("ArrowRight");
  assert.equal(result.details["aria-label"], "About Auto");
  assert.match(result.markup,/Illustrative capability range/);
  assert.doesNotMatch(result.markup,/Estimated model profile|observed routing performance is shown\. Higher/);
  result.detailsKey("ArrowDown");
  assert.equal(result.details["aria-label"], "About DeepSeek Flash");
  result.detailsKey("ArrowDown"); assert.equal(result.details["aria-label"], "About DeepSeek V4 Pro");
  result.detailsKey("End"); assert.equal(result.details["aria-label"], "About Claude Fable 5.1");
  result.detailsKey("Home"); assert.equal(result.details["aria-label"], "About Auto");
  assert.equal(result.trigger.value, "auto"); assert.deepEqual(result.changes, []);
  result.detailsKey("Escape"); assert.equal(result.details, undefined); result.dispose();
  }
});

const preferenceScope = "a".repeat(64);
const freePreferences = { subscription: "none", scope: preferenceScope };

test("verified non-subscriber gets one optional recommendation without delaying their deliberate choice", async () => {
  const result = render({ preferences: freePreferences });
  await result.ready();
  assert.doesNotMatch(result.markup, /Auto balances model capability/);
  result.choose("deepseek-flash");
  assert.deepEqual(result.changes, [{ mode: "explicit", modelId: "deepseek-flash" }]);
  assert.equal(result.trigger.value, "deepseek-flash");
  assert.match(result.markup, /Auto balances model capability with price/);
  assert.match(result.markup,/romanum-wordmark-compact\.svg/);
  assert.match(result.markup, /Keep choice: .*DeepSeek Flash/);
  assert.match(result.markup, /aria-label="Dismiss Auto recommendation"/);
  assert.equal(result.storage.size, 1);
  result.button("Keep choice: DeepSeek Flash");
  assert.doesNotMatch(result.markup, /Auto balances model capability/);
  assert.equal(result.trigger.value, "deepseek-flash");
  result.choose("auto"); result.choose("deepseek-flash"); result.choose("deepseek-flash");
  assert.doesNotMatch(result.markup, /Auto balances model capability/);
  assert.equal(result.changes.length, 4);
  result.dispose();
});

test("acknowledgement survives another composer and reload, and is scoped to the existing owner", async () => {
  const storage = new Map();
  const first = render({ preferences: freePreferences, storage });
  await first.ready(); first.choose("deepseek-flash"); first.dispose();
  for (let index = 0; index < 2; index++) {
    const next = render({ preferences: freePreferences, storage });
    await next.ready(); next.choose("deepseek-flash");
    assert.doesNotMatch(next.markup, /Auto balances model capability/);
    assert.equal(next.trigger.value, "deepseek-flash"); next.dispose();
  }
  const other = render({ preferences: { subscription: "none", scope: "b".repeat(64) }, storage });
  await other.ready(); other.choose("deepseek-flash");
  assert.match(other.markup, /Auto balances model capability/); other.dispose();
});

test("subscribed, unknown, malformed and unavailable persistence states keep full supported model access without advice", async () => {
  for (const options of [{ preferences: { subscription: "active", scope: preferenceScope } },
    { preferences: { subscription: "unknown", scope: preferenceScope } }, { preferences: null },
    { preferences: { subscription: "none", scope: "invalid" } }, { preferences: freePreferences, storageDenied: true }]) {
    const result = render(options); await result.ready(); result.choose("deepseek-flash");
    assert.equal(result.trigger.value, "deepseek-flash");
    assert.doesNotMatch(result.markup, /Auto balances model capability/);
    assert.equal(result.storage.size, 0); result.dispose();
  }
});

test("unknown state on the first deliberate switch never queues a later recommendation", async () => {
  const result = render({ preferences: freePreferences });
  result.choose("deepseek-flash"); await result.ready();
  result.choose("auto"); result.choose("deepseek-flash");
  assert.doesNotMatch(result.markup, /Auto balances model capability/);
  assert.equal(result.storage.size, 0); result.dispose();
});

test("opening the selector can verify a guest established after the initial identity read", async () => {
  const preferences = { subscription: "unknown", scope: null };
  const result = render({ preferences }); await result.ready(); result.clickTrigger();
  Object.assign(preferences, freePreferences); result.clickTrigger(); await result.ready(); result.choose("deepseek-flash");
  assert.match(result.markup, /Auto balances model capability/); result.dispose();
});

test("keyboard navigation alone shows no advice; choosing a model does, and returning to Auto is deliberate", async () => {
  const result = render({ preferences: freePreferences }); await result.ready();
  result.key("End"); assert.doesNotMatch(result.markup, /Auto balances model capability/);
  result.key("Enter");
  assert.equal(result.trigger.value, "deepseek-flash");
  assert.match(result.markup, /Auto balances model capability/);
  result.button("Use Auto");
  assert.equal(result.trigger.value, "auto");
  assert.deepEqual(result.changes, [{ mode: "explicit", modelId: "deepseek-flash" }, { mode: "auto" }]);
  result.choose("deepseek-flash"); assert.doesNotMatch(result.markup, /Auto balances model capability/); result.dispose();
});

test("dismiss action retains the explicit choice and restores focus", async () => {
  const result = render({ preferences: freePreferences }); await result.ready(); result.choose("deepseek-flash");
  const before = result.focusCount; result.button("Dismiss Auto recommendation");
  assert.equal(result.focusCount, before + 1); assert.equal(result.trigger.value, "deepseek-flash");
  assert.doesNotMatch(result.markup, /Auto balances model capability/); result.dispose();
});

test("Escape dismisses the recommendation with the explicit model retained", async () => {
  const result = render({ preferences: freePreferences }); await result.ready(); result.choose("deepseek-flash");
  const before = result.focusCount; result.escapeRecommendation();
  assert.equal(result.focusCount, before + 1); assert.equal(result.trigger.value, "deepseek-flash");
  assert.doesNotMatch(result.markup, /Auto balances model capability/); result.dispose();
});

test("subscription advice does not gate any otherwise supported catalog model", async () => {
  const supported = { ...catalog, models: catalog.models.map(model => ({ ...model, configured: true, adapterSupported: true,
    executionEnabled: true, selectable: true, reason: "ready" })) };
  for (const subscription of ["none", "active", "unknown"]) {
    const result = render({ catalog: supported, preferences: { subscription, scope: preferenceScope } }); await result.ready();
    for (const model of supported.models) {
      if (!result.list) result.clickTrigger();
      assert.equal(result.option(model.id)["aria-disabled"], undefined); result.choose(model.id);
      assert.equal(result.trigger.value, model.id);
    }
    assert.equal(result.changes.length, supported.models.length); result.dispose();
  }
});

test("configured keys cannot override disabled native server reviews", () => {
  const configured = publicModels({ DEEPSEEK_API_KEY: "fixture-only", OPENAI_API_KEY: "fixture-only", ANTHROPIC_API_KEY: "fixture-only" },
    Object.fromEntries(catalog.models.map(model => [model.id, { adapterSupported: model.id !== "deepseek-v4-pro", executionEnabled: model.id === "deepseek-flash" }])));
  const result = render({ catalog: configured });
  for (const model of configured.models.filter(model => model.id !== "deepseek-flash")) { assert.equal(result.option(model.id)["aria-disabled"], true); result.choose(model.id); }
  assert.match(result.markup, /Integration not supported/); assert.deepEqual(result.changes, []); result.dispose();
});

test("explicit choice survives metadata removal, loading and errors without replacement or secret leakage", () => {
  const selection = { mode: "explicit", modelId: "gpt-6.1-sol" };
  for (const extra of [{}, { catalog: null }, { loading: true }, { error: "internal diagnostic" }, { catalog: { ...catalog, models: catalog.models.filter(model => model.id !== selection.modelId) } }]) {
    const result = render({ selection, ...extra });
    assert.equal(result.trigger.value, selection.modelId); assert.deepEqual(result.changes, []);
    assert.doesNotMatch(result.markup, /internal diagnostic/);
    if (result.list) assert.equal(result.option(selection.modelId)["aria-selected"], true);
    result.dispose();
  }
});

test("unavailable and conflicting metadata cannot enable Auto or select a model", () => {
  for (const supplied of [publicModels({}), { ...catalog, models: catalog.models.map(model => ({ ...model, selectable: true, executionEnabled: false })) },
    { ...catalog, models: [...catalog.models, catalog.models[0]] }, { ...catalog, rateCardVersion: "other-version" }]) {
    const result = render({ catalog: supplied });
    assert.equal(result.option("auto")["aria-disabled"], true); assert.match(result.markup, /No supported model is enabled/);
    result.choose("auto"); result.choose("deepseek-flash"); result.key("Enter");
    assert.deepEqual(result.changes, []); result.dispose();
  }
});

test("disabled, loading and failed controls cannot open or change selection", () => {
  for (const extra of [{ disabled: true }, { loading: true }, { catalog: null }, { error: "not shown" }]) {
    const result = render(extra);
    assert.equal(result.trigger.disabled, true); assert.equal(result.list, undefined);
    result.key("ArrowDown"); result.key("Enter"); result.choose("deepseek-flash");
    assert.deepEqual(result.changes, []); result.dispose();
  }
});

test("arrows wrap enabled choices, Home/End reach bounds, and Enter restores focus", () => {
  const result = render();
  result.key("End"); assert.equal(result.trigger["aria-activedescendant"], result.option("deepseek-flash").id);
  result.key("ArrowDown"); assert.equal(result.trigger["aria-activedescendant"], result.option("auto").id);
  result.key("ArrowUp"); result.key("Enter");
  assert.deepEqual(result.changes, [{ mode: "explicit", modelId: "deepseek-flash" }]);
  assert.equal(result.trigger["aria-expanded"], false); assert.equal(result.focusCount, 1);
  result.key("Home"); result.key(" "); assert.deepEqual(result.changes.at(-1), { mode: "auto" });
  assert.ok(result.scrolled.length > 0); result.dispose();
});

test("Escape, outside click and Tab dismiss; inside clicks do not dismiss or select", () => {
  const result = render();
  result.inside(); assert.equal(result.trigger["aria-expanded"], true);
  const escaped = result.key("Escape"); assert.equal(escaped.prevented, true); assert.equal(escaped.stopped, true);
  assert.equal(result.trigger["aria-expanded"], false); assert.equal(result.focusCount, 1);
  result.clickTrigger(); result.outside(); assert.equal(result.list, undefined);
  result.clickTrigger(); assert.equal(result.key("Tab").prevented, false); assert.equal(result.list, undefined);
  assert.deepEqual(result.changes, []); result.dispose();
});

test("popover clamps to narrow viewports and uses below space when above cannot fit", () => {
  const result = render();
  result.resize({ innerWidth: 200, innerHeight: 200, rect: { top: 30, bottom: 74, left: 170 } });
  const style = result.list.style;
  assert.equal(style.width, 184); assert.equal(style.left, 8); assert.equal(style.bottom, undefined);
  assert.ok(style.top >= 8 && style.top + style.maxHeight <= 192); assert.ok(style.left + style.width <= 192); result.dispose();
});

test("foundation estimates identify per-call costs, ceilings and excluded extra calls", () => {
  const decision = decide({ mode: "auto" }), result = render({ decision });
  assert.match(result.markup, /Auto chose the lowest estimated cost/);
  assert.ok(result.markup.includes(`Estimated cost: ${creditText(decision.quote.estimatedCredits)} credits per model call.`));
  assert.ok(result.markup.includes(`Reservation ceiling: ${creditText(decision.quote.reservationCredits)} credits.`));
  assert.match(result.markup, /Estimate assumes uncached input/); assert.match(result.markup, /Tool fees and additional model calls are not included/);
  assert.match(result.markup, /Final charge uses reported usage/); result.dispose();
});

test("cache scenarios never promise a guaranteed hit or actual charge", () => {
  const binding = { ownerId: "fixture-owner", conversationId: "fixture-chat", provider: "deepseek", modelId: "deepseek-flash", prefixHash: "a".repeat(64), toolSchemaHash: "b".repeat(64), settingsHash: "c".repeat(64) };
  const decision = decide({ mode: "auto" }, { cacheBinding: binding, cacheObservations: [{ binding, observedAt: "2026-10-02T12:29:00.000Z", expiresAt: "2026-10-02T12:35:00.000Z", cacheReadTokens: 900 }] });
  const result = render({ decision });
  assert.equal(decision.quote.estimateBasis, "compatible_cache_scenario"); assert.match(result.markup, /a cache hit is not guaranteed/);
  assert.equal(result.trigger.value, "auto"); result.dispose();
});

test("affordable alternative requires a separate user click", () => {
  const selection = { mode: "explicit", modelId: "gpt-6.1-sol" }, decision = decide(selection), result = render({ selection, decision });
  assert.equal(result.trigger.value, selection.modelId); assert.deepEqual(result.changes, []);
  assert.equal(result.buttons[0].type, "button"); assert.match(result.markup, /Choose DeepSeek Flash instead — estimated/);
  result.alternative(); assert.deepEqual(result.changes, [{ mode: "explicit", modelId: "deepseek-flash" }]); result.dispose();
});

test("stale decisions, wrong versions and invalid prices never appear as estimates", () => {
  const decision = decide({ mode: "auto" });
  for (const quote of [{ ...decision.quote, rateCardVersion: "stale" }, { ...decision.quote, modelId: "gpt-6-luna" }, { ...decision.quote, estimatedCredits: NaN },
    { ...decision.quote, estimatedCredits: -1 }, { ...decision.quote, reservationCredits: 1 }, { ...decision.quote, reservationCredits: 2.5 },
    { ...decision.quote, cacheHitGuaranteed: true }, { ...decision.quote, estimateBasis: "guaranteed" }]) {
    const result = render({ decision: { ...decision, quote } }); assert.doesNotMatch(result.markup, /Estimated cost:|Reservation ceiling:/); result.dispose();
  }
  const explicit = { mode: "explicit", modelId: "deepseek-flash" };
  for (const props of [{ selection: explicit, decision }, { selection: { mode: "auto" }, decision: decide(explicit) }]) {
    const result = render(props); assert.doesNotMatch(result.markup, /Estimated cost:/); result.dispose();
  }
});

test("explicit routing reports minimum reservation without switching models", () => {
  const selection = { mode: "explicit", modelId: "deepseek-flash" }, result = render({ selection, decision: decide(selection, { availableCredits: 1 }) });
  assert.match(result.markup, /not enough credits for the minimum reservation/); assert.match(result.markup, /Reservation ceiling: 2 credits/);
  assert.equal(result.buttons.filter(button => !button["aria-label"]?.startsWith("About ")).length, 0); assert.deepEqual(result.changes, []); result.dispose();
});

test("real closed SSR uses unique React IDs and escaped metadata without a document", () => {
  const props = { catalog, selection: { mode: "auto" }, onChange: () => assert.fail("Render changed selection.") };
  const markup = renderToStaticMarkup(React.createElement("div", null, React.createElement(ModelSelector, props), React.createElement(ModelSelector, props)));
  const ids = [...markup.matchAll(/<button[^>]*id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.ok(markup.includes(`for="${id}"`));
  assert.doesNotMatch(markup, /role="listbox"/);
  const escaped = render({ catalog: { ...catalog, models: catalog.models.map(model => ({ ...model, label: '<script>alert("fixture")</script>' })) } });
  assert.doesNotMatch(escaped.markup, /<script>/); assert.match(escaped.markup, /&lt;script&gt;/); escaped.dispose();
});
