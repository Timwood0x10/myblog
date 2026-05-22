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
  // ============================================
  if(typeof mermaid!=="undefined"){
    mermaid.initialize({
      theme:"base",
      securityLevel:"loose",
      flowchart:{
        htmlLabels:true,
        curve:"basis",
        useMaxWidth:true,
        nodeSpacing:40,
        rankSpacing:60,
        padding:24
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
        clusterBkg:"rgba(255,255,255,.025)",
        clusterBorder:"rgba(255,255,255,.12)"
      }
    });
    var nodes=[];
    document.querySelectorAll("code[data-lang=mermaid]").forEach(function(el){
      var pre=el.parentElement;
      var div=document.createElement("div");div.className="mermaid";
      div.textContent=el.textContent;
      pre.parentNode.replaceChild(div,pre);nodes.push(div)
    });
    document.querySelectorAll(".mermaid-direct").forEach(function(el){
      el.className="mermaid";nodes.push(el)
    });
    if(nodes.length){
      nodes.forEach(function(el){
        mermaid.run({nodes:[el]}).then(function(){
          el.classList.add("mermaid-ready");
        }).catch(function(err){
          console.warn("Mermaid: skip one diagram (syntax error)", err);
          el.style.display="none";
        });
      });
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
