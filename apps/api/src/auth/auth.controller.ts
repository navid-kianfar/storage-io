import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import {
  SESSION_COOKIE_NAME,
  type ApiTokenList,
  type AuthSessionList,
  type CreateApiTokenResponse,
  type LoginResponse,
  type Me,
} from '@storage-io/contracts';
import { AppConfigService } from '../config/app-config.service';
import { CurrentActor, attachActor, clientIpOf, type Actor } from '../common/actor';
import { Public, SkipOriginCheck } from '../common/decorators/public.decorator';
import { NotFoundError } from '../common/errors/domain.exception';
import { LogActivity } from '../activity/activity.interceptor';
import { ApiTokenService } from './api-token.service';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { CreateApiTokenDto, LoginDto, RevokeSessionsQueryDto, UpdateMeDto } from './auth.dto';
import { LoginThrottled } from './login-throttler';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly tokens: ApiTokenService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Public and Origin-exempt: there is no session to forge yet. `@LoginThrottled`
   * is what attaches the login rate limit, so a brute-force attempt hits 429
   * rather than a thousand argon2id verifications.
   */
  @Post('login')
  @Public()
  @SkipOriginCheck()
  @LoginThrottled()
  @LogActivity({
    category: 'auth',
    action: 'auth.login',
    title: 'Signed in',
    failureTitle: 'Failed sign-in attempt',
  })
  @ApiOperation({ summary: 'Sign in and receive the session cookie' })
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const { user, session } = await this.auth.login({
      username: body.username,
      password: body.password,
      remember: body.remember,
      userAgent: userAgentOf(request),
      ip: clientIpOf(request),
    });

    // Login is @Public(), so the guard attached no actor. Without this the
    // activity interceptor falls back to the system actor and the audit trail
    // says "storage-io signed in" — attribute it to the admin who just did.
    attachActor(request, {
      type: 'admin',
      name: user.username,
      sessionId: session.id,
      tokenId: null,
    });

    response.cookie(SESSION_COOKIE_NAME, session.token, this.cookieOptions(session.maxAgeMs));
    return { user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({ category: 'auth', action: 'auth.logout', title: 'Signed out' })
  @ApiOperation({ summary: 'Revoke the current session and clear the cookie' })
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): void {
    const cookie = (request.cookies as Record<string, string | undefined> | undefined)?.[
      SESSION_COOKIE_NAME
    ];
    if (cookie !== undefined) this.sessions.revokeByToken(cookie);
    response.clearCookie(SESSION_COOKIE_NAME, this.cookieOptions(0));
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in administrator' })
  me(): Me {
    return this.auth.me();
  }

  @Patch('me')
  @LogActivity({ category: 'auth', action: 'auth.profile.update', title: 'Updated profile' })
  @ApiOperation({ summary: 'Update the display name and email' })
  updateMe(@Body() body: UpdateMeDto): Me {
    return this.auth.updateMe(body);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List active sessions' })
  listSessions(@CurrentActor() actor: Actor | undefined): AuthSessionList {
    return { items: [...this.sessions.list(actor?.sessionId ?? null)] };
  }

  /**
   * `DELETE /auth/sessions?others=true` revokes every session but this one. It
   * shares the route with the by-id form, which is why `:id` is optional here and
   * the query decides.
   */
  @Delete('sessions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({ category: 'auth', action: 'auth.sessions.revoke', title: 'Revoked sessions' })
  @ApiOperation({ summary: 'Revoke every other session (`?others=true`)' })
  revokeOtherSessions(
    @Query() query: RevokeSessionsQueryDto,
    @CurrentActor() actor: Actor | undefined,
  ): void {
    if (query.others !== true) {
      throw new NotFoundError('Pass ?others=true, or a session id in the path.');
    }
    const current = actor?.sessionId;
    if (current === null || current === undefined) {
      // An API token has no session of its own, so "others" means all of them.
      this.sessions.revokeAll();
      return;
    }
    this.sessions.revokeOthers(current);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({ category: 'auth', action: 'auth.session.revoke', title: 'Revoked a session' })
  @ApiOperation({ summary: 'Revoke one session' })
  revokeSession(@Param('id') id: string): void {
    const removed = this.sessions.revoke(id);
    if (!removed) throw new NotFoundError('No such session.');
  }

  @Get('tokens')
  @ApiOperation({ summary: 'List personal API tokens' })
  listTokens(): ApiTokenList {
    return { items: [...this.tokens.list()] };
  }

  @Post('tokens')
  @LogActivity({ category: 'auth', action: 'auth.token.create', title: 'Created an API token' })
  @ApiOperation({ summary: 'Create an API token; the secret is returned once' })
  createToken(@Body() body: CreateApiTokenDto): CreateApiTokenResponse {
    return this.tokens.create(body);
  }

  @Delete('tokens/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({ category: 'auth', action: 'auth.token.revoke', title: 'Revoked an API token' })
  @ApiOperation({ summary: 'Revoke an API token' })
  revokeToken(@Param('id') id: string): void {
    const removed = this.tokens.revoke(id);
    if (!removed) throw new NotFoundError('No such token.');
  }

  /**
   * `httpOnly` keeps it away from scripts, `SameSite=Strict` stops it travelling
   * cross-site, and `secure` follows `COOKIE_SECURE` so a plain-HTTP LAN install
   * still works while a TLS one is protected.
   */
  private cookieOptions(maxAgeMs: number): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.cookieSecure,
      path: '/',
      maxAge: maxAgeMs > 0 ? maxAgeMs : undefined,
    };
  }
}

function userAgentOf(request: Request): string | null {
  const value = request.headers['user-agent'];
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, 500);
}
