# FraymIQ Railway staging setup

This checklist prepares a persistent Railway environment named exactly
`staging`. It does not deploy to, mutate, or reuse production.

## What the repository establishes

- The existing Dockerfile is reusable for every environment.
- `railway.toml` keeps the production start command and gives only the Railway
  environment named `staging` the guarded `npm run start:staging` command.
- The former `[[deploy.volumeMounts]]` block is not part of Railway's current
  config-as-code schema. It has been replaced with `requiredMountPath =
  "/data"`. Config-as-code still cannot create or attach the Volume; that
  remains a dashboard/CLI step. Before this branch is merged, confirm the
  existing production Volume is already mounted at `/data`, because the base
  deploy now refuses to start without it.
- A first boot on an empty Volume writes `/data/.fraymiq-environment` with
  `staging`. A non-empty unmarked Volume is rejected to reduce the chance of
  accidentally attaching production storage.
- `server.js` already exposes `GET /health`. The port opens only after
  `initSchema()`, every migration, and orphan recovery have completed.
- A clean Volume therefore creates a new `/data/db/frameiq.db`; production's DB
  must never be copied.

## Ordered dashboard and CLI checklist

Replace values in angle brackets. Run every CLI command from a clone of this
repository. Keep `-e staging` on every Railway command.

1. Decide the code revision to test.

   - For staging-infrastructure review, use `infra/staging-environment`.
   - For PR #1 verification before merge, use a branch containing both this
     staging preparation and PR #1.
   - After PR #1 merges, use `main`.
   - Record the exact commit SHA in the verification report:

     ```bash
     git rev-parse HEAD
     ```

2. In the existing Railway project, create a persistent environment named
   exactly `staging`. Do not create it under or rename `production`.

3. In the `staging` environment, create or select the backend service instance
   and connect `Yakubu-Moshood/frameiq-backend`. Set its source branch to the
   branch selected in step 1. Confirm the root directory is the repository root
   and the Dockerfile path is `Dockerfile`.

4. Create a new Volume while the dashboard is showing the `staging`
   environment. Name it clearly, for example `frameiq-staging-data`, attach it
   only to the staging backend service, and set the mount path to `/data`.

   Do not clone, restore, or attach the production Volume. Railway Volumes are
   environment-scoped; confirm the Volume card shows `staging` before
   continuing.

5. Open the staging service's Variables tab and use the RAW Editor to paste
   `staging/railway.env.example`. Replace every `CHANGE_ME` value. Use a new
   staging-only `JWT_SECRET`; do not reuse production's. For a no-paid-call
   bootstrap, keep:

   ```text
   STAGING_BOOTSTRAP=true
   TEST_MODE=true
   AUTO_APPROVE_ACTS=false
   ```

   Railway supplies `PORT`, `RAILWAY_ENVIRONMENT_NAME`,
   `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_NAME`,
   `RAILWAY_VOLUME_NAME`, and `RAILWAY_VOLUME_MOUNT_PATH`; do not create them
   manually.

6. Review Railway's staged changes. Verify all of the following before clicking
   Deploy:

   - Environment: `staging`
   - Source branch: the step-1 branch
   - Builder: Dockerfile
   - Start command resolved from config: `npm run start:staging`
   - Health path: `/health`
   - Volume: the new staging Volume at `/data`

7. Deploy the bootstrap revision. This is the first and only stage in which
   missing runtime files are temporarily allowed. In deployment logs, require:

   ```text
   [staging-preflight] Initialized empty staging volume marker
   [staging-preflight] BOOTSTRAP MODE
   FRAMEIQ BACKEND — RUNNING
   ```

   If preflight reports a non-empty unclassified Volume, stop. Detach it and
   create a new empty staging Volume; do not bypass the guard.

8. Install/login/link the Railway CLI if needed:

   ```bash
   railway login
   railway link
   railway status --environment staging
   ```

   Select the existing FraymIQ project, `staging` environment, and staging
   backend service. Confirm the output before any file operation.

