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
          applyCyberpunkStyle(el);
        }).catch(function(err){
          console.warn("Mermaid: skip one diagram (syntax error)", err);
          el.style.display="none";
        });
      });
    }
  }

  // ============================================
  // Cyberpunk terminal-style post-processing
  // Sharp angles, neon borders, terminal aesthetic
  // ============================================
  function applyCyberpunkStyle(container){
    var svg=container.querySelector("svg");
    if(!svg)return;

    // 1. Convert rects to sharp-angled terminal shapes (slanted corners)
    svg.querySelectorAll(".node rect, .cluster rect").forEach(function(rect){
      var w=parseFloat(rect.getAttribute("width")||0);
      var h=parseFloat(rect.getAttribute("height")||0);
      var x=parseFloat(rect.getAttribute("x")||0);
      var y=parseFloat(rect.getAttribute("y")||0);
      if(w<2||h<2)return;
      var cut=Math.min(6,w/8,h/8);
      var path="M"+(x+cut)+","+y+" L"+(x+w-cut)+","+y+" L"+(x+w)+","+(y+cut)+" L"+(x+w)+","+(y+h-cut)+" L"+(x+w-cut)+","+(y+h)+" L"+(x+cut)+","+(y+h)+" L"+x+","+(y+h-cut)+" L"+x+","+(y+cut)+"Z";
      var pathEl=document.createElementNS("http://www.w3.org/2000/svg","path");
      pathEl.setAttribute("d",path);
      copyAttrs(rect,pathEl,["fill","stroke","stroke-width","fill-opacity","stroke-opacity"]);
      rect.parentNode.replaceChild(pathEl,rect);
    });

    // 2. Add corner accent lines to nodes (terminal bracket style)
    svg.querySelectorAll(".node").forEach(function(node){
      var path=node.querySelector("path");
      if(!path)return;
      var bbox=path.getBBox?path.getBBox():{x:0,y:0,width:0,height:0};
      if(bbox.width<10)return;
      var g=node.querySelector("g")||node;
      var accent=document.createElementNS("http://www.w3.org/2000/svg","path");
      var ax=bbox.x,ay=bbox.y,aw=bbox.width,ah=bbox.height,c=4;
      var d="M"+ax+","+(ay+c)+" L"+ax+","+ay+" L"+(ax+c)+","+ay;
      d+=" M"+(ax+aw-c)+","+ay+" L"+(ax+aw)+","+ay+" L"+(ax+aw)+","+(ay+c);
      d+=" M"+(ax+aw)+","+(ay+ah-c)+" L"+(ax+aw)+","+(ay+ah)+" L"+(ax+aw-c)+","+(ay+ah);
      d+=" M"+(ax+c)+","+(ay+ah)+" L"+ax+","+(ay+ah)+" L"+ax+","+(ay+ah-c);
      accent.setAttribute("d",d);
      accent.setAttribute("fill","none");
      accent.setAttribute("stroke",path.getAttribute("stroke")||"#fff");
      accent.setAttribute("stroke-width","1.5");
      accent.setAttribute("stroke-opacity",".6");
      g.appendChild(accent);
    });
  }

  // Copy specified attributes from source to target element
  function copyAttrs(src,tgt,attrs){
    attrs.forEach(function(a){
      var v=src.getAttribute(a);
      if(v!==null)tgt.setAttribute(a,v);
    });
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
