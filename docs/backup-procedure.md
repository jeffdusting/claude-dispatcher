# Backup procedure — verification checklist (Phase B.3)

This document describes the hourly R2 backup pipeline put in place during
Phase B.3 of the River migration, and the standing verification checklist
operators run when validating a backup, restoring from one, or rotating
keys. It satisfies Migration Plan §5.2 and architecture v2.1 §5.3.

The procedure is split into four parts:

1. Architecture summary.
2. Standing verification checklist (run on each Phase B.3 commit and after
   any change to the secrets, the public key, or the upload path).
3. Restore-from-cloud procedure (referenced from Phase F warm-spare
   work and the Phase G runbook bundle).
4. Key rotation procedure (Phase G runbook).

---

## 1. Architecture summary

1.1 The dispatcher's `STATE_DIR` (`/data/state` in production, mounted from
the `cos_state` Fly volume) is the source of truth for all runtime state —
sessions, project descriptors, ingest JSONL, escalator records, worker
registry. The full directory is the unit of backup; no per-file
filtering is applied.

1.2 `scripts/backup.sh` runs hourly under supercronic. The crontab is
`scripts/crontab` and contains the single line `0 * * * * /app/scripts/backup.sh`.
Supercronic is launched as a background child of the entrypoint and logs
each invocation to stdout where Fly captures it.

1.3 Each invocation tars `STATE_DIR`, encrypts the tarball to the age
public key `BACKUP_AGE_PUBLIC_KEY` (held in `fly.toml [env]`), and uploads
the ciphertext to Cloudflare R2 via rclone:

```
s3://cos-backups/state/YYYY/MM/DD/HH-MM-SS.tar.age
```

The bucket is in the OC (Oceania) region per OD-001; lifecycle policy
deletes objects after 180 days per OD-002 and applies bucket-wide.

1.4 After upload the same script re-fetches the just-written object,
decrypts using the age private key (`BACKUP_AGE_PRIVATE_KEY` env, fetched
from 1Password at container boot), extracts to `/dev/shm/backup-verify/`,
and validates that every JSON file under the extracted tree parses. Any
failure during these stages appends a JSONL record to
`STATE_DIR/pending-tier2-alerts.jsonl`; the dispatcher's escalator drains
this file on its next sweep tick (`src/pendingAlerts.ts` → `postTier2Alert`)
and the standard tier-2 SMS escalation pipeline takes over from there.

1.5 Fly logs ship in parallel to `s3://cos-backups/logs/YYYY/MM/DD/` via
the `cos-log-shipper` app (`log-shipper/fly.toml`). Both prefixes share
the same 6-month bucket lifecycle.

---

## 2. Standing verification checklist

The first check confirms the public key in `fly.toml` matches the private
half in 1Password. Run locally with the operator's 1Password account:

```bash
PRIV_FROM_VAULT=$(op read "op://CoS-Dispatcher/backup-age-key/credential")
PUB_DERIVED=$(printf '%s\n' "$PRIV_FROM_VAULT" \
  | age-keygen -y)
PUB_FROM_FLY=$(grep BACKUP_AGE_PUBLIC_KEY dispatcher/fly.toml \
  | sed 's/.*"\(age1[^"]*\)".*/\1/')
[ "$PUB_DERIVED" = "$PUB_FROM_FLY" ] \
  && echo "OK: keypair matches" \
  || echo "FAIL: keypair mismatch"
unset PRIV_FROM_VAULT
```

The second check confirms the bucket-scoped credentials read and write to
`cos-backups`:

```bash
ACCESS=$(op read "op://CoS-Dispatcher/r2-bucket-credentials/access-key-id")
SECRET=$(op read "op://CoS-Dispatcher/r2-bucket-credentials/secret-access-key")
ENDPOINT=$(op read "op://CoS-Dispatcher/r2-bucket-credentials/endpoint")
RCLONE_CONFIG_R2_TYPE=s3 \
RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
RCLONE_CONFIG_R2_ACCESS_KEY_ID="$ACCESS" \
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$SECRET" \
RCLONE_CONFIG_R2_ENDPOINT="$ENDPOINT" \
RCLONE_CONFIG_R2_REGION=auto \
  rclone lsd r2:cos-backups
unset ACCESS SECRET
```

