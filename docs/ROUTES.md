# Web routes (binding)

User rules:
1. **Route params are opaque IDs only.** Never a server name, bucket name, user name or policy name in the URL.
2. **Never pass data such as IDs through the query string.** Identity and context go in route params. Query-string search params are allowed only for view state that is not data identity: list filters, sort, page, active tab and time range.
3. Context that is neither an ID nor view state (e.g. the object browser's selection pre-filling the New-job wizard) travels in router **history state** (`navigate({ to, state })`), never in the URL.
4. Every page and dialog is fully usable at 375 px (no horizontal page scroll; tables scroll inside their container or switch to a card/list layout; dialogs become full-height sheets on mobile; toolbars wrap or collapse into menus).

The object key (and the browsed prefix) is the object's identity in S3 and has no other ID, so it travels as a splat route param. It is never a query param.

## IDs

| Entity | ID | Source |
|---|---|---|
| Server | `Server.id` (UUID) | servers table |
| Bucket | `Bucket.id` (UUID) | bucket_cache row, stable per (serverId, name) |
| S3 user / group / policy | `S3User.id`, `S3Group.id`, `PolicySummary.id` (UUID) | `iam_entities` table, stable per (serverId, kind, name) |
| Access key | `AccessKey.id` (UUID) | `iam_entities` (kind `key`) |
| Job, activity event, API token, session, notification | existing UUIDs | own tables |

Resolve endpoints (API): `GET /buckets/:bucketId`, `GET /iam/users/:userId`, `GET /iam/groups/:groupId`, `GET /iam/policies/:policyId` and `GET /iam/access-keys/:keyId`. Each returns the full entity (including `serverId` and `name`) or 404. The name-based per-server API endpoints stay as they are; the web resolves the ID first and then calls them.

## Route map

Dialogs that create or edit an entity are **routes** that render a dialog/sheet over their parent page. Closing one navigates back to the parent. Small in-page confirmations (delete, rename, tag) stay local component state with no URL.

```
/login
/welcome                                   first-run wizard (no shell)
/                                          overview
/servers                                   list
/servers/new                               add-server wizard (dialog over list)
/servers/$serverId                         detail (tab = search param ?tab=overview|buckets|users|connection|capabilities)
/servers/$serverId/rotate-credentials      dialog over detail
/buckets                                   list
/buckets/new                               create dialog over list
/buckets/$bucketId                         bucket settings (sections)
/buckets/$bucketId/quota                   edit-quota dialog
/buckets/$bucketId/browse/$                object browser; splat = prefix ("" = root)
/buckets/$bucketId/object/$                object browser with the inspector open on that key (splat = key)
/buckets/$bucketId/upload/$                upload dialog into prefix
/buckets/$bucketId/import/$                import-from-URL dialog into prefix
/browse                                    bucket picker (entry point for upload/import from the palette)
/quotas                                    list
/quotas/$bucketId                          edit-quota dialog over the list
/jobs                                      list (tab = search param)
/jobs/new                                  new-job wizard; prefill only via history state
/jobs/$jobId                               job detail/log sheet over the list
/jobs/$jobId/runs                          run history of a scheduled job
/transfers
/users                                     list (tab users|groups = search param)
/users/new                                 create-user dialog
/users/$userId                             user sheet
/users/groups/new
/users/groups/$groupId
/policies                                  list + empty editor state
/policies/new                              new-policy (templates) dialog
/policies/$policyId                        editor
/keys                                      list
/keys/new                                  create-key dialog → one-time secret step
/keys/$keyId/edit                          edit name and expiry
/keys/$keyId/rotate                        rotate dialog
/activity                                  list
/activity/$eventId                         event sheet over the list
/settings                                  redirects to /settings/account
/settings/$section                         account|security|appearance|region|transfers|notifications|forwarding|backup|about
```

Command-palette actions navigate to these routes (e.g. "Create bucket" → `/buckets/new`). The `?dialog=` convention is removed.
