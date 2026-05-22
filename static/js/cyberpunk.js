/* ================================================
   Cyberpunk Theme — Core (Mermaid + progress bar)
   ================================================ */

document.addEventListener("DOMContentLoaded",function(){

  // ============================================
  // Mermaid initialization
  // ============================================
  if(typeof mermaid!=="undefined"){
    mermaid.initialize({theme:"base",themeVariables:{
      background:"transparent",
      primaryColor:"#2a2d35",
      primaryBorderColor:"rgba(255,255,255,.3)",
      primaryTextColor:"rgba(255,255,255,.9)",
      lineColor:"rgba(255,255,255,.7)",
      fontSize:"14px",
      tertiaryColor:"transparent",
      actorBkg:"#2a2d35",
      actorBorder:"rgba(255,255,255,.3)",
      actorTextColor:"#ffffff"
    },flowchart:{
      useMaxWidth:true,
      htmlLabels:true,
      curve:"basis",
      padding:15,
      rankSep:60,
      nodeSep:30,
      wrap:true
    },sequence:{
      useMaxWidth:true,
      wrap:true,
      width:150,
      marginMax:30,
      marginMin:10,
      boxMargin:10,
      noteMargin:15,
      messageMargin:40
    }});
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
