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
remote-sync-0.7.2.tar.gz
remote-sync-0.7.2.tar.gz.sha256
```

Tests remain in the source repository but are not copied into the Remote installation archive.

## Install on Remote Two/3

1. Open **Web Configurator → Integrations → Add new → Install custom**.
2. Select `remote-sync-0.7.2.tar.gz`.
3. Select **Update existing driver** when upgrading.
4. Install or update Satellites before updating the Primary during rolling upgrades.

### Primary setup

Primary setup uses three steps:

1. Define the Primary details and optional advanced network overrides.
2. Configure synchronization settings and sections.
3. Pair and configure discovered Satellites.

The setup displays the detected interface, IPv4 address, MAC address, directed WoWLAN broadcast address and detection source. Manual overrides are only required for unusual routed or multi-interface networks.

### Satellite setup

Satellite setup requires the Web Configurator PIN. Network identity is detected automatically and shown before the configuration is saved. Advanced MAC and broadcast overrides remain available.

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
REMOTE_SYNC_IMAGE=ghcr.io/jstnjx/uc-remote-sync:0.7.2 docker compose up -d
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
| `REMOTE_SYNC_SATELLITE_REMOTE_ADDRESS` | `127.0.0.1` | Advanced Satellite Core address override |
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

Supported Satellite actions are `sync`, `preview`, `enable`, `disable`, `rediscover`, `rotate`, `unpair` and `remove`. Equivalent management buttons and status sensors are exposed by the Primary integration.

A synchronization preview can also be started through the global **Preview synchronization** button or with `POST /v1/sync` using `dry_run: true`. Preview mode estimates create, update and remove operations without applying the snapshot.

## Ports

| Port | Service |
|---:|---|
| `11081` | Agent, pairing, management and Dock tunnel API |
| `11082` | Unfolded Circle Integration API |
| `11083` | Satellite virtual Dock WebSocket server |

## GitHub workflows

- `test.yml` validates source and runs the complete test suite.
- `build.yml` creates and validates the Remote installation archive without running tests.
- `release.yml` requires tests and attaches the installation archive to tagged releases.
- `ghcr.yml` requires tests and publishes `linux/amd64` and `linux/arm64` images.

## License

MIT License. See [LICENSE](LICENSE).


