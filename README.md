# UC Remote Sync

UC Remote Sync can run directly on an Unfolded Circle Remote Two/3 or externally as a Docker or Node.js service. External deployment is intended for the master instance; child instances must run directly on their remotes because the virtual Dock endpoint uses loopback networking.

## Requirements

- Node.js 22.13 or newer for source builds and standalone deployment
- Docker with Compose for container deployment
- An Unfolded Circle Remote Two/3 for direct installation

## Build

Install no runtime dependencies; the project uses the Node.js standard library.

Run validation and tests:

```bash
npm run check
npm test
```

Build the Remote installation archive:

```bash
npm run build:embedded
```

Or run the complete validation and packaging pipeline:

```bash
npm run package
```

Generated files:

```text
remote-sync-<version>.tar.gz
remote-sync-<version>.tar.gz.sha256
```


## Install on Remote Two/3

1. Download `remote-sync-<version>.tar.gz` from the GitHub release or build it locally.
2. Open **Web Configurator → Integrations → Add new → Install custom**.
3. Select the archive.
4. For an existing installation, choose **Update existing driver**.

For rolling updates, update child remotes first and the master last. Existing configuration, pairing credentials and identifier mappings are retained.

## Deploy with Docker Compose

The default Compose configuration pulls the multi-architecture GHCR image:

```bash
docker compose pull
docker compose up -d
docker compose logs -f remote-sync
```

Default image:

```text
ghcr.io/jstnjx/uc-remote-sync:latest
```

Pin a specific image tag:

```bash
REMOTE_SYNC_IMAGE=ghcr.io/jstnjx/uc-remote-sync:latest docker compose up -d
```

Build the image locally instead of pulling it:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

The container uses host networking for Unfolded Circle discovery, child pairing discovery and WoWLAN broadcasts. Persistent state is stored in:

```text
./config
./data
```

On a host with multiple network interfaces, set the LAN address advertised to the remotes:

```bash
UC_MDNS_ADDRESS=192.168.1.10 docker compose up -d
```

The `ghcr.yml` workflow validates the source and publishes `linux/amd64` and `linux/arm64` images to `ghcr.io/<owner>/<repository>`.

## Deploy with Node.js

Run the service directly:

```bash
UC_CONFIG_HOME=/var/lib/uc-remote-sync/config \
STATE_DIRECTORY=/var/lib/uc-remote-sync/data \
UC_INTEGRATION_HTTP_PORT=11082 \
node src/driver.js
```

Available deployment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `UC_CONFIG_HOME` | `config` | Persistent configuration directory |
| `STATE_DIRECTORY` | `data` | Persistent state directory |
| `UC_INTEGRATION_HTTP_PORT` | `11082` | Integration API port |
| `UC_INTEGRATION_INTERFACE` | `0.0.0.0` | Integration API bind address |
| `UC_MDNS_HOSTNAME` | `remote-sync` | Advertised mDNS hostname |
| `UC_MDNS_ADDRESS` | automatic | LAN address advertised through mDNS |
| `UC_DISABLE_MDNS_PUBLISH` | `false` | Disable integration mDNS publication |
| `DEBUG` | unset | Logging namespace filter |

A systemd unit template is included at `deploy/remote-sync.service`.

## Ports

| Port | Service |
|---:|---|
| `11081` | Master/child agent and pairing API |
| `11082` | Unfolded Circle integration API |
| `11083` | Child-side virtual Dock WebSocket server |

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
