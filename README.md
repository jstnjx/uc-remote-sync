<img src="remote-sync.svg" width="72" alt="" align="right">

# UC Remote Sync

UC Remote Sync synchronizes one Primary Unfolded Circle Remote with one or more Satellite remotes. It can run directly on Remote Two/3 or as an external Primary through Docker or Node.js. Satellite instances must run directly on their remotes because the virtual Dock endpoint uses loopback networking.

## What's new in 0.9.0

- **Add Satellites by IP address and PIN.** The Primary creates a management key on the Satellite, installs or updates Remote Sync there, runs the Satellite setup remotely and pairs — no token copying.
- **Satellites stay on the Primary's version.** Satellites added by PIN are updated automatically (`POST /api/intg/install?update=true`), replacing the manual rolling-upgrade order. Can be turned off.
- **PIN-only integration setup.** The Remote's setup dialog asks for the Web Configurator PIN and nothing else (hidden field, English/German, wrong PIN corrected in place on Remotes with API 0.19.0+). The role and all other options moved to the dashboard.
- **Web dashboard** at `http://<remote>:11081/ui`, styled like Advanced Automations: choose the role, add and manage Satellites, readable preview diffs, settings and live logs. Sign in with the remote's Web Configurator PIN.
- **Wake on WLAN is detected and enabled automatically** (`wifi.wake_on_wlan`) instead of being confirmed by hand.
- **One shared Core WebSocket session** per remote instead of one connection per request, with back-off when the Core reports its connection limit (`503` + `Retry-After`).
- **Activity readiness:** relayed activity commands log which devices would not be reached (`/activities/{id}/readiness`).
- **Removing a Satellite cleans it up.** *Remove* deletes everything this Primary synchronized to the Satellite — profiles with their pages and groups, activity groups, activities, macros, proxied Docks, mirrored entities, the activity relay and synchronized resources — before unpairing. *Unpair* keeps the configuration.
- **Remote screen preview.** The dashboard preview renders the Primary's profiles and pages on a Remote screen at the native 480 × 850 layout — page through screens, open activities and entities, switch profiles. Read-only: nothing is sent to a remote.
- **New logo** in the Advanced Automations style (`remote-sync.svg`, `remote-sync.png`).
- **No more `ALREADY_EXISTS` when adding a Satellite again.** API key names are unique, a clash is retried, and keys Remote Sync no longer needs (previous setup, removed or re-added Satellites) are revoked.
- **Fewer entities:** each Satellite is now one status sensor and one action select instead of six sensors and seven buttons. Recreate any activity buttons that used the old per-Satellite buttons.

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
remote-sync-0.9.0.tar.gz
remote-sync-0.9.0.tar.gz.sha256
```

Tests remain in the source repository but are not copied into the Remote installation archive. The archive is produced by `src/shared/package.js`, the same builder a Primary uses at runtime to install Remote Sync on Satellites. The version is read from `driver.json`; `package.json` must match it.

## Install on Remote Two/3

1. Open **Web Configurator → Integrations → Add new → Install custom**.
2. Select `remote-sync-0.9.0.tar.gz`.
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
REMOTE_SYNC_IMAGE=ghcr.io/jstnjx/uc-remote-sync:0.9.0 docker compose up -d
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
