/* Apply only a previously resolved public device preference before first paint. */
(() => {
  try {
    const p = JSON.parse(
      localStorage.getItem("uf.student.appearance.applied.v1") || "null",
    );
    if (!p || p.version !== 1) return;
    const allowed = {
      theme: ["system", "light", "dark"],
      palette: ["violet", "graphite", "ocean", "forest", "sunset", "contrast"],
      density: ["compact", "standard", "spacious"],
      textSize: ["standard", "large", "larger"],
      rounding: ["square", "soft", "round"],
    };
    for (const [key, values] of Object.entries(allowed))
      if (values.includes(p[key]))
        document.documentElement.dataset[key] = p[key];
    if (p.reducedMotion === true)
      document.documentElement.dataset.reducedMotion = "true";
    const dark =
      p.theme === "dark" ||
      (p.theme === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    if (
      p.customDark === dark &&
      p.custom &&
      /^#[a-f0-9]{6}$/i.test(p.custom.accent) &&
      /^#[a-f0-9]{6}$/i.test(p.custom.onAccent)
    ) {
      document.documentElement.style.setProperty("--accent", p.custom.accent);
      document.documentElement.style.setProperty(
        "--on-accent",
        p.custom.onAccent,
      );
    }
  } catch {
    /* Private browsing: use accessible stylesheet defaults. */
  }
})();
