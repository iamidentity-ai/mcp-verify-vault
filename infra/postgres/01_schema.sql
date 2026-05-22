-- Healthcare schema for the verify-vault-agentcore-reference cookbook.
-- Runs at container init via Postgres's /docker-entrypoint-initdb.d hook.
-- The schema is intentionally minimal: enough patients and one clinician
-- to exercise the read flow and the VIP step-up flow.

\connect healthcare

-- Dedicated schema for clinical data so the verify-rar Postgres role
-- can be scoped to it without granting the public schema.
CREATE SCHEMA IF NOT EXISTS clinical;

-- ── clinicians ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinical.clinicians (
  id            SERIAL PRIMARY KEY,
  display_name  TEXT NOT NULL,
  upn           TEXT UNIQUE NOT NULL,
  specialty     TEXT NOT NULL
);

-- ── patients ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinical.patients (
  mrn                TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  dob                DATE NOT NULL,
  primary_diagnosis  TEXT NOT NULL,
  vip_flag           BOOLEAN NOT NULL DEFAULT FALSE,
  primary_clinician  TEXT NOT NULL REFERENCES clinical.clinicians(upn)
);

-- ── visits ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinical.visits (
  id            SERIAL PRIMARY KEY,
  patient_mrn   TEXT NOT NULL REFERENCES clinical.patients(mrn),
  visit_date    DATE NOT NULL,
  clinician_upn TEXT NOT NULL REFERENCES clinical.clinicians(upn),
  notes         TEXT NOT NULL
);

-- ── Read role used by the verify-rar plugin's role definition ────────────────
-- The plugin creates ephemeral roles that inherit this; the ephemeral role
-- gets SELECT on the clinical schema, and nothing else.
CREATE ROLE healthcare_read_template NOLOGIN;
GRANT USAGE ON SCHEMA clinical TO healthcare_read_template;
GRANT SELECT ON ALL TABLES IN SCHEMA clinical TO healthcare_read_template;
ALTER DEFAULT PRIVILEGES IN SCHEMA clinical
  GRANT SELECT ON TABLES TO healthcare_read_template;
