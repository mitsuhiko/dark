(function() {
  // Default dither mode - can be overridden via URL parameter ?dither=gaussian|atkinson|noise
  const DEFAULT_DITHER = 'atkinson';

  const canvas = document.getElementById('header-canvas');
  const gl = canvas.getContext('webgl');
  if (!gl) return;

  const vsSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0, 1);
      v_texCoord = a_texCoord;
    }
  `;

  const fsSource = `
    precision highp float;
    uniform sampler2D u_image;
    uniform sampler2D u_bayer;
    uniform vec2 u_resolution;
    uniform int u_ditherMode;  // 0 = Gaussian, 1 = Atkinson, 2 = noise
    varying vec2 v_texCoord;

    // Hash function for stable random noise
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Atkinson-style threshold pattern (4x4)
    // Mimics the high-contrast stippled look of Atkinson error diffusion
    float atkinsonThreshold(vec2 pos) {
      int x = int(mod(pos.x, 4.0));
      int y = int(mod(pos.y, 4.0));
      int idx = y * 4 + x;
      // Custom pattern optimized for Atkinson-like appearance
      // More clustered dots, higher contrast than Bayer
      float thresholds[16];
      thresholds[0] = 0.0;    thresholds[1] = 12.0;  thresholds[2] = 3.0;   thresholds[3] = 15.0;
      thresholds[4] = 8.0;   thresholds[5] = 4.0;   thresholds[6] = 11.0;  thresholds[7] = 7.0;
      thresholds[8] = 2.0;   thresholds[9] = 14.0;  thresholds[10] = 1.0;  thresholds[11] = 13.0;
      thresholds[12] = 10.0; thresholds[13] = 6.0;  thresholds[14] = 9.0;  thresholds[15] = 5.0;
      for (int i = 0; i < 16; i++) {
        if (i == idx) return thresholds[i] / 16.0;
      }
      return 0.0;
    }

    void main() {
      vec4 color = texture2D(u_image, v_texCoord);
      float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));

      // Fade to solid dark at the bottom edge for seamless blend with background
      float screenY = gl_FragCoord.y / u_resolution.y;
      float fade = smoothstep(0.0, 0.4, screenY);
      gray *= fade;

      float threshold;
      if (u_ditherMode == 2) {
        // Noise-based random dithering (stable per pixel)
        threshold = hash(gl_FragCoord.xy);
      } else if (u_ditherMode == 1) {
        // Atkinson-style dithering
        // Apply slight contrast boost to mimic Atkinson's 75% error diffusion
        gray = gray * 1.2 - 0.1;
        gray = clamp(gray, 0.0, 1.0);
        threshold = atkinsonThreshold(gl_FragCoord.xy);
      } else {
        // Gaussian (Bayer) ordered dithering
        vec2 bayerCoord = mod(gl_FragCoord.xy, 8.0) / 8.0;
        threshold = texture2D(u_bayer, bayerCoord).r;
      }

      // Add small offset so gray=0 always renders as dark
      float dithered = step(threshold + 0.1, gray);
      vec3 dark = vec3(0.067);  // #111
      vec3 cream = vec3(0.91, 0.835, 0.718);  // #e8d5b7
      gl_FragColor = vec4(mix(dark, cream, dithered), 1.0);
    }
  `;

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);

  const posBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const texLoc = gl.getAttribLocation(program, 'a_texCoord');
  gl.enableVertexAttribArray(texLoc);

  // Create 8x8 Bayer matrix texture
  const bayer = new Uint8Array([
    0,128,32,160,8,136,40,168,
    192,64,224,96,200,72,232,104,
    48,176,16,144,56,184,24,152,
    240,112,208,80,248,120,216,88,
    12,140,44,172,4,132,36,164,
    204,76,236,108,196,68,228,100,
    60,188,28,156,52,180,20,148,
    252,124,220,92,244,116,212,84
  ]);
  const bayerTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, bayerTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 8, 8, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bayer);
  gl.uniform1i(gl.getUniformLocation(program, 'u_bayer'), 1);

  // Dither mode: 0 = Gaussian, 1 = Atkinson, 2 = noise
  // Can be set via URL parameter: ?dither=gaussian, ?dither=atkinson, or ?dither=noise
  const ditherModes = { gaussian: 0, atkinson: 1, noise: 2 };
  const urlParams = new URLSearchParams(window.location.search);
  const ditherParam = urlParams.get('dither');
  const ditherMode = ditherModes[ditherParam] ?? ditherModes[DEFAULT_DITHER];
  gl.uniform1i(gl.getUniformLocation(program, 'u_ditherMode'), ditherMode);

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.src = '/static/waves.mp4';

  let texture = null;
  let texBuffer = null;
  let resolutionLoc = null;
  let animationId = null;

  function setupCanvas() {
    canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Calculate texture coords to show bottom of video (cover behavior)
    // With UNPACK_FLIP_Y_WEBGL=true: tex Y=0 is video bottom, Y=1 is video top
    const canvasAspect = canvas.width / canvas.height;
    const videoAspect = video.videoWidth / video.videoHeight;
    let texTop = 1, texBottom = 0, texLeft = 0, texRight = 1;
    if (videoAspect > canvasAspect) {
      // Video is wider - crop sides, show full height
      const scale = canvasAspect / videoAspect;
      texLeft = (1 - scale) / 2;
      texRight = 1 - texLeft;
    } else {
      // Video is taller - crop top (keep bottom)
      const scale = videoAspect / canvasAspect;
      texTop = scale;  // Only show bottom portion
      texBottom = 0;
    }

    if (!texBuffer) {
      texBuffer = gl.createBuffer();
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      texLeft, texBottom,   texRight, texBottom,
      texLeft, texTop,      texRight, texTop
    ]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

    if (!texture) {
      texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);
    }

    resolutionLoc = gl.getUniformLocation(program, 'u_resolution');
    gl.uniform2f(resolutionLoc, canvas.width, canvas.height);
  }

  function render() {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    animationId = requestAnimationFrame(render);
  }

  video.addEventListener('loadeddata', function() {
    setupCanvas();
    video.play();
    render();
  });

  window.addEventListener('resize', function() {
    if (video.readyState >= 2) {
      setupCanvas();
    }
  });
})();

// Dithered image effect for .dithered-image elements
(function() {
  const DEFAULT_DITHER = 'atkinson';

  // Fragment shader with border fade + noise for jagged edges
  const fsSourceImage = `
    precision highp float;
    uniform sampler2D u_image;
    uniform sampler2D u_bayer;
    uniform vec2 u_resolution;
    uniform int u_ditherMode;
    uniform float u_time;
    varying vec2 v_texCoord;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Animated noise for the "alive" effect
    float animatedNoise(vec2 p, float t) {
      // Slow-moving noise pattern - transitions once per second
      float n1 = hash(p + floor(t));
      float n2 = hash(p + floor(t) + 1.0);
      float blend = fract(t);
      return mix(n1, n2, smoothstep(0.0, 1.0, blend));
    }

    float atkinsonThreshold(vec2 pos) {
      int x = int(mod(pos.x, 4.0));
      int y = int(mod(pos.y, 4.0));
      int idx = y * 4 + x;
      float thresholds[16];
      thresholds[0] = 0.0;    thresholds[1] = 12.0;  thresholds[2] = 3.0;   thresholds[3] = 15.0;
      thresholds[4] = 8.0;   thresholds[5] = 4.0;   thresholds[6] = 11.0;  thresholds[7] = 7.0;
      thresholds[8] = 2.0;   thresholds[9] = 14.0;  thresholds[10] = 1.0;  thresholds[11] = 13.0;
      thresholds[12] = 10.0; thresholds[13] = 6.0;  thresholds[14] = 9.0;  thresholds[15] = 5.0;
      for (int i = 0; i < 16; i++) {
        if (i == idx) return thresholds[i] / 16.0;
      }
      return 0.0;
    }

    void main() {
      vec4 color = texture2D(u_image, v_texCoord);
      float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));

      // Calculate distance from all edges with noise for jagged effect
      vec2 uv = gl_FragCoord.xy / u_resolution;
      float edgeNoise = hash(gl_FragCoord.xy * 0.5) * 0.15;

      float fadeLeft = smoothstep(0.0, 0.15 + edgeNoise, uv.x);
      float fadeRight = smoothstep(0.0, 0.15 + edgeNoise, 1.0 - uv.x);
      float fadeBottom = smoothstep(0.0, 0.15 + edgeNoise, uv.y);
      float fadeTop = smoothstep(0.0, 0.15 + edgeNoise, 1.0 - uv.y);

      float fade = fadeLeft * fadeRight * fadeBottom * fadeTop;
      gray *= fade;

      float threshold;
      if (u_ditherMode == 2) {
        threshold = hash(gl_FragCoord.xy);
      } else if (u_ditherMode == 1) {
        gray = gray * 1.2 - 0.1;
        gray = clamp(gray, 0.0, 1.0);
        threshold = atkinsonThreshold(gl_FragCoord.xy);
      } else {
        vec2 bayerCoord = mod(gl_FragCoord.xy, 8.0) / 8.0;
        threshold = texture2D(u_bayer, bayerCoord).r;
      }

      // Animated noise - affects the dither threshold to make bright pixels flicker
      vec2 noiseCoord = gl_FragCoord.xy * 0.15;
      float noise = animatedNoise(noiseCoord, u_time) - 0.5;

      // Subtle flicker - varies the threshold over time for organic movement
      float flicker = 0.08 * sin(u_time * 2.0 + hash(gl_FragCoord.xy * 0.2) * 6.28);

      // Effect intensity ramps up with brightness - no effect on dark areas
      // Starts at gray ~0.05, full effect at gray ~0.3+
      float effectIntensity = smoothstep(0.05, 0.3, gray);

      // Apply noise and flicker to the dither threshold, scaled by brightness
      float animatedThreshold = threshold + 0.1 + (noise * 0.15 + flicker) * effectIntensity;
      float dithered = step(animatedThreshold, gray);

      vec3 dark = vec3(0.067);
      vec3 cream = vec3(0.91, 0.835, 0.718);

      gl_FragColor = vec4(mix(dark, cream, dithered), 1.0);
    }
  `;

  const vsSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0, 1);
      v_texCoord = a_texCoord;
    }
  `;

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function initDitheredImage(img) {
    const canvas = document.createElement('canvas');
    canvas.className = img.className.replace('dithered-image', '').trim();
    canvas.style.cssText = img.style.cssText;

    // Copy image dimensions to canvas
    const imgRect = img.getBoundingClientRect();
    canvas.style.width = imgRect.width + 'px';
    canvas.style.height = imgRect.height + 'px';

    const gl = canvas.getContext('webgl');
    if (!gl) return;

    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSourceImage);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    // Position buffer
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Texture coord buffer
    const texBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);
    const texLoc = gl.getAttribLocation(program, 'a_texCoord');
    gl.enableVertexAttribArray(texLoc);
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

    // Bayer matrix texture
    const bayer = new Uint8Array([
      0,128,32,160,8,136,40,168,
      192,64,224,96,200,72,232,104,
      48,176,16,144,56,184,24,152,
      240,112,208,80,248,120,216,88,
      12,140,44,172,4,132,36,164,
      204,76,236,108,196,68,228,100,
      60,188,28,156,52,180,20,148,
      252,124,220,92,244,116,212,84
    ]);
    const bayerTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bayerTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 8, 8, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bayer);
    gl.uniform1i(gl.getUniformLocation(program, 'u_bayer'), 1);

    // Dither mode
    const ditherModes = { gaussian: 0, atkinson: 1, noise: 2 };
    const urlParams = new URLSearchParams(window.location.search);
    const ditherParam = urlParams.get('dither');
    const ditherMode = ditherModes[ditherParam] ?? ditherModes[DEFAULT_DITHER];
    gl.uniform1i(gl.getUniformLocation(program, 'u_ditherMode'), ditherMode);

    // Image texture
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);

    const resolutionLoc = gl.getUniformLocation(program, 'u_resolution');
    const timeLoc = gl.getUniformLocation(program, 'u_time');

    let startTime = performance.now();
    let needsResize = true;

    function render() {
      if (needsResize) {
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * window.devicePixelRatio;
        canvas.height = rect.height * window.devicePixelRatio;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(resolutionLoc, canvas.width, canvas.height);
        needsResize = false;
      }

      // Update time uniform for animation (2000 = half speed)
      const elapsed = (performance.now() - startTime) / 2000.0;
      gl.uniform1f(timeLoc, elapsed);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      requestAnimationFrame(render);
    }

    img.parentNode.replaceChild(canvas, img);

    if (img.complete) {
      render();
    } else {
      img.onload = render;
    }

    window.addEventListener('resize', function() {
      needsResize = true;
    });
  }

  // Initialize all dithered images when DOM is ready
  function init() {
    document.querySelectorAll('.dithered-image').forEach(initDitheredImage);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
