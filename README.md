<img src="remote-sync.svg" width="72" alt="" align="right">

# UC Remote Sync

UC Remote Sync synchronizes one Primary Unfolded Circle Remote with one or more Satellite remotes. It can run directly on Remote Two/3 or as an external Primary through Docker or Node.js. Satellite instances must run directly on their remotes because the virtual Dock endpoint uses loopback networking.


## Requirements

- Node.js 22.13 or newer for builds and standalone deployment
- Docker with Compose for container deployment
- Remote Two or Remote 3 for direct installation

## Build and test

The project has no runtime npm dependencies.

```bash
npm run check
npm test
npm run build:embedded
```

To validate and build without running tests:

```bash
npm run package
```

Generated installation files:

```text
remote-sync-0.11.4.tar.gz
remote-sync-0.11.4.tar.gz.sha256
```

Tests remain in the source repository but are not copied into the Remote installation archive. The archive is produced by `src/shared/package.js`, the same builder a Primary uses at runtime to install Remote Sync on Satellites. The version is read from `driver.json`; `package.json` must match it.

## Install on Remote Two/3

1. Open **Web Configurator → Integrations → Add new → Install custom**.
2. Select `remote-sync-0.11.4.tar.gz`.
3. Select **Update existing driver** when upgrading.
4. Only the Primary has to be installed by hand. Satellites added by address and PIN are installed and kept on the Primary's version automatically. For Satellites paired with a token (0.8.x style), update them before the Primary.

### Setup

1. Install the integration and start its setup. Enter the remote's **Web Configurator PIN** — that is the only question. Remote Sync creates its API key, detects the network identity and enables Wake on WLAN.
2. The last page links to the dashboard. Sign in with the same PIN and choose **Primary** or **Satellite**.
3. On the Primary, choose **Add satellite** and enter each Satellite's IP address and PIN. Remote Sync is installed or updated on it, set up and paired automatically — a Satellite remote needs no manual setup at all. A remote that was set up but has no role yet becomes a Satellite when a Primary pairs with it.

Reconfiguring the integration on the Remote only renews the API key; the role, Satellites and settings are kept. To change the role, use **Settings → Reset role** in the dashboard.

Satellites on Remote Sync 0.8 or older can be added with their agent address and pairing token (*Add satellite → Pairing token*). An unpaired 0.9 Satellite shows its own fallback token on its dashboard for 0.8 Primaries.

### Web dashboard

```text
http://<remote-address>:11081/ui
```

Sign in with the Web Configurator PIN of the remote this instance manages.

- **No role yet:** choose Primary or Satellite.
- **Primary:** a sidebar of Satellites next to the Primary overview (status, last synchronization, Wake on WLAN, last preview with the names of objects that would be created, updated or removed). Selecting a Satellite shows its status and actions: synchronize, preview, update Remote Sync, enable/disable, rediscover, rotate credentials, unpair and remove. *Add satellite* supports address + PIN (with network search) and the token fallback.
- **Satellite:** pairing status, mirrored entities and the fallback token while unpaired.
- **Settings** (all roles): name, agent URL override and network overrides; on a Primary also synchronization behaviour, sections and physical Dock API tokens; and resetting the role.
- A log panel with continuous refresh at the bottom.

Sessions are held in memory for 12 hours in an `HttpOnly`, `SameSite=Strict` cookie. Login attempts are limited to five failures per five minutes per client.

## Deploy with Docker Compose

The default Compose file pulls:

```text
ghcr.io/jstnjx/uc-remote-sync:latest
```

Start the external Primary:

```bash
docker compose pull
docker compose up -d
docker compose logs -f remote-sync
```

Pin a release:

```bash
REMOTE_SYNC_IMAGE=ghcr.io/jstnjx/uc-remote-sync:0.11.3 docker compose up -d
```

Build locally:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Host networking is required for Remote discovery, Satellite pairing and WoWLAN. Persistent configuration and state are stored in `./config` and `./data`.

On a multi-interface host, set the LAN address to advertise:

