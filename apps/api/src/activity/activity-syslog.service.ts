import { Injectable, Logger } from '@nestjs/common';
import type { ActivityEvent } from '@storage-io/contracts';
import { SettingsService } from '../settings/settings.service';
import { sendSyslog, type SyslogSeverity } from '../notifications/delivery/syslog';

/**
 * Forwards the activity log to a syslog collector when
 * `Settings.activity.syslog.enabled` is on.
 *
 * It sits behind `ActivityService.record`, which means every audit line goes
 * through it — the interceptor's and the system's alike — and there is no call
 * site that can forget to forward.
 *
 * **It is fire-and-observe, not fire-and-forget.** The send is not awaited,
 * because an audit line must not add a network round trip to the request that
 * produced it, but the promise's rejection is handled and a failure is counted and
 * logged. A collector that is down produces one log line per failure at debug and
 * a warning the first time, rather than a growing pile of unhandled rejections.
 *
 * What is forwarded is the sanitized event — `sanitizeDetails` has already run, so
 * a credential cannot reach the collector through `details`.
 */

/** After this many consecutive failures the warning is only logged once. */
const WARN_AFTER_FAILURES = 1;

@Injectable()
export class ActivitySyslogService {
  private readonly log = new Logger(ActivitySyslogService.name);
  private consecutiveFailures = 0;

  constructor(private readonly settings: SettingsService) {}

  /**
   * Called from `ActivityService.record`. Returns immediately; it is safe to call
   * for every event, enabled or not.
   */
  forward(event: ActivityEvent): void {
    const syslog = this.settings.getInternal().activity.syslog;
    if (!syslog.enabled || syslog.host.length === 0) return;

    const payload = {
      id: event.id,
      at: event.at,
      category: event.category,
      action: event.action,
      title: event.title,
      actorType: event.actor.type,
      actorName: event.actor.name,
      target: event.target,
      serverName: event.serverName,
      ip: event.ip,
      result: event.result,
      requestId: event.requestId,
      details: event.details,
    };

    void sendSyslog(syslog, {
      severity: severityFor(event.result),
      msgId: event.action,
      payload,
    }).then(
      (result) => {
        if (result.ok) {
          this.consecutiveFailures = 0;
          return;
        }
        this.noteFailure(result.detail);
      },
      (error: unknown) => {
        // `sendSyslog` already swallows transport errors, so reaching here is a bug
        // in it rather than a collector problem — which is why it is not debug.
        this.log.error(
          { err: error instanceof Error ? error.message : String(error) },
          'The syslog forwarder threw',
        );
      },
    );
  }

  /** Consecutive failures since the last success — read by the e2e test. */
  get failureCount(): number {
    return this.consecutiveFailures;
  }

  private noteFailure(detail: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === WARN_AFTER_FAILURES) {
      this.log.warn({ detail }, 'Activity syslog forwarding is failing');
      return;
    }
    this.log.debug({ detail, failures: this.consecutiveFailures }, 'Activity syslog send failed');
  }
}

/* ------------------------------ helpers --------------------------- */

const severityFor = (result: ActivityEvent['result']): SyslogSeverity => {
  switch (result) {
    case 'failure':
      return 'error';
    case 'warning':
      return 'warning';
    case 'success':
      return 'info';
  }
};
