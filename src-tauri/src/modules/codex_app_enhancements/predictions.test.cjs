const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "predictions.js"), "utf8");
const target = { hostId: "local", threadId: "source", latestTurnId: "source-turn", generationTrigger: "catch_up" };

function environment(options = {}) {
  const timers = new Set(), messages = new Set(), bridgeCalls = [];
  const schedule = options.clock ? options.clock.setTimeout : setTimeout;
  const unschedule = options.clock ? options.clock.clearTimeout : clearTimeout;
  let fake, nextId = 0;
  const context = { module: { exports: {} }, URL, DOMException, AbortController, Symbol,
    Date: options.clock ? class extends Date { static now() { return options.clock.now(); } } : Date,
    crypto: { randomUUID: () => `sample-${++nextId}` },
    setTimeout(callback, delay) { const value = schedule(callback, options.timeout ?? delay); timers.add(value); return value; },
    clearTimeout(value) { timers.delete(value); unschedule(value); },
    addEventListener(type, listener) { assert.equal(type, "message"); messages.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "message"); messages.delete(listener); },
    electronBridge: { sendMessageFromView(payload) { bridgeCalls.push(payload); return fake.bridge(payload, env); } },
    __cockpitEnhancements: { nativePredictions: true, apiKeyAuthVerified: true, ...options.flags },
  };
  context.window = context;
  vm.runInNewContext(script, context);
  const api = context.module.exports;
  const env = { api, context, timers, messages, bridgeCalls,
    attach(value) { fake = value; },
    get samples() { return bridgeCalls.filter(call => call.type === "mcp-request"); },
    emit(data) { for (const listener of messages) listener({ data }); },
    respond(id, result = sampleResult()) { env.emit({ type: "mcp-response", hostId: "local", message: { id, result } }); },
    stop() { api.runtime.dispose(); for (const timer of timers) context.clearTimeout(timer); assert.equal(fake?.listenerCount ?? 0, 0); },
  };
  return env;
}

function sampleResult(overrides = {}) {
  return { responseId: "response-sample", sourceTurnId: "source-turn", text: '{"suggestion":"Inspect the next diagnostic result."}', ...overrides };
}

function nativeManager(options = {}) {
  const calls = [], listeners = new Set(), eventListeners = new Map(), broken = new Set();
  let latest = "source-turn", auth = options.auth ?? null, disposed = 0;
  const metadata = { latestTurnId: "source-turn", streamRole: { role: "owner" }, ephemeral: false, sideConversation: false, ...options.metadata };
  const emit = event => { for (const listener of listeners) listener(event); };
  const manager = {
    getAuthMethod: async () => auth,
    getFollowUpContext: async () => ({ mode: options.plan ? "plan" : "default", ephemeral: false, sideConversation: false, ...options.context }),
    getLatestTurnId: async () => latest,
    getCachedConversationMetadata: async () => ({ ...metadata, latestTurnId: latest }),
    subscribe(request) {
      const selected = request.type === "notification" ? listeners : (eventListeners.get(request.event) ?? new Set());
      if (request.type === "event") eventListeners.set(request.event, selected);
      selected.add(request.listener);
      let onBroken;
      return { onRpcBroken(listener) { onBroken = listener; broken.add(listener); },
        [Symbol.dispose]() { broken.delete(onBroken); if (selected.delete(request.listener)) disposed++; } };
    },
    async sendRequest(method, params, requestOptions) {
      calls.push({ method, params, options: requestOptions });
      if (options.request) {
        const result = options.request(method, params, emit);
        if (result !== undefined) return result;
      }
      if (method === "thread/resume") return { thread: { id: "source", status: { type: "idle" } }, model: "api-model", modelProvider: "local-api", ...options.resumed };
      return {};
    },
  };
  return { manager, calls, emit,
    bridge(payload, env) {
      if (options.bridge) {
        const result = options.bridge(payload, env);
        if (result !== undefined) return result;
      }
      if (payload.type === "mcp-request" && !options.pending)
        env.respond(payload.request.id, sampleResult(Object.hasOwn(options, "text") ? { text: options.text } : {}));
      return Promise.resolve({});
    },
    emitEvent(name, event) { for (const listener of eventListeners.get(name) ?? []) listener(event); },
    breakRpc() { for (const listener of broken) listener(); },
    listeners, setLatest(value) { latest = value; }, setAuth(value) { auth = value; },
    get listenerCount() { return listeners.size + [...eventListeners.values()].reduce((sum, selected) => sum + selected.size, 0); },
    get jobListenerCount() { return this.listenerCount - (listeners.size ? 1 : 0) - (eventListeners.get("auth-status")?.size ? 1 : 0); },
    get disposed() { return disposed; },
  };
}

