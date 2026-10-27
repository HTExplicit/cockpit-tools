const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "predictions.js"), "utf8");
const target = { hostId: "local", threadId: "source", latestTurnId: "source-turn", generationTrigger: "catch_up" };

function environment(options = {}) {
  const timers = new Set();
  const context = { module: { exports: {} }, URL, DOMException, AbortController, Symbol,
    setTimeout(callback, delay) { const value = setTimeout(callback, options.timeout ?? delay); timers.add(value); return value; },
    clearTimeout(value) { timers.delete(value); clearTimeout(value); },
    __cockpitEnhancements: { nativePredictions: true, apiKeyAuthVerified: true, ...options.flags },
  };
  context.window = context;
  vm.runInNewContext(script, context);
  const api = context.module.exports;
  return { api, context, stop() { api.runtime.dispose(); for (const timer of timers) clearTimeout(timer); } };
}

function nativeManager(options = {}) {
  const calls = [], listeners = new Set(), eventListeners = new Map();
  let latest = "source-turn", auth = options.auth ?? null, disposed = 0;
  const metadata = { latestTurnId: "source-turn", streamRole: { role: "owner" }, ephemeral: false, sideConversation: false };
  const emit = event => { for (const listener of listeners) listener(event); };
  const manager = {
    getAuthMethod: async () => auth,
    getFollowUpContext: async () => ({ mode: options.plan ? "plan" : "default", ephemeral: false, sideConversation: false }),
    getLatestTurnId: async () => latest,
    getCachedConversationMetadata: async () => ({ ...metadata, latestTurnId: latest }),
    subscribe(request) {
      const selected = request.type === "notification" ? listeners : (eventListeners.get(request.event) ?? new Set());
      if (request.type === "event") eventListeners.set(request.event, selected);
      selected.add(request.listener);
      return { [Symbol.dispose]() { if (selected.delete(request.listener)) disposed++; } };
    },
    async sendRequest(method, params, requestOptions) {
      calls.push({ method, params, options: requestOptions });
      if (options.request) {
        const result = options.request(method, params, emit);
        if (result !== undefined) return result;
      }
      if (method === "thread/resume") return { thread: { id: "source", status: { type: "idle" } }, model: "api-model", modelProvider: "local-api" };
      if (method === "thread/fork") return { thread: { id: "prediction", ephemeral: options.ephemeral !== false }, model: "api-model", modelProvider: "local-api" };
      if (method === "turn/start") {
        if (!options.pending) {
          // Events deliberately arrive before the start acknowledgement.
          emit({ method: "item/started", params: { threadId: "prediction", turnId: "prediction-turn", item: { type: "userMessage" } } });
          emit({ method: "item/agentMessage/delta", params: { threadId: "prediction", turnId: "prediction-turn", delta: options.text ?? '{"suggestion":"Inspect the next diagnostic result."}' } });
          emit({ method: "turn/completed", params: { threadId: "prediction", turn: { id: "prediction-turn", status: "completed" } } });
        }
        return { turn: { id: "prediction-turn" } };
      }
      return {};
    },
  };
  return { manager, calls, emit, emitEvent(name, event) { for (const listener of eventListeners.get(name) ?? []) listener(event); }, listeners, setLatest(value) { latest = value; }, setAuth(value) { auth = value; }, get disposed() { return disposed; } };
}

function activate(env, fake) {
  env.api.runtime.register({ managerForHost: () => fake.manager, nativeEnabled: scope => scope.nativeOption !== false });
  env.api.setReady(true);
  return env.api.runtime.serviceFor({}, "local", null);
}

