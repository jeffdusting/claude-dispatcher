# Warm-spare verification and failover-trigger procedure

This document describes the warm-spare configuration on the operator's
laptop and desktop, the nightly verification job that confirms the
backup pipeline is producing usable snapshots, and the manual failover
procedure when the Fly cloud dispatcher is unavailable.

It satisfies Migration Plan §9 (Phase F) deliverables 9.1 (spare
configurations verified), 9.4 (verification dry-run), and 9.5
(documented failover procedure). Architecture v2.1 §3.2 is the
authoritative target state.

The procedure is split into five parts:

1. Spare topology and roles.
2. Nightly backup verification job.
3. Failover detection signals.
4. Manual failover-trigger procedure.
5. Demotion procedure when cloud is restored.

---

## 1. Spare topology and roles

1.1 The Fly app `cos-dispatcher` in region `syd` is the live primary.
Production traffic terminates at `cos-dispatcher.fly.dev`. Architecture
v2.1 §3.1 is authoritative for the cloud machine itself.

1.2 The operator's laptop is the **tier-1 warm spare**. It carries a
complete checkout of the dispatcher source at
`~/claude-workspace/generic/dispatcher/`, the launchd plist
`com.river.generic-dispatcher.plist` in `~/Library/LaunchAgents/`
(disabled — see §1.4), and 1Password CLI access to the
`CoS-Dispatcher` vault via the operator's signed-in 1Password 8 desktop
app.

1.3 The operator's desktop is the **tier-2 warm spare**. Same pattern
as §1.2 but used only when the laptop itself is unavailable. Phase F.2
covers desktop bring-up; the procedure below applies to either spare
once configured.

1.4 The dispatcher plist remains on disk for fast promotion but is
configured `Disabled=true` so it does not auto-load on user login.
Cutover to the cloud (Phase E.1, 2026-04-29) decommissioned the
laptop's continuous-run role; resuming primary mode on a spare is an
operator-initiated decision triggered by §3 below.

---

## 2. Nightly backup verification job

2.1 The verification job lives at
`dispatcher/scripts/spare-verify-backup.sh`. It is installed as a
launchd job `com.river.spare-verify` via
`dispatcher/scripts/install-spare-verify.sh`. The schedule is 03:15
local time, fired by `StartCalendarInterval` in
`scripts/spare-verify.plist.template`.

2.2 Each invocation performs:

The first step lists `s3://cos-backups/state/` via rclone and selects
the lexicographically last `.tar.age` object — the
`YYYY/MM/DD/HH-MM-SS.tar.age` key shape sorts to the most recent.

The second step fetches the object to a per-run scratch directory
under `/tmp/river-spare-verify/`. The scratch dir is mode 0700 and is
unconditionally removed by an `EXIT` trap.

The third step decrypts the snapshot via `age -d -i <(...)` with the
private key sourced from `op://CoS-Dispatcher/backup-age-key/credential`
(via 1Password). The plaintext is piped directly to `tar -xf -` — the
private key never lands on disk and the plaintext tarball never
materialises.

The fourth step validates the extracted tree — confirms `projects/`
exists at the tar root, counts JSON files (sanity floor: at least one),
counts total files (sanity floor: ten), and runs `jq empty` against
every JSON file to confirm parseability.

The fifth step writes a heartbeat record to
`~/claude-workspace/generic/logs/spare-verify/last-verify.json`. The
shape is `{startedAt, finishedAt, status, snapshotKey, detail,
cipherBytes, jsonFilesValidated, exitCode}`. `status` is one of `ok`
or `fail`; `exitCode` is `0` on success, `1` on infrastructure failure
(op outage, rclone error, age decrypt failure), or `2` on validation
failure (missing `projects/`, JSON parse error, file count below the
sanity floor).

2.3 Operator-side check: open the heartbeat file. If `finishedAt` is
older than 24 hours, the launchd job has not run — investigate via
`launchctl list | grep river`, the stderr log at
`~/claude-workspace/generic/logs/spare-verify-stderr.log`, and the
1Password 8 desktop session state. If `status` is `fail`, the `detail`
field carries the verbatim error message.

2.4 The verification dependency on a signed-in 1Password 8 desktop
session is identical to the existing dispatcher launchd dependency
(B-009 closure). Phase F.4 will introduce a Keychain fallback so the
verification continues to function during a 1Password outage.

---

## 3. Failover detection signals

