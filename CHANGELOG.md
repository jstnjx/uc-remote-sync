# Changelog

## 0.7.2 - 2026-07-18

- Fixed IPv4 broadcast validation incorrectly rejecting every address because `net.isIPv4()` was compared with the number `1` instead of treated as a boolean.
- Added regression coverage for valid directed broadcast addresses and malformed IPv4 values.
- Updated the integration description to cover full configuration, entity, state, command, and Dock synchronization.

## 0.7.1 - 2026-07-18

- Reorganized the source tree into complete domain folders and left `src/driver.js` as the only root-level source file.
- Moved Core communication, agent transport, integration API, Dock proxying, pairing, protocol, proxy catalogue, network handling, storage, and shared infrastructure into dedicated modules.
- Renamed domain implementation files to concise names such as `apply/index.js`, `apply/docks.js`, `apply/profiles.js`, `core/events.js`, `storage/mappings.js`, and `storage/operations.js`.
- Updated every source, test, workflow, and documentation import to the new structure without adding compatibility wrapper files.
- Added source-layout documentation to make ownership and navigation explicit.

## 0.7.0 - 2026-07-18

- Restored the automated test suite to the source repository while keeping all test files out of the Remote installation archive.
- Added a dedicated reusable `test.yml` workflow and made release and GHCR publishing depend on successful tests.
- Added strict configuration schema validation, explicit migration functions, pre-migration backups and a `configuration_invalid` runtime state with actionable errors.
- Added protocol, snapshot-schema and capability negotiation for pairing, synchronization, previews, Dock tunnels and credential-management operations.
- Added authenticated Satellite status and management APIs plus per-Satellite sensors and actions on the Primary.
- Added read-only automatic network identity results and advanced fallback overrides to Primary and Satellite setup.
- Split setup, synchronization transport, profile restoration and Dock restoration into dedicated modules.
- Replaced the public detailed health response with a minimal `/healthz` endpoint and moved diagnostics to authenticated `/v1/status`.
- Added synchronization previews with estimated create, update and remove counts globally and per Satellite.
- Added credential rotation, rediscovery, enable/disable, unpair and remove operations for configured Satellites.
- Expanded regression coverage to configuration migration, validation, protocol negotiation, network detection, health authorization, Satellite management and dry-run previews.

## 0.6.1 - 2026-07-18

- Removed Primary and Satellite MAC-address and WoWLAN-broadcast entry fields from setup.
- Added automatic local Wi-Fi interface detection for on-device Primary and Satellite installations.
- Added external Primary neighbor-table lookup to determine the target Remote MAC after contacting Core.
- Calculate directed WoWLAN broadcast addresses from the selected LAN interface address and netmask.
- Publish Satellite network identity through pairing mDNS records and the authenticated pairing API.
- Populate discovered Satellite peer network details automatically and retain saved values only as a fallback.
- Added environment overrides for routed or unusual multi-interface deployments.

## 0.6.0 - 2026-07-18

- Replaced the user-facing Master / Child terminology with Primary / Satellite while retaining the stored `master` and `child` role values for configuration compatibility.
- Split primary setup into three steps: primary details, synchronization settings, and discovered satellite configuration.
- Preserved entered values while moving between setup steps and when validation returns the user to an earlier step.
- Replaced explanatory code-comment blocks with consistent section dividers across the source tree.
- Reduced inferred media-player command-to-feature mappings to the explicitly retained command set.
- Removed automated tests from the repository build workflow and made source validation independent of a `tests` directory.

## 0.5.3 - 2026-07-18

- Changed the project license from MPL-2.0 to MIT.
- Replaced the README with build, installation and deployment documentation.
- Removed `SECURITY.md`.
- Added `.github/workflows/build.yml` for reusable validation, testing, Remote-package creation and artifact upload.
- Updated `release.yml` to consume the reusable build workflow.
- Removed the obsolete `0.3.0` fallback from `tools/build_embedded.sh`.

