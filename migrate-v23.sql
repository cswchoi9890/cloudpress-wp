-- CloudPress v23 migration: products/orders/settlements (virtual account flow)

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  price         INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'KRW',
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  product_id          TEXT NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT 1,
  unit_price          INTEGER NOT NULL,
  gross_amount        INTEGER NOT NULL,
  fee_rate            REAL NOT NULL DEFAULT 0.2,
  fee_amount          INTEGER NOT NULL,
  net_amount          INTEGER NOT NULL,
  total_amount        INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  payment_method      TEXT NOT NULL DEFAULT 'virtual_account',
  virtual_account_no  TEXT,
  depositor_name      TEXT,
  verify_tx_id        TEXT,
  paid_at             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settlements (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL UNIQUE,
  user_id             TEXT NOT NULL,
  gross_amount        INTEGER NOT NULL,
  fee_rate            REAL NOT NULL DEFAULT 0.2,
  fee_amount          INTEGER NOT NULL,
  settlement_amount   INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'ready',
  account_bank        TEXT,
  account_holder      TEXT,
  account_number      TEXT,
  note                TEXT,
  settled_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
