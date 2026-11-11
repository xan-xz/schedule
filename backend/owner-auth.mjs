import {
  OWNER_EMAIL,
  OWNER_ORIGIN,
  isAccessToken,
  isRefreshToken,
  isChallenge,
  assertPassword,
  assertTotp,
  ownerError,
  tokenHash,
  randomOpaque,
  createSecretBox,
  privateIpHash,
  ownerCommand,
  createAuthProvider,
  createOwnerDatabase,
  serverConfiguration,
} from "./owner-access.mjs";

const cors = {
  "Access-Control-Allow-Origin": OWNER_ORIGIN,
  "Access-Control-Allow-Headers": "content-type,apikey",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  Vary: "Origin",
};
const emailHint = "a***@gmail.com";
const reply = (data, status = 200, retry = 0) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      ...(retry > 0 ? { "Retry-After": String(retry) } : {}),
    },
  });
const providerState = (session) => ({
  access_token: session.access_token,
  refresh_token: session.refresh_token,
  identity: {
    user: { id: session.identity.user.id, email: session.identity.user.email },
    claims: {
      session_id: session.identity.claims.session_id,
      aal: session.identity.claims.aal,
    },
  },
});
const challengePurpose = (hash) => "owner/challenge/" + hash;
const sessionPurpose = (nativeId) => "owner/session/" + nativeId;
// Only inspected after Auth has verified the fixed owner's fresh email proof.
// An existing verified factor must be proved, never silently replaced.
function existingSetupFactor(user) {
  const factors = (user.factors || []).filter(
    (factor) => factor.factor_type === "totp" && factor.status === "verified",
  );
  if (!factors.length) return null;
  if (
    factors.length !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      factors[0].id || "",
    )
  )
    throw ownerError("FLOW_CONFLICT", 409);
  return factors[0].id;
}

/** Dependencies are injectable for isolated HTTP tests; production uses only
 * server environment keys. Nothing logs request bodies or provider responses.
 */
