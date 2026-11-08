// Route native callbacks before public data, settings or appearance code runs.
(() => {
  const proof = new URLSearchParams(location.hash.slice(1));
  if (proof.has("access_token") || /^#\/?admin(?:[/?]|$)/.test(location.hash)) {
    const target = new URL("./admin/", location.href);
    if (proof.has("access_token")) target.hash = location.hash;
    location.replace(target.href);
  }
})();
