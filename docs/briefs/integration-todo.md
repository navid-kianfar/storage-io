# Integration pass — collected follow-ups (lead)

Web ↔ real API (switch every `features/*/api.ts` from MSW to the live API, then delete or dev-gate the mocks):
- [ ] `/browse` (no server/bucket) is a placeholder. Build the bucket picker (server + bucket comboboxes, recent buckets) so the `upload`/`import-url`/`new-folder`/`share-link` palette actions work from anywhere: pick a bucket, then open the dialog.
- [ ] Object browser: use the multipart endpoints for files larger than `transfers.partSizeMb`, with true pause/resume (resume from the uploaded parts), per-part retries = `settings.transfers.retries`, and bandwidth pacing between parts.
- [ ] Object browser: bulk tags, storage class, retention and legal hold on a selection call `POST …/objects/batch` directly (≤ 1000 keys). Larger sets still go to the New-job wizard.
- [ ] Archive preview lists the entries via `GET …/objects/archive-entries`.
- [ ] Transfers settings card shows `retries`.
- [ ] Bucket list: `POST /buckets/bulk` with the `delete` action.
- [ ] Server detail: Traffic chart from `metrics.traffic` (wave 2c), falling back to the capacity/latency card when it is `null`.
- [ ] Jobs wizard reads the `d_server/d_bucket/d_prefix/d_glob/d_type` prefill from the object browser.
- [ ] Quotas mocks keep their own bucket array. Irrelevant once the mocks are gone; make sure `/quotas` reflects quota edits made on `/buckets` against the real API.
- [ ] Sidebar counts come from `Dashboard.totals.users/accessKeys`.
- [ ] Server card "S3 users" uses `Server.counts.users`.

End-to-end verification (the real API on :3000 + the MinIO and SeaweedFS containers). Walk docs/FEATURE-CHECKLIST.md item by item in the browser: 1440 and 375 widths, light/dark, and RTL.

## Carried into final verification (not yet exercised live by integration pass 1)
- [ ] Add/edit/test a server from the UI; upload a folder; image preview; rename; move; share link opened without a cookie; download ZIP; import from URL; bulk bucket quota/tags/lifecycle/access actions.
- [ ] Rebuild and restart the API on :3000 before verifying (restore-version fallback for SeaweedFS landed after the running process started).
- Harness tips: in the built-in browser a Combobox option needs a `hover` before `left_click`; the pane can show a stale frame after click-only interactions, so re-screenshot before concluding.
