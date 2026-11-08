// Route native callbacks before public data, settings or appearance code runs.
(() => {
  const proof = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const failed = ["error", "error_code", "error_description"].some(
    (key) => proof.has(key) || query.has(key),
  );
  if (
    failed ||
    proof.has("access_token") ||
    /^#\/?admin(?:[/?]|$)/.test(location.hash)
  ) {
    const target = new URL("./admin/", location.href);
    if (failed) {
      const code = proof.get("error_code") || query.get("error_code") || "";
      const known = [
        "otp_expired",
        "invite_not_found",
        "flow_state_expired",
        "flow_state_not_found",
        "over_email_send_rate_limit",
        "over_request_rate_limit",
        "email_provider_disabled",
        "otp_disabled",
      ].includes(code);
      target.hash = new URLSearchParams({
        error_code: known ? code : "callback_error",
      }).toString();
    } else if (proof.has("access_token")) target.hash = location.hash;
    location.replace(target.href);
  }
})();
