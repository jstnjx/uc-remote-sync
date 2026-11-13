import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SnapshotApplier } from "../src/apply/index.js";
import { AppliedObjectState, configurationHash } from "../src/apply/object-state.js";
import { stableConfiguration } from "../src/protocol/snapshot.js";
import { CoreApiError } from "../src/core/client.js";
import { RemoteSyncService } from "../src/service/index.js";
import { buildProxyCatalog } from "../src/proxy/catalog.js";
import { DriftGuard } from "../src/service/drift-guard.js";

const config = { sync: { use_standby_inhibitor: false, prune: false, verify_existing_resource_hashes: false } };
const manifest = (sections, data, changeHash = "configuration") => ({
  operation_id: randomUUID(), source_node_id: "master", source_name: "Primary", sections,
  content_hash: randomUUID(), change_hash: changeHash, resources: [], data: { entities: [], ...data }
});
class MappingMemory {
  constructor() { this.values = new Map(); }
  get(node, kind, source) { return this.values.get(`${node}|${kind}|${source}`) || null; }
  set(node, kind, source, target) { this.values.set(`${node}|${kind}|${source}`, target); }
  items() { return {}; }
  save() {}
}
class NoCache { get() { return null; } put() {} }

class ActivityCore {
  constructor() {
    this.activity = { entity_id: "a1", name: { en: "Old" }, options: {} };
    this.pages = [{ page_id: "old", name: { en: "Old" }, items: [] }];
    this.buttons = {};
    this.calls = [];
    this.sequence = 0;
  }
  async getJson(endpoint) {
    if (endpoint === "/activities/a1") return structuredClone(this.activity);
    if (endpoint === "/activities/a1/buttons") return structuredClone(this.buttons);
    if (endpoint === "/activities/a1/ui") return { pages: structuredClone(this.pages) };
    return null;
  }
  async listPaginated(endpoint) { return endpoint === "/entities" ? [{ entity_id: "remote_sync.main.activity_relay" }] : []; }
  async json(method, endpoint, { json } = {}) {
    this.calls.push({ method, endpoint, json });
    if (endpoint === "/activities/a1" && method === "PATCH") {
      this.activity = { ...this.activity, ...structuredClone(json), options: { ...this.activity.options, ...(json.options || {}) } };
      return {};
    }
    const prefix = "/activities/a1/ui/pages";
    if (endpoint === prefix && method === "POST") {
      if (json.name?.en === "Rejected") throw new CoreApiError(400, method, endpoint, { code: "VALIDATION_ERROR" });
      const page = { ...structuredClone(json), page_id: `p${++this.sequence}` };
      this.pages.push(page);
      return page;
    }
    if (endpoint.startsWith(`${prefix}/`) && method === "DELETE") {
      this.pages = this.pages.filter((item) => item.page_id !== endpoint.slice(prefix.length + 1));
      return {};
    }
    return {};
  }
}

class ProfileCore {
  constructor() {
    this.profile = { profile_id: "default", name: { en: "My Profile" } };
    this.pages = [
      { page_id: "p1", name: { en: "Lights" }, pos: 1, items: [] },
      { page_id: "p2", name: { en: "Media" }, pos: 2, items: [] }
    ];
    this.groups = [{ group_id: "g1", name: { en: "Favorite" }, entities: [] }];
    this.calls = [];
  }
  async getJson(path) { return path === "/profiles/default" ? structuredClone(this.profile) : null; }
  async listPaginated() { return []; }
  async json(method, endpoint, { json } = {}) {
    this.calls.push({ method, endpoint, json });
    return {};
  }
  async coreMessage(method, arg) {
    this.calls.push({ method, arg });
    if (method === "get_profile") return structuredClone(this.profile);
    if (method === "get_pages") return { pages: structuredClone(this.pages) };
    if (method === "get_groups") return { groups: structuredClone(this.groups) };
    if (method === "update_profile") { this.profile = { ...this.profile, ...structuredClone(arg) }; return this.profile; }
    if (method === "switch_profile") return {};
    if (method === "update_page") {
      const entry = this.pages.find((value) => value.page_id === arg.page_id);
      if (!entry) throw new Error("Missing page");
      Object.assign(entry, structuredClone(arg));
      return entry;
    }
    if (method === "update_group") {
      Object.assign(this.groups.find((entry) => entry.group_id === arg.group_id), structuredClone(arg));
      return {};
    }
    throw new Error(`Unexpected Core message ${method}`);
  }
}

