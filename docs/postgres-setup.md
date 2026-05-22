## PostgreSQL Deployment

The clinical database is the simplest piece of the stack but it is also where the real protection shows. The schema has three tables in a `clinical` schema (clinicians, patients, visits) and a role template called `healthcare_read_template` that has SELECT on the `clinical` schema and nothing else. Every time the agent does a tool call, the verify-rar plugin creates a fresh ephemeral role that inherits from that template, the MCP server uses it for a single SELECT, and the role is dropped 5 minutes later. Bring this up first; the rest of the stack assumes it is there.

## Bring it up

The PostgreSQL container is configured by `infra/docker-compose.yml`. The schema and seed SQL files in `infra/postgres/` are mounted into `/docker-entrypoint-initdb.d`, which the official PostgreSQL image runs on the very first container start.

```bash
cd infra
docker compose up -d postgres
```

Expected: `Container vva-postgres Started`.

Wait a few seconds, then confirm the container is healthy:

```bash
docker inspect --format='{{.State.Health.Status}}' vva-postgres
```

Expected: `healthy`.

If the status sits at `starting` for more than ten seconds, check `docker logs vva-postgres`. The first start runs the schema and seed scripts inline, which adds a few seconds.

## Verify the data

Confirm the seed loaded by counting patients and checking the VIP flag:

```bash
docker exec vva-postgres psql -U vva_admin -d healthcare \
  -c "SELECT mrn, display_name, vip_flag FROM clinical.patients ORDER BY mrn;"
```

Expected: 10 rows. Two of them have `vip_flag = t` (true). The non-VIP MRNs return a patient record without any step-up MFA; the two VIP MRNs trigger the IBM Verify policy and a push to the clinician's phone. You will exercise both paths in the smoke test chapter.

Confirm the role template exists:

```bash
docker exec vva-postgres psql -U vva_admin -d healthcare \
  -c "\du healthcare_read_template"
```

Expected: a line showing `healthcare_read_template` with the attribute `Cannot login`. That last bit is intentional. The template is not for direct login. The verify-rar plugin uses it as the inheritance parent when it mints ephemeral roles; the ephemeral roles themselves have a password and `LOGIN`.

Confirm the admin role the Vault plugin uses:

```bash
docker exec vva-postgres psql -U vva_admin -d healthcare \
  -c "\du vva_admin"
```

Expected: a line showing `vva_admin` with `Superuser` or at least `Create role` in the attributes column. The plugin needs the right to CREATE ROLE, GRANT membership, and DROP ROLE; the simplest local-dev setup is to make it a superuser.

## What you might add

For most demos the seeded ten patients are fine. If you want to expand the dataset (different specialties, additional VIPs, longer visit histories), here are the patterns.

**Add more patients.** Open `infra/postgres/02_seed.sql`, copy one of the existing `INSERT INTO clinical.patients` rows, change the `mrn` and the other fields, paste at the bottom. The MRN values in the seed file follow the `A####` convention; pick something that does not collide.

**Add more clinicians.** Same file, the `INSERT INTO clinical.clinicians` section. The clinician's `upn` is what the agent passes when it requests the patient list; change `CLINICIAN_UPN` in `agent/.env` if you want the agent to act as a different clinician.

**Add more visits.** Same file again, the `INSERT INTO clinical.visits` section. Foreign-keyed to `patients.mrn`; make sure the patient exists.

**Caveat:** changes to the seed files do not re-run on an existing container. The PostgreSQL image only runs `/docker-entrypoint-initdb.d` scripts on the very first start of an empty data volume. You have two options:

1.  **Destructive: rebuild from scratch.** `docker compose down -v postgres && docker compose up -d postgres`. The `-v` flag drops the data volume, so the next start sees an empty data directory and runs your edited seed.
2.  **Non-destructive: apply your INSERTs directly.** `docker exec -i vva-postgres psql -U vva_admin -d healthcare < your-new-rows.sql`. This is the right call when you want to preserve any data your testing has already created.

## What you just did

You started a local PostgreSQL container, confirmed it loaded ten seeded patients (two VIP), and confirmed the two roles the verify-rar plugin needs are in place: `vva_admin` (the plugin's admin user) and `healthcare_read_template` (the inheritance parent for ephemeral roles).

## What you'll do next

Move on to [Start the MCP server](./mcp-server-setup.md) to configure and start the only process that handles the on-behalf-of token, talks to Vault, and runs the actual SQL.