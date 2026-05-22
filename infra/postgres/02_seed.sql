\connect healthcare

-- One clinician: Dr. Charlie Carter. The agent is hard-coded to act on
-- her behalf, so every read uses her upn.
INSERT INTO clinical.clinicians (id, display_name, upn, specialty) VALUES
  (1, 'Dr. Charlie Carter', 'ccarter@acmehealth.example', 'Cardiology')
ON CONFLICT (upn) DO NOTHING;

-- Ten patients on Dr. Carter's panel. Two are VIP-flagged so the cookbook
-- can exercise the step-up MFA flow.
INSERT INTO clinical.patients (mrn, display_name, dob, primary_diagnosis, vip_flag, primary_clinician) VALUES
  ('A0001', 'Alex Anderson',     '1972-04-11', 'Atrial fibrillation',     FALSE, 'ccarter@acmehealth.example'),
  ('A0002', 'Beth Bell',          '1980-09-23', 'Type 2 diabetes',         FALSE, 'ccarter@acmehealth.example'),
  ('A0003', 'Carlos Chen',        '1965-02-15', 'Hypertension',            FALSE, 'ccarter@acmehealth.example'),
  ('A0004', 'Dana Davis',         '1955-12-04', 'Coronary artery disease', FALSE, 'ccarter@acmehealth.example'),
  ('A0005', 'Evan Evans',         '1988-07-19', 'Asthma',                  FALSE, 'ccarter@acmehealth.example'),
  ('A0006', 'Fiona Fischer',      '1970-03-30', 'Migraine',                FALSE, 'ccarter@acmehealth.example'),
  ('A0007', 'Gabe Garcia',        '1962-06-12', 'Chronic kidney disease',  FALSE, 'ccarter@acmehealth.example'),
  ('A0008', 'Hana Hassan',        '1978-11-02', 'Hypothyroidism',          FALSE, 'ccarter@acmehealth.example'),
  ('A0042', 'Senator Riley Reed', '1958-05-20', 'Coronary stent',          TRUE,  'ccarter@acmehealth.example'),
  ('A0099', 'CEO Taylor Thornton','1969-10-08', 'Major depression',        TRUE,  'ccarter@acmehealth.example')
ON CONFLICT (mrn) DO NOTHING;

-- A handful of visits so get_visit_history returns something.
INSERT INTO clinical.visits (patient_mrn, visit_date, clinician_upn, notes) VALUES
  ('A0001', '2026-04-15', 'ccarter@acmehealth.example', 'Routine follow-up. Rate-control therapy continued.'),
  ('A0001', '2026-02-10', 'ccarter@acmehealth.example', 'EKG normal. No new symptoms.'),
  ('A0042', '2026-05-01', 'ccarter@acmehealth.example', 'Post-stent follow-up. No angina reported.'),
  ('A0099', '2026-03-20', 'ccarter@acmehealth.example', 'Mood stable on SSRI. Sleep improved.')
ON CONFLICT DO NOTHING;
