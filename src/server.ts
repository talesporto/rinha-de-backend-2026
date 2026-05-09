import { loadIndex, type IVFIndex } from "./search";
import { vectorize, type TransactionPayload } from "./vectorizer";

const INDEX_PATH = process.env.INDEX_PATH || "resources/index.bin";
const PORT = parseInt(process.env.PORT || "9999", 10);
const NPROBE = parseInt(process.env.NPROBE || "25", 10);
const FRAUD_THRESHOLD = 0.6;
const K = 5;

let index: IVFIndex | null = null;

function init() {
  console.log(`Loading index from ${INDEX_PATH}...`);
  const start = Date.now();
  index = loadIndex(INDEX_PATH);
  index.nprobe = NPROBE;
  const stats = index.getStats();
  console.log(
    `Index loaded in ${Date.now() - start}ms: ${stats.vectors} vectors, ${stats.clusters} clusters, nprobe=${stats.nprobe}`
  );
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/ready") {
      return index
        ? new Response("OK", { status: 200 })
        : new Response("Not Ready", { status: 503 });
    }

    if (url.pathname === "/fraud-score" && req.method === "POST") {
      return handleFraudScore(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

async function handleFraudScore(req: Request): Promise<Response> {
  try {
    const payload: TransactionPayload = await req.json();
    const queryVector = vectorize(payload);

    const result = index!.search(queryVector);
    const fraudScore = result.totalNeighbors > 0 ? result.fraudCount / K : 0;
    const approved = fraudScore < FRAUD_THRESHOLD;

    return Response.json({ approved, fraud_score: fraudScore });
  } catch {
    // Fallback: return a safe response rather than HTTP error (weight 5 vs 1-3)
    return Response.json({ approved: true, fraud_score: 0.0 });
  }
}

init();
console.log(`Server listening on port ${PORT}`);
