/* ================================================
   Cyberpunk Theme — Core (Mermaid + progress bar + tech typer)
   ================================================ */

document.addEventListener("DOMContentLoaded", () => {
  // ============================================
  // Looping typer — header (short tech words) and
  // home-card footer (realistic build/run commands)
  // ============================================
  function createTyper(el, words, opts) {
    if (!el || !words || !words.length) return;
    opts = opts || {};
    var TYPE = opts.type || 120;
    var ERASE = opts.erase || 55;
    var HOLD = opts.hold || 1800;
    var GAP = opts.gap || 300;
    var idx = 0,
      ci = 0,
      phase = "typing";

    (function tick() {
      var w = words[idx];
      if (phase === "typing") {
        ci++;
        el.textContent = w.substring(0, ci);
        if (ci >= w.length) {
          setTimeout(() => {
            phase = "erasing";
            tick();
          }, HOLD);
          return;
        }
        setTimeout(tick, TYPE);
      } else {
        ci--;
        el.textContent = w.substring(0, ci);
        if (ci <= 0) {
          setTimeout(() => {
            phase = "typing";
            idx = (idx + 1) % words.length;
            tick();
          }, GAP);
          return;
        }
        setTimeout(tick, ERASE);
      }
    })();
  }

  createTyper(document.getElementById("tech-typer"), [
    "Systems",
    "AI Infra",
    "Rust",
    "Memory Safety",
    "LLVM IR",
    "Static Analysis",
    "Agents",
    "Go",
    "Zig",
    "Python",
    "LLM",
    "FFI",
  ]);

  createTyper(
    document.getElementById("footer-typer"),
    [
      "cargo build --release",
      "zig build test",
      "go test -race ./...",
      "python train.py --epochs 10",
      "RUST_LOG=trace cargo run",
      "llvm-dis < model.bc",
    ],
    { type: 55, erase: 28, hold: 1400, gap: 350 },
  );

  // ============================================
  // Mermaid — unified init
  // ALL colors are defined in _mermaid.scss as CSS variables.
  // JS reads them at runtime — zero hardcoded colors here.
  // Change colors in ONE place: _mermaid.scss variables.
  // ============================================
  if (typeof mermaid !== "undefined") {
    var cs = getComputedStyle(document.documentElement);
    var C = (v) => v.trim();

    mermaid.initialize({
      theme: "base",
      securityLevel: "loose",
      startOnLoad: false,
      flowchart: {
        htmlLabels: false,
        curve: "basis",
        useMaxWidth: true,
        nodeSpacing: 50,
        rankSpacing: 70,
        padding: 20,
        diagramPadding: 16,
      },
      sequence: {
        useMaxWidth: true,
        wrap: true,
        width: 180,
        boxMargin: 15,
        noteMargin: 20,
        messageMargin: 50,
      },
      themeVariables: {
        darkMode: true,
        background: "transparent",
        primaryColor: C(cs.getPropertyValue("--m-node")),
        primaryBorderColor: C(cs.getPropertyValue("--m-border")),
        primaryTextColor: C(cs.getPropertyValue("--m-text")),
        secondaryColor: C(cs.getPropertyValue("--m-node")),
        secondaryTextColor: C(cs.getPropertyValue("--m-text")),
        secondaryBorderColor: C(cs.getPropertyValue("--m-border-teal")),
        tertiaryColor: C(cs.getPropertyValue("--m-node")),
        tertiaryTextColor: C(cs.getPropertyValue("--m-text")),
        tertiaryBorderColor: C(cs.getPropertyValue("--m-border-purple")),
        lineColor: C(cs.getPropertyValue("--m-edge")),
        textColor: C(cs.getPropertyValue("--m-text")),
        fontSize: "13px",
        fontFamily: "'JetBrains Mono','Fira Code','Hack',monospace",
        actorBkg: C(cs.getPropertyValue("--m-node")),
        actorBorder: C(cs.getPropertyValue("--m-border")),
        actorTextColor: C(cs.getPropertyValue("--m-text")),
        clusterBkg: C(cs.getPropertyValue("--m-cluster-bg")),
        clusterBorder: C(cs.getPropertyValue("--m-cluster-border")),
        edgeLabelBackground: C(cs.getPropertyValue("--m-edge-label-bg")),
        nodeBorder: C(cs.getPropertyValue("--m-border")),
        mainBkg: C(cs.getPropertyValue("--m-node")),
        activationBkgColor: C(cs.getPropertyValue("--m-node")),
        activationBorderColor: C(cs.getPropertyValue("--m-border")),
        signalColor: C(cs.getPropertyValue("--m-edge")),
        signalTextColor: C(cs.getPropertyValue("--m-text")),
        labelBoxBkgColor: C(cs.getPropertyValue("--m-node")),
        labelBoxBorderColor: C(cs.getPropertyValue("--m-muted")),
        labelTextColor: C(cs.getPropertyValue("--m-muted")),
        loopTextColor: C(cs.getPropertyValue("--m-muted")),
        noteBkgColor: C(cs.getPropertyValue("--m-node")),
        noteTextColor: C(cs.getPropertyValue("--m-text")),
        noteBorderColor: C(cs.getPropertyValue("--m-border-teal")),
        pie1: C(cs.getPropertyValue("--m-border")),
        pie2: C(cs.getPropertyValue("--m-border-teal")),
        pie3: C(cs.getPropertyValue("--m-border-purple")),
        pie4: "#3a9e5a",
        pie5: C(cs.getPropertyValue("--m-edge")),
        pie6: "#c06090",
        pie7: "#c85050",
        pie8: C(cs.getPropertyValue("--m-muted")),
        pieTitleTextSize: "14px",
        pieTitleTextColor: C(cs.getPropertyValue("--m-text")),
        pieSectionTextColor: C(cs.getPropertyValue("--m-canvas")),
        classText: C(cs.getPropertyValue("--m-text")),
      },
    });

    // Collect every diagram source and wrap in a unified .mermaid div.
    var nodes = [];

    // 1) Markdown code fences: <pre><code data-lang="mermaid">
    // Decode HTML entities that Zola's syntax highlighter may have double-encoded
    function decodeEntities(str) {
      return str
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    }
    document.querySelectorAll('code[data-lang="mermaid"]').forEach((code) => {
      var pre = code.parentElement;
      var div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = decodeEntities(code.textContent);
      // Optional filename — set via {% mermaid(name="...") %} or pages.html
      var name =
        code.getAttribute("data-name") ||
        (pre && pre.getAttribute("data-name"));
      if (name) div.setAttribute("data-name", name);
      pre.parentNode.replaceChild(div, pre);
      nodes.push(div);
    });

    // 2) Shortcode wrappers: <div class="mermaid-direct">
    document.querySelectorAll(".mermaid-direct").forEach((el) => {
      el.classList.remove("mermaid-direct");
      el.classList.add("mermaid");
      // data-series / data-name are preserved on the same element
      nodes.push(el);
    });

    // Render sequentially to avoid layout thrash on multi-diagram pages.
    if (nodes.length > 0) {
      var i = 0;
      function renderNext() {
        if (i >= nodes.length) return;
        var el = nodes[i++];
        el.style.minHeight = "80px";
        mermaid
          .run({ nodes: [el] })
          .then(() => {
            el.classList.add("mermaid-ready");
            setTimeout(renderNext, 30);
          })
          .catch((err) => {
            console.warn("Mermaid: skip one diagram (syntax error)", err);
            el.style.display = "none";
            setTimeout(renderNext, 30);
          });
      }
      setTimeout(renderNext, 80);
    }
  }

  // ============================================
  // Reading progress bar
  // ============================================
  var pb = document.getElementById("progress-bar");
  if (pb) {
    window.addEventListener("scroll", () => {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      pb.style.width = (h > 0 ? (window.scrollY / h) * 100 : 0) + "%";
    });
  }
});
