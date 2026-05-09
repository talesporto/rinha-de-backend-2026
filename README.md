# rinha-de-backend-2026

Fraud detection API for the [Rinha de Backend 2026](https://github.com/zanfranceschi/rinha-de-backend-2026) challenge.

## Stack

- **Bun** — HTTP server + JSON parsing + vectorization
- **IVF (Inverted File Index)** — vector search with uint8 scalar quantization
- **nginx** — round-robin load balancer

## Architecture

```
nginx (:9999) → api1 (Bun, in-process IVF search)
              → api2 (Bun, in-process IVF search)
```

Each API instance loads a pre-built 43MB binary index containing 3M quantized vectors
organized into 1500 K-means clusters. At query time, only the nearest 25 clusters are
searched using asymmetric distance lookup tables.

## Resource Usage

| Service | Memory | CPU |
|---------|--------|-----|
| nginx   | ~2 MB  | 0.05 |
| api1    | ~56 MB | 0.475 |
| api2    | ~56 MB | 0.475 |
| **Total** | **~114 MB** | **1.0** |

## Quick Start

```bash
# Download reference files
bun run download-resources

# Build the IVF index (takes ~14 min)
bun run build-index

# Run locally
bun run dev

# Run with Docker Compose
docker compose up -d
```

## Performance (local, 50 example payloads)

- **p50**: 1.0 ms
- **p99**: 1.5 ms (warm)
- **Detection**: 0% error rate on example payloads
