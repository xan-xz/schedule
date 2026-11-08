import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  consumeBootstrapCallback,
  consumeBootstrapFragment,
} from "../app/admin/api.mjs";
const routeSource = await readFile(
  new URL("../app/owner-route.js", import.meta.url),
  "utf8",
);
const appSource = await readFile(
  new URL("../app/app.mjs", import.meta.url),
  "utf8",
);
const fallbackRoute =
  appSource.slice(
    appSource.indexOf("function openOwnerRoute() {"),
    appSource.indexOf("// A callback document"),
  ) + "openOwnerRoute();";
function consume(hash = "", search = "") {
  let url = null;
  const result = consumeBootstrapCallback(
    { hash, search, pathname: "/schedule/admin/" },
    {
      replaceState(_state, _title, value) {
        url = value;
      },
    },
  );
  return { result, url };
}
function route(code, value) {
  const current = new URL(value);
  let target = null;
  vm.runInNewContext(code, {
    URL,
    URLSearchParams,
    location: {
      href: current.href,
      hash: current.hash,
      search: current.search,
      replace(value) {
        target = value;
      },
    },
  });
  return target;
}

test("native error callbacks are closed-mapped and synchronously scrub fragment/query without retaining descriptions or credentials", () => {
  for (const [native, expected] of [
    ["otp_expired", "CALLBACK_EXPIRED"],
    ["invite_not_found", "CALLBACK_EXPIRED"],
    ["flow_state_expired", "CALLBACK_EXPIRED"],
    ["flow_state_not_found", "CALLBACK_EXPIRED"],
    ["over_email_send_rate_limit", "CALLBACK_RATE_LIMITED"],
    ["over_request_rate_limit", "CALLBACK_RATE_LIMITED"],
    ["email_provider_disabled", "CALLBACK_UNAVAILABLE"],
    ["otp_disabled", "CALLBACK_UNAVAILABLE"],
    ["unknown_private_marker", "CALLBACK_ERROR"],
  ]) {
    for (const query of [false, true]) {
      const params = new URLSearchParams({
        error: "access_denied",
        error_code: native,
        error_description: "NEVER_REFLECT_DESCRIPTION",
        access_token: "NEVER_RETAIN_ACCESS",
        refresh_token: "NEVER_RETAIN_REFRESH",
        token_hash: "NEVER_RETAIN_HASH",
        code: "NEVER_RETAIN_CODE",
      });
      const { result, url } = consume(
        query ? "" : "#" + params,
        query ? "?notice=safe&" + params : "",
      );
      assert.deepEqual(result, { token: "", errorCode: expected });
      assert.equal(
        url,
        query ? "/schedule/admin/?notice=safe" : "/schedule/admin/",
      );
      assert.equal(JSON.stringify(result).includes("NEVER_"), false);
      assert.equal(
        JSON.stringify(result).includes("unknown_private_marker"),
        false,
      );
    }
  }
});

test("any callback error takes precedence over an accompanying token; descriptions alone yield only generic error", () => {
  for (const hash of [
    "#error_description=NEVER_REFLECT_DESCRIPTION&access_token=proof",
    "#error=&access_token=proof",
    "#error_code=otp_expired&access_token=proof",
  ]) {
    const { result, url } = consume(hash);
    assert.equal(result.token, "");
    assert.notEqual(result.errorCode, null);
    assert.equal(url, "/schedule/admin/");
  }
});

test("successful proof behaviour is preserved and callback consumption never creates an authenticated session", () => {
  const { result, url } = consume(
    "#access_token=fixture-proof&refresh_token=never-retain&type=invite",
    "?notice=safe",
  );
  assert.deepEqual(result, { token: "fixture-proof", errorCode: null });
  assert.equal(url, "/schedule/admin/?notice=safe");
  assert.equal(
    consumeBootstrapFragment(
      {
        hash: "#access_token=fixture-proof",
        search: "",
        pathname: "/schedule/admin/",
      },
      { replaceState() {} },
    ),
    "fixture-proof",
  );
  assert.deepEqual(consume().result, { token: "", errorCode: null });
});

test("both early and module owner routes constrain callback errors to the exact current origin/project and drop untrusted parameters", () => {
  for (const code of [routeSource, fallbackRoute])
    for (const origin of [
      "https://xan-xz.github.io",
      "http://127.0.0.1:4277",
    ]) {
      for (const suffix of [
        "#error=access_denied&error_code=otp_expired&error_description=NEVER_REFLECT_DESCRIPTION&sb=private",
        "?error=access_denied&error_code=otp_expired&error_description=NEVER_REFLECT_DESCRIPTION&redirect_to=https://attacker.invalid/path",
        "?error_description=NEVER_REFLECT_DESCRIPTION#access_token=NEVER_RETAIN_ACCESS",
      ]) {
        const target = route(code, origin + "/schedule/" + suffix);
        const parsed = new URL(target);
        assert.equal(parsed.origin, origin);
        assert.equal(parsed.pathname, "/schedule/admin/");
        assert.equal(parsed.search, "");
        assert.match(parsed.hash, /^#error_code=(otp_expired|callback_error)$/);
        assert.equal(target.includes("NEVER_"), false);
        assert.equal(target.includes("attacker"), false);
      }
    }
});

test("unknown callback codes forward a generic marker, success fragments retain existing handoff and unrelated public routes remain public", () => {
  for (const code of [routeSource, fallbackRoute]) {
    assert.equal(
      route(
        code,
        "https://xan-xz.github.io/schedule/?error_code=sb_secret_Unknown#public",
      ),
      "https://xan-xz.github.io/schedule/admin/#error_code=callback_error",
    );
    assert.equal(
      route(
        code,
        "https://xan-xz.github.io/schedule/#access_token=fixture-proof&type=invite",
      ),
      "https://xan-xz.github.io/schedule/admin/#access_token=fixture-proof&type=invite",
    );
    assert.equal(
      route(code, "https://xan-xz.github.io/schedule/?g=g-main#week"),
      null,
    );
    assert.equal(
      route(code, "https://xan-xz.github.io/schedule/#/admin"),
      "https://xan-xz.github.io/schedule/admin/",
    );
  }
});

test("owner entry consumes/redacts callback before lazy UI and passes only the closed error marker", async () => {
  const source = await readFile(
    new URL("../app/admin/app.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.indexOf("consumeBootstrapCallback();") <
      source.indexOf('await import("./access.mjs")'),
  );
  assert.match(source, /bootstrapError,/);
  assert.doesNotMatch(source, /error_description/);
});
