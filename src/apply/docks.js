import { incrementReport } from "../shared/models.js";
import { editableFields, firstIdentifier } from "../shared/util.js";
import { virtualDockToken, virtualDockUrl } from "../dock/proxy.js";

const DOCK_CREATE_FIELDS = new Set(["dock_id", "name", "model", "active", "custom_ws_url", "token", "wifi"]);
const DOCK_UPDATE_FIELDS = new Set(["name", "active", "custom_ws_url", "token", "wifi"]);

// -----------------------------------------------------------------------------
// Virtual Dock restoration
// -----------------------------------------------------------------------------

export class DockApplier {
  constructor({ client, config, mappings, responseList }) {
    this.client = client;
    this.config = config;
    this.mappings = mappings;
    this.responseList = responseList;
  }

  async apply(sourceNode, records, report) {
    const mapping = {};
    const currentIds = new Set();
    if (typeof this.client.coreMessage !== "function") {
      if (records.length) report.errors.push("Dock synchronization requires the Core WebSocket API");
      return mapping;
    }
    const existing = new Map();
    for (const active of [true, false]) {
      const response = await this.client.coreMessage("get_docks", { filter: { active }, paging: { page: 1, limit: 100 } }, 30_000);
      for (const dock of this.responseList(response, "docks")) {
        const id = String(firstIdentifier(dock, "dock_id", "id") || "");
        if (id) existing.set(id, dock);
      }
    }
    for (const record of records) {
      const sourceId = String(record?.source_id || firstIdentifier(record?.detail, "dock_id", "id") || "");
      if (!sourceId) continue;
      currentIds.add(sourceId);
      let targetId = this.mappings.get(sourceNode, "dock", sourceId) || sourceId;
      const detail = record.detail || {};
      const proxyFields = {
        active: true,
        custom_ws_url: virtualDockUrl(this.config, sourceId),
        token: virtualDockToken(this.config.agent_token, sourceNode, sourceId)
      };
      try {
        if (existing.has(targetId)) {
          try {
            await this.client.coreMessage("dock_connection_command", { dock_id: targetId, cmd: "DISCONNECT" }, 30_000);
          } catch (error) {
            report.warnings.push(`Could not disconnect Dock ${targetId} before proxy update: ${error.message}`);
          }
          const payload = { ...editableFields(detail, DOCK_UPDATE_FIELDS), ...proxyFields };
          await this.client.coreMessage("update_dock", { dock_id: targetId, ...payload }, 30_000);
          incrementReport(report, "docks_updated");
        } else {
          const payload = { ...editableFields({ ...detail, dock_id: targetId }, DOCK_CREATE_FIELDS), ...proxyFields };
          const created = await this.client.coreMessage("create_dock", payload, 30_000);
          targetId = firstIdentifier(created?.dock || created, "dock_id", "id") || targetId;
          incrementReport(report, "docks_created");
        }
        await this.client.coreMessage("dock_connection_command", { dock_id: targetId, cmd: "CONNECT" }, 30_000);
        incrementReport(report, "dock_connections_requested");
        const verified = await this.client.coreMessage("get_dock", { dock_id: targetId }, 30_000);
        if (!verified) throw new Error(`Dock ${targetId} was not visible after apply`);
        this.mappings.set(sourceNode, "dock", sourceId, targetId);
        mapping[sourceId] = targetId;
        incrementReport(report, "docks_proxied");
      } catch (error) {
        report.errors.push(`Dock ${sourceId}: ${error.message}`);
      }
    }
    if (this.config.sync.prune) {
      for (const [sourceId, targetId] of Object.entries(this.mappings.items(sourceNode, "dock"))) {
        if (currentIds.has(sourceId)) continue;
        try {
          await this.client.coreMessage("delete_dock", { dock_id: targetId }, 30_000);
          this.mappings.remove(sourceNode, "dock", sourceId);
          incrementReport(report, "docks_pruned");
        } catch (error) {
          report.warnings.push(`Could not prune dock ${targetId}: ${error.message}`);
        }
      }
    }
    return mapping;
  }
}
