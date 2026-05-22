/* ================================================
   Subtle terminal-style background with minimal cyberpunk elements
   ================================================ */

document.addEventListener("DOMContentLoaded", function() {
  var canvas = document.getElementById("bg-canvas");
  if (!canvas) return;
  
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var W, H;
  var particles = [];
  var PARTICLE_COUNT = 20; // Reduced from original

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  resize();
  window.addEventListener("resize", resize);

  // Create subtle particles instead of large orbs
  for (var i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.1, // Slower movement
      vy: (Math.random() - 0.5) * 0.1,
      size: 1 + Math.random() * 2, // Small dots
      alpha: 0.1 + Math.random() * 0.2 // Very subtle
    });
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    
    // Dark terminal background
    ctx.fillStyle = "rgb(5, 5, 8)";
    ctx.fillRect(0, 0, W, H);

    // Draw subtle particles
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(100, 200, 255, ${p.alpha})`; // Subtle blue glow
      ctx.fill();

      // Move particles slowly
      p.x += p.vx;
      p.y += p.vy;

      // Wrap around edges
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;
    }

    requestAnimationFrame(draw);
  }

  draw();
});