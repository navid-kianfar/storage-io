# Backend wave 2b — IAM: S3 users, groups, policies, access keys

Read: docs/BUILD-RULES.md, docs/ARCHITECTURE.md, docs/API.md (incl. Additions), docs/FEATURE-CHECKLIST.md, apps/api/README.md. Build on the existing providers framework (MinIO admin transport already exists).

Scope (`apps/api/src/providers/iam/*`, `apps/api/src/modules/{iam-users,iam-groups,iam-policies,access-keys}`):
- IAM driver interface (users, groups, policies, access keys, capabilities) with implementations:
  - `minio-admin`: users (add/remove/set-status/info/list), groups (update-group-members add/remove, set-group-status, info, list), canned policies (add/remove/info/list; attach/detach via idp/builtin/policy/attach|detach, fall back to set-user-or-group-policy on older servers), service accounts as access keys (add with name/description/expiry/session policy, update, delete, list, info). Built-in policies (readwrite, readonly, writeonly, diagnostics, consoleAdmin) are read-only.
  - `aws-iam` via @aws-sdk/client-iam with the server's iamEndpoint (AWS default; SeaweedFS IAM API port; Wasabi iam.wasabisys.com): users, groups, managed policies (create/update via CreatePolicyVersion keeping ≤5 versions), attach/detach, access keys (create/update status/delete, last used). Expiry for AWS/SeaweedFS keys is app-tracked in key_meta and enforced by the scheduler.
  - `ceph-admin`: RGW Admin Ops (SigV4 REST): users (create/modify suspend/remove/info/list via metadata/user), keys (create/remove), user caps; policies = user inline policies via IAM-compatible endpoint if available, else report not_supported for policies.
  - `garage-admin`: keys as users+access keys (create/import/update/delete, bucket permissions allow/deny) — map honestly: users = keys; policies not supported; groups not supported.
- Endpoints: everything under "IAM" in docs/API.md + policy versions/restore + users/keys CSV exports. Aggregation across servers with per-server `unavailable` entries (never fail the whole list because one server is down).
- Access keys: create returns the secret once; rotate = create new + schedule old disable at `now + graceSeconds` (key_meta), expiry scheduler (disable expired, mark `expired`), `expiring` filter = expires within 7 days, notifications on expiring (7d) and expired.
- Policy simulate/validate endpoints use the evaluator in @storage-io/contracts.
- Tests: unit (policy mapping, key-meta scheduler), integration against MinIO (users, groups, policies attach, service accounts with expiry + session policy, secret works for S3 calls) and SeaweedFS (IAM users/keys/policies). Ceph/Garage: unit tests with recorded HTTP fixtures (nock/msw) verifying request signing and mapping.

Report: short; what you ran and results; any contract changes.

Note: an API instance may already be running on :3000 (admin/dev-password-123, apps/api/.env) with MinIO + SeaweedFS containers up; restart it after rebuilding when you need your changes live. Another backend agent (storage) works in parallel under src/modules/{buckets,objects,quotas,inventory}; keep app.module/registry edits small and additive. The dashboard needs `totals.users`/`totals.accessKeys`: expose a cheap cached count from your module (e.g. `IamStatsService.counts()`) for wave 2c.