const fixtures = {
  initial: "function managerFor(scope,host){let registry=scope.get(registryAtom);if(registry)return registry.forHost(host);throw Error(`AppServerManager RPC is unavailable for hostId: ${host}`)}function initialize(){return slot=atom(base,({get:read})=>read(gates,`4290031608`)&&setting(read,descriptor().enabled)&&services.cumberbatch!=null)}",
  composer: "function Prediction(properties){let memo=cache(15),{controller:controller,canShowPrediction:visible,hostId:host,pluginHostId:plugin,roots:roots}=properties,scope=useScope(scopeAtom),target=read(targetAtom),service=services.cumberbatch,unused;let request={...target,generationTrigger:`catch_up`};return service.requestUserMessagePrediction(request)}",
  host: "async function background(scope,manager,target,current){let service=services?.cumberbatch;if(service!=null&&!remote(target.hostId)&&current()&&gate(scope,`4290031608`))try{if(!current()||!gate(scope,`4290031608`))return;return service.requestUserMessagePrediction(target)}catch(error){log(`Cumberbatch background prediction did not finish`,error)}}",
  settings: "function Settings(){let memo=cache(16),scope=useScope(scopeAtom),result;let gate=check(`4290031608`),service=services.cumberbatch,next=read(nextAtom),unused;const key=`cumberbatch-availability`;return gate&&service.isEnabledByRemoteConfig()}",
};
const urls = { initial: "app://-/assets/app-initial-random.js", composer: "app://-/assets/composer-content-random.js", host: "app://-/assets/initialize-app-host-services-random.js", settings: "app://-/assets/general-settings-random.js" };

