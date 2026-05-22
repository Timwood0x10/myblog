/* ================================================
   Subtle animated gradient background — cyberpunk purple
   Floating soft orbs, no distracting text
   ================================================ */

document.addEventListener("DOMContentLoaded",function(){
  var canvas=document.getElementById("bg-canvas");
  if(!canvas)return;
  var ctx=canvas.getContext("2d");
  if(!ctx)return;

  var W,H;
  var orbs=[];
  var ORB_COUNT=5;

  function resize(){
    W=canvas.width=window.innerWidth;
    H=canvas.height=window.innerHeight;
  }

  resize();
  window.addEventListener("resize",resize);

  // Create soft gradient orbs
  var colors=[
    {r:100,g:60,b:180},   // deep purple
    {r:140,g:80,b:200},   // medium purple
    {r:80,g:50,b:160},    // dark violet
    {r:120,g:70,b:190},   // lavender
    {r:60,g:40,b:140},    // midnight purple
  ];

  for(var i=0;i<ORB_COUNT;i++){
    orbs.push({
      x:Math.random()*W,
      y:Math.random()*H,
      vx:(Math.random()-0.5)*0.3,
      vy:(Math.random()-0.5)*0.2,
      radius:200+Math.random()*300,
      color:colors[i%colors.length],
      alpha:0.03+Math.random()*0.03
    });
  }

  function draw(){
    ctx.clearRect(0,0,W,H);

    // Dark base
    ctx.fillStyle="rgb(2,4,10)";
    ctx.fillRect(0,0,W,H);

    // Draw each orb as a radial gradient
    for(var i=0;i<orbs.length;i++){
      var o=orbs[i];
      var grad=ctx.createRadialGradient(o.x,o.y,0,o.x,o.y,o.radius);
      grad.addColorStop(0,"rgba("+o.color.r+","+o.color.g+","+o.color.b+","+o.alpha.toFixed(3)+")");
      grad.addColorStop(1,"rgba("+o.color.r+","+o.color.g+","+o.color.b+",0)");
      ctx.fillStyle=grad;
      ctx.fillRect(0,0,W,H);

      // Move
      o.x+=o.vx;
      o.y+=o.vy;

      // Bounce off edges softly
      if(o.x<-o.radius*0.5)o.vx=Math.abs(o.vx);
      if(o.x>W+o.radius*0.5)o.vx=-Math.abs(o.vx);
      if(o.y<-o.radius*0.5)o.vy=Math.abs(o.vy);
      if(o.y>H+o.radius*0.5)o.vy=-Math.abs(o.vy);
    }

    requestAnimationFrame(draw);
  }

  draw();
});