- Added a dedicated GitHub Actions workflow that builds and publishes `linux/amd64` and `linux/arm64` images to `ghcr.io/<owner>/<repository>`.
- Added semantic-version, branch and commit-SHA image tags, with `latest` generated automatically for stable version tags.
- Added BuildKit cache reuse, OCI metadata, provenance and an SBOM to published images.
- Changed the default Docker Compose deployment to pull the GHCR image and added `docker-compose.build.yml` for local source builds.
- Reworked the release workflow to derive archive names from `package.json` instead of the obsolete hard-coded `0.3.0` version.

## 0.5.2 - 2026-07-18

- Resolve physical Dock endpoints from Core's `resolved_ws_url` field, with a standard Dock mDNS fallback.
- Accept a shared physical Dock API token or per-Dock token mappings in master setup.
- Normalize restored profile page-item positions to Core's one-based range.

## 0.5.1 - 2026-07-18

- Explicitly connect child virtual docks after creating or updating their Core configuration.
- Reconcile inactive dock configurations to avoid duplicate `Data already exists` errors.
- Recreate profile groups before pages and proactively remove invalid page items.


## 0.5.0

- Replaced inactive child Dock mirroring with an active protocol-compatible virtual Dock endpoint on each child.
- Added a child-to-master WebSocket tunnel for the complete Dock 3 text protocol, including IR, serial, trigger, port-mode, heartbeat, replies and asynchronous events.
- Added per-child/per-Dock HMAC-derived virtual tokens. The master validates the virtual credential and substitutes the physical Dock token only in the native Dock authentication request.
- Preserved Dock request IDs, response codes and event payloads by relaying all non-authentication frames unchanged.
- Added physical Dock endpoint resolution for Core records exposing a WebSocket URL directly or an address/host/IP plus token.
- Updated existing mirrored Dock records in place to `active: true`, a loopback virtual WebSocket URL and the derived credential during the next synchronization.
- Added virtual Dock and active tunnel counts to runtime status.
- Added end-to-end regression coverage from a simulated child Core through the virtual Dock and master tunnel to a simulated physical Dock, including an asynchronous serial event.

## 0.4.8

- Fixed child activity start/stop commands not reaching the master. Mirrored activities now replace Core's real `options.sequences.on` and `options.sequences.off` definitions with wrapped commands targeting the internal activity relay.
- Removed the copied source on/off sequences from child activities. Device commands now execute only on the master; the child activity remains a local UI/state representation.
- Added pending child activity intent tracking. A stale opposite master state received while a child start/stop request is in flight is ignored until the matching authoritative state arrives.
- Preserved the existing loop-suppression handshake for master-driven child state updates.
- Mirrored dock records are now forced inactive on child remotes. This preserves dock configuration without Core continuously reconnecting to a physical dock already connected to the master.
- Existing active mirrored docks are changed to inactive during the next successful synchronization.
- Added regressions for the native `options.sequences` relay shape, stale opposite activity-state rejection, and inactive dock creation.

## 0.4.7

- Fixed native remote entities being absent when Core returns an empty or incomplete `/remotes` collection. Remote Sync now discovers and hydrates `remote` entities from the configured `/entities` detail records and preserves their simple commands, button mappings and user-interface pages in the proxy catalogue.
- Added real-time activity on/off synchronization between master and child remotes. Child activity commands are relayed to the corresponding master activity, while master activity state events update the mapped child activities.
- Added a loop-suppression handshake so a state update received from the master can activate or deactivate the local child activity without forwarding the same command back to the master.
- Child activities now use Core's native `activity.on` and `activity.off` commands. Original activity sequences remain authoritative on the master instead of being executed independently on every child.
- Fixed profile page background images and positions being omitted. Profile pages are now created with `add_page` and then fully populated with `update_page`, matching Core's two-step page API.
- Preserved the `image` and `pos` page fields in both profile and activity UI snapshots.
- Fixed Core-generated blank pages appearing before mirrored activity pages. Existing activity UI pages are removed individually, mirrored pages are recreated in source order, and any extra empty page regenerated by Core is deleted afterward.
- Expanded activity-state event parsing for Core 0.17.x variants which omit `entity_type`, nest attributes inside the entity object, or provide only an internal `uc.main.*` identifier.
- Added regressions for remote fallback discovery, profile page image updates, activity relay and state synchronization, authenticated state delivery, and generated blank-page cleanup.

