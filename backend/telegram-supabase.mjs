function legacyServiceRole(key) {
  const parts =
    typeof key === "string" && /^eyJ[\w-]+\.([\w-]+)\.[\w-]+$/u.exec(key);
  if (!parts) return false;
  try {
    const payload = atob(parts[1].replaceAll("-", "+").replaceAll("_", "/"));
    // The API gateway verifies the signature. Avoid sending a misconfigured anon key.
    return JSON.parse(payload).role === "service_role";
  } catch {
    return false;
  }
}

export function createTelegramServiceRpc(
  { env, fetcher = fetch },
  name,
  unavailableMessage,
) {
  const project = env.get("SUPABASE_URL");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/u.test(project || ""))
    return undefined;

  const legacy = env.get("SUPABASE_SERVICE_ROLE_KEY");
  let secret;
  try {
    const configured = JSON.parse(
      env.get("SUPABASE_SECRET_KEYS") || "{}",
    )?.default;
    if (
      typeof configured === "string" &&
      /^sb_secret_[\w-]+$/u.test(configured)
    )
      secret = configured;
  } catch {
    // Older deployments can use their legacy service role key.
  }
  if (!secret && !legacyServiceRole(legacy)) return undefined;

  const endpoint = new URL("/rest/v1/rpc/" + name, project);
  const headers = {
    "Content-Type": "application/json",
    apikey: secret || legacy,
    ...(!secret ? { Authorization: "Bearer " + legacy } : {}),
  };
  return async (body) => {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok)
        return response.status === 204 ? null : await response.json();
    } catch {
      // Keep upstream error details and credentials out of webhook responses.
    }
    throw Error(unavailableMessage);
  };
}
