const payloads = await Bun.file("resources/example-payloads.json").json();

console.log(`Testing ${payloads.length} payloads...\n`);

const latencies: number[] = [];
let approved = 0;
let denied = 0;

for (const payload of payloads) {
  const start = performance.now();
  const res = await fetch("http://localhost:9999/fraud-score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const elapsed = performance.now() - start;
  latencies.push(elapsed);

  const body = await res.json() as { approved: boolean; fraud_score: number };
  if (body.approved) approved++;
  else denied++;

  console.log(
    `  ${payload.id}: approved=${body.approved}, score=${body.fraud_score}, latency=${elapsed.toFixed(1)}ms`
  );
}

latencies.sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)];
const p99 = latencies[Math.floor(latencies.length * 0.99)];
const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

console.log(`\nResults:`);
console.log(`  Total: ${payloads.length} (approved: ${approved}, denied: ${denied})`);
console.log(`  Latency — avg: ${avg.toFixed(1)}ms, p50: ${p50.toFixed(1)}ms, p99: ${p99.toFixed(1)}ms`);
console.log(`  Min: ${latencies[0].toFixed(1)}ms, Max: ${latencies[latencies.length - 1].toFixed(1)}ms`);
