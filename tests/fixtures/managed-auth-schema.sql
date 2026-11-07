-- SQL INFRASTRUCTURE FIXTURE ONLY. This is not Supabase Auth/GoTrue, an invite,
-- password verifier, mail delivery, JWT proof or a real owner login.
-- No Auth user, session, factor, password, token or key is populated here.
-- Used only in an isolated in-memory PGlite database by fresh-project checks.
create role anon;
create role authenticated;
create role service_role bypassrls;
create role supabase_auth_admin;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text, email_confirmed_at timestamptz, invited_at timestamptz,
  deleted_at timestamptz, banned_until timestamptz,
  phone text, phone_change text, is_anonymous boolean not null default false
);
create table auth.sessions (
  id uuid primary key, user_id uuid not null references auth.users(id),
  factor_id uuid, aal text, not_after timestamptz
);
create table auth.mfa_factors (
  id uuid primary key, user_id uuid not null references auth.users(id),
  factor_type text, status text
);
revoke all on schema auth from public,anon,authenticated,service_role;
revoke all on all tables in schema auth from public,anon,authenticated,service_role;
