(function () {
  try {
    var p = JSON.parse(localStorage.getItem("nv-prefs") || "{}");
    var d = document.documentElement;
    var lang = p.lang === "en" ? "en" : "ar";
    d.lang = lang;
    d.dir = lang === "ar" ? "rtl" : "ltr";
    var dark =
      p.theme === "dark" ||
      ((!p.theme || p.theme === "system") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) d.classList.add("dark");
    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute("content", dark ? "#0d0e1d" : "#f6f4ef");
    if (p.reduceMotion) d.classList.add("reduce-motion");
    if (p.textSize) {
      d.style.fontSize = { sm: "14px", md: "16px", lg: "18px", xl: "20px" }[p.textSize] || "16px";
    }
  } catch {
    /* ignore corrupt localStorage */
  }
})();