test("all four synthetic native contracts transform together without fixed symbols", () => {
  const env = environment();
  try {
    for (const [kind, source] of Object.entries(fixtures)) {
      const result = env.api.transform(source, urls[kind]);
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.diagnostics.kind, kind);
      assert.ok(result.patchedSource.includes(`__cockpitNativePredictionContract:${kind}:v1`));
      assert.doesNotThrow(() => new vm.Script(result.patchedSource));
      assert.ok(!/addEventListener\(["']keydown|createElement|fetch\(/.test(result.patchedSource));
    }
    assert.match(env.api.transform(fixtures.initial, urls.initial).patchedSource, /managerForHost:managerFor/);
  } finally { env.stop(); }
});

test("ambiguous, missing and reinstalled contracts fail without a partial source", () => {
  const env = environment();
  try {
    for (const [kind, source] of Object.entries(fixtures)) {
      const duplicate = `${source}\n${source}`;
      const result = env.api.transform(duplicate, urls[kind]);
      assert.equal(result.ok, false);
      assert.equal(result.patchedSource, duplicate);
      assert.equal(env.api.transform("function unrelated(){}", urls[kind]).ok, false);
      const once = env.api.transform(source, urls[kind]);
      assert.equal(env.api.transform(once.patchedSource, urls[kind]).ok, false);
      assert.equal(env.api.transform(source, urls[kind].replace("app://-", "https://untrusted.example")).ok, false);
    }
  } finally { env.stop(); }
});

test("readiness and verified API flags are both required", async () => {
  const env = environment(), fake = nativeManager();
  try {
    env.api.runtime.register({ managerForHost: () => fake.manager, nativeEnabled: () => true });
    assert.equal(env.api.runtime.allow(), false);
    env.api.setReady(true);
    assert.equal(env.api.runtime.allow("local"), true);
    assert.equal(env.api.runtime.allow("ssh:example"), false);
    env.context.__cockpitEnhancements.apiKeyAuthVerified = false;
    env.api.runtime.update();
    assert.equal(env.api.runtime.allow(), false);
    assert.deepEqual(fake.calls, []);
  } finally { env.stop(); }
});

test("native fork inherits provider and uses the original source without HTTP generation", async () => {
  const env = environment(), fake = nativeManager();
  try {
    const service = activate(env, fake);
    const result = await service.requestUserMessagePrediction(target);
    assert.equal(result.text, "Inspect the next diagnostic result.");
    assert.equal(result.sourceTurnId, target.latestTurnId);
    assert.equal(result.predictionThreadId, "prediction");
    assert.deepEqual(fake.calls.map(call => call.method), ["thread/resume", "thread/fork", "turn/start", "thread/unsubscribe"]);
    const fork = fake.calls.find(call => call.method === "thread/fork").params;
    assert.equal(fork.experimentalPredictionMode, true);
    assert.equal(fork.experimentalDisablePredictionMcp, true);
    assert.equal(fork.ephemeral, true);
    assert.equal(fork.model, undefined);
    assert.equal(fork.modelProvider, undefined);
    const turn = fake.calls.find(call => call.method === "turn/start").params;
    assert.equal(turn.threadId, "prediction");
    assert.equal(turn.turnTrigger, "composer_predictions");
    assert.equal(turn.effort, "low");
    assert.match(turn.input[0].text, /Make zero tool calls/);
    assert.equal(fake.disposed, 5);
    assert.equal(fake.listeners.size, 0);
    assert.equal(env.api.runtime.status().inFlight, 0);
    assert.equal(script.includes("fetch("), false);
  } finally { env.stop(); }
});

test("matching requests share one native job and completed source turns stay cached", async () => {
  const env = environment(), fake = nativeManager();
  try {
    const service = activate(env, fake);
    const first = service.requestUserMessagePrediction(target), second = service.requestUserMessagePrediction(target);
    assert.equal(first, second);
    await first;
    await service.requestUserMessagePrediction(target);
    assert.equal(fake.calls.filter(call => call.method === "turn/start").length, 1);
  } finally { env.stop(); }
});

test("repeating the same bootstrap preserves active native bindings and jobs", async () => {
  const env = environment(), fake = nativeManager({ pending: true });
  try {
    const service = activate(env, fake);
    const promise = service.requestUserMessagePrediction(target);
    while (!fake.calls.some(call => call.method === "turn/start")) await new Promise(resolve => setImmediate(resolve));
    vm.runInNewContext(script, env.context);
    assert.equal(env.context.__cockpitNativePredictions, env.api);
    assert.equal(env.api.runtime.allow(), true);
    assert.equal(env.api.runtime.status().inFlight, 1);
    fake.emit({ method: "item/agentMessage/delta", params: { threadId: "prediction", turnId: "prediction-turn", delta: '{"suggestion":"Continue the native test."}' } });
    fake.emit({ method: "turn/completed", params: { threadId: "prediction", turn: { id: "prediction-turn", status: "completed" } } });
    assert.equal((await promise).text, "Continue the native test.");
  } finally { env.stop(); }
});

test("reconnect revocation requires the graph owner's explicit readiness grant", () => {
  const env = environment(), fake = nativeManager();
  try {
    activate(env, fake);
    env.api.runtime.dispose();
    vm.runInNewContext(script, env.context);
    assert.equal(env.api.runtime.allow(), false, "rebootstrap alone cannot reactivate a revoked graph");
    assert.equal(env.api.setReady(true), true, "a verified owner can reuse the same native module binding");
  } finally { env.stop(); }
});

test("a verified active graph can adopt native bindings after an owner reconnect", () => {
  const env = environment(), fake = nativeManager();
  try {
    activate(env, fake);
    env.api.runtime.dispose();
    env.context.__cockpitEnhancements.nativePatchState = "active";
    env.context.__cockpitEnhancements.nativePredictionPatchState = "ready";
    vm.runInNewContext(script, env.context);
    assert.equal(env.api.runtime.allow(), true);
    env.api.runtime.dispose();
    env.context.__cockpitEnhancements.nativePredictionPatchState = "unsupported";
    vm.runInNewContext(script, env.context);
    assert.equal(env.api.runtime.allow(), false);
  } finally { env.stop(); }
});

test("official and remote requests delegate to the existing native service", async () => {
  const env = environment(), fake = nativeManager({ auth: "chatgpt" });
  const calls = [];
  const original = { isEnabledByRemoteConfig: async () => false, requestUserMessagePrediction(request) { calls.push(request); return Promise.resolve({ text: "Official result" }); } };
  try {
    activate(env, fake);
    const service = env.api.runtime.serviceFor({}, "local", original);
    assert.equal(await service.isEnabledByRemoteConfig(), false);
    assert.equal((await service.requestUserMessagePrediction(target)).text, "Official result");
    const remoteTarget = { ...target, hostId: "ssh:host" };
    const remote = env.api.runtime.serviceFor({}, remoteTarget.hostId, original);
    assert.equal((await remote.requestUserMessagePrediction(remoteTarget)).text, "Official result");
    assert.equal(calls.length, 2);
    assert.deepEqual(fake.calls, []);
  } finally { env.stop(); }
});

test("plan, stale sources and a non-ephemeral fork never publish", async () => {
  for (const mode of ["plan", "stale", "persistent-fork"]) {
    const env = environment(), fake = nativeManager({ plan: mode === "plan", ephemeral: mode !== "persistent-fork" });
    try {
      if (mode === "stale") fake.setLatest("new-turn");
      const result = await activate(env, fake).requestUserMessagePrediction(target);
      assert.equal(result, null);
      assert.equal(fake.calls.some(call => call.method === "turn/start"), false);
      if (mode === "persistent-fork") assert.ok(fake.calls.some(call => call.method === "thread/unsubscribe"));
    } finally { env.stop(); }
  }
});

test("a new parent turn cancels only its temporary prediction and releases listeners", async () => {
  const env = environment(), fake = nativeManager({ pending: true });
  try {
    const promise = activate(env, fake).requestUserMessagePrediction(target);
    while (!fake.calls.some(call => call.method === "turn/start")) await new Promise(resolve => setImmediate(resolve));
    fake.emit({ method: "turn/started", params: { threadId: "source", turn: { id: "new-turn" } } });
    assert.equal(await promise, null);
    assert.ok(fake.calls.some(call => call.method === "turn/interrupt" && call.params.threadId === "prediction"));
    assert.ok(fake.calls.some(call => call.method === "thread/unsubscribe" && call.params.threadId === "prediction"));
    assert.equal(fake.listeners.size, 0);
    assert.equal(fake.calls.some(call => call.method === "turn/interrupt" && call.params.threadId === "source"), false);
  } finally { env.stop(); }
});

test("account changes invalidate a native prediction in flight", async () => {
  const env = environment(), fake = nativeManager({ pending: true });
  try {
    const promise = activate(env, fake).requestUserMessagePrediction(target);
    while (!fake.calls.some(call => call.method === "turn/start")) await new Promise(resolve => setImmediate(resolve));
    fake.setAuth("chatgpt");
    fake.emit({ method: "account/updated", params: { authMode: "chatgpt" } });
    assert.equal(await promise, null);
    assert.ok(fake.calls.some(call => call.method === "turn/interrupt"));
    assert.equal(fake.listeners.size, 0);
  } finally { env.stop(); }
});

test("native approval and input events cancel only the prediction fork", async () => {
  for (const event of ["approval-request", "user-input-request", "mcp-elicitation-request"]) {
    const env = environment(), fake = nativeManager({ pending: true });
    try {
      const promise = activate(env, fake).requestUserMessagePrediction(target);
      while (!fake.calls.some(call => call.method === "turn/start")) await new Promise(resolve => setImmediate(resolve));
      fake.emitEvent(event, { conversationId: "unrelated" });
      assert.equal(env.api.runtime.status().inFlight, 1);
      fake.emitEvent(event, { conversationId: "prediction" });
      assert.equal(await promise, null);
      assert.ok(fake.calls.some(call => call.method === "turn/interrupt" && call.params.threadId === "prediction"));
      assert.equal(fake.disposed, 5);
    } finally { env.stop(); }
  }
});

test("native Show predictions disabled prevents any fork and cancels an active one", async () => {
  const env = environment(), fake = nativeManager({ pending: true });
  let watchCallback, unwatchCount = 0;
  const scope = { nativeOption: false, watch(callback) { watchCallback = callback; return () => { unwatchCount++; }; } };
  try {
    activate(env, fake);
    const service = env.api.runtime.serviceFor(scope, "local", null);
    assert.equal(await service.requestUserMessagePrediction(target), null);
    assert.equal(fake.calls.some(call => call.method === "thread/fork"), false);
    scope.nativeOption = true;
    const pending = service.requestUserMessagePrediction(target);
    while (!fake.calls.some(call => call.method === "turn/start")) await new Promise(resolve => setImmediate(resolve));
    scope.nativeOption = false;
    watchCallback();
    assert.equal(await pending, null);
    assert.ok(fake.calls.some(call => call.method === "turn/interrupt"));
    assert.equal(unwatchCount, 1);
  } finally { env.stop(); }
});

test("an invalid fork cannot cause the real source thread to be unsubscribed", async () => {
  const env = environment(), fake = nativeManager({ request(method) {
    if (method === "thread/fork") return { thread: { id: "source", ephemeral: true }, model: "api-model", modelProvider: "local-api" };
  } });
  try {
    assert.equal(await activate(env, fake).requestUserMessagePrediction(target), null);
    assert.equal(fake.calls.some(call => call.method === "thread/unsubscribe" && call.params.threadId === "source"), false);
  } finally { env.stop(); }
});

test("timeout and disabling the feature cancel pending predictions without retry", async () => {
  for (const mode of ["timeout", "disabled"]) {
    const env = environment(mode === "timeout" ? { timeout: 20 } : {}), fake = nativeManager({ pending: true });
    try {
      const promise = activate(env, fake).requestUserMessagePrediction(target);
      while (!fake.calls.some(call => call.method === "turn/start")) await new Promise(resolve => setImmediate(resolve));
      if (mode === "disabled") { env.context.__cockpitEnhancements.nativePredictions = false; env.api.runtime.update(); }
      assert.equal(await promise, null);
      assert.equal(fake.calls.filter(call => call.method === "turn/start").length, 1);
      assert.equal(fake.listeners.size, 0);
    } finally { env.stop(); }
  }
});

test("late fork creation after cancellation is unsubscribed", async () => {
  let resolveFork;
  const env = environment(), fake = nativeManager({ request(method) {
    if (method === "thread/fork") return new Promise(resolve => { resolveFork = resolve; });
  } });
  try {
    const promise = activate(env, fake).requestUserMessagePrediction(target);
    while (!resolveFork) await new Promise(resolve => setImmediate(resolve));
    promise[Symbol.dispose]();
    assert.equal(await promise, null);
    resolveFork({ thread: { id: "late-fork", ephemeral: true }, model: "api-model", modelProvider: "local-api" });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(fake.calls.some(call => call.method === "thread/unsubscribe" && call.params.threadId === "late-fork"));
  } finally { env.stop(); }
});

test("tool requests and malformed or long suggestions are rejected", async () => {
  const inputs = ['not JSON', '{"suggestion":"x","extra":true}', '{"suggestion":false}', JSON.stringify({ suggestion: "x".repeat(201) }), '{"suggestion":null}', '{"suggestion":"line\\nbreak"}'];
  for (const text of inputs) {
    const env = environment(), fake = nativeManager({ text });
    try { assert.equal(await activate(env, fake).requestUserMessagePrediction(target), null); }
    finally { env.stop(); }
  }
  const env = environment(), fake = nativeManager({ pending: true });
  try {
    const promise = activate(env, fake).requestUserMessagePrediction(target);
    while (!fake.calls.some(call => call.method === "turn/start")) await new Promise(resolve => setImmediate(resolve));
    fake.emit({ method: "item/started", params: { threadId: "prediction", turnId: "prediction-turn", item: { type: "commandExecution" } } });
    assert.equal(await promise, null);
    assert.ok(fake.calls.some(call => call.method === "turn/interrupt"));
  } finally { env.stop(); }
});
