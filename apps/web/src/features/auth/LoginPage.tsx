import { PROVIDER_LABELS, PROVIDERS, loginRequestSchema } from '@storage-io/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  CloudUploadIcon,
  EyeIcon,
  EyeOffIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { CopyField } from '@/components/app/CopyField';
import { FormField } from '@/components/app/FormField';
import { Meter } from '@/components/app/Meter';
import { StatusDot } from '@/components/app/StatusBadge';
import { Logo } from '@/components/shell/Logo';
import { LanguageMenu, ThemeMenu } from '@/components/shell/ThemeMenu';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { useLogin } from '@/features/auth/api';
import { isApiError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

/**
 * /login — the concept's login.html: brand art panel on the inline-start, the form
 * on the inline-end, and the art panel hidden below 900px.
 *
 * There is no second step. Two-factor authentication was dropped by decision
 * (docs/ARCHITECTURE.md), so the concept's OTP panel is deliberately absent.
 * "Forgot password?" explains that the credentials come from the environment,
 * because there is nothing in the UI that could change them.
 */

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.1.0';

/**
 * `remember` has a default in the contract, so the schema's input and output types
 * differ: the form fields are the input, the submitted payload is the output.
 * react-hook-form's third generic is exactly that distinction.
 */
type LoginInput = z.input<typeof loginRequestSchema>;
type LoginOutput = z.output<typeof loginRequestSchema>;

/** The three fake servers in the art panel are decoration, as in the concept. */
const ART_SERVERS = [
  { name: 'minio-prod-01', tone: 'ok', latency: '12 ms', fill: 0.72 },
  { name: 'seaweed-archive', tone: 'ok', latency: '8 ms', fill: 0.61 },
  { name: 'ceph-lab', tone: 'warn', latency: '184 ms', fill: 0.18 },
] as const;

export function LoginPage() {
  const { t } = useTranslation('auth');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  // `strict: false` widens the search type across every route, so the one param
  // this page cares about is narrowed by hand.
  const search = useSearch({ strict: false });
  const redirectTo = typeof search.redirect === 'string' ? search.redirect : '/';
  const login = useLogin();
  const [revealed, setRevealed] = useState(false);

  const form = useForm<LoginInput, unknown, LoginOutput>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { username: '', password: '', remember: true },
  });

  const onSubmit = form.handleSubmit((values) => {
    login.mutate(values, {
      onSuccess: () => {
        void navigate({ to: redirectTo, replace: true });
      },
    });
  });

  const errorMessage = (() => {
    if (!login.isError) return null;
    const error = login.error;
    if (!isApiError(error)) return tCommon('error.unexpected');
    if (error.isNetworkError) return tCommon('error.network');
    if (error.is('AUTH_INVALID')) return t('signIn.invalid');
    if (error.is('RATE_LIMITED')) return t('signIn.rateLimited');
    return error.detail ?? tCommon('error.unexpected');
  })();

  return (
    <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <BrandPanel />

      <section className="flex flex-col px-6 py-5">
        <div className="flex items-center justify-end gap-1">
          <LanguageMenu />
          <ThemeMenu />
        </div>

        <div className="m-auto flex w-full max-w-92 flex-col gap-5 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">{t('signIn.title')}</h1>
            <p className="text-muted-foreground">{t('signIn.subtitle')}</p>
          </div>

          <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
            <FormField
              label={t('signIn.username')}
              error={
                form.formState.errors.username === undefined
                  ? undefined
                  : tCommon('form.required')
              }
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={invalid}
                  {...form.register('username')}
                />
              )}
            </FormField>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="password">{t('signIn.password')}</Label>
                <ForgotPasswordPopover />
              </div>
              <InputGroup>
                <InputGroupInput
                  id="password"
                  type={revealed ? 'text' : 'password'}
                  autoComplete="current-password"
                  aria-invalid={form.formState.errors.password !== undefined}
                  {...form.register('password')}
                />
                <InputGroupAddon align="inline-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={revealed ? tCommon('form.hideSecret') : tCommon('form.showSecret')}
                    onClick={() => setRevealed((value) => !value)}
                  >
                    {revealed ? <EyeOffIcon /> : <EyeIcon />}
                  </Button>
                </InputGroupAddon>
              </InputGroup>
              {form.formState.errors.password ? (
                <p className="text-[0.8125rem] text-destructive">{tCommon('form.required')}</p>
              ) : null}
            </div>

            {/*
              A shadcn Checkbox is not a native input, so it is bound through
              `Controller` rather than `register` — and `Controller` re-renders only
              this field, where `watch()` would re-render the whole form.
            */}
            <Controller
              control={form.control}
              name="remember"
              render={({ field }) => (
                <Label className="flex items-center gap-2 text-sm font-normal">
                  <Checkbox
                    ref={field.ref}
                    checked={field.value ?? false}
                    onCheckedChange={(checked) => field.onChange(checked === true)}
                    onBlur={field.onBlur}
                  />
                  {t('signIn.remember')}
                </Label>
              )}
            />

            {errorMessage === null ? null : (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" size="lg" className="w-full" disabled={login.isPending}>
              {login.isPending ? <Spinner /> : null}
              {login.isPending ? t('signIn.submitting') : t('signIn.submit')}
              {login.isPending ? null : <ArrowRightIcon className="flip-rtl" />}
            </Button>

            <Alert>
              <ShieldCheckIcon className="text-success" />
              <AlertDescription className="text-xs">{t('signIn.secured')}</AlertDescription>
            </Alert>
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          storage-io <span className="font-mono">v{APP_VERSION}</span> · {tCommon('app.selfHosted')}
        </p>
      </section>
    </main>
  );
}