function activate(env, fake) {
  env.attach(fake);
  env.api.runtime.register({ managerForHost: () => fake.manager, nativeEnabled: scope => scope.nativeOption !== false });
  env.api.setReady(true);
  return env.api.runtime.serviceFor({}, "local", null);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function testClock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(delay) {
      const end = now + delay;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

async function until(predicate) {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("Expected asynchronous state was not reached");
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

test("the relocated native manager module retains the same host contract", () => {
  const env = environment();
  try {
    const url = "app://-/assets/renderer-app-server-managers-fixture.js";
    const result = env.api.transform(fixtures.host, url);
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.kind, "host");
    assert.ok(result.patchedSource.includes("__cockpitNativePredictionContract:host:v1"));
    assert.doesNotThrow(() => new vm.Script(result.patchedSource));
    assert.equal(env.api.transform(`${fixtures.host}\n${fixtures.host}`, url).ok, false);
    const wrapper = 'export { background } from "./renderer-app-server-managers-content.js";';
    assert.equal(env.api.transform(wrapper, url).ok, false);
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

test("a synchronous auth failure rejects and removes its initialized job", async () => {
  const env = environment(), fake = nativeManager();
  const failure = new Error("Auth unavailable");
  fake.manager.getAuthMethod = () => { throw failure; };
  try {
    const pending = activate(env, fake).requestUserMessagePrediction(target);
    await assert.rejects(pending, error => error === failure);
    assert.equal(env.api.runtime.status().inFlight, 0);
    assert.equal(env.api.runtime.status().reason, "request-failed");
    assert.deepEqual(fake.calls, []);
    assert.equal(fake.listeners.size, 0);
  } finally { env.stop(); }
});

test("native sample uses the loaded source and preserves its response shape", async () => {
  const env = environment(), fake = nativeManager();
  try {
    const result = await activate(env, fake).requestUserMessagePrediction(target);
    assert.equal(result.text, "Inspect the next diagnostic result.");
    assert.equal(result.responseId, "response-sample");
    assert.equal(result.sourceTurnId, target.latestTurnId);
    assert.equal(result.predictionThreadId, undefined);
    assert.equal(result.predictionTurnId, undefined);
    assert.equal(result.promptVersion, "cockpit-native-predictions-v3");
    assert.deepEqual(fake.calls.map(call => call.method), ["thread/resume"]);
    assert.equal(fake.calls[0].params.threadId, target.threadId);
    assert.equal(fake.calls[0].params.excludeTurns, true);
    const sample = env.samples[0], params = sample.request.params;
    assert.match(sample.request.id, /^thread\/sample:sample-1$/);
    assert.equal(sample.request.method, "thread/sample");
    assert.equal(sample.hostId, "local");
    assert.equal(sample.priority, "background");
    assert.equal(sample.source, "composer_predictions");
    assert.equal(sample.timeoutMs, 75000);
    assert.equal(sample.coalesce, false);
    assert.equal(params.threadId, target.threadId);
    assert.equal(params.expectedTurnId, target.latestTurnId);
    assert.equal(params.turnTrigger, "composer_predictions");
    assert.equal(params.threadSource, "composer_predictions");
    assert.equal(params.effort, "low");
    assert.equal(params.disableMcp, true);
    assert.match(params.prompt, /Make zero tool calls/);
    assert.match(params.prompt, /exactly one field/);
    assert.doesNotMatch(params.prompt, /consequential|200 characters/);
    assert.equal(params.responsesapiClientMetadata.prediction_source_thread_id, target.threadId);
    assert.equal(params.responsesapiClientMetadata.prediction_source_turn_id, target.latestTurnId);
    assert.equal(params.responsesapiClientMetadata.prediction_trigger, target.generationTrigger);
    assert.equal(params.model, undefined);
    assert.equal(params.modelProvider, undefined);
    assert.equal(params.context, undefined);
    assert.equal(fake.disposed, 0);
    assert.equal(fake.jobListenerCount, 0);
    assert.equal(env.messages.size, 0);
    assert.equal(env.timers.size, 0);
    assert.equal(env.api.runtime.status().inFlight, 0);
    for (const removed of ["thread/fork", "turn/start", "turn/interrupt", "thread/unsubscribe"])
      assert.equal(script.includes(`"${removed}"`), false, removed);
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
    assert.equal(env.samples.length, 1);
  } finally { env.stop(); }
});

test("a sample response can complete before its enqueue acknowledgement", async () => {
  const ack = deferred();
  const env = environment(), fake = nativeManager({ bridge(payload, context) {
    if (payload.type === "mcp-request") {
      context.respond(payload.request.id);
      return ack.promise;
    }
  } });
  try {
    const result = await activate(env, fake).requestUserMessagePrediction(target);
    assert.equal(result.text, "Inspect the next diagnostic result.");
    assert.equal(fake.jobListenerCount, 0);
    assert.equal(env.messages.size, 0);
    assert.equal(env.api.runtime.status().inFlight, 0);
    ack.resolve({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.bridgeCalls.length, 1);
    assert.deepEqual(fake.calls.map(call => call.method), ["thread/resume"]);
  } finally { ack.resolve({}); env.stop(); }
});

test("cancel retires locally before ACK then orders abandon before critical sample cancel", async () => {
  const ack = deferred(), abandon = deferred(), cancelAck = deferred();
  const env = environment(), fake = nativeManager({ pending: true,
    bridge(payload) {
      if (payload.type === "mcp-request") return ack.promise;
      if (payload.type === "mcp-request-abandon") return abandon.promise;
    },
    request(method) { if (method === "thread/sample/cancel") return cancelAck.promise; },
  });
  try {
    const pending = activate(env, fake).requestUserMessagePrediction(target);
    await until(() => env.samples.length === 1);
    const requestId = env.samples[0].request.id;
    pending[Symbol.dispose]();
    assert.equal(fake.jobListenerCount, 0);
    assert.equal(env.messages.size, 0);
    assert.equal(env.timers.size, 0);
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(env.api.runtime.status().inFlight, 0);
    assert.equal(env.bridgeCalls.length, 1);
    assert.equal(fake.calls.some(call => call.method === "thread/sample/cancel"), false);
    ack.resolve({});
    await until(() => env.bridgeCalls.length === 2);
    assert.equal(env.bridgeCalls[1].type, "mcp-request-abandon");
    assert.equal(env.bridgeCalls[1].hostId, "local");
    assert.equal(env.bridgeCalls[1].requestId, requestId);
    assert.equal(fake.calls.some(call => call.method === "thread/sample/cancel"), false);
    abandon.resolve({});
    await until(() => fake.calls.some(call => call.method === "thread/sample/cancel"));
    const cancel = fake.calls.at(-1);
    assert.equal(cancel.params.requestId, requestId);
    assert.equal(cancel.options.priority, "critical");
    assert.equal(cancel.options.source, "composer_predictions");
    assert.equal(cancel.options.coalesce, false);
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(fake.disposed, 0);
    cancelAck.resolve({});
  } finally { ack.resolve({}); abandon.resolve({}); cancelAck.resolve({}); env.stop(); }
});

test("failed abandon and cancel acknowledgements never change the retired result", async () => {
  for (const mode of ["throw", "reject"]) {
    const cancelAck = deferred();
    const env = environment(), fake = nativeManager({ pending: true,
      bridge(payload) {
        if (payload.type !== "mcp-request-abandon") return;
        if (mode === "throw") throw new Error("Abandon disconnected");
        return Promise.reject(new Error("Abandon disconnected"));
      },
      request(method) { if (method === "thread/sample/cancel") return cancelAck.promise; },
    });
    try {
      const pending = activate(env, fake).requestUserMessagePrediction(target);
      await until(() => env.samples.length === 1);
      pending[Symbol.dispose]();
      await assert.rejects(pending, { name: "AbortError" });
      await until(() => fake.calls.some(call => call.method === "thread/sample/cancel"));
      cancelAck.reject(new Error("Cancel disconnected"));
      await new Promise(resolve => setImmediate(resolve));
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
      assert.equal(env.api.runtime.status().inFlight, 0);
    } finally { cancelAck.resolve({}); env.stop(); }
  }
});

test("an old disposed job and late response cannot disturb a reacquired source job", async () => {
  const ack = deferred();
  const env = environment(), fake = nativeManager({ pending: true,
    bridge(payload) { if (payload.type === "mcp-request" && payload.request.id.endsWith("sample-1")) return ack.promise; },
  });
  try {
    const service = activate(env, fake);
    const first = service.requestUserMessagePrediction(target);
    await until(() => env.samples.length === 1);
    const oldId = env.samples[0].request.id;
    env.api.runtime.dispose();
    env.api.setReady(true);
    const second = service.requestUserMessagePrediction(target);
    await assert.rejects(first, { name: "AbortError" });
    await until(() => env.samples.length === 2);
    assert.equal(env.api.runtime.status().inFlight, 1);
    assert.equal(service.requestUserMessagePrediction(target), second);
    env.respond(oldId);
    ack.resolve({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.api.runtime.status().inFlight, 1);
    assert.equal(env.api.runtime.status().completed, 0);
    assert.equal(service.requestUserMessagePrediction(target), second);
    second[Symbol.dispose]();
    await assert.rejects(second, { name: "AbortError" });
    assert.equal(env.api.runtime.status().inFlight, 0);
  } finally { ack.resolve({}); env.stop(); }
});

test("repeating the same bootstrap preserves active native bindings and jobs", async () => {
  const env = environment(), fake = nativeManager({ pending: true });
  try {
    const promise = activate(env, fake).requestUserMessagePrediction(target);
    await until(() => env.samples.length === 1);
    vm.runInNewContext(script, env.context);
    assert.equal(env.context.__cockpitNativePredictions, env.api);
    assert.equal(env.api.runtime.allow(), true);
    assert.equal(env.api.runtime.status().inFlight, 1);
    env.respond(env.samples[0].request.id, sampleResult({ text: '{"suggestion":"Continue the native test."}' }));
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
    assert.equal(env.samples.length, 0);
  } finally { env.stop(); }
});

test("ineligible source contexts and incompatible resume results never sample", async () => {
  const cases = [
    { plan: true }, { stale: true }, { context: { ephemeral: true } }, { context: { sideConversation: true } },
    { context: { isClosedSubagent: true } }, { context: { latestCollaborationMode: { mode: "plan" } } },
    { resumed: { collaborationMode: { mode: "plan" } } }, { resumed: { model: null } }, { resumed: { modelProvider: null } },
    { resumed: { thread: { id: "other", status: { type: "idle" } } } },
    { resumed: { thread: { id: "source", status: { type: "active" } } } },
  ];
  for (const options of cases) {
    const env = environment(), fake = nativeManager(options);
    try {
      if (options.stale) fake.setLatest("new-turn");
      assert.equal(await activate(env, fake).requestUserMessagePrediction(target), null);
      assert.equal(env.samples.length, 0, JSON.stringify(options));
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
    } finally { env.stop(); }
  }
});

test("source turn and deletion notifications cancel only the active sample ID", async () => {
  for (const method of ["turn/started", "thread/deleted"]) {
    const env = environment(), fake = nativeManager({ pending: true });
    try {
      const promise = activate(env, fake).requestUserMessagePrediction(target);
      await until(() => env.samples.length === 1);
      fake.emit({ method, params: { threadId: "unrelated" } });
      assert.equal(env.api.runtime.status().inFlight, 1);
      fake.emit({ method, params: { threadId: "source", turn: { id: "new-turn" } } });
      await assert.rejects(promise, { name: "AbortError" });
      await until(() => fake.calls.some(call => call.method === "thread/sample/cancel"));
      assert.equal(fake.calls.at(-1).params.requestId, env.samples[0].request.id);
      assert.deepEqual(fake.calls.map(call => call.method), ["thread/resume", "thread/sample/cancel"]);
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
    } finally { env.stop(); }
  }
});

test("changed auth status and broken RPC invalidate an in-flight sample", async () => {
  for (const mode of ["account", "auth-status", "rpc-broken"]) {
    const env = environment(), fake = nativeManager({ pending: true });
    try {
      const promise = activate(env, fake).requestUserMessagePrediction(target);
      await until(() => env.samples.length === 1);
      if (mode === "account") {
        fake.setAuth("chatgpt");
        fake.emit({ method: "account/updated", params: { authMode: "chatgpt" } });
      } else if (mode === "auth-status") { fake.setAuth("chatgpt"); fake.emitEvent(mode, {}); }
      else fake.breakRpc();
      await assert.rejects(promise, { name: "AbortError" });
      await until(() => fake.calls.some(call => call.method === "thread/sample/cancel"));
      assert.equal(fake.calls.at(-1).params.requestId, env.samples[0].request.id);
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
    } finally { env.stop(); }
  }
});

test("native Show predictions prevents a sample and cancels an active one", async () => {
  const env = environment(), fake = nativeManager({ pending: true });
  let watchCallback, unwatchCount = 0;
  const scope = { nativeOption: false, watch(callback) { watchCallback = callback; return () => { unwatchCount++; }; } };
  try {
    activate(env, fake);
    const service = env.api.runtime.serviceFor(scope, "local", null);
    assert.equal(await service.requestUserMessagePrediction(target), null);
    assert.equal(env.samples.length, 0);
    scope.nativeOption = true;
    const pending = service.requestUserMessagePrediction(target);
    await until(() => env.samples.length === 1);
    scope.nativeOption = false;
    watchCallback();
    await assert.rejects(pending, { name: "AbortError" });
    await until(() => fake.calls.some(call => call.method === "thread/sample/cancel"));
    assert.equal(unwatchCount, 0);
    env.api.runtime.dispose();
    assert.equal(unwatchCount, 1);
    assert.equal(fake.jobListenerCount, 0);
    assert.equal(env.messages.size, 0);
  } finally { env.stop(); }
});

test("a synchronous Show predictions change cancels before dispatch and releases on disposal", async () => {
  const env = environment(), fake = nativeManager();
  let unwatchCount = 0;
  const scope = { nativeOption: true, watch(callback) {
    scope.nativeOption = false;
    callback();
    return () => { unwatchCount++; };
  } };
  try {
    activate(env, fake);
    await assert.rejects(env.api.runtime.serviceFor(scope, "local", null).requestUserMessagePrediction(target), { name: "AbortError" });
    assert.equal(unwatchCount, 0);
    env.api.runtime.dispose();
    assert.equal(unwatchCount, 1);
    assert.equal(fake.disposed, 0);
    assert.equal(fake.jobListenerCount, 0);
    assert.equal(env.messages.size, 0);
    assert.equal(env.timers.size, 0);
    assert.equal(env.api.runtime.status().inFlight, 0);
    assert.deepEqual(fake.calls, []);
    assert.equal(env.samples.length, 0);
  } finally { env.stop(); }
});

test("timeout, feature revocation and manager replacement cancel without retry", async () => {
  for (const mode of ["timeout", "disabled", "manager-replaced"]) {
    const env = environment(mode === "timeout" ? { timeout: 20 } : {}), fake = nativeManager({ pending: true });
    try {
      const promise = activate(env, fake).requestUserMessagePrediction(target);
      await until(() => env.samples.length === 1);
      if (mode === "disabled") { env.context.__cockpitEnhancements.nativePredictions = false; env.api.runtime.update(); }
      if (mode === "manager-replaced") env.api.runtime.register({ managerForHost: () => nativeManager().manager, nativeEnabled: () => true });
      await assert.rejects(promise, { name: "AbortError" });
      await until(() => fake.calls.some(call => call.method === "thread/sample/cancel"));
      assert.equal(env.samples.length, 1);
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
    } finally { env.stop(); }
  }
});

test("the adapter and its RPCs allow 75 seconds before cancelling", async () => {
  const clock = testClock(), env = environment({ clock }), fake = nativeManager({ pending: true });
  try {
    const pending = activate(env, fake).requestUserMessagePrediction(target);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await until(() => env.samples.length === 1);
    assert.equal(fake.calls.find(call => call.method === "thread/resume").options.timeoutMs, 75000);
    assert.equal(env.samples[0].timeoutMs, 75000);
    clock.advance(74999);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(env.api.runtime.status().inFlight, 1);
    clock.advance(1);
    await assert.rejects(pending, { name: "AbortError" });
    await until(() => fake.calls.some(call => call.method === "thread/sample/cancel"));
    const status = env.api.runtime.status();
    assert.equal(status.reason, "cancelled");
    assert.equal(status.stage, "sample");
    assert.equal(status.category, "cancelled");
    assert.equal(status.code, DOMException.ABORT_ERR);
    assert.equal(status.elapsedMs, 75000);
    assert.equal(env.samples.length, 1);
    assert.equal(env.timers.size, 0);
  } finally { env.stop(); }
});

test("concurrent timeout and success publish complete diagnostics for their own job", async () => {
  const clock = testClock(), env = environment({ clock }), fake = nativeManager({ pending: true,
    request(method, params) {
      if (method === "thread/resume") return { thread: { id: params.threadId, status: { type: "idle" } },
        model: "api-model", modelProvider: "local-api" };
    },
  });
  try {
    const service = activate(env, fake), timedOut = service.requestUserMessagePrediction(target);
    await until(() => env.samples.length === 1);
    clock.advance(1000);
    const successful = service.requestUserMessagePrediction({ ...target, threadId: "other" });
    await until(() => env.samples.length === 2);
    clock.advance(2000);
    env.emit({ type: "mcp-response", hostId: "local", message: {
      id: env.samples[0].request.id, error: { code: -32603, message: "sample timed out" },
    } });
    await assert.rejects(timedOut, error => error.code === -32603);
    let status = env.api.runtime.status();
    assert.equal(status.reason, "request-failed");
    assert.equal(status.stage, "sample");
    assert.equal(status.category, "timeout");
    assert.equal(status.code, -32603);
    assert.equal(status.elapsedMs, 3000);
    clock.advance(4000);
    env.respond(env.samples[1].request.id);
    await successful;
    status = env.api.runtime.status();
    assert.equal(status.reason, "completed");
    assert.equal(status.stage, "complete");
    assert.equal(status.category, null);
    assert.equal(status.code, null);
    assert.equal(status.elapsedMs, 6000);
    assert.equal(status.completed, 1);
    assert.equal(status.inFlight, 0);
  } finally { env.stop(); }
});

test("only a matching local mcp-response completes a sample", async () => {
  const env = environment(), fake = nativeManager({ pending: true });
  let delivered = false;
  try {
    const pending = activate(env, fake).requestUserMessagePrediction(target);
    pending.then(() => { delivered = true; });
    await until(() => env.samples.length === 1);
    const id = env.samples[0].request.id;
    for (const data of [null, {}, { type: "other", hostId: "local", message: { id, result: sampleResult() } },
      { type: "mcp-response", hostId: "remote", message: { id, result: sampleResult() } },
      { type: "mcp-response", hostId: "local", message: { id: "old-id", result: sampleResult() } },
      { type: "mcp-response", hostId: "local", message: { result: sampleResult() } }]) env.emit(data);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delivered, false);
    assert.equal(env.api.runtime.status().inFlight, 1);
    assert.equal(env.api.runtime.status().completed, 0);
    // Preload dispatches a synthetic MessageEvent without source or origin.
    env.respond(id);
    assert.equal((await pending).responseId, "response-sample");
    assert.equal(env.messages.size, 0);
  } finally { env.stop(); }
});

test("sample failures reject without automatic retry and a new native request can succeed", async () => {
  for (const mode of ["response-id", "source-turn", "unsupported", "backend-timeout"]) {
    const env = environment(), fake = nativeManager({ bridge(payload, context) {
      if (payload.type !== "mcp-request") return;
      if (context.samples.length !== 1) return;
      if (mode === "unsupported" || mode === "backend-timeout") context.emit({ type: "mcp-response", hostId: "local",
        message: { id: payload.request.id, error: mode === "unsupported"
          ? { code: -32601, message: "Method not found" } : { code: -32603, message: "sample timed out" } } });
      else context.respond(payload.request.id, sampleResult(mode === "response-id" ? { responseId: null } : { sourceTurnId: "stale-turn" }));
      return Promise.resolve({});
    } });
    try {
      const service = activate(env, fake);
      await assert.rejects(service.requestUserMessagePrediction(target),
        /Unsupported prediction sample|Method not found|sample timed out/);
      assert.equal(env.api.runtime.status().reason, "request-failed");
      assert.equal(env.api.runtime.status().completed, 0);
      if (mode === "backend-timeout") {
        assert.equal(env.api.runtime.status().category, "timeout");
        assert.equal(env.api.runtime.status().code, -32603);
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(env.samples.length, 1);
      assert.deepEqual(fake.calls.map(call => call.method), ["thread/resume"]);
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
      assert.equal(env.timers.size, 0);
      assert.equal(env.api.runtime.status().inFlight, 0);
      const next = service.requestUserMessagePrediction(target);
      assert.equal(service.requestUserMessagePrediction(target), next);
      assert.equal((await next).text, "Inspect the next diagnostic result.");
      assert.equal(env.samples.length, 2);
      assert.equal((await service.requestUserMessagePrediction(target)).text, "Inspect the next diagnostic result.");
      assert.equal(env.samples.length, 2);
    } finally { env.stop(); }
  }
});

test("a missing or failed bridge rejects without caching an empty result", async () => {
  for (const mode of ["missing", "throw", "reject"]) {
    let failBridge = true;
    const env = environment(), fake = nativeManager({ bridge(payload) {
      if (payload.type !== "mcp-request" || !failBridge) return;
      if (mode === "throw") throw new Error("Bridge disconnected");
      return Promise.reject(new Error("Bridge disconnected"));
    } });
    try {
      const service = activate(env, fake);
      const originalBridge = env.context.electronBridge;
      if (mode === "missing") delete env.context.electronBridge;
      await assert.rejects(service.requestUserMessagePrediction(target),
        /Prediction sample bridge unavailable|Bridge disconnected/);
      assert.equal(env.api.runtime.status().reason, "request-failed");
      assert.equal(env.api.runtime.status().completed, 0);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(env.samples.length, mode === "missing" ? 0 : 1);
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
      assert.equal(env.api.runtime.status().inFlight, 0);
      if (mode === "missing") env.context.electronBridge = originalBridge;
      failBridge = false;
      assert.equal((await service.requestUserMessagePrediction(target)).text, "Inspect the next diagnostic result.");
      assert.equal(env.samples.length, mode === "missing" ? 1 : 2);
    } finally { env.stop(); }
  }
});

test("final auth, source turn and provider checks can discard a completed sample", async () => {
  for (const mode of ["auth", "source", "provider"]) {
    const context = {};
    const env = environment(), fake = nativeManager({ pending: true, context });
    try {
      const pending = activate(env, fake).requestUserMessagePrediction(target);
      await until(() => env.samples.length === 1);
      if (mode === "auth") fake.setAuth("chatgpt");
      if (mode === "source") fake.setLatest("new-turn");
      if (mode === "provider") context.modelProvider = "other-provider";
      env.respond(env.samples[0].request.id);
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(fake.calls.some(call => call.method === "thread/sample/cancel"), false);
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
    } finally { env.stop(); }
  }
});

test("legitimate null and trimmed empty suggestions stay cached as successful empty results", async () => {
  const inputs = ['{"suggestion":null}', '{"suggestion":" "}', '{"suggestion":"\\r\\n\\t "}',
    '{"suggestion":null,"extra":true}'];
  for (const text of inputs) {
    const env = environment(), fake = nativeManager({ text });
    try {
      const service = activate(env, fake);
      const result = await service.requestUserMessagePrediction(target);
      assert.equal(result.text, null);
      assert.equal(result.responseId, "response-sample");
      assert.equal(result.sourceTurnId, target.latestTurnId);
      assert.equal(env.api.runtime.status().reason, "empty");
      assert.equal(env.api.runtime.status().completed, 1);
      assert.equal((await service.requestUserMessagePrediction(target)).text, null);
      assert.equal(env.samples.length, 1);
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
    } finally { env.stop(); }
  }
});

test("native string suggestions retain long, multiline and control-character content", async () => {
  const suggestions = ["x".repeat(201), "line\nbreak", "line\r\nbreak", "with\ttab\u0000inside"];
  for (const suggestion of suggestions) {
    const env = environment(), fake = nativeManager({ text: JSON.stringify({ suggestion: `  ${suggestion}  `, extra: true }) });
    try {
      const service = activate(env, fake);
      const result = await service.requestUserMessagePrediction(target);
      assert.equal(result.text, suggestion);
      assert.equal(env.api.runtime.status().reason, "completed");
      assert.equal((await service.requestUserMessagePrediction(target)).text, suggestion);
      assert.equal(env.samples.length, 1);
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
    } finally { env.stop(); }
  }
});

test("invalid JSON and native suggestion schema failures reject instead of caching null", async () => {
  const inputs = [null, undefined, "not JSON", "null", "false", "1", '"text"', "[]", "{}",
    '{"suggestion":false}', '{"suggestion":1}', '{"suggestion":[]}', '{"suggestion":{}}',
    '```json\n{"suggestion":"valid only without fences"}\n```'];
  for (const text of inputs) {
    const env = environment(), fake = nativeManager({ bridge(payload, context) {
      if (payload.type !== "mcp-request" || context.samples.length !== 1) return;
      const result = sampleResult({ text });
      if (text === undefined) delete result.text;
      context.respond(payload.request.id, result);
      return Promise.resolve({});
    } });
    try {
      const service = activate(env, fake);
      await assert.rejects(service.requestUserMessagePrediction(target));
      assert.equal(env.api.runtime.status().reason, "request-failed");
      assert.equal(env.api.runtime.status().completed, 0);
      assert.equal(env.api.runtime.status().inFlight, 0);
      assert.equal(fake.jobListenerCount, 0);
      assert.equal(env.messages.size, 0);
      assert.equal(env.timers.size, 0);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(env.samples.length, 1);
      assert.equal((await service.requestUserMessagePrediction(target)).text, "Inspect the next diagnostic result.");
      assert.equal(env.samples.length, 2);
    } finally { env.stop(); }
  }
});


test("catch-up uses native readiness without repeating the live owner gate", async () => {
  for (const generationTrigger of ["catch_up", "live"]) {
    const env = environment(), fake = nativeManager({ metadata: { streamRole: { role: "subscriber" } } });
    try {
      const result = await activate(env, fake).requestUserMessagePrediction({ ...target, generationTrigger });
      if (generationTrigger === "catch_up") {
        assert.equal(result.responseId, "response-sample");
        assert.equal(env.samples.length, 1);
      } else {
        assert.equal(result, null);
        assert.equal(env.samples.length, 0);
      }
    } finally { env.stop(); }
  }
});

test("unchanged account and auth events leave the current sample running", async () => {
  const env = environment(), fake = nativeManager({ pending: true });
  try {
    const service = activate(env, fake), pending = service.requestUserMessagePrediction(target);
    await until(() => env.samples.length === 1);
    fake.emit({ method: "account/updated", params: { authMode: "apikey" } });
    fake.setAuth("apiKey");
    fake.emitEvent("auth-status", {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.api.runtime.status().cancelled, 0);
    assert.equal(service.requestUserMessagePrediction(target), pending);
    env.respond(env.samples[0].request.id);
    assert.equal((await pending).text, "Inspect the next diagnostic result.");
    assert.equal(fake.calls.some(call => call.method === "thread/sample/cancel"), false);
  } finally { env.stop(); }
});

test("new turns and Show predictions changes clear completed results without extra subscriptions", async () => {
  const env = environment(), fake = nativeManager();
  let watchCallback, unwatched = 0;
  const scope = { nativeOption: true, watch(callback) { watchCallback = callback; return () => { unwatched++; }; } };
  try {
    activate(env, fake);
    const service = env.api.runtime.serviceFor(scope, "local", null);
    await service.requestUserMessagePrediction(target);
    assert.equal(fake.listenerCount, 2);
    await service.requestUserMessagePrediction(target);
    assert.equal(env.samples.length, 1);
    assert.equal(fake.listenerCount, 2);
    fake.emit({ method: "turn/started", params: { threadId: target.threadId } });
    await service.requestUserMessagePrediction(target);
    assert.equal(env.samples.length, 2);
    scope.nativeOption = false;
    watchCallback();
    assert.equal(await service.requestUserMessagePrediction(target), null);
    scope.nativeOption = true;
    watchCallback();
    await service.requestUserMessagePrediction(target);
    assert.equal(env.samples.length, 3);
    assert.equal(fake.listenerCount, 2);
    env.api.runtime.dispose();
    assert.equal(fake.listenerCount, 0);
    assert.equal(unwatched, 1);
  } finally { env.stop(); }
});

test("RPC failures preserve their code while diagnostics exclude response content", async () => {
  const secret = "SYNTHETIC-PRIVATE-ERROR-CONTENT";
  const env = environment(), fake = nativeManager({ bridge(payload, context) {
    if (payload.type !== "mcp-request") return;
    context.emit({ type: "mcp-response", hostId: "local", message: {
      id: payload.request.id, error: { code: -32603, message: secret },
    } });
    return Promise.resolve({});
  } });
  try {
    await assert.rejects(activate(env, fake).requestUserMessagePrediction(target), error =>
      error.message === secret && error.code === -32603);
    const status = env.api.runtime.status();
    assert.equal(status.stage, "sample");
    assert.equal(status.category, "rpc");
    assert.equal(status.code, -32603);
    assert.equal(typeof status.elapsedMs, "number");
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(env.samples.length, 1);
  } finally { env.stop(); }
});


test("changing native route scopes retires the previous settings watcher", async () => {
  const env = environment(), fake = nativeManager();
  let active = 0;
  const scope = () => ({ nativeOption: true, watch() { active++; return () => { active--; }; } });
  try {
    activate(env, fake);
    for (let index = 0; index < 4; index++) {
      const service = env.api.runtime.serviceFor(scope(), "local", null);
      await service.requestUserMessagePrediction(target);
      assert.equal(active, 1);
      assert.equal(fake.listenerCount, 2);
    }
    assert.equal(env.samples.length, 1);
    env.api.runtime.dispose();
    assert.equal(active, 0);
  } finally { env.stop(); }
});


test("a late retired subscription failure cannot remove the replacement observer", async () => {
  const late = deferred(), env = environment(), fake = nativeManager();
  let subscriptions = 0;
  const subscribe = fake.manager.subscribe;
  fake.manager.subscribe = request => {
    subscriptions++;
    if (subscriptions === 1) return late.promise;
    return subscribe(request);
  };
  try {
    const service = activate(env, fake), old = service.requestUserMessagePrediction(target);
    await until(() => subscriptions === 1);
    env.api.runtime.dispose();
    env.api.setReady(true);
    await assert.rejects(old, { name: "AbortError" });
    assert.equal((await service.requestUserMessagePrediction(target)).responseId, "response-sample");
    assert.equal(subscriptions, 3);
    late.reject(new Error("Retired subscription closed"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await service.requestUserMessagePrediction(target)).responseId, "response-sample");
    assert.equal(subscriptions, 3);
    fake.emit({ method: "turn/started", params: { threadId: target.threadId } });
    await service.requestUserMessagePrediction(target);
    assert.equal(env.samples.length, 2);
  } finally { late.resolve({}); env.stop(); }
});
