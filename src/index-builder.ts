/**
 * Build-time script: reads references.json.gz, quantizes vectors to uint8,
 * clusters them via K-means (IVF), and writes a compact binary index file.
 *
 * Binary format:
 *   Header (16 bytes):
 *     u32 magic          (0x52494E48 = "RINH")
 *     u32 numClusters
 *     u32 numVectors
 *     u32 dims           (14)
 *   Centroids (numClusters * dims * 4 bytes):
 *     float32[] centroids in row-major order
 *   Cluster offsets table (numClusters * 8 bytes):
 *     u32 offset         (byte offset from start of vectors section)
 *     u32 count          (number of vectors in this cluster)
 *   Vectors section:
 *     For each cluster, contiguously:
 *       For each vector in the cluster:
 *         u8[dims]         quantized vector
 *         u8               label (0 = legit, 1 = fraud)
 */

import { gunzipSync } from "zlib";

const DIMS = 14;
const NUM_CLUSTERS = 1500;
const KMEANS_ITERATIONS = 20;
const MAGIC = 0x52494e48;

// Quantize a float in [-1, 1] to uint8 [0, 255]
function quantize(val: number): number {
  return Math.round(((val + 1) / 2) * 255);
}

function loadReferences(path: string): { vectors: Float32Array; labels: Uint8Array; count: number } {
  console.log("Loading references...");
  const compressed = require("fs").readFileSync(path);
  console.log(`  Compressed size: ${(compressed.length / 1024 / 1024).toFixed(1)} MB`);

  const decompressed = gunzipSync(compressed);
  console.log(`  Decompressed size: ${(decompressed.length / 1024 / 1024).toFixed(1)} MB`);

  const data: Array<{ vector: number[]; label: string }> = JSON.parse(decompressed.toString());
  const count = data.length;
  console.log(`  Parsed ${count} vectors`);

  const vectors = new Float32Array(count * DIMS);
  const labels = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const entry = data[i];
    for (let d = 0; d < DIMS; d++) {
      vectors[i * DIMS + d] = entry.vector[d];
    }
    labels[i] = entry.label === "fraud" ? 1 : 0;
  }

  return { vectors, labels, count };
}

function initCentroids(vectors: Float32Array, count: number): Float32Array {
  // K-means++ initialization for better convergence
  const centroids = new Float32Array(NUM_CLUSTERS * DIMS);
  const chosen = new Set<number>();

  // Pick first centroid randomly
  const first = Math.floor(Math.random() * count);
  chosen.add(first);
  for (let d = 0; d < DIMS; d++) {
    centroids[d] = vectors[first * DIMS + d];
  }

  const minDists = new Float32Array(count).fill(Infinity);

  for (let c = 1; c < NUM_CLUSTERS; c++) {
    // Update min distances to nearest chosen centroid
    const prevIdx = (c - 1) * DIMS;
    for (let i = 0; i < count; i++) {
      let dist = 0;
      const vi = i * DIMS;
      for (let d = 0; d < DIMS; d++) {
        const diff = vectors[vi + d] - centroids[prevIdx + d];
        dist += diff * diff;
      }
      if (dist < minDists[i]) minDists[i] = dist;
    }

    // Weighted random selection proportional to squared distance
    let totalWeight = 0;
    for (let i = 0; i < count; i++) totalWeight += minDists[i];

    let target = Math.random() * totalWeight;
    let selected = 0;
    for (let i = 0; i < count; i++) {
      target -= minDists[i];
      if (target <= 0) {
        selected = i;
        break;
      }
    }

    chosen.add(selected);
    for (let d = 0; d < DIMS; d++) {
      centroids[c * DIMS + d] = vectors[selected * DIMS + d];
    }

    if (c % 100 === 0) console.log(`  K-means++ init: ${c}/${NUM_CLUSTERS} centroids`);
  }

  return centroids;
}

function kmeansAssign(
  vectors: Float32Array,
  centroids: Float32Array,
  count: number,
  assignments: Int32Array
): void {
  for (let i = 0; i < count; i++) {
    let bestCluster = 0;
    let bestDist = Infinity;
    const vi = i * DIMS;

    for (let c = 0; c < NUM_CLUSTERS; c++) {
      let dist = 0;
      const ci = c * DIMS;
      for (let d = 0; d < DIMS; d++) {
        const diff = vectors[vi + d] - centroids[ci + d];
        dist += diff * diff;
      }
      if (dist < bestDist) {
        bestDist = dist;
        bestCluster = c;
      }
    }

    assignments[i] = bestCluster;
  }
}

