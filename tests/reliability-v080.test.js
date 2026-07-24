import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotBuilder, SnapshotReader } from "../src/protocol/snapshot.js";
import { SyncCoordinator } from "../src/service/sync-coordinator.js";

const config = { node_id:"n", node_name:"N", sync:{ sections:[] }, remote:{}, peers:[] };
class Client { async version(){return {api:"test"}} async integrations(){return []} }

test("v0.8 binary snapshot round-trip uses non-base64 framing", async () => {
  const snapshot = await new SnapshotBuilder(new Client(), config).build();
  const parsed = await SnapshotReader.read(snapshot.payload);
  assert.equal(parsed.manifest.content_hash, snapshot.manifest.content_hash);
  assert.ok(snapshot.metrics.uncompressed_bytes > 0);
});

test("snapshot coordinator reuses a current compressed cache", async () => {
  let versions = 0;
  const client = new Client(); client.version = async () => { versions += 1; return {api:"test"}; };
  const coordinator = new SyncCoordinator({ getConfig:()=>config, getClient:()=>client, getStatus:()=>({}), discovery:{}, setDockCatalog:()=>{}, initializeActivityStates:async()=>{} });
  const first = await coordinator.buildSnapshot();
  const second = await coordinator.buildSnapshot();
  assert.equal(first, second);
  assert.equal(versions, 1);
  coordinator.invalidateCache();
  await coordinator.buildSnapshot();
  assert.equal(versions, 2);
});

test("snapshot generation can be cancelled when superseded", async () => {
  const builder = new SnapshotBuilder(new Client(), config, { shouldAbort: () => true });
  await assert.rejects(() => builder.build(), (error) => error.code === "SNAPSHOT_SUPERSEDED");
});