function ForgotPasswordPopover() {
  const { t } = useTranslation('auth');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="link" size="sm">
          {t('signIn.forgot')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold">{t('forgot.title')}</p>
          <p className="text-xs text-muted-foreground">{t('forgot.body')}</p>
          <CopyField value="ADMIN_PASSWORD=…" label={t('forgot.title')} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The dark gradient panel. Hidden below the `lg` breakpoint, as the concept does. */
function BrandPanel() {
  const { t } = useTranslation('auth');
  const { t: tCommon } = useTranslation();

  return (
    <section
      className={cn(
        'relative isolate hidden flex-col justify-between gap-8 overflow-hidden p-10 lg:flex',
        'bg-[oklch(0.19_0.045_277)] text-[oklch(0.97_0.01_277)]',
      )}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(40rem_26rem_at_110%_-10%,oklch(0.55_0.22_277/0.55),transparent_60%),radial-gradient(30rem_24rem_at_-10%_110%,oklch(0.6_0.16_215/0.35),transparent_60%)]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-50 [background-image:linear-gradient(oklch(1_0_0/0.05)_1px,transparent_1px),linear-gradient(90deg,oklch(1_0_0/0.05)_1px,transparent_1px)] [background-size:32px_32px] [mask-image:radial-gradient(ellipse_at_60%_40%,#000_30%,transparent_75%)]"
      />

      <div className="flex items-center gap-2.5 text-base font-bold">
        <Logo className="size-8" tileFill="oklch(0.62 0.2 277)" strokeColor="#fff" />
        storage-io
      </div>

      <div>
        <h2 className="max-w-[16ch] text-[clamp(1.75rem,2.6vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.03em]">
          {tCommon('app.tagline')}
        </h2>
        <p className="mt-3 max-w-[42ch] text-[oklch(0.85_0.03_277)]">{t('art.body')}</p>
      </div>

      <div aria-hidden="true" className="relative h-60">
        <div className="absolute start-0 top-0 w-84 rounded-[0.875rem] border border-white/12 bg-white/6 p-4 text-xs shadow-[0_24px_48px_-16px_oklch(0_0_0/0.5)] backdrop-blur-md">
          {ART_SERVERS.map((server) => (
            <div key={server.name} className="mt-2.5 first:mt-0">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <StatusDot tone={server.tone} />
                  <b className="font-mono">{server.name}</b>
                </span>
                <span className="font-mono text-[oklch(0.8_0.03_277)]">{server.latency}</span>
              </div>
              <Meter
                value={server.fill}
                label={server.name}
                className="mt-1.5 bg-white/12 [&>span]:bg-[oklch(0.78_0.12_277)]"
              />
            </div>
          ))}
        </div>
        <div className="absolute start-36 top-30 w-68 rounded-[0.875rem] border border-white/12 bg-white/6 p-4 text-xs shadow-[0_24px_48px_-16px_oklch(0_0_0/0.5)] backdrop-blur-md">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <CloudUploadIcon className="size-4" />
              <b>Uploading 2 / 5</b>
            </span>
            <span className="font-mono text-[oklch(0.8_0.03_277)]">64%</span>
          </div>
          <Meter
            value={0.64}
            label="Uploading"
            className="mt-1.5 bg-white/12 [&>span]:bg-[oklch(0.78_0.12_277)]"
          />
          <div className="mt-1.5 flex justify-between font-mono text-[oklch(0.8_0.03_277)]">
            <span>raw-shot-0142.cr3</span>
            <span>48 MB</span>
          </div>
        </div>
      </div>

      <ul className="flex flex-wrap gap-1.5 text-xs text-[oklch(0.82_0.03_277)]">
        {PROVIDERS.filter((provider) => provider !== 'generic').map((provider) => (
          <li key={provider} className="rounded-full border border-white/14 px-2.5 py-1">
            {PROVIDER_LABELS[provider]}
          </li>
        ))}
      </ul>
    </section>
  );
}