9. Upload runtime-only files using Railway's service file browser:

   ```bash
   railway service files browse --environment staging --service <STAGING_SERVICE_NAME>
   ```

   Create/upload the paths listed in `staging/runtime-files.example.txt`.
   Upload copies into the staging Volume; never point staging at or mount the
   production Volume.

   At minimum, copy:

   - `pipeline.config.json`
   - `config-reader.cjs`
   - `surface-script-writer.cjs`
   - `surface-vo-generator.cjs`
   - `surface-image-generator.cjs`
   - `surface-animator.cjs`
   - `append-outro.cjs`
   - the complete provider tree selected by `pipeline.config.json`
   - `public/outro_EmpireOmitted.mp4`
   - `public/background_music.mp3`
   - every watermark/logo/music asset referenced by the config

   The repository's `pipeline-updates/*.cjs` files are copied automatically to
   `/data/pipeline` at the start of a pipeline job. Do not replace them with an
   older production-volume copy.

10. Review the staging copy of `pipeline.config.json` before enabling it.

    - It must have `channels.EmpireOmitted`.
    - All absolute paths must begin with `/data/`, never `C:/` or a production
      host path.
    - Provider tiers must match the keys you intend to fund in staging.
    - Output, episode, public, music, watermark, and asset paths must remain on
      the staging `/data` Volume.

11. In Railway Variables, set:

    ```text
    STAGING_BOOTSTRAP=false
    ```

    Keep `TEST_MODE=true` for a free infrastructure smoke test. Redeploy. The
    staging preflight must now log:

    ```text
    [staging-preflight] Runtime pipeline configuration and required Empire Omitted assets are present.
    [staging-preflight] PASS: staging is ready to start.
    ```

12. Confirm the clean database was created by this deployment:

    ```bash
    railway ssh --environment staging --service <STAGING_SERVICE_NAME> -- \
      sh -lc 'test -f /data/db/frameiq.db && test -f /data/.fraymiq-environment && grep -qx staging /data/.fraymiq-environment'
    ```

    Also confirm the deployment logs show successful startup after migrations.
    Do not upload `frameiq.db`, `frameiq.db-wal`, or `frameiq.db-shm`.

13. Generate a staging-only public domain from the service's Settings >
    Networking page. Set `BACKEND_URL` to `https://<STAGING_DOMAIN>` if the
    Railway reference in the example did not resolve. Point only a staging
    frontend/operator client at this domain.

14. Verify health:

    ```bash
    curl --fail --show-error https://<STAGING_DOMAIN>/health
    ```

    Expected JSON includes `"ok":true` and the Railway environment identifier.
    A Railway health check proves successful boot; it is not continuous
    application monitoring after deployment.

15. Verify operator-visible logs:

    ```bash
    railway logs --environment staging --service <STAGING_SERVICE_NAME> --latest --lines 500
    ```

    Application `console.log`/`console.error`, including PR #1's duration-cap,
    missing-asset, and missing-outro errors, appears in:

    - the staging service Deployment panel's logs;
    - Railway Observability > Log Explorer; and
    - the CLI command above.

    Configure a project webhook under Project Settings > Webhooks for
    deployment-status and platform-alert notifications. Railway does not turn
    arbitrary application error text into an alert by itself; if paging on
    render failures is required, connect an external log/observability sink or
    add an application-level notification in a separate change.

16. Run the no-paid-call smoke test with `TEST_MODE=true`. Confirm episode files
    are written under `/data/episodes` in staging and production contains no new
    episode/job.

17. Only when approved to spend on a real test, set `TEST_MODE=false`, fill all
    real provider secrets, review `AUTO_APPROVE_ACTS`, and redeploy. A
    production-like Empire Omitted episode uses paid calls:

    - Anthropic for script/shot work;
    - ElevenLabs (or the configured voice fallback);
    - OpenAI for image generation and/or transcription;
    - fal.ai/Kling for any `CLIP` shots;
    - Replicate only when a configured fallback selects it.

18. After verification, set `TEST_MODE=true` or scale/stop the staging service
    according to the team's cost policy. Preserve the isolated Volume if
    repeatability is desired; deleting the environment/Volume destroys its
    SQLite DB and rendered outputs.

## Complete runtime environment-variable inventory

