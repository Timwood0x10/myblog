/* ================================================
   Ownership Graph — WebGL Background (homepage only)
   Rust ownership semantics visualized with WebGL glow
   ================================================ */

document.addEventListener("DOMContentLoaded",function(){
  var canvas=document.getElementById("bg-canvas");
  if(!canvas)return;
  // Check WebGL support
  var gl=canvas.getContext("webgl")||canvas.getContext("experimental-webgl");
  if(!gl)return; // fall back to nothing

  // ============ Shaders ============
  var vsSource=[
    "attribute vec2 a_pos;",
    "attribute vec3 a_color;",
    "attribute float a_size;",
    "varying vec3 v_color;",
    "uniform vec2 u_res;",
    "void main(){",
      "vec2 p=a_pos/u_res*2.0-1.0;",
      "gl_Position=vec4(p,0.0,1.0);",
      "gl_PointSize=a_size;",
      "v_color=a_color;",
    "}"
  ].join("\n");

  var fsSource=[
    "precision mediump float;",
    "varying vec3 v_color;",
    "void main(){",
      "float d=distance(gl_PointCoord,vec2(0.5));",
      "if(d>0.5)discard;",
      "float glow=exp(-d*8.0);",
      "float core=smoothstep(0.5,0.0,d);",
      "float alpha=mix(glow*0.3,core*0.7,core);",
      "gl_FragColor=vec4(v_color,alpha);",
    "}"
  ].join("\n");

  function compileShader(src,type){
    var s=gl.createShader(type);
    gl.shaderSource(s,src);
    gl.compileShader(s);
    return s;
  }

  var prog=gl.createProgram();
  gl.attachShader(prog,compileShader(vsSource,gl.VERTEX_SHADER));
  gl.attachShader(prog,compileShader(fsSource,gl.FRAGMENT_SHADER));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  var uRes=gl.getUniformLocation(prog,"u_res");
  var aPos=gl.getAttribLocation(prog,"a_pos");
  var aColor=gl.getAttribLocation(prog,"a_color");
  var aSize=gl.getAttribLocation(prog,"a_size");

  // ============ Buffers ============
  var ptBuf=gl.createBuffer();
  var colBuf=gl.createBuffer();
  var sizeBuf=gl.createBuffer();
  var edgeBuf=gl.createBuffer();
  var arrowBuf=gl.createBuffer();
  var flowBuf=gl.createBuffer();
  var flowColBuf=gl.createBuffer();
  var flowSizeBuf=gl.createBuffer();

  // ============ Ownership Graph Simulation ============
  var nodes=[];
  var edges=[];
  var MAX_NODES=80;
  var MAX_EDGES=200;

  var colors={
    root: [120/255,226/255,160/255],
    depth1: [100/255,200/255,255/255],
    depth2: [179/255,136/255,255/255],
    depth3: [77/255,208/255,200/255],
  };

  function nodeColor(depth){
    if(depth===0)return colors.root;
    if(depth===1)return colors.depth1;
    if(depth===2)return colors.depth2;
    return colors.depth3;
  }

  function nodeSize(depth){
    return Math.max(3,8-depth*1.5);
  }

  // Root node
  nodes.push({
    x:0.5,y:0.5,vx:0,vy:0,
    depth:0,owner:-1,
    alive:true,age:0,
    targetX:0.5,targetY:0.5
  });

  function spawnNode(parentIdx){
    if(nodes.length>=MAX_NODES)return;
    var p=nodes[parentIdx];
    var angle=Math.random()*Math.PI*2;
    var dist=0.08+Math.random()*0.12;
    var child={
      x:p.x+Math.cos(angle)*dist,
      y:p.y+Math.sin(angle)*dist,
      vx:0,vy:0,
      depth:p.depth+1,
      owner:parentIdx,
      alive:true,age:0,
      targetX:p.x+Math.cos(angle)*dist,
      targetY:p.y+Math.sin(angle)*dist
    };
    nodes.push(child);
    edges.push({from:parentIdx,to:nodes.length-1});
  }

  // Seed initial nodes
  for(var i=0;i<10;i++)spawnNode(0);

  // Periodically spawn/drop
  var spawnTimer=0;
  var dropTimer=0;

  // ============ Flow Particles ============
  var flowParticles=[];
  var MAX_FLOW=25;
  var flowSpawnTimer=0;

  function spawnFlowParticle(){
    if(edges.length===0||flowParticles.length>=MAX_FLOW)return;
    var edgeIdx=Math.floor(Math.random()*edges.length);
    flowParticles.push({edgeIdx:edgeIdx,t:0});
  }

  function updateFlowParticles(){
    for(var i=flowParticles.length-1;i>=0;i--){
      var fp=flowParticles[i];
      var edge=edges[fp.edgeIdx];
      if(!edge){
        flowParticles.splice(i,1);
        continue;
      }
      var a=nodes[edge.from],b=nodes[edge.to];
      if(!a.alive||!b.alive){
        flowParticles.splice(i,1);
        continue;
      }
      fp.t+=0.025;
      if(fp.t>=1)flowParticles.splice(i,1);
    }
  }

  // ============ Resize ============
  var W,H;
  function resize(){
    W=window.innerWidth;
    H=window.innerHeight;
    canvas.width=W;
    canvas.height=H;
    gl.viewport(0,0,W,H);
    gl.uniform2f(uRes,W,H);
  }
  resize();
  var resizeTimer;
  window.addEventListener("resize",function(){
    cancelAnimationFrame(resizeTimer);
    resizeTimer=requestAnimationFrame(resize);
  });

  // ============ Physics ============
  var SPRING_K=0.002;
  var REPULSION_K=0.0001;
  var DAMPING=0.92;
  var EDGE_LEN=0.1;

  function simulate(){
    // Update targets based on time
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i];
      if(!n.alive)continue;

      // Root stays centered with slow wander
      if(i===0){
        n.targetX=0.5+Math.sin(n.age*0.002)*0.05;
        n.targetY=0.5+Math.cos(n.age*0.003)*0.05;
      }
      n.age++;
    }

    // Spring forces
    for(var e=0;e<edges.length;e++){
      var edge=edges[e];
      var a=nodes[edge.from],b=nodes[edge.to];
      if(!a.alive||!b.alive)continue;
      var dx=b.x-a.x,dy=b.y-a.y;
      var dist=Math.sqrt(dx*dx+dy*dy)||0.001;
      var force=(dist-EDGE_LEN)*SPRING_K;
      var fx=dx/dist*force,fy=dy/dist*force;
      // Pull child toward parent's target
      b.vx+=fx*0.5+(a.targetX-b.x)*0.0008;
      b.vy+=fy*0.5+(a.targetY-b.y)*0.0008;
      a.vx-=fx*0.3;
      a.vy-=fy*0.3;
    }

    // Repulsion between all nodes
    for(var i=0;i<nodes.length;i++){
      for(var j=i+1;j<nodes.length;j++){
        var a=nodes[i],b=nodes[j];
        if(!a.alive||!b.alive)continue;
        var dx=b.x-a.x,dy=b.y-a.y;
        var dist=Math.sqrt(dx*dx+dy*dy)||0.001;
        if(dist<0.3){
          var force=REPULSION_K/(dist*dist);
          a.vx-=dx/dist*force;
          a.vy-=dy/dist*force;
          b.vx+=dx/dist*force;
          b.vy+=dy/dist*force;
        }
      }
    }

    // Apply velocities
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i];
      if(!n.alive)continue;
      n.vx*=DAMPING;
      n.vy*=DAMPING;
      n.x+=n.vx;
      n.y+=n.vy;
      // Clamp to viewport bounds with soft padding
      if(n.x<0.02){n.x=0.02;n.vx*=-0.5}
      if(n.x>0.98){n.x=0.98;n.vx*=-0.5}
      if(n.y<0.02){n.y=0.02;n.vy*=-0.5}
      if(n.y>0.98){n.y=0.98;n.vy*=-0.5}
    }
  }

  // ============ Spawn / Drop lifecycle ============
  function spawnCycle(){
    // Find a node that can have children (depth < 4)
    var candidates=[];
    for(var i=0;i<nodes.length;i++){
      if(nodes[i].alive&&nodes[i].depth<4)candidates.push(i);
    }
    if(candidates.length>0&&nodes.length<MAX_NODES){
      var idx=candidates[Math.floor(Math.random()*candidates.length)];
      spawnNode(idx);
    }
  }

  function dropCycle(){
    // Drop a leaf node (node with no children)
    var childSet={};
    for(var e=0;e<edges.length;e++){
      childSet[edges[e].to]=true;
    }
    var leaves=[];
    for(var i=1;i<nodes.length;i++){ // skip root
      if(nodes[i].alive&&!childSet[i])leaves.push(i);
    }
    if(leaves.length>0){
      var idx=leaves[Math.floor(Math.random()*leaves.length)];
      nodes[idx].alive=false;
      // Remove edges to this node
      for(var e=edges.length-1;e>=0;e--){
        if(edges[e].from===idx||edges[e].to===idx){
          edges.splice(e,1);
        }
      }
    }
  }

  // ============ Render ============
  function render(){
    // Prepare particle data
    var pts=[],cols=[],sizes=[];
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i];
      if(!n.alive)continue;
      pts.push(n.x*W,n.y*H);
      var c=nodeColor(n.depth);
      cols.push(c[0],c[1],c[2]);
      sizes.push(nodeSize(n.depth)+Math.sin(n.age*0.05)*1.5);
    }

    // Prepare edge data + arrowhead triangles
    var edgePts=[];
    var arrowVerts=[];
    var arrowSize=10,arrowWidth=6;
    for(var e=0;e<edges.length;e++){
      var edge=edges[e];
      var a=nodes[edge.from],b=nodes[edge.to];
      if(!a.alive||!b.alive)continue;
      var ax=a.x*W,ay=a.y*H,bx=b.x*W,by=b.y*H;
      edgePts.push(ax,ay,bx,by);

      // Arrowhead: triangle pointing from parent→child, placed at child
      var dx=bx-ax,dy=by-ay;
      var len=Math.sqrt(dx*dx+dy*dy)||1;
      var nx=dx/len,ny=dy/len;
      var px=-ny,py=nx; // perpendicular
      // tip at child, wings extend backward toward parent
      arrowVerts.push(
        bx,by,
        bx-nx*arrowSize+px*arrowWidth,by-ny*arrowSize+py*arrowWidth,
        bx-nx*arrowSize-px*arrowWidth,by-ny*arrowSize-py*arrowWidth
      );
    }

    // Prepare flow particle data
    var flowPts=[],flowCols=[],flowSizes=[];
    for(var f=0;f<flowParticles.length;f++){
      var fp=flowParticles[f];
      var edge=edges[fp.edgeIdx];
      if(!edge)continue;
      var a=nodes[edge.from],b=nodes[edge.to];
      if(!a.alive||!b.alive)continue;
      // Interpolate position along edge
      var x=a.x+(b.x-a.x)*fp.t;
      var y=a.y+(b.y-a.y)*fp.t;
      flowPts.push(x*W,y*H);
      // Color: white-cyan core with depth influence
      var dc=nodeColor(b.depth);
      flowCols.push(
        0.7+dc[0]*0.3,
        0.7+dc[1]*0.3,
        0.7+dc[2]*0.3
      );
      // Size: bigger in middle of edge, smaller at ends
      var mid=1-Math.abs(fp.t-0.5)*2; // 0→1→0
      flowSizes.push(3+mid*3);
    }

    // Clear
    gl.clearColor(0,0,0,0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA,gl.ONE);

    // --- Draw edges (fixed color via vertexAttrib3f) ---
    if(edgePts.length>0){
      gl.disableVertexAttribArray(aColor);
      gl.disableVertexAttribArray(aSize);
      gl.bindBuffer(gl.ARRAY_BUFFER,edgeBuf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(edgePts),gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,0,0);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttrib3f(aColor,120/255,226/255,160/255);
      gl.vertexAttrib1f(aSize,1);
      gl.drawArrays(gl.LINES,0,edgePts.length/2);
    }

    // --- Draw arrowheads (triangles, same fixed green) ---
    if(arrowVerts.length>0){
      gl.bindBuffer(gl.ARRAY_BUFFER,arrowBuf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(arrowVerts),gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,0,0);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttrib3f(aColor,120/255,226/255,160/255);
      gl.vertexAttrib1f(aSize,1);
      gl.drawArrays(gl.TRIANGLES,0,arrowVerts.length/2);
    }

    // --- Draw nodes (re-enable per-vertex color/size) ---
    gl.enableVertexAttribArray(aColor);
    gl.enableVertexAttribArray(aSize);
    gl.bindBuffer(gl.ARRAY_BUFFER,ptBuf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(pts),gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,0,0);
    gl.enableVertexAttribArray(aPos);

    gl.bindBuffer(gl.ARRAY_BUFFER,colBuf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(cols),gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(aColor,3,gl.FLOAT,false,0,0);

    gl.bindBuffer(gl.ARRAY_BUFFER,sizeBuf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(sizes),gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(aSize,1,gl.FLOAT,false,0,0);

    gl.drawArrays(gl.POINTS,0,pts.length/2);

    // --- Draw flow particles (per-vertex color/size already enabled) ---
    if(flowPts.length>0){
      gl.bindBuffer(gl.ARRAY_BUFFER,flowBuf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(flowPts),gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,0,0);
      gl.enableVertexAttribArray(aPos);

      gl.bindBuffer(gl.ARRAY_BUFFER,flowColBuf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(flowCols),gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(aColor,3,gl.FLOAT,false,0,0);

      gl.bindBuffer(gl.ARRAY_BUFFER,flowSizeBuf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(flowSizes),gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(aSize,1,gl.FLOAT,false,0,0);

      gl.drawArrays(gl.POINTS,0,flowPts.length/2);
    }
  }

  // ============ Main Loop ============
  var frameCount=0;
  function loop(){
    frameCount++;
    // Spawn/drop on timer
    spawnTimer++;
    if(spawnTimer>120&&nodes.length<MAX_NODES){
      spawnCycle();
      spawnTimer=0;
    }
    dropTimer++;
    if(dropTimer>200&&nodes.length>3){
      dropCycle();
      dropTimer=0;
    }

    // Flow particles
    flowSpawnTimer++;
    if(flowSpawnTimer>8&&edges.length>0){
      spawnFlowParticle();
      flowSpawnTimer=0;
    }
    updateFlowParticles();

    simulate();
    render();
    requestAnimationFrame(loop);
  }
  loop();
});
