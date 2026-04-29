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

2.4 The verification reads its credentials through
`scripts/op-or-keychain.sh` (Phase F.4). When the 1Password 8 desktop
session is signed in, op is the resolution path and the helper
opportunistically refreshes a macOS Keychain cache. When op is
unresponsive, locked, or times out (typically the biometric prompt),
the helper transparently falls back to the cached value. The
fallback restores deterministic execution under a 1Password outage —
the verify job no longer fails noisily during a brief desktop-app
hiccup. The fallback log at
`~/claude-workspace/generic/logs/keychain-fallback.log` records which
path was taken on every read so the operator can audit how often
fallback fires.

---

## 3. Failover detection signals

3.1 The operator triggers failover; there is no automatic promotion.
The architectural choice is deliberate (architecture v2.1 §3.2 — "Failover
is operator-initiated using `failover-up.sh`") because false positives
on transient network blips would produce a worse outcome than a brief
outage during a real failure.

3.2 Three signals warrant escalating to the §4 procedure:

The first signal is `flyctl checks list -a cos-dispatcher` reporting
the internal health check `failing` or absent for longer than two
minutes. The dispatcher has no public IP — Discord-bot operation needs
only outbound connectivity to Discord's gateway — so
`cos-dispatcher.fly.dev` does not resolve in public DNS and
`curl https://cos-dispatcher.fly.dev/health` always fails regardless of
cloud state. The flyctl-based check is the authoritative signal because
it terminates inside Fly's WireGuard mesh against the dispatcher's
internal `:8080/health` endpoint. The Phase F.3 drill confirmed this:
a public-DNS probe returned `Could not resolve host` while the
internal check was passing.

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
flyctl checks list -a cos-dispatcher
flyctl status -a cos-dispatcher
flyctl logs -a cos-dispatcher --no-tail 2>&1 | tail -30
```

The dispatcher has no public IP, so `curl https://cos-dispatcher.fly.dev/health`
will not resolve and is not a useful pre-flight check (the §3.2 first
signal explanation covers why). The `flyctl checks list` command runs
through the Fly WireGuard mesh to the internal `:8080/health` endpoint;
if it reports `passing`, the cloud is genuinely up. The new
`failover-up.sh` script automates this same pre-flight (§4.4) and
refuses to promote unless the cloud is unreachable or `--force` is
given. The refusal exists because a spurious promotion creates a
split-brain risk during the demote window.

4.3 **Restore latest state from R2**. The dispatcher stores its state
under `STATE_DIR=~/claude-workspace/generic/dispatcher/state` on the
laptop. The cloud's hourly backup landed under
`s3://cos-backups/state/YYYY/MM/DD/HH-MM-SS.tar.age`. Use the new
restore script (Phase F.3 deliverable):

```bash
cd ~/claude-workspace/generic/dispatcher
scripts/restore-from-cloud.sh --dry-run            # validate first
scripts/restore-from-cloud.sh --force              # overwrite local state
```

The `--dry-run` mode pulls the latest snapshot, decrypts it, validates
it, prints what would be written, and exits without touching
`STATE_DIR`. Run that first; the heartbeat record at
`~/claude-workspace/generic/logs/restore-from-cloud/last-restore.json`
captures the snapshot key and JSON-file count. If the count looks
right, re-run without `--dry-run` (and with `--force` because the
spare's `STATE_DIR` is non-empty after spare-verify activity).

Optional flags: `--target=<dir>` writes elsewhere (used by the F.3
drill against `/tmp/restore-test`); `--key=<key>` pins to a specific
snapshot.

4.4 **Promote the dispatcher**. The full sequence is automated by
`scripts/failover-up.sh` (Phase F.3 deliverable, replaces the v1-era
`promote-to-primary.sh`):

```bash
cd ~/claude-workspace/generic/dispatcher
scripts/failover-up.sh                   # genuine promotion (cloud confirmed down)
scripts/failover-up.sh --force           # planned drill or cloud known stale
scripts/failover-up.sh --dry-run         # walk the path without changes
scripts/failover-up.sh --stop-cloud      # also stop a flapping cloud machine
```

The script orchestrates: pre-flight cloud-down check via
`flyctl checks list`; restore-from-cloud (`--force` because the spare's
`STATE_DIR` is non-empty after spare-verify activity); materialise
Discord token and access.json from 1Password into
`~/.claude/channels/discord/`; `launchctl load -w` the dispatcher
plist (clears `Disabled=true` and the launchd disabled-job DB
entry); poll local `/health` until it returns ok within 60s.
Heartbeat record: `~/claude-workspace/generic/logs/failover/last-failover.json`.

If the script refuses pre-flight because the cloud reports passing
checks, either it is a false alarm (operator should investigate
network) or a genuine drill (re-run with `--force`). The refusal is
deliberate; a spurious promotion creates split-brain.

4.5 **Verify promotion**. `failover-up.sh` polls `/health` automatically
and warns if `/health/integrations` aggregate is anything other than
`ok`. After it returns, two further checks confirm the dispatcher is
fully healthy on the laptop:

```bash
curl -fsS http://127.0.0.1:3000/health/integrations | jq .aggregate
# expect: "ok"
```

The dispatcher logs at
`~/claude-workspace/generic/logs/launchd-stdout.log` should show
`gateway_connected`, `ingest_backfill_complete`, and a heartbeat
within 30 seconds. A round-trip `claude_done` for a real Discord
ping (operator-side) confirms the worker spawn path, Anthropic API
access, and Discord egress end-to-end.

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

5.3 **Push laptop state to R2**. Use `backup.sh` — it produces the
same age-encrypted format the cloud reads from at boot via the volume
restore path. The v1-era `state-push.sh` was removed in Phase F.3
because it wrote unencrypted tar.gz which the cloud entrypoint does
not consume.

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
and run the restore from R2 using the same script as the laptop side:

```bash
flyctl ssh console -a cos-dispatcher
# inside the machine:
cd /app
scripts/restore-from-cloud.sh --target=/data/state --force
```

The script behaves identically inside the container as on the laptop —
reads creds from 1Password (the `OP_SERVICE_ACCOUNT_TOKEN` Fly secret
already gives the running container `op` access to the
`CoS-Dispatcher` vault), pulls the latest snapshot, validates, and
rsyncs into `/data/state` overwriting the in-place state. Restart the
machine afterwards (`flyctl machine restart 0803795b154078 -a cos-dispatcher`)
so the dispatcher re-loads from the restored state.

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

6.1 **1Password dependency** (CLOSED by Phase F.4). The verify job
(§2) and the failover procedure (§4) read credentials through
`scripts/op-or-keychain.sh`. The helper tries `op read` first
(five-second timeout) and falls back to a macOS Keychain cache
populated by every successful op read. This eliminates the
single-point-of-failure on the operator's signed-in 1Password 8
desktop session — a locked desktop, a sleeping app, or a transient
biometric-prompt timeout no longer breaks the verify job or a real
failover. The cache covers seven entries: the four
operationally-critical secrets named in Migration Plan §9.2 (age
private key, R2 access key id, R2 secret access key, Discord bot
production token) plus three operationally-required adjuncts (R2
endpoint URL, Discord access-config-json, Anthropic API key — all
needed during a real failover).

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
the verify heartbeat goes stale. Phase G runbook work will add a
launchd job that reads the heartbeat and emits a tier-2 alert via the
dispatcher's `pending-tier2-alerts.jsonl` bridge if `finishedAt` is
more than 26 hours behind wall clock.

6.5 **1Password CLI biometric timeouts during drills**. The Phase F.3
drill (2026-04-29) saw two transient `op` auth-timeout failures
during the dry-run sequence — the macOS biometric prompt timed out
before the operator could approve. The Phase F.4 Keychain fallback
(landed in the same session) eliminates this failure mode entirely:
a fault-injection drill (replacing `op` with a stub that always
returns failure) confirmed the verify and restore paths complete
end-to-end against the Keychain cache without operator interaction.
Each successful op read continues to refresh the cache so it tracks
the live vault values.

6.6 **Cloud-side restore script availability**. §5.4's `flyctl ssh
console` restore procedure assumes the cloud image carries the
`scripts/restore-from-cloud.sh` script. The script lands in the cloud
image at the next deploy after Phase F.3 merges; until that deploy
runs, the demote-side cloud restore reverts to the manual sequence
(rclone lsf + rclone copyto + age -d + tar -xf + rsync — the same
shape the v1 script's removed body documented).

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

7.5 **Keychain fallback init** (Phase F.4). Pre-populate the Keychain
cache so a 1Password outage does not break the first verify run:

```bash
~/claude-workspace/generic/dispatcher/scripts/op-or-keychain.sh sync-all
```

Each line should print `ok`. Re-running `... list` afterwards confirms
the seven allow-listed entries are `cached`. The fallback is idempotent
and self-refreshing — every successful op read in normal operation
refreshes the cache.

7.6 **Spare-verify install**. Same install script as the laptop:

```bash
~/claude-workspace/generic/dispatcher/scripts/install-spare-verify.sh
```

The script derives all paths from its own location, so the same script
works regardless of whether the workspace is at `~/claude-workspace/`,
`~/Documents/...`, or elsewhere.

7.7 **One manual verify run**. Do not wait until 03:15 for the first
verification — kick it off immediately to confirm the install works:

```bash
~/claude-workspace/generic/dispatcher/scripts/spare-verify-backup.sh
cat ~/claude-workspace/generic/logs/spare-verify/last-verify.json | jq
```

Expect `"status": "ok"` and `"jsonFilesValidated"` in the same range as
the laptop's most recent heartbeat.

7.8 **Dispatcher plist install — DO NOT auto-load**. Copy the laptop's
plist template (a customised version is at
`scripts/dispatcher-spare.plist.template` in a future commit) and ensure
both `Disabled=true` and the launchd-database disabled state are set
before placing it in `~/Library/LaunchAgents/`. The desktop never runs
the dispatcher in normal operation; the plist exists only for failover
promotion via the §4 procedure.

7.9 **Tier note**. Architecture v2.1 §3.2 specifies the laptop as the
primary spare and the desktop as the secondary. Failover decisions
should default to the laptop unless the laptop itself is unavailable
(operator travelling, hardware failure, network outage at the laptop's
location). The desktop's freshness depends on its own verify heartbeat
— a desktop that has been powered off for a week may have the same
1Password access but may not have detected an interim R2 backup
regression.

---

## 8. Phase F.3 drill record

8.1 **Drill date**: 2026-04-29 (between 02:31 and 02:36 UTC, ~5 minutes).

8.2 **Scope**: dry-run drill exercising the new
`scripts/restore-from-cloud.sh` and `scripts/failover-up.sh` against
real R2 state without touching the laptop's `STATE_DIR` or promoting
the dispatcher. End-to-end live drill against a separate Discord test
bot is deferred — see §8.6.

8.3 **Pre-flight signal verification**:

The first finding is that the dispatcher has no public IP. A direct
`curl https://cos-dispatcher.fly.dev/health` returned `Could not
resolve host: cos-dispatcher.fly.dev` while `flyctl checks list`
reported the internal `:8080/health` check `passing`. The Discord-bot
operating model requires only outbound connectivity to Discord's
gateway, so no public IP is correct posture; the failover doc's
detection signals (§3.2) and the failover script's pre-flight (§4.2,
§4.4) had to switch from public-DNS probe to flyctl-based check. Both
were updated before the drill record was written.

8.4 **Restore-from-cloud dry-run**:

The script pulled the latest snapshot
`state/2026/04/29/02-00-00.tar.age` (4 762 952 bytes cipher) from
`r2:cos-backups/state/`, decrypted via `age -d -i <(op read ...)`,
extracted to a per-run scratch directory, and validated 130 JSON
files / 267 total files — well above the sanity floor of 10. Heartbeat
record at `~/claude-workspace/generic/logs/restore-from-cloud/last-restore.json`
captures `mode:"dry-run"`, `status:"ok"`, `target` set to the
laptop's `STATE_DIR`. Scratch directory cleaned by EXIT trap.

8.5 **Failover-up dry-run**:

Run twice. First run (`--dry-run` without `--force`) refused promotion
because flyctl reported a passing check and a started machine — the
deliberate split-brain guard fired correctly. Second run
(`--dry-run --force`) walked the full sequence: pre-flight, restore
(via the dry-run mode), Discord-credential materialisation
(report-only), plist load (skipped), local /health verification
(skipped), cloud-stop step (skipped because `--stop-cloud` not
given). Heartbeat record at
`~/claude-workspace/generic/logs/failover/last-failover.json` captures
`status:"ok"`, `mode:"dry-run"`.

8.6 **Deferred work — live drill against test bot**:

The original Phase F.3 scope referenced a live spare-mode drill
against a separate Discord test bot. No test bot is provisioned yet —
the `CoS-Dispatcher` 1Password vault carries only `discord-bot`
(production). Provisioning a test bot requires (a) Discord Developer
Portal sign-in (operator), (b) creating the application + bot, (c)
inviting the bot to a test guild, (d) recording the token under a
new vault item `discord-bot-test`, (e) populating a test access list,
(f) the dispatcher gaining a `DISCORD_TEST_BOT_TOKEN` env override
when running in drill mode. This is deferred to a Phase F.3
follow-up labelled "F.3.live" pending the operator's test-bot
provisioning. The dry-run drill above exercises the state-restore
and orchestration paths end-to-end; only the gateway connect and
ingest-backfill paths remain unexercised under live drill conditions.

8.7 **Two transient 1Password failures**:

The drill saw two transient `op` auth-timeout failures (errors logged
verbatim in the restore-from-cloud `last-restore.json` heartbeat).
Both cleared on the next attempt after a `op vault list` warmed the
desktop session. The macOS biometric prompt times out faster than
operator response if the 1Password 8 app is not focused. This is
recorded as §6.5 above and is the load-bearing F.4 motivation:
Keychain fallback eliminates the manual approval step.

---

## 9. Phase F.4 deliverable record

9.1 **Deliverable date**: 2026-04-29.

9.2 **Scope**: Migration Plan §9.2 — Keychain cache populated on each
spare; §9.3 — failover scripts updated to try 1Password first, fall
back to Keychain. Closes Δ I-009 (1Password as single point of
failure for spare operations).

9.3 **Helper script**: `scripts/op-or-keychain.sh` exposing four
subcommands (`read`, `sync`, `sync-all`, `list`). The `read` path is
the primary surface — drop-in replacement for `op read <path>` with
opportunistic Keychain refresh on op success and transparent
fallback on op failure. The `sync-all` subcommand pre-populates every
allow-listed entry from 1Password (used during initial spare
bring-up); `list` reports cache status. Implementation degrades
gracefully on Linux — when the macOS `security` binary is absent,
the helper acts as a thin wrapper around `op read` (used by §5.4's
cloud-side restore from inside the Fly machine).

9.4 **Allow-list**: seven op:// references, all under
`op://CoS-Dispatcher/`. The list covers the four operationally-critical
secrets named in Migration Plan §9.2 (age private key, R2 access
key id, R2 secret access key, Discord production token) plus three
operationally-required adjuncts (R2 endpoint URL, Discord
access-config-json, Anthropic API key). The allow-list is
intentionally small — non-listed paths fall through to direct `op
read` so a real 1Password outage still surfaces during routine
operations rather than being silently masked.

9.5 **Trust model**: Keychain entries use
`security add-generic-password -A` so any process running as the
operator can read them without a prompt. This matches the existing
trust posture: when the dispatcher is active, the same secrets land
in plaintext under `~/.claude/channels/discord/.env`,
`~/.claude/channels/discord/access.json`, and the running
dispatcher process's environment. The Keychain entries are encrypted
at rest by the operator's login keychain and unlocked by the macOS
login session — same trust boundary as those plaintext files.

9.6 **F.4 drill — fault injection**:

The first injection placed a stub `op` binary on PATH that exits 1
on every invocation. A direct `op-or-keychain.sh read` call against
`backup-age-key/credential` returned the cached value (74 chars,
prefix `AGE-SECRET-KEY`) in under 100ms. The fallback log recorded
`ok via keychain (op unavailable)`.

The second injection ran `restore-from-cloud.sh --dry-run` under the
same PATH override. The script resolved all four R2/age secrets via
Keychain in ~2 seconds total (versus ~19 seconds via op on the warm
path due to biometric round-trips), pulled the latest snapshot from
R2, decrypted, validated 130 JSON files / 267 total, and exited 0.
The fault-injection drill confirmed end-to-end resilience under a
1Password outage with zero operator interaction.

9.7 **Wiring**: `spare-verify-backup.sh`, `restore-from-cloud.sh`, and
`failover-up.sh` were updated to route the four/seven op:// reads
through `op-or-keychain.sh`. No change to the script surfaces or
flags — the helper is a transparent layer under existing call sites.
Cloud-container reads continue to use `op read` directly because the
cloud has no Keychain to fall back to and `OP_SERVICE_ACCOUNT_TOKEN`
does not require biometric prompts.

9.8 **Initial population**: the laptop's Keychain was populated via
`scripts/op-or-keychain.sh sync-all` on 2026-04-29. All seven entries
report `cached`. The desktop spare bring-up procedure (§7.5) names
`sync-all` as the F.4 init step before the first `spare-verify-backup`
run.

9.9 **Operational note for credential rotation**: Phase G's rotation
runbook (Migration Plan §10.3) must include a `op-or-keychain.sh
sync-all` step after each rotation, otherwise the Keychain cache
drifts from the live 1Password value and a 1Password outage during
the drift window would surface a stale credential. The natural
self-refresh on every op-path read covers steady-state drift; the
post-rotation explicit sync covers the burst case.

---

## 10. Document control

| Item | Value |
|---|---|
| Document | Warm-spare verification and failover-trigger procedure |
| Status | Active. Updated after Phase F.3 dry-run drill and Phase F.4 deliverable (both 2026-04-29). |
| Author | CBS Group, drafted with Claude |
| Repository | `claude-dispatcher` at `docs/warm-spare-failover.md` |
| Companion | Migration Plan v1.1 §9; architecture v2.1 §3.2; backup-procedure.md |
| Update cadence | After F.3.live drill; after each spare promotion event; on plist or script changes; after each rotation runbook revision. |