## 0.4.6

- Fixed macros still being collected as zero on Core API 0.17.6. Snapshot collection now reuses fully hydrated configured-entity details, where the internal `macro` type and sequence options are available even when the `/macros` collection and lightweight `/entities` overview are incomplete.
- Added Core WebSocket `get_entities` macro-filter compatibility attempts as a secondary discovery path.
- Internal activity, macro and remote records are no longer counted as ordinary proxy-source entities.
- Fixed profile restoration aborting after one invalid page. Rewritten profile pages are now checked against the child's configured entity set; unsupported items are removed individually, with a page-shell fallback if Core still rejects the layout.
- Profile groups are created after every profile page has a valid child identifier, including pages restored through the compatibility fallback.
- The active profile is no longer switched when profile restoration is incomplete.
- Dock records remain synchronized and active, but Remote Sync no longer forces an immediate `CONNECT` command. Core manages the dock connection lifecycle, avoiding false failures when the physical dock is already connected to the master.
- Added regressions for detail-only macro discovery, invalid profile-page recovery, profile-group continuation and non-forced dock connections.

## 0.4.5

- Added transactional profile synchronization through the native Core WebSocket API. Profiles are created or updated first, their existing pages and groups are reset, then pages and groups are recreated and verified by count.
- Profile page identifiers returned by the child are mapped before profile groups are written, so group page references point to the child-created pages.
- Profile page and group failures are now hard apply errors instead of warnings that could leave synchronization appearing successful.
- Added macro discovery fallback through configured `macro` entities when the dedicated `/macros` collection is empty on Core API 0.17.x.
- Fixed macro updates incorrectly using the activity-only membership-first payload. Macros are now updated directly with their rewritten command sequences.
- Added dock collection and synchronization through Core WebSocket operations, including create, update, verification, optional pruning and connection requests for active docks.
- Added the `docks` snapshot section and automatic migration of existing master configuration so updates do not require setup to be repeated.
- Bumped the snapshot schema to 5 while accepting schema 4 during a child-first rolling update.
- Added regressions for verified profile hierarchies, macro fallback and updates, dock restoration, configuration migration and schema compatibility.

## 0.4.4

- Fixed activity button mappings failing when configured entity metadata exposed only a subset of the source integration's available commands.
- Snapshot collection now force-refreshes each source integration's available-entity catalogue and merges full features, options and device class into configured entities.
- Activity, macro and page command references augment proxy capabilities as a fallback, including media-player navigation, playback, volume and menu features.
- Capability changes now create a revised proxy identifier while display-only changes retain the existing stable identifier.
- Superseded capability proxies are pruned only after activities, groups and profiles have been restored successfully.
- Added regressions for full capability metadata, `media_player.previous`, capability revision identifiers and deferred proxy pruning.

## 0.4.3

- Fixed activities remaining name/icon-only even though proxy entities were already configured successfully on the child.
- Core API 0.17.6 validates activity sequences against the activity's existing assigned entity list before applying the rest of the same PATCH. Activity and macro restoration now commits `options.entity_ids` first, then applies sequences and the remaining options in a second request.
- Entity membership is reconstructed from explicit `entity_ids`, on/off sequences, button mappings and activity UI pages after all source identifiers have been rewritten to child proxy IDs.
- Removed empty command and entity wrappers left behind when unsupported or master-only references are filtered. This fixes `Command object missing in sequence` and prevents invalid page-item shells.
- Activity groups and profiles are no longer modified after an activity or macro restoration failure, preventing another partial graph with invalid profile pages.
- Existing incomplete activities from earlier 0.4.x releases are repaired in place through the persisted mappings on the next successful synchronization.
- Added physical-log regression tests for membership-first activity updates, wrapped command pruning, invalid nested page-item pruning and dependent-profile blocking.

## 0.4.2