3.1 The operator triggers failover; there is no automatic promotion.
The architectural choice is deliberate (architecture v2.1 §3.2 — "Failover
is operator-initiated using `failover-up.sh`") because false positives
on transient network blips would produce a worse outcome than a brief
outage during a real failure.

3.2 Three signals warrant escalating to the §4 procedure:

The first signal is repeated `cos-dispatcher.fly.dev/health` failures
across at least two distinct vantage points (operator's laptop, mobile
data network, an unrelated host) over a five-minute window. A single
vantage point reporting failure is more likely a local DNS or
connectivity issue.

The second signal is `flyctl status -a cos-dispatcher` reporting
`stopped` or `failed` machine state for longer than the Fly grace
period (typically 60 seconds). Transient `replacing` or `pending` states
during a deploy are expected.

The third signal is loss of Discord coverage — the bot does not respond
to a fresh ping for longer than two minutes — combined with confirmed
healthy Discord gateway status (no Discord-side outage on
discordstatus.com).

3.3 Tier-2 alerts (Twilio SMS) are wired to escalate backup-verify
failures and the dispatcher's own integration probe failures. The
absence of recent tier-2 alerts during a perceived outage suggests a
local-side issue rather than a real cloud failure.

---

## 4. Manual failover-trigger procedure

4.1 This procedure assumes the laptop spare. The desktop equivalent
substitutes the desktop's paths but is otherwise identical.

4.2 **Pre-flight (60 seconds)**. Confirm the cloud is genuinely down.
Run all three from a different network if possible (operator's mobile
hotspot is the standard alternate path):

```bash
curl -fsS https://cos-dispatcher.fly.dev/health || echo "health failed"
flyctl status -a cos-dispatcher
flyctl logs -a cos-dispatcher --no-tail 2>&1 | tail -30
```

If `flyctl` shows `started` and `1 total, 1 passing` checks but
`/health` fails, the issue is network reachability, not the cloud
machine. Investigate the operator's network before promoting; a
spurious promotion creates a split-brain risk during the demote
window.

4.3 **Restore latest state from R2**. The dispatcher stores its state
under `STATE_DIR=~/claude-workspace/generic/dispatcher/state` on the
laptop. The cloud's hourly backup landed under
`s3://cos-backups/state/YYYY/MM/DD/HH-MM-SS.tar.age`. Use the
restore-from-cloud sequence in `dispatcher/docs/backup-procedure.md`
§3 with the laptop's `STATE_DIR` as the target. Until
`scripts/restore-from-cloud.sh` lands (Phase F.3), perform the steps
manually:

```bash
cd ~/claude-workspace/generic/dispatcher
KEY=$(rclone lsf "r2:cos-backups/state/" \
       --recursive --files-only --format=p \
       | grep -E '\.tar\.age$' | sort | tail -n 1)
SANDBOX=/tmp/restore-$(date +%s)
mkdir -p "$SANDBOX"
rclone copyto "r2:cos-backups/state/$KEY" "$SANDBOX/snapshot.tar.age"
PRIV=$(op read "op://CoS-Dispatcher/backup-age-key/credential")
age -d -i <(printf '%s\n' "$PRIV") "$SANDBOX/snapshot.tar.age" \
  | tar -xf - -C "$SANDBOX"
unset PRIV
ls "$SANDBOX/projects" | head        # spot-check
rsync -a --delete "$SANDBOX/" state/  # overwrite local state
rm -rf "$SANDBOX"
```

The operator should spot-check `state/projects/` for the most recent
project descriptors before swapping; a corrupt or empty restore creates
a worse incident than the cloud outage.

4.4 **Promote the dispatcher**. Existing helper:
`dispatcher/scripts/promote-to-primary.sh`. It is the v1-era script and
predates the B.3 backup format — the state-pull sub-step it performs
no longer applies. Use the manual sequence instead until Phase F.3
modernises the script:

```bash
launchctl load -w ~/Library/LaunchAgents/com.river.generic-dispatcher.plist
# RunAtLoad=true so the dispatcher boots immediately on load.
# -w writes the override into the per-user launchd disabled-job DB.
sleep 5
curl -fsS http://localhost:3000/health
```

The local `/health` endpoint should return `200 ok`. The dispatcher
inherits its production Discord token, Anthropic key, and access.json
from the laptop's `~/.claude/channels/discord/` — the laptop has been
the primary as recently as Phase E.1 cutover (2026-04-29) so the
material is current. Re-fetch from 1Password if uncertain:

```bash
op read "op://CoS-Dispatcher/discord-bot/credential" \
  > ~/.claude/channels/discord/.env.tmp
# manual: prepend `DISCORD_BOT_TOKEN=`
mv ~/.claude/channels/discord/.env.tmp ~/.claude/channels/discord/.env
op read "op://CoS-Dispatcher/discord-bot/access-config-json" \
  > ~/.claude/channels/discord/access.json
```

4.5 **Verify promotion**. Within 60 seconds:

```bash
curl -fsS http://localhost:3000/health/integrations | jq .aggregate
# expect: "ok"

# Send a synthetic Discord ping in the test channel:
op read "op://CoS-Dispatcher/discord-bot/test-channel-id"  # if recorded
# or use the operator's known test channel ID
```

The dispatcher logs at
`~/claude-workspace/generic/logs/launchd-stdout.log` should show
`gateway_connected`, `ingest_backfill_complete`, and a heartbeat
within 30 seconds. A round-trip `claude_done` for the synthetic ping
confirms the worker spawn path, Anthropic API access, and Discord
egress.

4.6 **Stop the cloud machine if it is partially up**. A genuinely-down
machine needs no action; a flapping machine does:

```bash
flyctl machine stop <machine-id> -a cos-dispatcher
```

Two dispatchers in primary mode against the same Discord workspace
will both try to acknowledge the same messages and produce duplicate
worker spawns. The split-brain is short-lived (the failover window)
but worth eliminating cleanly.

---

## 5. Demotion procedure when cloud is restored

5.1 Resume the cloud machine. The `flyctl deploy --remote-only` path
brings up a fresh machine with the current image; alternatively
`flyctl machine start <machine-id>` reuses the existing one.

5.2 Confirm the cloud `/health` and `/health/integrations` both return
green. The cloud machine ingests state from the `cos_state` Fly volume
which has been frozen during the outage; the laptop's mutations during
its primary tenure now need to flow back.

5.3 **Push laptop state to R2**. The laptop's `state-push.sh` writes a
v1-era unencrypted snapshot which the cloud entrypoint does not
consume. Use `backup.sh` instead — it produces the same age-encrypted
format the cloud reads from at boot via the volume restore path:

```bash
cd ~/claude-workspace/generic/dispatcher
STATE_DIR="$(pwd)/state" \
BACKUP_AGE_PUBLIC_KEY="$(op read "op://CoS-Dispatcher/backup-age-key/public-key")" \
BACKUP_AGE_PRIVATE_KEY="$(op read "op://CoS-Dispatcher/backup-age-key/credential")" \
R2_ACCESS_KEY_ID="$(op read 'op://CoS-Dispatcher/r2-bucket-credentials/access-key-id')" \
R2_SECRET_ACCESS_KEY="$(op read 'op://CoS-Dispatcher/r2-bucket-credentials/secret-access-key')" \
R2_ENDPOINT="$(op read 'op://CoS-Dispatcher/r2-bucket-credentials/endpoint')" \
R2_BUCKET=cos-backups \
  bash scripts/backup.sh
```

5.4 **Pull state into the cloud volume**. SSH into the Fly machine
and run the restore from R2:

```bash
flyctl ssh console -a cos-dispatcher
# inside the machine:
KEY=$(rclone lsf "r2:cos-backups/state/" --recursive --files-only --format=p \
       --config /dev/null \
       --s3-access-key-id "$R2_ACCESS_KEY_ID" \
       --s3-secret-access-key "$R2_SECRET_ACCESS_KEY" \
       --s3-endpoint "$R2_ENDPOINT" \
       --s3-region auto --s3-provider Cloudflare \
       | grep -E '\.tar\.age$' | sort | tail -n 1)
# fetch + age decrypt + tar extract into /data/state, replacing in place
# (full sequence formalised in scripts/restore-from-cloud.sh under F.3)
```

5.5 **Stop the laptop dispatcher**:

```bash
launchctl unload -w ~/Library/LaunchAgents/com.river.generic-dispatcher.plist
```

The `-w` writes the disabled state back to the per-user launchd
database so subsequent logins do not auto-load.

5.6 **Confirm cloud is primary again**. Send a synthetic Discord ping
and watch for a single `claude_done` event in the cloud logs. Two
events (one from each side) means the demote did not complete.

---

## 6. Operational notes

6.1 **1Password dependency**. Both the verify job (§2) and the
failover procedure (§4) depend on a signed-in 1Password 8 desktop
session on the spare. If the operator is travelling and the desktop is
locked, the laptop's verify will fail. Phase F.4's Keychain fallback
covers this gap; until F.4 lands, this is a known operational risk.

6.2 **Plist disabled state**. The dispatcher plist on the laptop carries
both `Disabled=true` (set in Phase F.1) and the launchd disabled-job
database entry from the E.1 cutover unload. Either alone would suffice;
both together are belt-and-braces. `launchctl load -w` from §4.4 clears
both.

6.3 **State drift**. The cloud writes hourly backups; the laptop's
local state diverges from the cloud after Phase E.1. The verify job
(§2) only confirms the cloud snapshot is decryptable and structurally
sound — it does not refresh the laptop's local state. A real failover
must restore from R2 first (§4.3), not boot the dispatcher against
stale local state.

6.4 **Heartbeat staleness alerting**. There is no automated alert when
the verify heartbeat goes stale. Phase F.3 will add a launchd job that
reads the heartbeat and emits a tier-2 alert via the dispatcher's
`pending-tier2-alerts.jsonl` bridge if `finishedAt` is more than 26
hours behind wall clock.

---

## 7. Desktop spare bring-up (Phase F.2)

7.1 The desktop carries the same role as the laptop spare but at tier-2.
The procedure below brings a fresh desktop into spare-ready state. It
runs entirely on the desktop and is idempotent; rerun if any step fails
mid-flight.

7.2 **Workspace clone**. Place the workspace under one of the paths
`scripts/check-spare-tooling.sh` searches:

```bash
mkdir -p "$HOME/claude-workspace"
cd "$HOME/claude-workspace"
# replace with the canonical workspace remote when it lands; until then,
# clone from the operator's iCloud or USB transfer of the existing
# laptop directory.
```

7.3 **Tooling check**. Run the readiness script:

```bash
~/claude-workspace/generic/dispatcher/scripts/check-spare-tooling.sh
```

It reports each required binary and version. The remediation hint at the
end of a failed run names the Homebrew formulae that cover every gap.
Rerun until all checks pass.

7.4 **1Password 8 desktop sign-in**. Sign in to the desktop's 1Password 8
app under `jeff@cbs.com.au` (the same account used on the laptop) and
enable Settings → Developer → "Integrate with 1Password CLI". Verify:

```bash
op vault list
# expect to see CoS-Dispatcher in the list
op read "op://CoS-Dispatcher/backup-age-key/public-key"
# expect: age12ezyd77jp8cc4l7ypf0xwpz45x5y9u3j6vcpxeahshscn0ry9p9qunv2z4
```

If `op vault list` returns an authorisation timeout, unlock the desktop
1Password app and re-run.

7.5 **Spare-verify install**. Same install script as the laptop:

```bash
~/claude-workspace/generic/dispatcher/scripts/install-spare-verify.sh
```

The script derives all paths from its own location, so the same script
works regardless of whether the workspace is at `~/claude-workspace/`,
`~/Documents/...`, or elsewhere.

7.6 **One manual verify run**. Do not wait until 03:15 for the first
verification — kick it off immediately to confirm the install works:

```bash
~/claude-workspace/generic/dispatcher/scripts/spare-verify-backup.sh
cat ~/claude-workspace/generic/logs/spare-verify/last-verify.json | jq
```

Expect `"status": "ok"` and `"jsonFilesValidated"` in the same range as
the laptop's most recent heartbeat.

7.7 **Dispatcher plist install — DO NOT auto-load**. Copy the laptop's
plist template (a customised version is at
`scripts/dispatcher-spare.plist.template` in a future commit) and ensure
both `Disabled=true` and the launchd-database disabled state are set
before placing it in `~/Library/LaunchAgents/`. The desktop never runs
the dispatcher in normal operation; the plist exists only for failover
promotion via the §4 procedure.

7.8 **Tier note**. Architecture v2.1 §3.2 specifies the laptop as the
primary spare and the desktop as the secondary. Failover decisions
should default to the laptop unless the laptop itself is unavailable
(operator travelling, hardware failure, network outage at the laptop's
location). The desktop's freshness depends on its own verify heartbeat
— a desktop that has been powered off for a week may have the same
1Password access but may not have detected an interim R2 backup
regression.

---

## 8. Document control

| Item | Value |
|---|---|
| Document | Warm-spare verification and failover-trigger procedure |
| Status | Active. Phase F.1 deliverable, draft pending Phase F.3 drill validation. |
| Author | CBS Group, drafted with Claude |
| Repository | `claude-dispatcher` at `docs/warm-spare-failover.md` |
| Companion | Migration Plan v1.1 §9; architecture v2.1 §3.2; backup-procedure.md |
| Update cadence | After Phase F.3 drill; after each spare promotion event; on plist or script changes. |
