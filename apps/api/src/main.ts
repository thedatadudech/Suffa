/**
 * Entry point for both roles of the image: SUFFA_ROLE=api (default) or worker.
 * Exit codes: 1 = invalid configuration / fatal error, 3 = schema revision mismatch
 * (worker started before the api migrated; CapRover restarts it).
 */
import { PgAssignmentRepository } from './classes/assignments.js';
import {
  enqueueImport,
  enqueueTranscode,
  enqueueSuggest,
  enqueueSummarize,
  enqueueTranscribe,
  registerMedia,
} from './media/jobs.js';
import { PgInteractiveRepository, transcribeRecording } from './media/interactive.js';
import { OpenAiCompatibleTranscriber } from './media/transcribe.js';
import { HttpGoogleClient } from './drive/google.js';
import { DriveService, importFromDrive, PgDriveConnections } from './drive/service.js';
import { PgMediaRepository } from './media/repository.js';
import {
  PgSuggestionRepository,
  SUGGEST_TASK,
  suggestForRecording,
} from './media/suggestions.js';
import {
  PgSummaryRepository,
  SUMMARY_TASK,
  summarizeRecording,
} from './media/summary.js';
import { ffmpegTranscoder, MediaService } from './media/service.js';
import { S3ObjectStorage } from './storage/s3Storage.js';
import { registerNotifications } from './notifications/jobs.js';
import { FcmNotifier, RoutingNotifier } from './notifications/fcm.js';
import { disabledNotifier, WebPushNotifier } from './notifications/notifier.js';
import { PgRecapRepository } from './notifications/recap.js';
import { PgNotificationRepository } from './notifications/repository.js';
import { PgClassProgressRepository } from './classes/progress.js';
import { PgCertificateRepository } from './classes/certificates.js';
import { PgLiveQuizRepository } from './classes/quizRepository.js';
import { PgClassLeagueRepository } from './classes/league.js';
import { PgClassSpiritRepository } from './classes/spirit.js';
import { registerEngagement, requestRecompute } from './engagement/jobs.js';
import { PgEngagementRepository } from './engagement/repository.js';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { pino, type Logger } from 'pino';
import { createApp, type AuthRouteDeps } from './app.js';
import { ChainResolver, createAuth, SessionResolver } from './auth/betterAuth.js';
import { FileMailer, LogMailer, SmtpMailer } from './auth/mailer.js';
import { registerMaintenance } from './jobs/maintenance.js';
import { queueDepth, startBoss } from './jobs/queue.js';
import {
  createErrorReporter,
  disabledReporter,
  type ErrorReporter,
} from './observability/errors.js';
import { DenyAllResolver, DevTokenResolver, type AuthResolver } from './auth/resolver.js';
import { PgSyncRepository } from './sync/repository.js';
import { PgAdminRepository } from './admin/repository.js';
import { AiGateway } from './ai/gateway.js';
import { buildProviders } from './ai/providers.js';
import { PgAiRepository } from './ai/repository.js';
import { ModelRouter, type ProviderId } from '@suffa/llm';
import { ContentCatalog } from './tutor/content.js';
import { enqueueChannelImport, registerImports } from './videos/jobs.js';
import { PgVideoRepository } from './videos/repository.js';
import { YouTubeClient } from './videos/youtube.js';
import { PgLearnerState } from './tutor/learner.js';
import { ClassMediaAccess } from './tutor/media.js';
import { GradeService, PgGradeRepository } from './tutor/grading.js';
import { PgTutorRepository } from './tutor/repository.js';
import { PgReviewRepository } from './tutor/review.js';
import { PgTutorSettings } from './tutor/routes.js';
import { TUTOR_TASK, TutorService } from './tutor/service.js';

