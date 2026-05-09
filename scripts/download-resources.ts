const BASE_URL = "https://raw.githubusercontent.com/zanfranceschi/rinha-de-backend-2026/main/resources";

const FILES = [
  "references.json.gz",
  "mcc_risk.json",
  "normalization.json",
  "example-payloads.json",
  "example-references.json",
];

async function download(file: string): Promise<void> {
  const url = `${BASE_URL}/${file}`;
  const dest = `resources/${file}`;

  if (await Bun.file(dest).exists()) {
    console.log(`  [skip] ${file} already exists`);
    return;
  }

  console.log(`  [download] ${file}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${file}: ${res.status}`);
  await Bun.write(dest, res);
  console.log(`  [done] ${file}`);
}

console.log("Downloading resources...");
for (const file of FILES) {
  await download(file);
}
console.log("All resources downloaded.");