The third check is an end-to-end dry run of the script against a tmp
state dir:

```bash
TMPSTATE=$(mktemp -d)
echo '{"hello":"world"}' > "$TMPSTATE/sentinel.json"
mkdir -p "$TMPSTATE/seeds"
echo '{"seed":1}' > "$TMPSTATE/seeds/a.json"

STATE_DIR="$TMPSTATE" \
BACKUP_AGE_PUBLIC_KEY=$(op read "op://CoS-Dispatcher/backup-age-key/public-key") \
BACKUP_AGE_PRIVATE_KEY=$(op read "op://CoS-Dispatcher/backup-age-key/credential") \
R2_ACCESS_KEY_ID="$(op read 'op://CoS-Dispatcher/r2-bucket-credentials/access-key-id')" \
R2_SECRET_ACCESS_KEY="$(op read 'op://CoS-Dispatcher/r2-bucket-credentials/secret-access-key')" \
R2_ENDPOINT="$(op read 'op://CoS-Dispatcher/r2-bucket-credentials/endpoint')" \
R2_BUCKET=cos-backups \
BACKUP_VERIFY_DIR="$TMPSTATE/verify" \
  bash dispatcher/scripts/backup.sh

# expect: "backup ok: state/YYYY/MM/DD/HH-MM-SS.tar.age (...)"
rm -rf "$TMPSTATE"
```

The fourth check verifies the round-trip path from R2 back to plaintext.
Pick the most recent object via rclone, fetch, decrypt, extract, and
sample one JSON file:

```bash
# (rclone env vars from check 2 must still be exported)
LATEST=$(rclone ls r2:cos-backups/state/ --max-depth 5 \
  | sort -k 1 -n | tail -1 | awk '{print $2}')
echo "latest: $LATEST"
TMP=$(mktemp -d)
rclone copyto "r2:cos-backups/$LATEST" "$TMP/snapshot.tar.age"
PRIV=$(op read "op://CoS-Dispatcher/backup-age-key/credential")
age -d -i <(printf '%s\n' "$PRIV") "$TMP/snapshot.tar.age" \
  | tar -xf - -C "$TMP"
unset PRIV
ls -l "$TMP"
jq empty "$TMP"/*.json
rm -rf "$TMP"
```

The fifth check is the alert-bridge round trip — append a synthetic
record and confirm the dispatcher's next sweep drains it:

```bash
echo '{"category":"backup-failure","summary":"checklist-test"}' \
  >> "$STATE_DIR/pending-tier2-alerts.jsonl"
# wait one sweep interval (default 30s), then:
grep pending_alerts_drained "$LOG_DIR/dispatcher.log" | tail -1
```

If any check fails, do not regress the deploy. Investigate root cause and
either fix forward (key mismatch → re-export `fly.toml`; creds outage →
operator re-issues from dashboard) or revert. Backup absence is a tier-2
condition; an undetected silent regression here is the failure mode
DA-009 was raised against.

---

## 3. Restore-from-cloud procedure

This procedure is the input to `restore-from-cloud.sh` (Phase F warm-spare
work). Until that script exists, restoration runs the steps below by hand.

3.1 Identify the snapshot to restore. By default the most recent
successful object under `s3://cos-backups/state/YYYY/MM/DD/` is the
correct choice; for point-in-time recovery, browse the prefix tree.

3.2 Fetch and decrypt to a sandbox directory:

```bash
SANDBOX=/tmp/restore-$(date +%s)
mkdir -p "$SANDBOX"
rclone copyto "r2:cos-backups/$KEY" "$SANDBOX/snapshot.tar.age"
age -d -i <(op read "op://CoS-Dispatcher/backup-age-key/credential") \
  "$SANDBOX/snapshot.tar.age" \
  | tar -xf - -C "$SANDBOX"
```