/** The course content the app bundles (copied into the image at the same relative place). */
const CONTENT_DIR = fileURLToPath(new URL('../../web/src/content', import.meta.url));
import { PgClassRepository } from './classes/repository.js';
import { PgPrivacyRepository } from './privacy/repository.js';
import { PgAccountRepository } from './account/repository.js';
import type { AccountRouteDeps } from './account/routes.js';
import { PgSecondFactorRepository, SecondFactorService } from './account/secondFactor.js';
import { writeAudit } from './audit/log.js';
import { SecretBox } from './security/secretBox.js';
import { ConfigError, loadConfig, redactDatabaseUrl, type Config } from './config.js';
import {
  currentRevision,
  expectedRevision,
  loadMigrations,
  migrate,
  SchemaMismatchError,
} from './migrate.js';
import { runWorker } from './worker.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
/** Running jobs get this long to finish on shutdown; Docker/CapRover sends SIGKILL after 10 s. */
const JOB_DRAIN_TIMEOUT_MS = 8_000;

/** Module-level so the crash handler below can still report after main() failed. */
let errors: ErrorReporter = disabledReporter;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Logger is not configured yet; one structured line on stderr is enough.
      console.error(
        JSON.stringify({ level: 'fatal', msg: 'config.invalid', issues: error.issues })
      );
      process.exit(1);
    }
    throw error;
  }

  const log = pino({
    level: config.logLevel,
    base: { service: 'suffa', role: config.role },
  });
  // Incomplete optional features are off; say so loudly so the setting gets fixed.
  for (const warning of config.warnings) log.error({ warning }, 'config.feature_off');
  // Where recordings go for transcripts, visible in the log (host only, never the token).
  if (config.transcribe) {
    log.info(
      {
        host: new URL(config.transcribe.url).host,
        model: config.transcribe.model,
        language: config.transcribe.language ?? 'auto',
      },
      'transcribe.enabled'
    );
  } else {
    log.info('transcribe.disabled: SUFFA_TRANSCRIBE_URL is not set');
  }
  errors = createErrorReporter({
    dsn: config.errorDsn,
    release: config.version,
    environment: config.env,
    role: config.role,
  });
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
  });
  pool.on('error', (error) => log.error({ err: error }, 'db.pool_error'));
  log.info(
    {
      version: config.version,
      db: redactDatabaseUrl(config.databaseUrl),
      errorTracking: errors.enabled,
    },
    'service.starting'
  );

  const migrations = await loadMigrations(MIGRATIONS_DIR);
  const expected = expectedRevision(migrations);
  const shutdown = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    log.info({ signal }, 'service.stopping');
    shutdown.abort();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  if (config.role === 'worker') {
    try {
      await runWorker({
        pool,
        startJobs: async () => {
          const boss = await startBoss({
            databaseUrl: config.databaseUrl,
            role: 'worker',
            log,
            onError: (error) => errors.capture(error, { source: 'pg-boss' }),
          });
          await registerMaintenance(boss, pool, log, errors);
          if (config.youtubeApiKey) {
            await registerImports(
              boss,
              {
                videos: new PgVideoRepository(pool),
                youtube: new YouTubeClient(config.youtubeApiKey),
                log,
              },
              errors
            );
          }
          const tutorRouter = new ModelRouter({
            providers: buildProviders(config),
            source: new PgAiRepository(pool),
          });
          await registerEngagement(
            boss,
            new PgEngagementRepository(pool),
            log,
            errors,
            async () => ({
              videos: await new PgVideoRepository(pool).hasVisibleVideos(),
              tutor:
                (await tutorRouter.plan(TUTOR_TASK, { requires: ['streaming', 'tools'] }))
                  .length > 0,
            })
          );
          if (config.storage) {
            const repo = new PgMediaRepository(pool);
            const storage = new S3ObjectStorage(config.storage);
            const drive = driveParts(config);
            await registerMedia(
              boss,
              {
                repo,
                storage,
                transcoder: ffmpegTranscoder,
                log,
                importFromDrive: drive
                  ? (mediaId) =>
                      importFromDrive(
                        {
                          media: repo,
                          storage,
                          transcoder: ffmpegTranscoder,
                          google: drive.google,
                          connections: new PgDriveConnections(pool),
                          box: drive.box,
                          log,
                        },
                        mediaId
                      )
                  : undefined,
                transcribe: config.transcribe
                  ? (mediaId) =>
                      transcribeRecording(
                        {
                          media: repo,
                          interactive: new PgInteractiveRepository(pool),
                          storage,
                          transcriber: new OpenAiCompatibleTranscriber(
                            config.transcribe!
                          ),
                          log,
                        },
                        mediaId
                      )
                  : // The api queued it (it has the settings), this worker has not: say so
                    // instead of leaving the transcript "queued" for ever.
                    async (mediaId) => {
                      log.warn({ mediaId }, 'transcribe.not_configured_on_worker');
                      await new PgInteractiveRepository(pool).saveTranscript(mediaId, {
                        status: 'failed',
                        error:
                          'Die Transkription ist auf dem Server nicht vollständig eingerichtet (Worker ohne SUFFA_TRANSCRIBE_URL).',
                      });
                    },
                onReady: config.transcribe
                  ? async (mediaId) => {
                      const item = await repo.byId(mediaId);
                      const interactive = new PgInteractiveRepository(pool);
                      if (item && (await interactive.aiEnabled(item.classId))) {
                        await interactive.saveTranscript(mediaId, {
                          status: 'queued',
                          source: 'whisper',
                        });
                        await enqueueTranscribe(boss)(mediaId);
                      }
                    }
                  : undefined,
                summarize: async (mediaId) =>
                  summarizeRecording(
                    {
                      gateway: new AiGateway({
                        router: tutorRouter,
                        repo: new PgAiRepository(pool),
                        log,
                      }),
                      summaries: new PgSummaryRepository(pool),
                      media: repo,
                      interactive: new PgInteractiveRepository(pool),
                      log,
                    },
                    mediaId
                  ),
                suggest: async (mediaId) =>
                  suggestForRecording(
                    {
                      gateway: new AiGateway({
                        router: tutorRouter,
                        repo: new PgAiRepository(pool),
                        log,
                      }),
                      suggestions: new PgSuggestionRepository(pool),
                      media: repo,
                      interactive: new PgInteractiveRepository(pool),
                      catalog: await ContentCatalog.load(CONTENT_DIR).catch(() => null),
                      log,
                    },
                    mediaId
                  ),
              },
              errors
            );
          }
          await registerNotifications(
            boss,
            {
              notifications: new PgNotificationRepository(pool),
              recaps: new PgRecapRepository(pool),
              // Web push for browsers, FCM for the native apps (ADR-0019).
              notifier: new RoutingNotifier(
                config.vapid ? new WebPushNotifier(config.vapid) : disabledNotifier,
                config.fcm ? new FcmNotifier(config.fcm) : disabledNotifier
              ),
              log,
            },
            errors
          );
          return () => boss.stop({ graceful: true, timeout: JOB_DRAIN_TIMEOUT_MS });
        },
        expectedRevision: expected,
        version: config.version,
        heartbeatMs: config.workerHeartbeatMs,
        log,
        signal: shutdown.signal,
      });
    } catch (error) {
      if (error instanceof SchemaMismatchError) {
        log.warn(
          { expected: error.expected, actual: error.actual },
          'db.schema_mismatch'
        );
        await pool.end();
        // Expected during a deploy (worker before api); not reported as an error.
        process.exit(3);
      }
      throw error;
    }
    await pool.end();
    return;
  }

  await migrate(pool, migrations, log);
  // The api only installs the queue schema and sends jobs; the worker processes them.
  const boss = await startBoss({
    databaseUrl: config.databaseUrl,
    role: 'api',
    log,
    onError: (error) => errors.capture(error, { source: 'pg-boss' }),
  });

  // Sign-in (magic link) needs a secret and the public URL; prod config enforces both.
  const resolvers: AuthResolver[] = [];
  let authRoutes: AuthRouteDeps | undefined;
  let accountRoutes: AccountRouteDeps | undefined;
  // In prod the link is never written to the log: without SMTP there is no sign-in.
  const canMail = Boolean(config.smtp) || config.env !== 'prod';
  if (config.authSecret && config.publicUrl && canMail) {
    const betterAuth = createAuth({
      pool,
      secret: config.authSecret,
      publicUrl: config.publicUrl,
      trustedOrigins: [...config.trustedOrigins, ...config.appOrigins],
      mailer: config.smtp
        ? new SmtpMailer(config.smtp, log)
        : config.mailDir
          ? new FileMailer(config.mailDir)
          : new LogMailer(log),
      production: config.env === 'prod',
    });
    const sessions = new SessionResolver(betterAuth);
    resolvers.push(sessions);
    accountRoutes = {
      repo: new PgAccountRepository(pool),
      privacy: new PgPrivacyRepository(pool),
      sessions: { actor: (h) => sessions.sessionActor(h) },
      secondFactor: new SecondFactorService(
        new PgSecondFactorRepository(pool),
        new SecretBox(config.authSecret, 'totp')
      ),
      audit: ({ actorId, action, ip }) =>
        writeAudit(pool, {
          actorId,
          action,
          targetType: 'user',
          targetId: actorId,
          ipAddress: ip,
        }),
      log,
    };
    authRoutes = {
      handler: (request) => betterAuth.handler(request),
      me: (h) => sessions.me(h),
    };
    // The origin is what browsers must send; a mismatch answers 403 INVALID_ORIGIN.
    log.info(
      { mail: config.smtp ? 'smtp' : 'log', origins: config.trustedOrigins },
      'auth.enabled'
    );
  } else if (!canMail) {
    log.error(
      'auth.disabled: SMTP is not configured (SUFFA_SMTP_HOST and SUFFA_MAIL_FROM)'
    );
  } else {
    log.warn('auth.disabled (set SUFFA_AUTH_SECRET and SUFFA_PUBLIC_URL)');
  }
  if (config.syncDevTokens.size > 0) {
    const userIds = [...new Set(config.syncDevTokens.values())];
    await pool.query(
      'insert into users (id) select unnest($1::uuid[]) on conflict (id) do nothing',
      [userIds]
    );
    resolvers.push(new DevTokenResolver(config.syncDevTokens));
    log.warn({ users: userIds.length }, 'sync.dev_tokens_enabled');
  }
  const auth: AuthResolver =
    resolvers.length > 0 ? new ChainResolver(resolvers) : new DenyAllResolver();

  const ai = aiParts(config, pool, log, auth);
  const suggestAvailable = async () =>
    (await ai.router.plan(SUGGEST_TASK, { requires: ['structuredOutput'] })).length > 0;
  const summaryAvailable = async () =>
    (await ai.router.plan(SUMMARY_TASK, { requires: ['structuredOutput'] })).length > 0;
  const app = createApp({
    version: config.version,
    expectedRevision: expected,
    health: {
      schemaRevision: () => currentRevision(pool),
      queueDepth: () => queueDepth(pool),
    },
    onProbeError: (error) => log.warn({ err: error }, 'health.db_unreachable'),
    sync: {
      repo: new PgSyncRepository(pool),
      auth,
      log,
      onPushed: requestRecompute(boss),
    },
    engagement: { repo: new PgEngagementRepository(pool), auth, log },
    media: config.storage
      ? {
          classes: new PgClassRepository(pool),
          repo: new PgMediaRepository(pool),
          media: new MediaService(
            new PgMediaRepository(pool),
            new S3ObjectStorage(config.storage),
            enqueueTranscode(boss)
          ),
          audit: pool,
          auth,
          log,
        }
      : undefined,
    assignments: {
      classes: new PgClassRepository(pool),
      repo: new PgAssignmentRepository(pool),
      auth,
      log,
    },
    interactive: config.storage
      ? {
          classes: new PgClassRepository(pool),
          media: new PgMediaRepository(pool),
          interactive: new PgInteractiveRepository(pool),
          transcribe: config.transcribe ? enqueueTranscribe(boss) : undefined,
          chapters: new PgSuggestionRepository(pool),
          canSuggest: suggestAvailable,
          summaries: new PgSummaryRepository(pool),
          canSummarize: summaryAvailable,
          auth,
          log,
        }
      : undefined,
    summaries: config.storage
      ? {
          classes: new PgClassRepository(pool),
          media: new PgMediaRepository(pool),
          interactive: new PgInteractiveRepository(pool),
          summaries: new PgSummaryRepository(pool),
          enqueue: enqueueSummarize(boss),
          available: summaryAvailable,
          auth,
          log,
        }
      : undefined,
    suggestions: config.storage
      ? {
          classes: new PgClassRepository(pool),
          media: new PgMediaRepository(pool),
          interactive: new PgInteractiveRepository(pool),
          suggestions: new PgSuggestionRepository(pool),
          enqueue: enqueueSuggest(boss),
          available: suggestAvailable,
          auth,
          log,
        }
      : undefined,
    drive: (() => {
      const drive = driveParts(config);
      if (!drive || !config.google) return undefined;
      return {
        drive: new DriveService(
          drive.google,
          new PgDriveConnections(pool),
          drive.box,
          new PgMediaRepository(pool),
          enqueueImport(boss)
        ),
        google: drive.google,
        classes: new PgClassRepository(pool),
        picker: { apiKey: config.google.apiKey, appId: config.google.appId },
        stateSecret: config.authSecret!,
        auth,
        log,
      };
    })(),
    notifications: {
      repo: new PgNotificationRepository(pool),
      recaps: new PgRecapRepository(pool),
      publicKey: config.vapid?.publicKey ?? null,
      appPush: Boolean(config.fcm),
      auth,
      log,
    },
    ...(await classContentDeps(pool, auth, log)),
    classSpirit: {
      classes: new PgClassRepository(pool),
      progress: new PgClassProgressRepository(pool),
      spirit: new PgClassSpiritRepository(pool),
      league: new PgClassLeagueRepository(pool),
      auth,
      log,
    },
    admin: { repo: new PgAdminRepository(pool), auth, log },
    aiAdmin: ai,
    videos: {
      videos: new PgVideoRepository(pool),
      enqueueImport: config.youtubeApiKey ? enqueueChannelImport(boss) : undefined,
      auth,
      log,
    },
    tutor: await tutorParts(ai, pool, log, auth, config),
    reviews: {
      classes: new PgClassRepository(pool),
      reviews: new PgReviewRepository(pool),
      auth,
      log,
    },
    classes: config.publicUrl
      ? {
          repo: new PgClassRepository(pool),
          auth,
          log,
          publicUrl: new URL(config.publicUrl).origin,
        }
      : undefined,
    authzLog: log,
    auth: authRoutes,
    account: accountRoutes,
    allowedOrigin: config.trustedOrigins,
    appOrigins: config.appOrigins,
    appLinks: config.appLinks,
    errorTunnel: { webDsn: config.webErrorDsn, log },
    onUnhandledError: (error, path) => {
      log.error({ err: error, path }, 'http.unhandled_error');
      errors.capture(error, { path });
    },
  });
  const server = serve(
    { fetch: app.fetch, port: config.port, hostname: '0.0.0.0' },
    (info) => log.info({ port: info.port }, 'http.listening')
  );
  shutdown.signal.addEventListener('abort', () => {
    server.close(() => {
      void boss
        .stop({ graceful: false })
        .then(() => pool.end())
        .then(() => log.info('service.stopped'));
    });
  });
}

