# Security policy

## Supported versions

storage-io is pre-1.0. Fixes land on `main` and go out in the next tagged
release; only the latest release is supported. If you are running an older
image, upgrading is the fix.

## Reporting a vulnerability

**Report privately, not in an issue.** Use GitHub's private vulnerability
reporting:

**[Open a security advisory →](https://github.com/navid-kianfar/storage-io/security/advisories/new)**

That form is private to the maintainers until an advisory is published. A public
issue for a vulnerability tells everyone running storage-io about it before
there is anything to upgrade to.

Please include:

- what an attacker can do, and what they need to start (network position,
  credentials, an existing session);
- the affected version or commit, and the storage provider if it matters;
- a reproduction — a request, a sequence of UI steps, or a small script;
- **no live credentials.** Redact access keys, `APP_SECRET`, admin passwords and
  session cookies. If a credential of yours was exposed by the bug, rotate it
  before you report, and say that you did rather than sending it.

You should get an acknowledgement within a few days. There is no bounty.

Please give a fix a reasonable window before disclosing publicly — roughly 90
days, less if the bug is already being exploited. Credit in the advisory is
yours unless you ask otherwise.

## What is in scope

The API, the web console, the provider and IAM drivers, the Docker image and the
release workflow. In particular:

- authentication, session handling and the API-token path;
- anything that lets one request act as the admin without the admin's
  credentials (CSRF, session fixation, the `Origin` check);
- a stored storage-server secret, `APP_SECRET`-derived key material or a
  settings secret becoming readable through the API, a log, an export or an
  error;
- stored or reflected XSS in the console — including through object bytes,
  object keys, bucket names or anything else a storage server can be made to
  return;
- path traversal through an object key, including in the ZIP download;
- SSRF through a server endpoint, an import-from-URL or a notification webhook;
- privilege escalation via a bucket policy, an access-key session policy or the
  policy editor.

## What is not a vulnerability

- **The admin can do admin things.** There is one account and it is the
  operator; being able to read every bucket or create any key is the product.
- **Development credentials.** `docker/docker-compose.dev.yml` and the demo seed
  script contain fixed local credentials on purpose. They are documented as
  development values and must never reach a deployed environment.
- **Running without TLS.** storage-io is meant to sit behind a reverse proxy
  that terminates TLS; `COOKIE_SECURE=false` is the default because the
  container speaks plain HTTP to that proxy.
- **Locking yourself out with `security.allowedNetworks`.** The API does not
  refuse a list that excludes you — an operator may be configuring for another
  network deliberately. `/health` stays reachable.
- **A finding that assumes `APP_SECRET` or the SQLite file is already in the
  attacker's hands.** Anyone holding those holds the installation.
- Missing hardening headers on a route that returns no content, version
  disclosure at `/health`, and automated-scanner output with no demonstrated
  impact.

## If you find a secret committed to this repository

Report it as a vulnerability, privately, and **do not** open a PR that deletes
it. A committed secret is in the git history whether or not the file still
contains it; the fix is to rotate the credential, and a PR that quietly removes
the line announces it instead.