async function runApply(client, mappings, state, snap) {
  const applier = new SnapshotApplier(client, config, new NoCache(), mappings, { appliedObjects: state });
  const report = await applier.apply(snap, {}, buildProxyCatalog(snap));
  return { report, state: applier.objectState.entries };
}

test("hashes ignore live availability and status without ignoring substantive configuration", () => {
  const source = { name: "Lamp", available: true, status: "ONLINE", attributes: { state: "OFF" }, options: { theme: "dark" } };
  const next = structuredClone(source);
  next.available = false; next.status = "OFFLINE"; next.attributes.state = "ON";
  assert.equal(configurationHash(source), configurationHash(next));
  assert.deepEqual(stableConfiguration(source), stableConfiguration(next));
  next.options.theme = "light";
  assert.notEqual(configurationHash(source), configurationHash(next));
  const authored = { ...source, options: { ...source.options, status: "shown" } };
  assert.notEqual(configurationHash(source), configurationHash(authored), "authored option.status must not be stripped");
});

test("saved desired configuration alone never hides observed local drift", async () => {
  const state = new AppliedObjectState();
  let actual = { name: "Old", available: true };
  await state.remember("activity", "source", "target", { name: "Old" }, async () => actual);
  assert.equal(await state.matches("activity", "source", "target", { name: "Old" }, async () => actual), true);
  actual = { name: "Changed locally", available: true };
  assert.equal(await state.matches("activity", "source", "target", { name: "Old" }, async () => actual), false);
  assert.equal(await state.matches("activity", "source", "target", { name: "Old" }, async () => { throw new Error("timeout"); }), false);
});

test("repeated activity syncs write nothing, metadata updates do not rebuild UI, and local drift is repaired", async () => {
  const client = new ActivityCore();
  const mappings = new MappingMemory();
  mappings.set("master", "activity", "source", "a1");
  let state = {};
  const snap = (name = "New", page = "Controls") => manifest(["activities"], {
    activities: [{ source_id: "source", detail: { name: { en: name }, options: {} },
      ui: { pages: [{ page_id: "source-page", name: { en: page }, items: [] }] } }]
  });
  let result = await runApply(client, mappings, state, snap());
  assert.equal(result.report.success, true, result.report.errors.join("; "));
  state = result.state;
  let previous = client.calls.length;
  result = await runApply(client, mappings, state, snap());
  assert.equal(result.report.success, true, result.report.errors.join("; "));
  assert.equal(client.calls.length, previous, "identical snapshot must cause zero writes");
  state = result.state;
  result = await runApply(client, mappings, state, snap("New name"));
  assert.equal(result.report.success, true, result.report.errors.join("; "));
  assert.ok(client.calls.length > previous, "changed activity metadata must be applied");
  assert.equal(client.calls.slice(previous).filter((call) => call.endpoint.includes("/ui/pages")).length, 0, "unchanged UI must survive metadata update");
  state = result.state;
  client.pages[0].name = { en: "Locally edited" };
  previous = client.calls.length;
  result = await runApply(client, mappings, state, snap("New name"));
  assert.equal(result.report.success, true, result.report.errors.join("; "));
  assert.ok(client.calls.slice(previous).some((call) => call.method === "POST" && call.endpoint.endsWith("/ui/pages")), "drifted UI must be restored");
  assert.equal(client.pages[0].name.en, "Controls");
});

test("invalid activity UI is rejected without deleting an existing page or claiming success", async () => {
  const client = new ActivityCore();
  const mappings = new MappingMemory();
  mappings.set("master", "activity", "source", "a1");
  const snap = manifest(["activities"], { activities: [{ source_id: "source", detail: { name: { en: "TV" }, options: {} },
    ui: { pages: [{ page_id: "bad", name: { en: "Rejected" }, items: [] }] } }] });
  const { report } = await runApply(client, mappings, {}, snap);
  assert.equal(report.success, false);
  assert.match(report.errors.join(" "), /previous pages preserved/);
  assert.deepEqual(client.pages.map((page) => page.page_id), ["old"]);
  assert.equal(client.calls.filter((call) => call.method === "DELETE" && call.endpoint.includes("/ui/pages/")).length, 0);
});