3.3 Verify the sandbox contents look complete (project descriptors,
ingest JSONL, etc) before pointing the dispatcher at it. Dry-run mode in
the future `restore-from-cloud.sh --dry-run` will short-circuit here.

3.4 Stop the dispatcher (`flyctl machine stop ...`), swap `/data/state`
contents from the sandbox via `rsync -a --delete`, restart. Watch the
first health-check pass and confirm correlation IDs propagate cleanly.

---

## 4. Key rotation procedure

Phase G runbook owns the formal version. Outline:

The first step is generating a fresh age keypair and publishing the new
public half to `fly.toml [env] BACKUP_AGE_PUBLIC_KEY`.

The second step is overlapping the two keypairs in 1Password — the
existing `backup-age-key` becomes `backup-age-key-old`, the new pair
takes the canonical name. Both private halves stay in the vault for the
overlap window (default 30 days).

The third step is updating the dispatcher's `entrypoint.sh` to read both
`backup-age-key/credential` and `backup-age-key-old/credential` and pass
both to age via repeated `-i` flags during decrypt; encryption uses only
the new public key.

The fourth step is decommissioning the old key after the overlap window
expires — delete `backup-age-key-old` from the vault, drop the old `-i`
flag from `entrypoint.sh`. Pre-overlap snapshots are still decryptable
from a developer machine via the vault's audit-log archive.

R2 bucket-scoped credentials follow the same pattern via the Cloudflare
dashboard and the vault item `r2-bucket-credentials`. Token rotation
cadence is a Phase G item.

---

## 5. B.3 smoke test record

The first end-to-end smoke test of the pipeline ran on the operator's
laptop on 2026-04-28 against a synthetic STATE_DIR with three JSON
files and one plaintext file. Outcome:

The first observation is that `backup.sh` completed in 1 second wall
clock, producing a 6 344-byte ciphertext from a 6 144-byte tarball.
Verification round-trip (re-fetch + decrypt + extract + JSON parse)
passed with no errors logged. Audit JSONL entry recorded as
`{"event":"backup_ok","key":"state/2026/04/27/23-09-04.tar.age",
"jsonValidated":3,"durationSec":1}`.

The second observation is that an out-of-band restore (rclone fetch +
age decrypt with the private key read directly from 1Password via
`op read`) recovered the exact synthetic file tree — `sentinel.json`
contents byte-identical to what was written, `seeds/a.json` and
`seeds/b.json` parsing cleanly. Confirms the public/private keypair in
1Password is correctly paired with the public half embedded in
`fly.toml`.

The third observation is a portability note: the original `backup.sh`
used `date +%s%3N` for millisecond timing, which is GNU-only and broke
on macOS BSD `date` during the smoke test. Switched to second
resolution (`date +%s`); fix committed within the same B.3 PR. Hourly
cadence makes 1-second granularity sufficient.

The fourth observation is that the test snapshots at
`state/2026/04/27/23-07-43.tar.age` and `state/2026/04/27/23-09-04.tar.age`
were purged from the bucket after verification so they would not be
mistaken for production snapshots during the Phase F restore drills.
The `cos-backups` bucket is empty at the close of B.3, ready for E.1.

The fifth observation: D5 alert-bridge round trip (synthetic JSONL
record drained by escalator sweep) is covered by the eight-case
`tests/pendingAlerts.test.ts` corpus run during PR #16 testing — the
end-to-end version (real backup.sh failure → escalator → Discord post →
SMS escalation) requires the dispatcher to be running and so deferred
to the first hour after E.1 cutover.

## 6. Document control

| Item | Value |
|---|---|
| Document | Backup procedure — verification checklist (B.3) |
| Status | Active. Standing checklist for Phase B.3 onwards. |
| Author | CBS Group, drafted with Claude |
| Repository | `claude-dispatcher` at `docs/backup-procedure.md` |
| Companion | Migration Plan v1.1 §5.2; architecture v2.1 §5.3 / §6.1 |
| Update cadence | On any change to `scripts/backup.sh`, the public key, the bucket lifecycle, or the alert-bridge plumbing. |
