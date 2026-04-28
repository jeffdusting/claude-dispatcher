# cos-log-shipper

Fly app that streams dispatcher logs from the Fly NATS firehose into the
Cloudflare R2 bucket `cos-backups`, prefix `logs/YYYY/MM/DD/`. Uses the
upstream `ghcr.io/superfly/fly-log-shipper` image (Vector-based).

This satisfies Migration Plan §5.2.3 (Δ S-006). Retention is set by the
bucket-level lifecycle policy: 6 months across all keys (Δ OD-002).

## 1. Provisioning state

The Fly app `cos-log-shipper` is created during Phase B.3 and the
`fly.toml` in this directory is committed to source. The actual deploy and
secret population is staged for Phase E.1 (cutover) so log flow starts the
moment the dispatcher comes up.

## 2. Deploy procedure (run during Phase E.1)

The first step is creating the Fly logs token scoped to the dispatcher app:

```bash
flyctl tokens create logs --app cos-dispatcher --name log-shipper
```

The output token is captured into 1Password under
`op://CoS-Dispatcher/log-shipper-fly-token/credential` and never written to
disk.

The second step is setting the three deploy-time secrets on the
log-shipper app:

```bash
ACCESS_TOKEN=$(op read "op://CoS-Dispatcher/log-shipper-fly-token/credential")
AWS_ACCESS_KEY_ID=$(op read "op://CoS-Dispatcher/r2-bucket-credentials/access-key-id")
AWS_SECRET_ACCESS_KEY=$(op read "op://CoS-Dispatcher/r2-bucket-credentials/secret-access-key")
flyctl secrets set \
  ACCESS_TOKEN="$ACCESS_TOKEN" \
  AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --app cos-log-shipper \
  --stage
unset ACCESS_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

The third step is the deploy itself:

```bash
flyctl deploy --app cos-log-shipper --remote-only --config log-shipper/fly.toml
```

## 3. Verification

After deploy and a few minutes of dispatcher activity, log objects should
appear under `s3://cos-backups/logs/YYYY/MM/DD/` with `.log.gz` suffix.
List via:

```bash
rclone ls "r2:cos-backups/logs/" --max-depth 4 | head
```

## 4. Operational notes

The shipper consumes one Fly machine running continuously (the firehose is
a long-lived NATS subscription, so there is no idle-down option). Cost is
approximately AUD 2–3 per month at `shared-cpu-1x` with 256 MB.

Rotation of the Fly logs token is part of the Phase G runbook bundle.
