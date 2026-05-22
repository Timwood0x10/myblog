/* ================================================
   Cyberpunk Theme — Core (Mermaid + progress bar + tech typer)
   ================================================ */

document.addEventListener("DOMContentLoaded",function(){

  // ============================================
  // Terminal logo — typing carousel
  // ============================================
  var typer=document.getElementById("tech-typer");
  if(typer){
    // Tech stack from GitHub profile: Rust, Go, Zig, Python + focus areas
    var techs=["Rust","Go","Zig","Python","LLVM","FFI","Static Analysis","Memory Safety"];
    var idx=0,charIdx=0,deleting=false,paused=false;
    var TYPE_SPEED=100,DELETE_SPEED=55,PAUSE_MS=2500;

    function tick(){
      var word=techs[idx];
      if(!deleting){
        charIdx++;
        typer.textContent=word.substring(0,charIdx);
        if(charIdx===word.length){
          paused=true;
          setTimeout(function(){paused=false;deleting=true;tick();},PAUSE_MS);
          return;
        }
        setTimeout(tick,TYPE_SPEED);
      }else{
        charIdx--;
        typer.textContent=word.substring(0,charIdx);
        if(charIdx===0){
          deleting=false;
          idx=(idx+1)%techs.length;
          setTimeout(tick,400);
          return;
        }
        setTimeout(tick,DELETE_SPEED);
      }
    }
    tick();
  }

  // ============================================
  // Mermaid initialization
  // ============================================
  if(typeof mermaid!=="undefined"){
    mermaid.initialize({
      theme:"base",
      securityLevel:"loose",
      flowchart:{
        htmlLabels:true,
        curve:"basis",
        useMaxWidth:true,
        nodeSpacing:30,
        rankSpacing:50,
        padding:20
      },
      themeVariables:{
        background:"transparent",
        primaryColor:"#2a2d35",
        primaryBorderColor:"rgba(255,255,255,.3)",
        primaryTextColor:"rgba(255,255,255,.9)",
        lineColor:"rgba(255,255,255,.7)",
        fontSize:"14px",
        fontFamily:"'JetBrains Mono','Fira Code','Hack',monospace",
        tertiaryColor:"transparent",
        actorBkg:"#2a2d35",
        actorBorder:"rgba(255,255,255,.3)",
        actorTextColor:"#ffffff",
        clusterBkg:"rgba(255,255,255,.03)",
        clusterBorder:"rgba(255,255,255,.15)"
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
    // Each diagram is rendered individually so one syntax error
    // doesn't block the rest, and errors are caught gracefully.
    // Failed diagrams are hidden to prevent raw source text leakage.
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
