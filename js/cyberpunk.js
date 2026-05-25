/* ================================================
   Cyberpunk Theme — Core (Mermaid + progress bar + tech typer)
   ================================================ */

document.addEventListener("DOMContentLoaded",function(){

  // ============================================
  // Terminal prompt — continuous typing effect
  // Types: Tim@0x10:~ Rust | Go | Zig | Python
  // ============================================
  var typer=document.getElementById("tech-typer");
  if(typer){
    var techs=["Rust","Go","Zig","Python","LLVM","FFI","Static Analysis","Memory Safety"];
    var idx=0,charIdx=0,phase="typing";
    var TYPE_SPEED=120,ERASE_SPEED=60,PAUSE_AFTER_TYPE=1800,PAUSE_AFTER_ERASE=300;

    function tick(){
      var word=techs[idx];
      if(phase==="typing"){
        charIdx++;
        typer.textContent=word.substring(0,charIdx);
        if(charIdx>=word.length){
          phase="pause_after_type";
          setTimeout(function(){phase="erasing";tick();},PAUSE_AFTER_TYPE);
          return;
        }
        setTimeout(tick,TYPE_SPEED);
      }else if(phase==="erasing"){
        charIdx--;
        typer.textContent=word.substring(0,charIdx);
        if(charIdx<=0){
          phase="pause_after_erase";
          setTimeout(function(){phase="typing";idx=(idx+1)%techs.length;tick();},PAUSE_AFTER_ERASE);
          return;
        }
        setTimeout(tick,ERASE_SPEED);
      }
    }
    tick();
  }

  // ============================================
  // Mermaid initialization — cyberpunk terminal style
  // Unified configuration for ALL pages (homepage + articles)
  // ============================================
  if(typeof mermaid!=="undefined"){
    mermaid.initialize({
      theme:"base",
      securityLevel:"loose",
      startOnLoad:false,
      flowchart:{
        htmlLabels:true,
        curve:"basis",
        useMaxWidth:true,
        nodeSpacing:50,
        rankSpacing:70,
        padding:20,
        wrap:true,
        diagramPadding:16,
        useMaxWidth:true
      },
      sequence:{
        useMaxWidth:true,
        wrap:true,
        width:180,
        marginMax:40,
        marginMin:15,
        boxMargin:15,
        noteMargin:20,
        messageMargin:50
      },
      themeVariables:{
        background:"transparent",
        primaryColor:"#2a2d35",
        primaryBorderColor:"rgba(255,255,255,.35)",
        primaryTextColor:"rgba(255,255,255,.9)",
        lineColor:"rgba(255,255,255,.55)",
        fontSize:"13px",
        fontFamily:"'JetBrains Mono','Fira Code','Hack',monospace",
        tertiaryColor:"transparent",
        actorBkg:"#2a2d35",
        actorBorder:"rgba(255,255,255,.35)",
        actorTextColor:"#ffffff",
        clusterBkg:"rgba(255,255,255,.03)",
        clusterBorder:"rgba(255,255,255,.15)"
      }
    });

    // Collect all mermaid diagrams from different sources
    var nodes=[];

    // 1. Code blocks with data-lang="mermaid" (from markdown)
    document.querySelectorAll("code[data-lang=mermaid]").forEach(function(el){
      var pre=el.parentElement;
      var div=document.createElement("div");div.className="mermaid";
      div.textContent=el.textContent;
      pre.parentNode.replaceChild(div,pre);nodes.push(div)
    });

    // 2. Direct mermaid containers (from shortcodes)
    document.querySelectorAll(".mermaid-direct").forEach(function(el){
      el.className="mermaid";nodes.push(el)
    });

    // Render each diagram individually to prevent layout conflicts
    // Use sequential rendering with small delay for stability
    if(nodes.length>0){
      var renderIndex=0;

      function renderNext(){
        if(renderIndex>=nodes.length)return;

        var el=nodes[renderIndex];
        renderIndex++;

        // Ensure element is visible before rendering
        el.style.visibility="hidden";
        el.style.minHeight="100px";

        mermaid.run({nodes:[el]}).then(function(){
          el.classList.add("mermaid-ready");
          el.style.visibility="visible";

          // Small delay between renders to prevent conflicts
          setTimeout(renderNext,50);
        }).catch(function(err){
          console.warn("Mermaid: skip one diagram (syntax error)", err);
          el.style.display="none";

          // Continue rendering next diagram even if this one failed
          setTimeout(renderNext,50);
        });
      }

      // Start rendering after a short delay to ensure DOM is ready
      setTimeout(renderNext,100);
    }
  }

  // ============================================
  // Reading progress bar
  // ============================================
  var pb=document.getElementById("progress-bar");
  window.addEventListener("scroll",function(){
    var h=document.documentElement.scrollHeight-window.innerHeight;
    pb.style.width=(h>0?(window.scrollY/h*100):0)+"%"
  });
});