```bash
UC_MDNS_ADDRESS=192.168.1.10 docker compose up -d
```

## Deploy with Node.js

```bash
UC_CONFIG_HOME=/var/lib/uc-remote-sync/config \
STATE_DIRECTORY=/var/lib/uc-remote-sync/data \
UC_INTEGRATION_HTTP_PORT=11082 \
node src/driver.js
```

A systemd unit template is included at `deploy/remote-sync.service`.

## Deployment variables

| Variable | Default | Purpose |
|---|---:|---|
| `UC_CONFIG_HOME` | `config` | Configuration directory |
| `STATE_DIRECTORY` | `data` | Runtime-state directory |
| `UC_INTEGRATION_HTTP_PORT` | `11082` | Integration API port |
| `UC_INTEGRATION_INTERFACE` | `0.0.0.0` | Integration API bind address |
| `UC_MDNS_HOSTNAME` | `remote-sync` | Advertised mDNS hostname |
| `UC_MDNS_ADDRESS` | automatic | LAN address advertised through mDNS |
| `REMOTE_SYNC_PRIMARY_MAC` | automatic | Advanced external Primary MAC override |
| `REMOTE_SYNC_PRIMARY_BROADCASTS` | automatic | Advanced Primary broadcast override list |
| `REMOTE_SYNC_SATELLITE_MAC` | automatic | Advanced Satellite MAC override |
| `REMOTE_SYNC_SATELLITE_BROADCASTS` | automatic | Advanced Satellite broadcast override list |
| `REMOTE_SYNC_REMOTE_ADDRESS` | automatic | Core address used by the PIN setup; defaults to `127.0.0.1` on the Remote and to the address of the Remote running the setup for an external instance |
| `REMOTE_SYNC_REMOTE_PORT` | unset | Core HTTP port used by the PIN setup |
| `REMOTE_SYNC_AGENT_PORT` | `11081` | Agent and dashboard port written by the first setup |
| `REMOTE_SYNC_SATELLITE_REMOTE_ADDRESS` | unset | Deprecated alias for `REMOTE_SYNC_REMOTE_ADDRESS` |
| `REMOTE_SYNC_CHILD_REMOTE_ADDRESS` | unset | Deprecated alias for the Satellite address |
| `UC_DISABLE_MDNS_PUBLISH` | `false` | Disable integration mDNS publication |
| `DEBUG` | unset | Logging namespace filter |

## Health and management

Public container health endpoint:

```text
GET /healthz
```

It returns only service status and version. Detailed diagnostics require the agent bearer token:

```text
GET /v1/status
GET /v1/satellites
POST /v1/satellites/<peer-id>/actions/<action>
```

Supported Satellite actions are `sync`, `preview`, `update`, `enable`, `disable`, `rediscover`, `rotate`, `unpair` and `remove`. `unpair` keeps the synchronized configuration on the Satellite; `remove` first calls `POST /v1/pairing/purge` on the Satellite, which deletes every object it recorded while applying this Primary's snapshots (plus the resources of the Primary's current snapshot), then unpairs. Objects that cannot be deleted stay tracked, so a later removal retries them. A Satellite on 0.8.x or one that is offline is still removed from the Primary, and the dashboard reports that its configuration was left in place. The Primary integration exposes a status sensor and an action select per Satellite.

A synchronization preview can also be started through the global **Preview synchronization** button or with `POST /v1/sync` using `dry_run: true`. Preview mode estimates create, update and remove operations without applying the snapshot.

### Staying in sync

Any remote can be the Primary — a Remote Two, a Remote 3 or an external instance (Docker, Node.js) — and any mix of Remote Two and Remote 3 can be Satellites.

**Persistent link.** Every Satellite keeps one WebSocket open to the Primary while it is awake (`/v1/link`, authenticated with its command token; heartbeats every 15 s). The Primary numbers every live update — device states and activity states — within an epoch that changes when the Primary restarts. A Satellite that reconnects reports the last number it applied: missed updates are replayed, and if they are no longer buffered (or the Primary restarted) it receives a complete state image instead. Gaps are detected and repaired, never guessed. Commands, button presses and activity starts travel up the same link; if the link is down they fall back to HTTP, which also wakes a sleeping Primary over WLAN. A command that was sent over the link but not answered is never repeated, so nothing runs twice.