- Fixed proxy catalogs remaining unavailable on the child even after the v0.4.1 restart handshake. The real failure was the use of guessed REST entity-configuration routes that do not exist on Core API 0.17.6.
- Replaced per-proxy REST requests with the official Core WebSocket flow: force-refresh `get_available_entities`, verify every required local proxy ID, then call `configure_entities_from_integration`.
- Added fallback to `configure_entity_from_integration` for Core versions without the batch operation.
- Added compatibility request shapes and merged partial responses for older Core releases that omit paging metadata or return only a default-sized first page.
- Removed the child driver restart and Integration API socket-close activation path, eliminating `WebSocket is not open` response storms and overlapping snapshot retries.
- Added a hard configured-entity barrier: activities, macros, groups and pages are not created or updated until all required `remote_sync.main.proxy_*` entities appear in Core's `/entities` collection.
- Removed master-only Remote Sync control references such as `remote_sync.main.sync_now` from mirrored child activity sequences and pages.
- Existing incomplete activities and pages from v0.4.0/v0.4.1 are repaired in place through the persisted source-to-child mappings after proxy registration succeeds.
- Added structured Core WebSocket errors, entity-refresh diagnostics, batch/individual configuration tests, partial-response compatibility tests and registration-barrier regressions.

## 0.4.1

- Fixed proxy entities never becoming available after receiving the first proxy catalog. Core learns available integration entities during the driver handshake, so changed catalogs are now persisted and activated through a controlled child-driver restart.
- Added a `202 Accepted` proxy-catalog activation handshake. The master waits for the child to restart and resends the exact same signed snapshot before marking synchronization successful.
- Removed the unsafe mid-request Integration WebSocket close that produced `write after end` and left Core with an empty available-entity list.
- Replaced sixteen retries per proxy with a single global proxy-registration barrier followed by bounded concurrent configuration.
- Activities, macros, groups and profiles are no longer staged when proxy registration fails, preventing name/icon-only activities and invalid empty pages.
- Existing name/icon-only activities from 0.4.0 are completed on the next successful synchronization using their persisted source-to-child mappings.
- Added compatibility aliases for common Home Assistant helper entity types such as binary sensors, input selects, input buttons, scripts and scenes.
- Unsupported entity references are removed from individual sequences or pages instead of invalidating the complete activity or profile page.
- Snapshot collection now expands activity and profile page overviews to their full page definitions before delivery.
- Failed apply reports are no longer written to the idempotency cache, allowing the same operation to be retried after a transient registration failure.
- Added proxy activation, restart/resend, startup catalog, registration-barrier, helper-type and full-page regression tests.

## 0.4.0

- Replaced source-integration entity recreation with Remote Sync-owned proxy entities on child remotes.
- Child remotes no longer require Home Assistant, Denon, Apple TV or any other master integration to be installed or configured.
- Added deterministic `remote_sync.main.proxy_<hash>` identifiers while preserving source names, types, icons, descriptions, features, options, areas and synchronized attributes.
- Added authenticated child-to-master command forwarding. Commands executed on a child proxy are sent to the original master entity.
- Added a separate per-child command token, independent from the child snapshot-delivery token.
- Added reverse master-agent connection metadata to pairing and snapshot delivery, including WoWLAN fallback information.
- Added persistent child proxy catalogs and automatic restoration after driver restart.
- Added dynamic Integration API entity refresh when a new proxy catalog arrives.
- Reworked snapshot application order: proxy entities first, then staged macros and activities, followed by groups and profiles.
- Rewrites activity sequences, macro sequences, button mappings, UI pages, profile pages and groups to proxy/native child identifiers.
- Represents master native remote entities as Remote Sync remote proxies with simple commands, button mappings and UI options.
- Added proxy pruning limited to entities previously provided by Remote Sync.
- Added the **Mirrored entity count** sensor.
- Added schema version 4 and migration of existing pairing configuration without requiring re-pairing.
- Added proxy catalog, command-forwarding, activity-rewrite and no-child-integration regression tests.

## 0.3.4

