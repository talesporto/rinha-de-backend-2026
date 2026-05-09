import { expect, test } from "bun:test";
import { vectorize, type TransactionPayload } from "./vectorizer";

// From DETECTION_RULES.md — legitimate transaction example
const LEGIT_PAYLOAD: TransactionPayload = {
  id: "tx-1329056812",
  transaction: { amount: 41.12, installments: 2, requested_at: "2026-03-11T18:45:53Z" },
  customer: { avg_amount: 82.24, tx_count_24h: 3, known_merchants: ["MERC-003", "MERC-016"] },
  merchant: { id: "MERC-016", mcc: "5411", avg_amount: 60.25 },
  terminal: { is_online: false, card_present: true, km_from_home: 29.23 },
  last_transaction: null,
};

const LEGIT_EXPECTED = [0.0041, 0.1667, 0.05, 0.7826, 0.3333, -1, -1, 0.0292, 0.15, 0, 1, 0, 0.15, 0.006];

// From DETECTION_RULES.md — fraudulent transaction example
const FRAUD_PAYLOAD: TransactionPayload = {
  id: "tx-3330991687",
  transaction: { amount: 9505.97, installments: 10, requested_at: "2026-03-14T05:15:12Z" },
  customer: { avg_amount: 81.28, tx_count_24h: 20, known_merchants: ["MERC-008", "MERC-007", "MERC-005"] },
  merchant: { id: "MERC-068", mcc: "7802", avg_amount: 54.86 },
  terminal: { is_online: false, card_present: true, km_from_home: 952.27 },
  last_transaction: null,
};

const FRAUD_EXPECTED = [0.9506, 0.8333, 1.0, 0.2174, 0.8333, -1, -1, 0.9523, 1.0, 0, 1, 1, 0.75, 0.0055];

function roundVec(v: Float32Array, decimals: number): number[] {
  const factor = 10 ** decimals;
  return Array.from(v).map((x) => Math.round(x * factor) / factor);
}

test("legitimate transaction vectorization matches spec", () => {
  const result = vectorize(LEGIT_PAYLOAD);
  const rounded = roundVec(result, 4);
  expect(rounded).toEqual(LEGIT_EXPECTED);
});

test("fraudulent transaction vectorization matches spec", () => {
  const result = vectorize(FRAUD_PAYLOAD);
  const rounded = roundVec(result, 4);
  expect(rounded).toEqual(FRAUD_EXPECTED);
});

test("unknown MCC uses default 0.5", () => {
  const payload: TransactionPayload = {
    id: "tx-test",
    transaction: { amount: 100, installments: 1, requested_at: "2026-01-01T12:00:00Z" },
    customer: { avg_amount: 100, tx_count_24h: 1, known_merchants: [] },
    merchant: { id: "MERC-001", mcc: "9999", avg_amount: 100 },
    terminal: { is_online: true, card_present: false, km_from_home: 0 },
    last_transaction: null,
  };
  const result = vectorize(payload);
  expect(result[12]).toBe(0.5);
});

test("last_transaction present computes minutes and km", () => {
  const payload: TransactionPayload = {
    id: "tx-test",
    transaction: { amount: 100, installments: 1, requested_at: "2026-01-01T12:00:00Z" },
    customer: { avg_amount: 100, tx_count_24h: 1, known_merchants: [] },
    merchant: { id: "MERC-001", mcc: "5411", avg_amount: 100 },
    terminal: { is_online: false, card_present: true, km_from_home: 50 },
    last_transaction: { timestamp: "2026-01-01T06:00:00Z", km_from_current: 200 },
  };
  const result = vectorize(payload);
  // 6 hours = 360 minutes; 360/1440 = 0.25
  expect(Math.round(result[5] * 10000) / 10000).toBe(0.25);
  // 200/1000 = 0.2
  expect(Math.round(result[6] * 10000) / 10000).toBe(0.2);
});
