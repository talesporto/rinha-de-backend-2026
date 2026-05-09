/**
 * IVF search engine with uint8 scalar quantization and lookup-table distance.
 *
 * At query time:
 *   1. Build a 14x256 distance lookup table from the float32 query vector.
 *   2. Find the nearest `nprobe` cluster centroids.
 *   3. Scan all vectors in those clusters using table lookups.
 *   4. Return the K=5 nearest neighbors with their labels.
 */

const DIMS = 14;
const K = 5;
const MAGIC = 0x52494e48;

export interface SearchResult {
  fraudCount: number;
  totalNeighbors: number;
}

export class IVFIndex {
  private numClusters: number;
  private numVectors: number;
  private centroids: Float32Array;
  private clusterOffsets: Uint32Array; // byte offset per cluster
  private clusterCounts: Uint32Array;  // vector count per cluster
  private vectorsData: Uint8Array;     // all quantized vectors + labels, sorted by cluster
  private vectorsDataOffset: number;   // offset in the raw buffer where vectors section starts
  private rawBuffer: Buffer;

  nprobe: number = 25;

  constructor(buffer: Buffer) {
    let pos = 0;

    const magic = buffer.readUInt32LE(pos); pos += 4;
    if (magic !== MAGIC) throw new Error(`Bad magic: 0x${magic.toString(16)}`);

    this.numClusters = buffer.readUInt32LE(pos); pos += 4;
    this.numVectors = buffer.readUInt32LE(pos); pos += 4;
    const dims = buffer.readUInt32LE(pos); pos += 4;
    if (dims !== DIMS) throw new Error(`Expected ${DIMS} dims, got ${dims}`);

    this.rawBuffer = buffer;

    // Read centroids
    const centroidsBytes = this.numClusters * DIMS * 4;
    this.centroids = new Float32Array(
      buffer.buffer.slice(buffer.byteOffset + pos, buffer.byteOffset + pos + centroidsBytes)
    );
    pos += centroidsBytes;

    // Read cluster offset table
    this.clusterOffsets = new Uint32Array(this.numClusters);
    this.clusterCounts = new Uint32Array(this.numClusters);
    for (let c = 0; c < this.numClusters; c++) {
      this.clusterOffsets[c] = buffer.readUInt32LE(pos); pos += 4;
      this.clusterCounts[c] = buffer.readUInt32LE(pos); pos += 4;
    }

    this.vectorsDataOffset = pos;
    this.vectorsData = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset + pos,
      this.numVectors * (DIMS + 1)
    );
  }

  search(query: Float32Array): SearchResult {
    // Step 1: Build asymmetric distance lookup table
    // table[d * 256 + v] = (query[d] - dequantize(v))^2
    const table = new Float32Array(DIMS * 256);
    for (let d = 0; d < DIMS; d++) {
      const qd = query[d];
      const base = d * 256;
      for (let v = 0; v < 256; v++) {
        const deq = (v / 255) * 2 - 1; // dequantize uint8 to [-1, 1]
        const diff = qd - deq;
        table[base + v] = diff * diff;
      }
    }

    // Step 2: Find nearest `nprobe` cluster centroids
    const clusterDists = new Float32Array(this.numClusters);
    for (let c = 0; c < this.numClusters; c++) {
      let dist = 0;
      const ci = c * DIMS;
      for (let d = 0; d < DIMS; d++) {
        const diff = query[d] - this.centroids[ci + d];
        dist += diff * diff;
      }
      clusterDists[c] = dist;
    }

    // Partial sort: find the nprobe smallest distances
    const probeIndices = this.topKSmallest(clusterDists, this.nprobe);

    // Step 3: Scan vectors in selected clusters, keeping top-K nearest
    // Use a max-heap of size K for efficient tracking
    const topDists = new Float32Array(K).fill(Infinity);
    const topLabels = new Uint8Array(K);
    let maxIdx = 0; // index of the current maximum in topDists

    const recordSize = DIMS + 1;

    for (let p = 0; p < probeIndices.length; p++) {
      const clusterId = probeIndices[p];
      const count = this.clusterCounts[clusterId];
      if (count === 0) continue;

      const startByte = this.clusterOffsets[clusterId];

      for (let j = 0; j < count; j++) {
        const vecStart = startByte + j * recordSize;

        // Compute distance via lookup table
        let dist = 0;
        for (let d = 0; d < DIMS; d++) {
          dist += table[d * 256 + this.vectorsData[vecStart + d]];
        }

        if (dist < topDists[maxIdx]) {
          topDists[maxIdx] = dist;
          topLabels[maxIdx] = this.vectorsData[vecStart + DIMS];

          // Find new max
          maxIdx = 0;
          for (let i = 1; i < K; i++) {
            if (topDists[i] > topDists[maxIdx]) maxIdx = i;
          }
        }
      }
    }

    // Count frauds among top K
    let fraudCount = 0;
    let totalNeighbors = 0;
    for (let i = 0; i < K; i++) {
      if (topDists[i] < Infinity) {
        totalNeighbors++;
        if (topLabels[i] === 1) fraudCount++;
      }
    }

    return { fraudCount, totalNeighbors };
  }

  private topKSmallest(arr: Float32Array, k: number): number[] {
    // Build array of [index, value] and partially sort
    const indexed: Array<[number, number]> = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      indexed[i] = [i, arr[i]];
    }

    // Use a selection approach: find k-th smallest and filter
    // For 1500 clusters, a full sort is fast enough
    indexed.sort((a, b) => a[1] - b[1]);
    const result = new Array(Math.min(k, indexed.length));
    for (let i = 0; i < result.length; i++) {
      result[i] = indexed[i][0];
    }
    return result;
  }

  getStats(): { clusters: number; vectors: number; nprobe: number } {
    return {
      clusters: this.numClusters,
      vectors: this.numVectors,
      nprobe: this.nprobe,
    };
  }
}

export function loadIndex(path: string): IVFIndex {
  const buffer = require("fs").readFileSync(path);
  return new IVFIndex(buffer);
}