function kmeansUpdate(
  vectors: Float32Array,
  assignments: Int32Array,
  count: number,
  centroids: Float32Array
): void {
  const sums = new Float64Array(NUM_CLUSTERS * DIMS);
  const counts = new Int32Array(NUM_CLUSTERS);

  for (let i = 0; i < count; i++) {
    const c = assignments[i];
    counts[c]++;
    const vi = i * DIMS;
    const ci = c * DIMS;
    for (let d = 0; d < DIMS; d++) {
      sums[ci + d] += vectors[vi + d];
    }
  }

  for (let c = 0; c < NUM_CLUSTERS; c++) {
    if (counts[c] === 0) continue;
    const ci = c * DIMS;
    for (let d = 0; d < DIMS; d++) {
      centroids[ci + d] = sums[ci + d] / counts[c];
    }
  }
}

function buildIndex(
  vectors: Float32Array,
  labels: Uint8Array,
  count: number
): Buffer {
  console.log("Running K-means clustering...");
  console.log(`  Clusters: ${NUM_CLUSTERS}, Iterations: ${KMEANS_ITERATIONS}`);

  const centroids = initCentroids(vectors, count);
  const assignments = new Int32Array(count);

  for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
    kmeansAssign(vectors, centroids, count, assignments);
    kmeansUpdate(vectors, assignments, count, centroids);
    console.log(`  Iteration ${iter + 1}/${KMEANS_ITERATIONS} done`);
  }

  // Final assignment
  kmeansAssign(vectors, centroids, count, assignments);

  // Count vectors per cluster
  const clusterCounts = new Int32Array(NUM_CLUSTERS);
  for (let i = 0; i < count; i++) {
    clusterCounts[assignments[i]]++;
  }

  // Build sorted indices per cluster
  const clusterOffsets = new Int32Array(NUM_CLUSTERS);
  let offset = 0;
  for (let c = 0; c < NUM_CLUSTERS; c++) {
    clusterOffsets[c] = offset;
    offset += clusterCounts[c];
  }

  const sortedIndices = new Int32Array(count);
  const insertPos = new Int32Array(NUM_CLUSTERS);
  for (let c = 0; c < NUM_CLUSTERS; c++) insertPos[c] = clusterOffsets[c];

  for (let i = 0; i < count; i++) {
    const c = assignments[i];
    sortedIndices[insertPos[c]++] = i;
  }

  // Quantize vectors and serialize
  const RECORD_SIZE = DIMS + 1; // 14 bytes vector + 1 byte label
  const headerSize = 16;
  const centroidsSize = NUM_CLUSTERS * DIMS * 4;
  const clusterTableSize = NUM_CLUSTERS * 8;
  const vectorsSize = count * RECORD_SIZE;
  const totalSize = headerSize + centroidsSize + clusterTableSize + vectorsSize;

  console.log(`  Binary index size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);

  const buf = Buffer.alloc(totalSize);
  let pos = 0;

  // Header
  buf.writeUInt32LE(MAGIC, pos); pos += 4;
  buf.writeUInt32LE(NUM_CLUSTERS, pos); pos += 4;
  buf.writeUInt32LE(count, pos); pos += 4;
  buf.writeUInt32LE(DIMS, pos); pos += 4;

  // Centroids
  for (let i = 0; i < NUM_CLUSTERS * DIMS; i++) {
    buf.writeFloatLE(centroids[i], pos); pos += 4;
  }

  // Cluster offset table
  let vectorByteOffset = 0;
  for (let c = 0; c < NUM_CLUSTERS; c++) {
    buf.writeUInt32LE(vectorByteOffset, pos); pos += 4;
    buf.writeUInt32LE(clusterCounts[c], pos); pos += 4;
    vectorByteOffset += clusterCounts[c] * RECORD_SIZE;
  }

  // Vectors section (quantized, sorted by cluster)
  for (let i = 0; i < count; i++) {
    const origIdx = sortedIndices[i];
    const vi = origIdx * DIMS;
    for (let d = 0; d < DIMS; d++) {
      buf.writeUInt8(quantize(vectors[vi + d]), pos++);
    }
    buf.writeUInt8(labels[origIdx], pos++);
  }

  return buf;
}

async function main() {
  const startTime = Date.now();
  const resourcesDir = process.argv[2] || "resources";
  const outputPath = process.argv[3] || "resources/index.bin";

  const { vectors, labels, count } = loadReferences(`${resourcesDir}/references.json.gz`);
  const indexBuf = buildIndex(vectors, labels, count);

  require("fs").writeFileSync(outputPath, indexBuf);
  console.log(`Index written to ${outputPath}`);
  console.log(`Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("Index build failed:", err);
  process.exit(1);
});
