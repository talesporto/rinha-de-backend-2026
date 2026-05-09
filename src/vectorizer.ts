export interface TransactionPayload {
  id: string;
  transaction: {
    amount: number;
    installments: number;
    requested_at: string;
  };
  customer: {
    avg_amount: number;
    tx_count_24h: number;
    known_merchants: string[];
  };
  merchant: {
    id: string;
    mcc: string;
    avg_amount: number;
  };
  terminal: {
    is_online: boolean;
    card_present: boolean;
    km_from_home: number;
  };
  last_transaction: {
    timestamp: string;
    km_from_current: number;
  } | null;
}

interface NormalizationConstants {
  max_amount: number;
  max_installments: number;
  amount_vs_avg_ratio: number;
  max_minutes: number;
  max_km: number;
  max_tx_count_24h: number;
  max_merchant_avg_amount: number;
}

const MCC_RISK: Record<string, number> = {
  "5411": 0.15,
  "5812": 0.30,
  "5912": 0.20,
  "5944": 0.45,
  "7801": 0.80,
  "7802": 0.75,
  "7995": 0.85,
  "4511": 0.35,
  "5311": 0.25,
  "5999": 0.50,
};

const NORM: NormalizationConstants = {
  max_amount: 10000,
  max_installments: 12,
  amount_vs_avg_ratio: 10,
  max_minutes: 1440,
  max_km: 1000,
  max_tx_count_24h: 20,
  max_merchant_avg_amount: 10000,
};

const MCC_DEFAULT = 0.5;

function clamp(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// Mon=0, Sun=6. JS getUTCDay() returns Sun=0..Sat=6, so we remap.
const JS_DAY_TO_SPEC: readonly number[] = [6, 0, 1, 2, 3, 4, 5];

export function vectorize(p: TransactionPayload): Float32Array {
  const v = new Float32Array(14);

  v[0] = clamp(p.transaction.amount / NORM.max_amount);
  v[1] = clamp(p.transaction.installments / NORM.max_installments);
  v[2] = clamp((p.transaction.amount / p.customer.avg_amount) / NORM.amount_vs_avg_ratio);

  const dt = new Date(p.transaction.requested_at);
  v[3] = dt.getUTCHours() / 23;
  v[4] = JS_DAY_TO_SPEC[dt.getUTCDay()] / 6;

  if (p.last_transaction !== null) {
    const lastDt = new Date(p.last_transaction.timestamp);
    const minutesSince = (dt.getTime() - lastDt.getTime()) / 60000;
    v[5] = clamp(minutesSince / NORM.max_minutes);
    v[6] = clamp(p.last_transaction.km_from_current / NORM.max_km);
  } else {
    v[5] = -1;
    v[6] = -1;
  }

  v[7] = clamp(p.terminal.km_from_home / NORM.max_km);
  v[8] = clamp(p.customer.tx_count_24h / NORM.max_tx_count_24h);
  v[9] = p.terminal.is_online ? 1 : 0;
  v[10] = p.terminal.card_present ? 1 : 0;
  v[11] = p.customer.known_merchants.includes(p.merchant.id) ? 0 : 1;
  v[12] = MCC_RISK[p.merchant.mcc] ?? MCC_DEFAULT;
  v[13] = clamp(p.merchant.avg_amount / NORM.max_merchant_avg_amount);

  return v;
}
