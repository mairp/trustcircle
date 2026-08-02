# Kubernetes Disaster-Recovery Runbook — Governance Control Plane

Phase 9 · T289 · GAR-010. Operational procedures for **encrypted backup**, **point-in-time
restore**, **object-version verification**, **NATS topology restore**, and **checkpoint**
procedures on Kubernetes. The recovery objective is **four hours** (NFR-008): committed governance
records and audit events MUST be reachable again within four hours with **zero accepted committed
audit/decision loss**.

The end-to-end recovery boundary is proven by `tests/recovery/canonical-restore.test.ts` (T279):
approved four-hour restore, no committed loss, evidence verification, replay, projection rebuild,
and paused reconciliation. This runbook is the operational counterpart.

> For day-to-day operations (alerts, dead letters, reconciliation, audit freeze, evidence gaps) see
> `docs/runbooks/operations.md` (T285).

---

## 0. Recovery objectives & invariants

| Objective                        | Value                              | Source         |
| -------------------------------- | ---------------------------------- | -------------- |
| Recovery Time Objective (RTO)    | 4 hours                            | NFR-008        |
| Committed audit/decision loss    | **zero**                           | GAR-002 / T279 |
| Reconciliation during restore    | **paused** until verified-complete | T279           |
| Evidence integrity after restore | verified by content address        | GAR-006 / T279 |

**Fail-closed invariant.** Reconciliation and consequential/destructive actions stay **paused**
until the restore is verified complete: the audit chain re-verifies, the restored head and signed
checkpoint root match the backup, and evidence verifies by content address. A restore that exceeds
the 4-hour RTO or fails any check is **not approved** — do not resume.

---

## 1. Prerequisites

- `kubectl` context for the recovery cluster; namespace `governance`.
- Access to the encrypted backup bucket (object-lock enabled) and the KMS keys.
- The last **signed** audit checkpoint (ed25519) and its verification key.
- The PostgreSQL WAL archive for point-in-time restore.

---

## 2. Encrypted backup (steady state — verify before you need it)

Backups are useless if they are not restorable, so this section is part of DR readiness.

1. **Database.** Continuous WAL archiving + periodic base backups, encrypted at rest with a KMS key
   distinct from the running cluster's data key. Verify the archive is advancing:
   ```
   kubectl -n governance exec statefulset/postgres -- pg_controldata | grep "Latest checkpoint location"
   ```
2. **Object store (evidence, A3).** Versioned, object-lock (WORM) enabled, replicated to a second
   region. Evidence is content-addressed, so a restored blob is self-verifying.
3. **Audit ledger + checkpoints.** Signed checkpoints are exported to the backup bucket on every
   publish. The signed root is the anchor the restore verifies against.
4. **Encryption.** All backup artifacts are encrypted; keys are held in KMS under workload
   identity, never in cluster secrets in plaintext.
5. **Backup verification job.** A scheduled job restores the latest backup into an ephemeral
   namespace and runs the T279 checks. A backup that does not pass is treated as no backup — page
   the SRE lead.

---

## 3. Point-in-time restore (PITR)

**Target:** restore PostgreSQL to the last consistent point before the incident, then replay WAL up
to (but not past) the corruption boundary.

1. Freeze writes: scale the API and workers to zero.
   ```
   kubectl -n governance scale deploy/api deploy/worker --replicas=0
   ```
2. Provision a fresh PostgreSQL StatefulSet from the encrypted base backup.
3. Configure recovery target (timestamp or LSN) just before the incident:
   ```
   # postgresql.auto.conf
   restore_command = 'kms-decrypt %f | wal-fetch %f %p'
   recovery_target_time = '<pre-incident timestamp>'
   recovery_target_action = 'promote'
   ```
4. Start recovery and wait for promotion. Confirm the recovered timeline.
5. **Do NOT** start the API/workers yet — reconciliation stays paused (§6).

---

## 4. Object-version verification (evidence)

After PITR, verify evidence integrity before trusting the restored state.

1. For every evidence reference in the restored governance records, fetch the object **version**
   pinned by the record and recompute its content address.
2. A blob whose recomputed address does not match the recorded digest is corrupt → treat as an
   integrity incident (operations runbook §5) and restore that object from the replicated region.
3. Confirm object-lock retention is intact on the restored bucket (no shortened retention).

This mirrors the T279 evidence-verification leg: every restored blob must verify by content
address; a corrupted blob is detected.

---

## 5. NATS JetStream topology restore

The event bus is rebuildable; projections are rebuilt from the authoritative store, so NATS carries
no unique source of truth. Restore the **topology**, not the truth.

1. Recreate streams and consumers from the declarative topology manifest (subjects, replicas,
   retention, max-age) in `deploy/kubernetes/`.
2. Restore durable consumer state where available; otherwise recreate consumers at the
   last-acknowledged sequence derived from the rebuilt projections.
3. Because delivery is at-least-once and consumers are idempotent (`event_id` +
   `aggregate_version`), replaying from an earlier sequence is safe — no duplicate governed effect.
4. Verify stream health and that no consumer is wedged before resuming workers.

---

## 6. Checkpoint procedures (audit ledger) & resume

This is the gate that lets the platform come back online.

1. **Replay.** Reconstruct the audit ledger from the restored records and re-verify the hash chain
   from genesis (`packages/audit-ledger` verifier). Every sequence must be present, gap-free, and
   digest-consistent.
2. **Checkpoint match.** Recompute the checkpoint root over the restored range and confirm it
   equals the last **signed** checkpoint root; verify the ed25519 signature with the verification
   key. A signed root over an honest range cannot equal a root over a tampered range, so a match is
   strong evidence of no committed loss.
3. **Projection rebuild.** Rebuild read-model projections purely from the replayed events and
   compare against the pre-incident projection snapshot. A mismatch means the replay is not
   faithful — do not resume.
4. **RTO check.** Confirm elapsed restore time ≤ 4 hours. If exceeded, the restore is **not
   approved**; escalate and re-plan.
5. **Resume.** Only when chain-verifies AND head/checkpoint match AND evidence verifies AND RTO is
   met: unpause reconciliation and scale the API/workers back up.
   ```
   kubectl -n governance scale deploy/api --replicas=3
   kubectl -n governance scale deploy/worker --replicas=2
   ```
6. Record `recovery.completed` as a governed audit event with the accountable owner, the verified
   checkpoint id, and the measured RTO.

---

## 7. Post-recovery

- Run the full release gate `scripts/verify-release.ts` (T283) against the recovered environment
  before declaring the incident resolved.
- File a blameless post-incident review; update residual-risk register RR-4 if the RTO was at risk.
