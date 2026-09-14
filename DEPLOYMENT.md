# Deploying planee with Docker + GHCR

This project ships a container pipeline that builds a single image (the Go
backend serving the built frontend on one origin) and publishes it to the
GitHub Container Registry (GHCR).

## What gets published

`.github/workflows/docker.yaml` builds and pushes **multi-arch** images
(linux/amd64 + linux/arm64) to `ghcr.io/descent098/planee` on:

- pushes to `master` → `latest`
- git tags `v*` → `1.2.3`, `1.2`, `1` (semver)
- every build → `sha-<short>` (for pinning)

Pull requests build (to catch breakage) but do **not** push.

## One-time GitHub setup

1. Push this repo to GitHub. The owner/repo should match `descent098/planee` — GHCR
   image names must be lowercase.
2. The workflow authenticates with the built-in `GITHUB_TOKEN` (no secrets to
   add); it already declares `permissions: packages: write` so it can push.
3. After the first successful publish, the image is **private** by default. To
   let anyone `docker pull` it without logging in, open the package on GHCR and
   set its visibility to **Public** (Package settings → Danger Zone → Change
   visibility). Otherwise run `docker login ghcr.io` on the host first.

## Deploying

On any Docker host, from a folder containing `docker-compose.yml`:

```sh
docker compose up -d          # pulls ghcr.io/descent098/planee:latest
# app + sync API → http://localhost:8228, database → ./data/planee.db
```

Update later with:

```sh
docker compose pull && docker compose up -d
```

Pin to a specific release for reproducible deploys by editing the image tag in
`docker-compose.yml`, e.g. `ghcr.io/descent098/planee:v1.0.0`.

## Building from source instead

No registry needed — build the image locally:

```sh
docker compose -f docker-compose.build.yml up --build
```

## Data & backups

The SQLite database is bind-mounted to `./data` on the host, so `planee.db`
(plus its `-wal`/`-shm` files) is a real file next to the compose file —
recreating or updating the container never touches it. Back up by copying that
folder, or download a checkpointed copy from `GET /backup` on the running
server.
