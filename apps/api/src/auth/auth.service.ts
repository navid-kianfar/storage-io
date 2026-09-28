import { Injectable, Logger } from '@nestjs/common';
import type { Me, UpdateMeRequest } from '@storage-io/contracts';
import { AppConfigService } from '../config/app-config.service';
import { CryptoService, constantTimeEquals } from '../crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthInvalidError } from '../common/errors/domain.exception';
import { SessionService, type CreatedSession } from './session.service';

export interface LoginContext {
  readonly username: string;
  readonly password: string;
  readonly remember: boolean;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

/**
 * The single administrator, from the environment. There is no sign-up, no
 * password change and no second factor — all three are decisions recorded in
 * docs/ARCHITECTURE.md, not omissions.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly crypto: CryptoService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Both the username and the password are compared in constant time, and both
   * are compared even when the username is already wrong — an early return on
   * the username turns the endpoint into a username oracle.
   */
  async login(context: LoginContext): Promise<{ user: Me; session: CreatedSession }> {
    const usernameMatches = constantTimeEquals(this.config.adminUsername, context.username);
    const passwordMatches = await this.crypto.verifyAdminPassword(context.password);

    if (!usernameMatches || !passwordMatches) {
      this.logger.warn({ ip: context.ip }, 'Failed login attempt');
      throw new AuthInvalidError();
    }

    const isNewDevice = this.sessions.isNewDevice(context.userAgent, context.ip);
    const session = this.sessions.create({
      remember: context.remember,
      userAgent: context.userAgent,
      ip: context.ip,
    });

    if (isNewDevice) {
      this.notifications.raise({
        level: 'info',
        title: 'Sign-in from a new device',
        detail: `A session was started from ${context.ip ?? 'an unknown address'}.`,
        href: '/settings/security',
        ruleKey: 'auth.new-device',
      });
    }

    return { user: this.me(), session };
  }

  /** The username is env-owned; the display name and email live in settings. */
  me(): Me {
    const profile = this.settings.getInternal().profile;
    return {
      username: this.config.adminUsername,
      displayName: profile.displayName,
      email: profile.email,
    };
  }

  updateMe(patch: UpdateMeRequest): Me {
    this.settings.updateProfile(patch);
    return this.me();
  }
}