**Configuration: the Primary is the master.** On every (re)connection the Satellite reports which configuration it has applied; if it missed a change it is synchronized at once. Edits made directly on a Satellite to anything that came from the Primary (activities, macros, activity groups, profiles, pages) are detected, a backup of the edited object is kept on the Satellite (`data/drift-backups/`), and the Primary's version is restored. Repeated restorations of the same Satellite are limited to one every five minutes. Objects that exist only on the Satellite are never touched.

**Activities: the newest action wins.** Actions carry their age rather than a timestamp, so the remotes' clocks never have to agree. An activity start or stop that reaches the Primary after a newer change of that activity (for example one queued while the Primary was asleep) is dropped, and every remote is told the current state.

**Hardware differences.** Each remote reports its model, physical buttons and screen grid (`/cfg/device/button_layout`, `/cfg/device/screen_layout`). The Primary ships its own profile with every snapshot and each Satellite adapts what it receives: button mappings for buttons it does not have are skipped, and UI pages larger than its screen are reduced, skipping items that no longer fit. Every adaptation is listed in the Satellite's dashboard. When a layout cannot be read nothing is removed.

**Device settings (optional).** Enable *Device settings* under Settings → Synchronization on the Primary and choose what to keep identical: button backlight (brightness, automatic backlight, static colour), display brightness, haptic feedback, sound effects, power saving and standby timers, and — off by default — language/region/time, microphone and the software-update schedule. The device name, Wi-Fi and network, Bluetooth peripherals, the admin PIN, feature flags and the voice assistant are never synchronized. Satellites write only settings their own hardware reports (a static button colour is skipped on remotes without colour backlight) and only values that differ; anything a Satellite rejects is reported, never failing the synchronization. A synchronized setting changed directly on a Satellite is backed up and restored to the Primary's value (at most once a minute; brightness is left alone while automatic brightness is on). Changing a synchronized setting on the Primary triggers a synchronization on its own.

**Standby.** A remote in standby stops all integration drivers, Remote Sync included, so nothing can be exchanged while it sleeps. The guarantee is therefore: no update is ever silently lost — whatever happened while a remote slept is caught up as soon as it is awake and linked. For a Primary that is always reachable, run it on an always-on machine (Docker or Node.js).

### IP + PIN pairing

`POST /v1/pairing/pin` on a Satellite returns its pairing token when the request carries an admin API key of the Satellite's own Core in `X-Remote-Sync-Core-Key`. The Satellite verifies the key against its Core, so only someone holding the Web Configurator PIN can obtain the token. Failed attempts are rate limited. The Primary stores the management key to update the Satellite later; it is redacted in all status output.

### Firmware compatibility

`min_core_api` stays at `0.17.0`. Newer Core features are detected at runtime: the setup `language` field and the Remote's `get_version` answer enable in-place PIN correction (API 0.19.0+); missing endpoints such as `/cfg/network`, `/activities/{id}/readiness`, `/intg/install` or the setup keep-alive fall back to the previous behaviour. On Remotes before API 0.19.0 the driver keeps sending setup progress events during slow steps to avoid the old 60-second watchdog.

## Ports

| Port | Service |
|---:|---|
| `11081` | Agent, pairing, management, Dock tunnel API and web dashboard (`/ui`) |
| `11082` | Unfolded Circle Integration API |
| `11083` | Satellite virtual Dock WebSocket server |

## GitHub workflows

- `test.yml` validates source and runs the complete test suite.
- `build.yml` creates and validates the Remote installation archive without running tests.
- `release.yml` requires tests and attaches the installation archive to tagged releases.
- `docker.yml` requires tests and publishes `linux/amd64` and `linux/arm64` images.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
