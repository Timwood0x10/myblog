/* ================================================
   Cyberpunk Theme — Core (Mermaid + progress bar + tech typer)
   ================================================ */

document.addEventListener("DOMContentLoaded", function () {

  // ============================================
  // Looping typer — header (short tech words) and
  // home-card footer (realistic build/run commands)
  // ============================================
  function createTyper(el, words, opts) {
    if (!el || !words || !words.length) return;
    opts = opts || {};
    var TYPE  = opts.type  || 120;
    var ERASE = opts.erase || 55;
    var HOLD  = opts.hold  || 1800;
    var GAP   = opts.gap   || 300;
    var idx = 0, ci = 0, phase = "typing";

    (function tick() {
      var w = words[idx];
      if (phase === "typing") {
        ci++;
        el.textContent = w.substring(0, ci);
        if (ci >= w.length) {
          setTimeout(function () { phase = "erasing"; tick(); }, HOLD);
          return;
        }
        setTimeout(tick, TYPE);
      } else {
        ci--;
        el.textContent = w.substring(0, ci);
        if (ci <= 0) {
          setTimeout(function () { phase = "typing"; idx = (idx + 1) % words.length; tick(); }, GAP);
          return;
        }
        setTimeout(tick, ERASE);
      }
    })();
  }

  createTyper(
    document.getElementById("tech-typer"),
    ["Systems", "AI Infra", "Rust", "Memory Safety",
     "LLVM IR", "Static Analysis", "Agents",
     "Go", "Zig", "Python", "LLM", "FFI"]
  );

  createTyper(
    document.getElementById("footer-typer"),
    ["cargo build --release",
     "zig build test",
     "go test -race ./...",
     "python train.py --epochs 10",
     "RUST_LOG=trace cargo run",
     "llvm-dis < model.bc"],
    { type: 55, erase: 28, hold: 1400, gap: 350 }
  );

  // ============================================
  // Mermaid — unified terminal/cyberpunk init
  // Palette is intentionally close to CSS vars in
  // sass/color/green.scss so the frame + svg agree.
  // Per-series classDef colors win (no !important on fill in CSS).
  // ============================================
  if (typeof mermaid !== "undefined") {
    var PALETTE = {
      bg:        "transparent",
      card:      "#1c2128",          // --bg-card
      cardSoft:  "#161b22",          // --bg-secondary
      border:    "rgba(120, 226, 160, .55)",   // accent @ 55%
      borderDim: "rgba(255, 255, 255, .12)",
      text:      "#e6edf3",          // --color
      textDim:   "#8b949e",          // --color-secondary
      line:      "rgba(120, 226, 160, .7)",
      accent:    "#7ee2a0"           // --accent
    };

    mermaid.initialize({
      theme: "base",
      securityLevel: "loose",
      startOnLoad: false,
      flowchart: {
        htmlLabels: true,
        curve: "basis",
        useMaxWidth: true,
        nodeSpacing: 50,
        rankSpacing: 70,
        padding: 20,
        diagramPadding: 16
      },
      sequence: {
        useMaxWidth: true,
        wrap: true,
        width: 180,
        boxMargin: 15,
        noteMargin: 20,
        messageMargin: 50
      },
      themeVariables: {
        background:         PALETTE.bg,
        primaryColor:       PALETTE.card,
        primaryBorderColor: PALETTE.border,
        primaryTextColor:   PALETTE.text,
        secondaryColor:     PALETTE.cardSoft,
        tertiaryColor:      "transparent",
        lineColor:          PALETTE.line,
        fontSize:           "13px",
        fontFamily:         "'JetBrains Mono','Fira Code','Hack',monospace",
        actorBkg:           PALETTE.card,
        actorBorder:        PALETTE.border,
        actorTextColor:     PALETTE.text,
        clusterBkg:         "rgba(255,255,255,.015)",
        clusterBorder:      PALETTE.borderDim,
        edgeLabelBackground: PALETTE.cardSoft,
        nodeBorder:         PALETTE.border,
        mainBkg:            PALETTE.card
      }
    });

    // Collect every diagram source and wrap in a unified .mermaid div.
    var nodes = [];

    // 1) Markdown code fences: <pre><code data-lang="mermaid">
    document.querySelectorAll('code[data-lang="mermaid"]').forEach(function (code) {
      var pre = code.parentElement;
      var div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = code.textContent;
      // Optional filename — set via {% mermaid(name="...") %} or pages.html
      var name = code.getAttribute("data-name") || (pre && pre.getAttribute("data-name"));
      if (name) div.setAttribute("data-name", name);
      pre.parentNode.replaceChild(div, pre);
      nodes.push(div);
    });

    // 2) Shortcode wrappers: <div class="mermaid-direct">
    document.querySelectorAll(".mermaid-direct").forEach(function (el) {
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
        mermaid.run({ nodes: [el] })
          .then(function () {
            el.classList.add("mermaid-ready");
            setTimeout(renderNext, 30);
          })
          .catch(function (err) {
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
    window.addEventListener("scroll", function () {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      pb.style.width = (h > 0 ? (window.scrollY / h * 100) : 0) + "%";
    });
  }
});