main().catch(async (error: unknown) => {
  console.error(
    JSON.stringify({ level: 'fatal', msg: 'service.crashed', err: String(error) })
  );
  errors.capture(error, { fatal: true });
  await errors.flush();
  process.exit(1);
});

/**
 * Google Drive import needs Google credentials, object storage, the auth secret (seals the
 * refresh tokens) and the public URL (OAuth redirect).
 */
function driveParts(config: Config) {
  if (!config.google || !config.storage || !config.authSecret || !config.publicUrl) {
    return undefined;
  }
  return {
    google: new HttpGoogleClient({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      redirectUri: `${new URL(config.publicUrl).origin}/api/v1/drive/callback`,
    }),
    box: new SecretBox(config.authSecret, 'drive'),
  };
}

/**
 * AI gateway (ADR-0010): providers from their keys, routes from Postgres. Without any key the
 * admin page still shows routes and spend, and every call answers "unavailable".
 */
async function tutorParts(
  ai: ReturnType<typeof aiParts>,
  pool: pg.Pool,
  log: Pick<Logger, 'info' | 'warn'>,
  auth: AuthResolver,
  config: Config
) {
  let catalog: ContentCatalog;
  try {
    catalog = await ContentCatalog.load(CONTENT_DIR);
  } catch (error) {
    // Without the course content the tutor could not stay grounded: leave it off.
    log.warn({ err: error, dir: CONTENT_DIR }, 'tutor.content_missing');
    return undefined;
  }
  const repo = new PgTutorRepository(pool);
  const learner = new PgLearnerState(pool, catalog);
  const grades = new PgGradeRepository(pool);
  return {
    grading: {
      service: new GradeService({ gateway: ai.gateway, repo: grades, catalog, learner }),
      repo: grades,
    },
    service: new TutorService({
      gateway: ai.gateway,
      repo,
      catalog,
      learner,
      media: config.storage
        ? new ClassMediaAccess(
            new PgMediaRepository(pool),
            new PgClassRepository(pool),
            new PgInteractiveRepository(pool)
          )
        : null,
      log,
    }),
    repo,
    settings: new PgTutorSettings(pool),
    available: async () =>
      (await ai.router.plan(TUTOR_TASK, { requires: ['streaming', 'tools'] })).length > 0,
    auth,
    log,
  };
}