export function createOwnerHandler({
  db,
  auth,
  box,
  secret,
  now = Date.now,
  sleep,
} = {}) {
  const wait =
    sleep ||
    ((milliseconds) => new Promise((r) => setTimeout(r, milliseconds)));
  let contextPromise;
  async function context() {
    if (db && auth && box && secret) return { db, auth, box, secret };
    if (!contextPromise)
      contextPromise = (async () => {
        const configuration = serverConfiguration(Deno.env);
        return {
          db: createOwnerDatabase(configuration),
          auth: createAuthProvider(configuration),
          box: await createSecretBox(configuration.encryptionSecret),
          secret: configuration.encryptionSecret,
        };
      })();
    return contextPromise;
  }
  return async function handle(req) {
    const origin = req.headers.get("origin");
    if (origin && origin !== OWNER_ORIGIN)
      return reply(
        { error: "Доступ не разрешён.", code: "ACCESS_DENIED" },
        403,
      );
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST")
      return reply(
        { error: "Метод не разрешён.", code: "INVALID_REQUEST" },
        405,
      );
    let dependencies,
      body,
      ipHash,
      device,
      lease,
      challenge,
      challengeHash,
      refreshSession;
    let attempt = 1;
    try {
      if (Number(req.headers.get("content-length")) > 24000)
        throw ownerError("INVALID_REQUEST", 400);
      const raw = await req.text();
      if (raw.length > 24000) throw ownerError("INVALID_REQUEST", 400);
      try {
        body = JSON.parse(raw);
      } catch {
        throw ownerError("INVALID_REQUEST", 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw ownerError("INVALID_REQUEST", 400);
      dependencies = await context();
      const {
        db: database,
        auth: provider,
        box: encryption,
        secret: serverSecret,
      } = dependencies;
      const command = (op, payload) => ownerCommand(database, op, payload);
      const cfg = await command("state");
      if (body.action === "status")
        return reply({
          available: true,
          configured: cfg.setup_complete === true,
          setupRequired: cfg.setup_complete !== true,
          ownerHint: emailHint,
          emailOtp: true,
          totp: true,
          recovery: true,
        });
      const scope = body.action?.startsWith("setup.")
        ? "setup"
        : body.action === "login.begin"
          ? "login"
          : body.action === "session.refresh"
            ? "refresh"
            : "proof";
      ipHash = await privateIpHash(
        serverSecret,
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown",
      );
      device = Array.from(req.headers.get("user-agent") || "", (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
          ? " "
          : character,
      )
        .join("")
        .slice(0, 200);
      const reserved = await command("rate.reserve", {
        scope,
        ip_hash: ipHash,
      });
      attempt = reserved.attempt || 1;
      const audit = (event, sessionId) =>
        command("log", {
          event,
          ip_hash: ipHash,
          device,
          ...(sessionId ? { session_id: sessionId } : {}),
        });
      if (body.action === "setup.request") {
        const mailLease = crypto.randomUUID();
        const reservation = await command("setup.reserve", {
          lease: mailLease,
        });
        let ownerUid = reservation.owner_uid;
        if (!ownerUid) {
          const invited = await provider.invite();
          ownerUid = invited.id || invited.user?.id;
          if (!ownerUid) throw ownerError("UNAVAILABLE", 503);
          await command("setup.pin", { lease: mailLease, owner_uid: ownerUid });
        } else {
          await provider.sendEmail();
        }
        await audit("setup_requested");
        return reply({
          sent: true,
          retryAfterSeconds: 300,
          ownerHint: emailHint,
        });
      }
      if (body.action === "setup.start") {
        if (
          cfg.setup_complete ||
          !cfg.owner_uid ||
          !cfg.bootstrap_deadline ||
          Date.parse(cfg.bootstrap_deadline) <= now()
        )
          throw ownerError("ACCESS_DENIED", 403);
        const proof = await provider.email(body.bootstrapToken, {
          setup: true,
          since: Math.max(
            0,
            Date.parse(cfg.bootstrap_deadline) - 15 * 60 * 1000,
          ),
        });
        if (proof.identity.user.id !== cfg.owner_uid)
          throw ownerError("ACCESS_DENIED", 403);
        const resumeFactorId = existingSetupFactor(proof.identity.user);
        const id = randomOpaque("ow1c.");
        const hash = await tokenHash(id);
        const created = await command("challenge.create", {
          challenge_hash: hash,
          kind: "setup",
          owner_uid: cfg.owner_uid,
          native_session_id: proof.identity.claims.session_id,
          encrypted_state: await encryption.seal(
            {
              step: "password",
              provider: providerState(proof),
              ...(resumeFactorId ? { resumeFactorId } : {}),
            },
            challengePurpose(hash),
          ),
        });
        return reply({
          challengeId: id,
          expiresAt: created.expires_at,
          step: resumeFactorId ? "existing-password" : "password",
        });
      }
      if (body.action === "login.begin") {
        if (!cfg.setup_complete || !cfg.owner_uid || !cfg.factor_id)
          throw ownerError("ACCESS_DENIED", 403);
        assertPassword(body.password);
        const passwordSession = await provider.password(body.password);
        if (passwordSession.identity.user.id !== cfg.owner_uid)
          throw ownerError("ACCESS_DENIED", 403);
        await provider.sendEmail();
        const id = randomOpaque("ow1c.");
        const hash = await tokenHash(id);
        const created = await command("challenge.create", {
          challenge_hash: hash,
          kind: "login",
          owner_uid: cfg.owner_uid,
          native_session_id: passwordSession.identity.claims.session_id,
          encrypted_state: await encryption.seal(
            { step: "login", provider: providerState(passwordSession) },
            challengePurpose(hash),
          ),
        });
        return reply({
          challengeId: id,
          expiresAt: created.expires_at,
          emailHint,
        });
      }
      async function complete(nativeSession, factorId, recoveryCodes) {
        const token = randomOpaque("ow1a.");
        const refreshToken = randomOpaque("ow1r.");
        const nativeId = nativeSession.identity.claims.session_id;
        const result = await command("session.create", {
          challenge_hash: challengeHash,
          lease,
          native_session_id: nativeId,
          factor_id: factorId,
          access_hash: await tokenHash(token),
          refresh_hash: await tokenHash(refreshToken),
          encrypted_state: await encryption.seal(
            providerState(nativeSession),
            sessionPurpose(nativeId),
          ),
          ip_hash: ipHash,
          device,
          ...(recoveryCodes
            ? {
                recovery_hashes: await Promise.all(
                  recoveryCodes.map(tokenHash),
                ),
              }
            : {}),
          renew_recovery:
            challenge.kind === "login" && recoveryCodes !== undefined,
        });
        // Success audit and activation are one database transaction. A separate
        // post-commit audit failure must never hide the one-time recovery codes.
        challenge = null;
        return reply({
          token,
          refreshToken,
          expiresAt: result.expires_at,
          refreshExpiresAt: result.absolute_expires_at,
          owner: { id: result.owner_uid, email: OWNER_EMAIL },
          ...(recoveryCodes ? { recoveryCodes } : {}),
        });
      }
      const makeCodes = () =>
        Array.from({ length: 10 }, () => randomOpaque("uwr1-").slice(0, 37));
      if (
        [
          "setup.password",
          "setup.verify",
          "login.verify",
          "recovery.verify",
          "recovery.finish",
        ].includes(body.action)
      ) {
        if (!isChallenge(body.challengeId))
          throw ownerError("INVALID_REQUEST", 400);
        challengeHash = await tokenHash(body.challengeId);
        lease = crypto.randomUUID();
        challenge = await command("challenge.claim", {
          challenge_hash: challengeHash,
          lease,
        });
        if (challenge.owner_uid !== cfg.owner_uid)
          throw ownerError("ACCESS_DENIED", 403);
        const state = await encryption.open(
          challenge.encrypted_state,
          challengePurpose(challengeHash),
        );
        const save = async (extra = {}) => {
          challenge = await command("challenge.save", {
            challenge_hash: challengeHash,
            lease,
            encrypted_state: await encryption.seal(
              state,
              challengePurpose(challengeHash),
            ),
            ...extra,
          });
        };
        const enrollmentReply = () =>
          reply({
            challengeId: body.challengeId,
            expiresAt: challenge.expires_at,
            step: state.step === "existing-totp" ? "existing-totp" : "totp",
            ...(state.step === "existing-totp"
              ? {}
              : { enrollment: state.enrollment }),
          });
        if (body.action === "setup.password") {
          if (
            challenge.kind === "setup" &&
            ["totp", "existing-totp"].includes(state.step) &&
            state.enrollment
          ) {
            const response = enrollmentReply();
            await command("challenge.release", {
              challenge_hash: challengeHash,
              lease,
            });
            challenge = null;
            return response;
          }
          if (
            challenge.kind !== "setup" ||
            state.step !== "password" ||
            cfg.setup_complete
          )
            throw ownerError("INVALID_PROOF", 401);
          assertPassword(body.password);
          const passwordSession = state.resumeFactorId
            ? await provider.password(body.password)
            : await provider.setPassword(
                state.provider.access_token,
                body.password,
              );
          if (passwordSession.identity.user.id !== cfg.owner_uid)
            throw ownerError("ACCESS_DENIED", 403);
          const currentFactorId = existingSetupFactor(
            passwordSession.identity.user,
          );
          if (currentFactorId !== (state.resumeFactorId || null))
            throw ownerError("FLOW_CONFLICT", 409);
          const enrollment = state.resumeFactorId
            ? { factorId: state.resumeFactorId }
            : await provider.enroll(passwordSession.access_token);
          state.provider = providerState(passwordSession);
          state.enrollment = enrollment;
          state.step = state.resumeFactorId ? "existing-totp" : "totp";
          await save({
            native_session_id: passwordSession.identity.claims.session_id,
          });
          const response = enrollmentReply();
          await command("challenge.release", {
            challenge_hash: challengeHash,
            lease,
          });
          challenge = null;
          return response;
        }
        if (
          body.action === "setup.verify" ||
          body.action === "recovery.finish"
        ) {
          const expectedKind =
            body.action === "setup.verify" ? "setup" : "recovery";
          if (
            challenge.kind !== expectedKind ||
            !(
              state.step === "totp" ||
              (expectedKind === "setup" &&
                state.step === "existing-totp" &&
                state.resumeFactorId === state.enrollment?.factorId)
            ) ||
            !state.enrollment
          )
            throw ownerError("INVALID_PROOF", 401);
          assertTotp(body.totpCode);
          const verified = await provider.totp(
            state.provider,
            state.enrollment.factorId,
            body.totpCode,
          );
          return complete(verified, state.enrollment.factorId, makeCodes());
        }
        const recoveryResume =
          body.action === "recovery.verify" &&
          challenge.kind === "recovery" &&
          ["login", "recovery-reset", "totp"].includes(state.step);
        if (recoveryResume && state.step === "totp" && state.enrollment) {
          const response = enrollmentReply();
          await command("challenge.release", {
            challenge_hash: challengeHash,
            lease,
          });
          challenge = null;
          return response;
        }
        if (
          !recoveryResume &&
          (challenge.kind !== "login" || state.step !== "login")
        )
          throw ownerError("INVALID_PROOF", 401);
        if (!challenge.email_proved_at) {
          const emailProof = await provider.email(body.emailCode, {
            since: Date.parse(challenge.created_at),
          });
          if (
            emailProof.identity.user.id !== cfg.owner_uid ||
            emailProof.identity.claims.session_id ===
              state.provider.identity.claims.session_id
          )
            throw ownerError("INVALID_PROOF", 401);
          // Email produces a separate Auth session. Never replace the password
          // session or its MFA challenge with this email-only session.
          await save({
            email_proved: true,
            email_session_id: emailProof.identity.claims.session_id,
          });
          try {
            await provider.logout(emailProof.access_token, false);
          } catch {
            /* The proof remains bound; an email-session cleanup failure cannot grant access. */
          }
        }
        if (body.action === "recovery.verify") {
          assertPassword(body.password);
          if (
            typeof body.recoveryCode !== "string" ||
            !/^uwr1-[a-f0-9]{32}$/.test(body.recoveryCode)
          )
            throw ownerError("INVALID_REQUEST", 400);
          // Verify the repeated password before consuming a recovery code or
          // changing any native factor. A typo must not revoke the owner's MFA.
          const confirmation = await provider.password(body.password);
          if (confirmation.identity.user.id !== cfg.owner_uid)
            throw ownerError("ACCESS_DENIED", 403);
          if (challenge.kind === "login")
            challenge = await command("recovery.consume", {
              challenge_hash: challengeHash,
              lease,
              code_hash: await tokenHash(body.recoveryCode),
              ip_hash: ipHash,
              device,
            });
          state.step = "recovery-reset";
          await save();
          const factors = new Set([
            cfg.factor_id,
            ...(confirmation.identity.user.factors || []).map(
              (factor) => factor.id,
            ),
          ]);
          for (const factorId of factors)
            await provider.deleteFactor(cfg.owner_uid, factorId);
          // Removing a verified native factor revokes provider sessions. A fresh
          // password session must enroll and prove a new factor before access.
          const passwordSession = await provider.password(body.password);
          if (passwordSession.identity.user.id !== cfg.owner_uid)
            throw ownerError("ACCESS_DENIED", 403);
          state.provider = providerState(passwordSession);
          state.enrollment = await provider.enroll(
            passwordSession.access_token,
          );
          state.step = "totp";
          await save({
            native_session_id: passwordSession.identity.claims.session_id,
          });
          const response = enrollmentReply();
          await command("challenge.release", {
            challenge_hash: challengeHash,
            lease,
          });
          challenge = null;
          return response;
        }
        assertTotp(body.totpCode);
        if (
          body.renewRecoveryCodes !== undefined &&
          typeof body.renewRecoveryCodes !== "boolean"
        )
          throw ownerError("INVALID_REQUEST", 400);
        const verified = await provider.totp(
          state.provider,
          cfg.factor_id,
          body.totpCode,
        );
        return complete(
          verified,
          cfg.factor_id,
          body.renewRecoveryCodes === true ? makeCodes() : undefined,
        );
      }
      if (body.action === "session.refresh") {
        if (!isRefreshToken(body.refreshToken))
          throw ownerError("INVALID_REQUEST", 400);
        lease = crypto.randomUUID();
        refreshSession = await command("session.claim_refresh", {
          refresh_hash: await tokenHash(body.refreshToken),
          lease,
        });
        const providerSession = await encryption.open(
          refreshSession.encrypted_state,
          sessionPurpose(refreshSession.native_session_id),
        );
        const updated = await provider.refresh(
          providerSession.refresh_token,
          refreshSession.native_session_id,
        );
        if (updated.identity.user.id !== cfg.owner_uid)
          throw ownerError("ACCESS_DENIED", 403);
        const token = randomOpaque("ow1a.");
        const refreshToken = randomOpaque("ow1r.");
        const result = await command("session.rotate", {
          id: refreshSession.id,
          lease,
          access_hash: await tokenHash(token),
          refresh_hash: await tokenHash(refreshToken),
          encrypted_state: await encryption.seal(
            providerState(updated),
            sessionPurpose(refreshSession.native_session_id),
          ),
        });
        refreshSession = null;
        return reply({
          token,
          refreshToken,
          expiresAt: result.expires_at,
          refreshExpiresAt: result.absolute_expires_at,
          owner: { id: result.owner_uid, email: OWNER_EMAIL },
        });
      }
      if (["logout", "logout.all"].includes(body.action)) {
        if (!isAccessToken(body.token)) throw ownerError("INVALID_PROOF", 401);
        const session = await command("session.verify", {
          access_hash: await tokenHash(body.token),
        });
        const providerSession = await encryption.open(
          session.encrypted_state,
          sessionPurpose(session.native_session_id),
        );
        const all = body.action === "logout.all";
        // Revoke application access even when the external Auth logout fails.
        await command("session.revoke", { id: session.id, all });
        await provider.logout(providerSession.access_token, all);
        await audit(all ? "logout_all" : "logout", session.id);
        return reply({ ok: true });
      }
      throw ownerError("INVALID_REQUEST", 400);
    } catch (error) {
      if (dependencies) {
        if (challenge && challengeHash && lease)
          try {
            await ownerCommand(dependencies.db, "challenge.release", {
              challenge_hash: challengeHash,
              lease,
            });
          } catch {
            /* Fail closed, the short lease expires. */
          }
        if (refreshSession)
          try {
            await ownerCommand(dependencies.db, "session.revoke", {
              id: refreshSession.id,
            });
          } catch {
            /* The old access expires and native checks remain mandatory. */
          }
        if (
          ipHash &&
          [
            "login.begin",
            "login.verify",
            "recovery.verify",
            "setup.verify",
            "recovery.finish",
            "session.refresh",
          ].includes(body?.action)
        )
          try {
            await ownerCommand(dependencies.db, "log", {
              event:
                body.action === "session.refresh"
                  ? "refresh_failed"
                  : body.action === "login.begin"
                    ? "login_failed"
                    : "proof_failed",
              ip_hash: ipHash,
              device,
            });
          } catch {
            /* Never log secrets or raw provider errors. */
          }
      }
      const errorStatuses = {
        INVALID_REQUEST: 400,
        INVALID_PROOF: 401,
        ACCESS_DENIED: 403,
        FLOW_CONFLICT: 409,
        RATE_LIMITED: 429,
        MAIL_UNAVAILABLE: 503,
      };
      const knownError = Object.hasOwn(errorStatuses, error?.code || "");
      const safe = ownerError(
        knownError ? error.code : "UNAVAILABLE",
        knownError ? errorStatuses[error.code] : 503,
        Math.min(900, Math.max(0, Number(error?.retryAfterSeconds) || 0)),
      );
      if ([401, 403, 429].includes(safe.status))
        await wait(Math.min(3000, 400 + 150 * 2 ** Math.min(4, attempt - 1)));
      return reply(
        {
          error: safe.message,
          code: safe.code,
          ...(safe.retryAfterSeconds > 0
            ? { retryAfterSeconds: safe.retryAfterSeconds }
            : {}),
        },
        safe.status,
        safe.retryAfterSeconds,
      );
    }
  };
}
export const handle = createOwnerHandler();
if (typeof Deno !== "undefined") Deno.serve(handle);