test("editing one profile page leaves unrelated pages, groups, and active-profile selection untouched", async () => {
  const client = new ProfileCore();
  const mappings = new MappingMemory();
  let state = {};
  const snap = (name = "Media") => manifest(["profiles"], { profiles: {
    items: [{ source_id: "default", detail: { profile_id: "default", name: { en: "My Profile" } },
      pages: [{ page_id: "source1", name: { en: "Lights" }, pos: 1, items: [] }, { page_id: "source2", name: { en: name }, pos: 2, items: [] }],
      groups: [{ group_id: "source-group", name: { en: "Favorite" }, entities: [] }] }],
    active: { profile_id: "default" }
  } });
  let result = await runApply(client, mappings, state, snap());
  assert.equal(result.report.success, true, result.report.errors.join("; "));
  state = result.state;
  let start = client.calls.length;
  result = await runApply(client, mappings, state, snap());
  assert.equal(result.report.success, true, result.report.errors.join("; "));
  assert.equal(client.calls.slice(start).filter((entry) => /^(update_|delete_|add_|switch_)/.test(entry.method)).length, 0);
  state = result.state;
  start = client.calls.length;
  result = await runApply(client, mappings, state, snap("Movies"));
  assert.equal(result.report.success, true, result.report.errors.join("; "));
  const writes = client.calls.slice(start).filter((entry) => /^(update_|delete_|add_|switch_)/.test(entry.method));
  assert.deepEqual(writes.map(({ method }) => method), ["update_page"]);
  assert.equal(writes[0].arg.page_id, "p2");
  assert.deepEqual(client.pages.map((p) => p.name.en), ["Lights", "Movies"]);
});

test("integrity diagnostics identify missing fingerprints, pending events, and mismatched objects", async () => {
  const detail = { name: { en: "A" } };
  const guard = new DriftGuard({
    getClient: () => ({ getJson: async () => ({ ...detail }), listPaginated: async () => [] }),
    getMappings: () => ({ kinds: () => ({ activity: { a: "target" } }) }),
    getSourceNode: () => "master", report: async () => true
  });
  assert.equal((await guard.integrityReport()).reason, "no saved fingerprints");
  await guard.captureFingerprints();
  assert.equal((await guard.integrityReport()).intact, true);
  detail.name = { en: "Edited" };
  const changed = await guard.integrityReport();
  assert.equal(changed.reason, "object fingerprint changed");
  assert.equal(changed.key, "activity|target");
  guard.pending.set("activity|target", { kind: "activity", id: "target" });
  assert.equal((await guard.integrityReport()).reason, "pending edited configuration");
});

test("state-only proxy refreshes do not re-register catalog entities", async () => {
  const snap = (attributes, name = "Lamp") => manifest(["entities"], { entities: [{
    entity_id: "hass.main.lamp", integration_id: "hass.main", entity_type: "light", name: { en: name },
    features: ["on_off"], attributes
  }] }, "same");
  const service = new RemoteSyncService({ load: () => null, save() {} });
  service.config = { ...config, role: "child", pairing: {}, peers: [] };
  let current = snap({ state: "OFF" });
  service.proxyCatalog = buildProxyCatalog(current);
  service.proxyCatalog.applied_change_hash = "earlier";
  const entity = service.proxyCatalog.entities[0];
  let registrations = 0;
  service.proxyListeners.push(() => { registrations += 1; });
  service.proxyStore = { save() {} };
  service.client = {
    getJson: async () => null,
    listPaginated: async () => [{ entity_id: entity.target_entity_id, name: entity.name, icon: entity.icon, description: entity.description }],
    json: async () => ({}),
    configureEntitiesFromIntegration: async () => ({})
  };
  service.hardwareProfile = { model: "UCR3" };
  service.driftGuard = { beginApply() {}, endApply() {}, setAppliedSettings() {}, async captureFingerprints() { return {}; } };
  current = snap({ state: "ON" });
  const result = await service.applyReceived(current, {}, { apply_mode: "full" });
  assert.equal(result.success, true, result.errors.join("; "));
  assert.equal(registrations, 0);
  const changed = await service.applyReceived(snap({ state: "ON" }, "Renamed"), {}, { apply_mode: "full" });
  assert.equal(changed.success, true, changed.errors.join("; "));
  assert.equal(registrations, 1);
  service.eventLoopDelay.disable();
});