- Fixed synchronization not starting until the first configured interval elapsed. A master now starts an initial forced synchronization 1.5 seconds after setup or startup.
- Added compatibility with Remote Core API 0.17.x pagination: the first collection request omits `page=1` and uses the validated `limit=100` request shape.
- Added compatibility fallback between the legacy `/intg` routes and current `/intg/instances` routes.
- Added compatibility fallback for configuring entities through legacy and current integration-instance endpoints.
- Fixed a retry-state bug where a snapshot hash was saved even when one or more children rejected the snapshot. Failed snapshots now remain pending and are retried even when the master configuration has not changed.
- Missing integration instances on a child no longer abort the entire apply operation. Their entities are skipped while resources, activities, macros, remotes and profiles continue where possible.
- Added detailed Core REST diagnostics including method, full request path, HTTP status, duration and a sanitized response body.
- Added detailed snapshot collection and per-child delivery logs.
- Added compatibility tests for Core API 0.17.6, legacy/current route fallback, partial child application and unchanged-snapshot retries.

## 0.3.3

- Fixed master setup failing to find children when the custom integration mDNS announcement does not leave the Remote sandbox.
- Added discovery through the Remote's system-owned `_uc-remote._tcp` DNS-SD service.
- Master setup now probes port `11081/health` on each discovered Remote and includes only Remote Sync children in ready-to-pair state.
- Added follow-up SRV, TXT and A queries for mDNS responders that do not include all additional records in the initial PTR response.
- The custom `_uc-remote-sync._tcp` announcement remains available as a fast path.
- Added regression tests for Remote-device discovery and child health classification.

## 0.3.2

- Fixed child discovery advertising `127.0.0.1` when the Remote integration interface is loopback-only.
- Loopback, unspecified and multicast IPv4 addresses are no longer published as child endpoints.
- Master discovery now derives the reachable child address from the mDNS response source and prefers it over advertised A records.
- Added `.local` hostname fallback when no usable IPv4 address is available.
- Identifier-based peers are resolved through mDNS before using any saved URL fallback, allowing DHCP address changes.
- Transient discovered addresses are no longer persisted as authoritative peer URLs.
- Added regression tests for loopback filtering and source-address discovery.

## 0.3.1

- Fixed setup getting stuck on **Setting up** after selecting Master or Child.
- Added the required intermediate `driver_setup_change` progress event before returning the next setup screen.
- Aligned setup transition ordering and delay with the official Unfolded Circle Node.js Integration API library.
- Added setup transition logging without exposing PINs or pairing tokens.
- Added a WebSocket protocol regression test covering role submission and the following setup form.

## 0.3.0

- Reworked setup into explicit master and child flows.
- Child setup now asks only for the Web Configurator PIN.
- Child setup generates a fresh pairing token and enters ready-to-pair mode.
- Added `ready=1` and paired-state mDNS advertisements.
- Master setup discovers all ready children and creates individual token, name and WoWLAN fields for each.
- Added pairing-token validation before setup completion.
- Added an authenticated child claim handshake.
- Claimed children remain discoverable with `ready=0` for runtime address resolution.
- Moved all synchronization, section, pruning, inhibitor and hash settings to the master setup.
- Added schema version 3 pairing state and child claim metadata.
- Added setup-flow and pairing-agent tests.

## 0.2.0

- Added stable `RMS-XXXX-XXXX` child identifiers.
- Added identifier-and-token master/child pairing.
- Added dependency-free DNS-SD/mDNS child discovery.
- Added manual URL, MAC and broadcast fallback fields.
- Removed the pairing token from normal integration entities.
- Added child identifier health/status metadata.
- Added discovery cache invalidation and WoWLAN retry handling.
- Added pairing, DNS packet and configuration migration tests.
- Master, child and external-host modes share the same Node.js artifact.

## 0.1.0

- Initial Node.js implementation.
- Master and child roles.
- Signed snapshot delivery and idempotent child application.
- Resource, entity, activity, macro, remote, activity-group and profile synchronization.
- Direct Core API access with WoWLAN fallback.
- Remote-hosted and external Docker deployment.