Variables directly read by versioned runtime code:

- `JWT_SECRET` — required; use a staging-only secret.
- `FRONTEND_URL` — required; CORS/client origin.
- `BACKEND_URL` — optional but recommended; absolute preview/download URLs.
- `ANTHROPIC_API_KEY` — real script and shot generation.
- `OPENAI_API_KEY` — image generation, transcription, and some fallbacks.
- `FAL_KEY` — fal.ai image/video generation, including Kling.
- `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` — primary voice path.
- `REPLICATE_API_TOKEN` — only for configured SDXL/SVD/Coqui fallbacks.
- `TEST_MODE` — existing no-paid-provider stub workflow.
- `AUTO_APPROVE_ACTS` — optional review-gate bypass; default it to false.
- `CONFIG_READER_PATH` — defaults to `/data/pipeline/config-reader.cjs`.
- `PIPELINE_CONFIG_PATH` — generated config reader defaults to
  `/data/pipeline/pipeline.config.json`.
- `DB_MODULE_PATH` — generated provider/config modules default to `/app/db`.
- `FFMPEG_PATH` and `FFPROBE_PATH` — optional binary overrides.
- `YOUTUBE_CREDENTIALS_PATH` — optional; upload is disabled when absent.
- `PORT`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_ENVIRONMENT_ID`,
  `RAILWAY_SERVICE_NAME`, `RAILWAY_VOLUME_NAME`, and
  `RAILWAY_VOLUME_MOUNT_PATH` — Railway-provided.
- `FRAYMIQ_ENVIRONMENT` and `STAGING_BOOTSTRAP` — staging guard variables added
  by this branch.

The prior code checked only `RAILWAY_ENVIRONMENT`, which is not in Railway's
current documented built-in variable list. This branch now prefers
`RAILWAY_ENVIRONMENT_NAME`/`RAILWAY_ENVIRONMENT_ID` and retains
`RAILWAY_ENVIRONMENT` only as a compatibility fallback, ensuring Railway uses
the mounted `/data` path rather than ephemeral `local-data`.

Test-only provider-host overrides present in generator source writers, and not
appropriate for normal Railway staging: `SDXL_TEST_API_HOSTNAME`,
`SDXL_TEST_API_PORT`, `SVD_TEST_API_HOSTNAME`, `SVD_TEST_API_PORT`,
`COQUI_TEST_API_HOSTNAME`, and `COQUI_TEST_API_PORT`.

## Known blockers and unknowns

1. The actual `pipeline.config.json`, volume-only pipeline modules, provider
   modules, and binary assets are not versioned. Their contents and hashes
   cannot be verified from this repository. A human must obtain approved copies
   and review them for staging paths and provider choices.
2. `src/data/channelRegistry.json` contains Windows-only `C:/Users/...` paths,
   including Empire Omitted's external `channel.config.json`. The live
   `server.js` routes and `jobs/runner.js` do not consume this registry, so the
   shared production engine can stage without it. Any standalone adapter or
   tooling that does consume it remains blocked on Railway until the registry
   gets a separate portability fix; copying `channel.config.json` alone does
   not repair that path.
3. `pipeline.config.json` may encode additional asset/provider requirements.
   The preflight checks every `/data/...` reference it can see, but cannot infer
   dependencies hidden inside unversioned modules.
4. PR #1 is not present on `main` at the base commit used to prepare this
   branch. A verification branch must include both changes, or staging must
   deploy `main` only after PR #1 merges.
5. Railway config-as-code cannot create or prove Volume isolation. The human
   environment/Volume selection is mandatory; the marker guard is a secondary
   safety check.

## Railway references used

- [Config as code reference](https://docs.railway.com/config-as-code/reference)
- [Environments](https://docs.railway.com/environments)
- [Variables and Railway-provided variables](https://docs.railway.com/variables/reference)
- [Volumes](https://docs.railway.com/volumes)
- [Health checks](https://docs.railway.com/deployments/healthchecks)
- [Deployment and application logs](https://docs.railway.com/observability/logs)
- [Service file management](https://docs.railway.com/services)
- [Project webhooks](https://docs.railway.com/observability/webhooks)