test("profile page validation failure retains the previously configured page and marks the sync failed", async () => {
  const client = new ProfileCore();
  client.coreMessage = ((base) => async function (method, arg) {
    if (method === "update_page" && arg.name?.en === "Unsupported widget") {
      throw Object.assign(new Error("Invalid number-widget configuration"), { name: "CoreWebSocketError", code: 400 });
    }
    return base.call(client, method, arg);
  })(client.coreMessage);
  const snap = manifest(["profiles"], { profiles: {
    items: [{ source_id: "default", detail: { profile_id: "default", name: { en: "My Profile" } },
      pages: [{ page_id: "source1", name: { en: "Unsupported widget" }, pos: 1, items: [] },
        { page_id: "source2", name: { en: "Media" }, pos: 2, items: [] }],
      groups: [{ group_id: "source-group", name: { en: "Favorite" }, entities: [] }] }], active: null
  } });
  const { report } = await runApply(client, new MappingMemory(), {}, snap);
  assert.equal(report.success, false);
  assert.match(report.errors.join(" "), /Invalid number-widget configuration/);
  assert.equal(client.pages.length, 2);
  assert.equal(client.pages[0].name.en, "Lights");
});

test("a failing sync is never executed twice when its standby-inhibitor callback throws", async () => {
  let attempted = 0;
  const client = {
    async withStandbyInhibitor(_id, _name, _description, callback) { await callback(); },
    async listPaginated() { attempted += 1; throw new Error("Core unavailable"); }
  };
  const sync = manifest(["entities"], { entities: [] });
  const applier = new SnapshotApplier(client, {
    sync: { use_standby_inhibitor: true, prune: false }
  }, new NoCache(), new MappingMemory());
  const result = await applier.apply(sync, {}, buildProxyCatalog(sync));
  assert.equal(result.success, false);
  assert.equal(attempted, 1, "failing apply callback must not be retried as an inhibitor acquisition failure");
  assert.match(result.errors.join(" "), /Core unavailable/);
});

test("activity UI drift is detected independently of entity metadata", async () => {
  let pages = [{ page_id: "p1", name: { en: "Controls" }, items: [] }];
  const guard = new DriftGuard({
    getClient: () => ({
      getJson: async (endpoint) => endpoint.endsWith("/ui") ? { pages: structuredClone(pages) }
        : endpoint.endsWith("/buttons") ? {}
        : { entity_id: "target", name: { en: "TV" }, state: "OFF" },
      listPaginated: async () => []
    }),
    getMappings: () => ({ kinds: () => ({ activity: { src: "target" } }) }),
    getSourceNode: () => "master", report: async () => true
  });
  await guard.captureFingerprints();
  assert.equal((await guard.integrityReport()).intact, true);
  pages = [{ ...pages[0], name: { en: "Locally changed" } }];
  assert.equal((await guard.integrityReport()).reason, "object fingerprint changed");
});

test("runtime activity events are verified and discarded instead of forcing a full resync", async () => {
  let liveState = "OFF";
  const guard = new DriftGuard({
    getClient: () => ({
      getJson: async (endpoint) => endpoint.endsWith("/ui") ? { pages: [] }
        : endpoint.endsWith("/buttons") ? {}
        : { entity_id: "target", name: { en: "TV" }, state: liveState },
      listPaginated: async () => []
    }),
    getMappings: () => ({ kinds: () => ({ activity: { src: "target" } }) }),
    getSourceNode: () => "master", report: async () => true
  });
  await guard.captureFingerprints();
  guard.pending.set("activity|target", { kind: "activity", id: "target" });
  liveState = "ON";
  assert.equal((await guard.integrityReport()).intact, true);
  assert.equal(guard.pending.size, 0);
});