function aiParts(
  config: Config,
  pool: pg.Pool,
  log: Pick<Logger, 'info' | 'warn'>,
  auth: AuthResolver
) {
  const providers = buildProviders(config);
  const repo = new PgAiRepository(pool);
  const router = new ModelRouter({ providers, source: repo });
  return {
    repo,
    router,
    gateway: new AiGateway({ router, repo, log }),
    configured: Object.keys(providers) as ProviderId[],
    auth,
    log,
  };
}

/**
 * Certificates and the live quiz need the course words; without the content both stay off.
 */
async function classContentDeps(
  pool: pg.Pool,
  auth: AuthResolver,
  log: Pick<Logger, 'info' | 'warn'>
) {
  let catalog: ContentCatalog;
  try {
    catalog = await ContentCatalog.load(CONTENT_DIR);
  } catch (error) {
    log.warn({ err: error, dir: CONTENT_DIR }, 'class_content.missing');
    return {};
  }
  const classes = new PgClassRepository(pool);
  const units = catalog.units.map((u) => ({
    unit: u.einheit,
    title: u.titel,
    wordIds: u.vokabeln.map((w) => w.id),
  }));
  const words = catalog.units.flatMap((u) =>
    u.vokabeln.map((w) => ({ id: w.id, ar: w.ar, de: w.de, unit: u.einheit }))
  );
  return {
    certificates: {
      classes,
      certificates: new PgCertificateRepository(pool, units),
      auth,
      log,
    },
    quiz: { classes, quiz: new PgLiveQuizRepository(pool, words), auth, log },
  };
}
