import { fontsOf } from './pack-art.mjs'

// The revealed card of AI credit packs (/credits), ported from repo-inference (web/card.js), drawn in WebGL as a real foil card: a 3D card with perspective that bows a little when it turns
// fast, rounded corners, and a holographic foil whose rainbow, sheen and glitter follow the card's real angle, so the
// colours sweep across it as it turns and as you tilt it. RepoCat floats above the art window (parallax), and a point
// light makes a glare spot that follows the pointer.
//
// The foil material follows the Holographic effect of Shaders (https://github.com/shader-effects-inc/shaders, MIT,
// Copyright (c) 2026 Shader Effects Inc.; the notice is in NOTICE.md here): laminate crinkle on the normal,
// a diffraction hue from noise blotches plus a ramp plus the tilt, a metallic sheen, glitter flakes, and grain. The printed faces (frame, text) are 2D
// canvases; a second, smaller canvas per face says where the foil is (red) and where the print is glossy (green).

const W = 640, H = 896;                                  // the card in drawing units (5:7)
const COLOR_PX = 1024, MASK_PX = 512;                    // texture sizes: powers of two, so they can have mipmaps
const ART = {x: 64, y: 104, w: 512, h: 410};             // the art window
const CAT = {x: W / 2 - 190, y: 124, w: 380, h: 380};    // RepoCat in the art window
const RARITY = {
  common: {glow: [0.67, 0.71, 0.76], foil: [0.78, 0.80, 0.84], sat: 0.32, holo: 0.42, sparkle: 0.3, hue: 0.0},
  rare: {glow: [0.37, 0.78, 1.0], foil: [0.55, 0.78, 1.0], sat: 0.6, holo: 0.62, sparkle: 0.5, hue: 0.55},
  epic: {glow: [0.73, 0.55, 1.0], foil: [0.72, 0.58, 1.0], sat: 0.85, holo: 0.78, sparkle: 0.7, hue: 0.78},
  legendary: {glow: [1.0, 0.79, 0.30], foil: [1.0, 0.80, 0.38], sat: 0.55, holo: 0.85, sparkle: 1.0, hue: 0.12},
};

const VERT = `
attribute vec2 aUv;
uniform mat4 uProj;
uniform vec3 uRot;
uniform float uScale, uBend;
varying vec2 vUv; varying vec3 vN; varying vec3 vPos;
mat3 rx(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
mat3 ry(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 rz(float a){float c=cos(a),s=sin(a);return mat3(c,s,0.,-s,c,0.,0.,0.,1.);}
void main(){
  vUv=aUv;
  vec2 p=(aUv-.5)*vec2(1.,1.4);
  vec3 pos=vec3(p,uBend*(p.x*p.x-.25));             // a fast turn bows the card a little
  vec3 n=normalize(vec3(-2.*uBend*p.x,0.,1.));
  mat3 R=rz(uRot.z)*ry(uRot.y)*rx(uRot.x);
  pos=R*pos*uScale; n=R*n;
  vN=n; vPos=pos;
  gl_Position=uProj*vec4(pos-vec3(0.,0.,4.),1.);
}`;
const FRAG = `
precision highp float;
varying vec2 vUv; varying vec3 vN; varying vec3 vPos;
uniform sampler2D uFront, uFrontMask, uBack, uBackMask, uCat;
uniform vec4 uArt, uCatBox;
uniform vec3 uFoil, uGlow, uLight;
uniform float uSat, uHolo, uSparkle, uHue, uTime, uPx;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
vec3 rainbow(float t){return .5+.5*cos(6.28318*(t+vec3(0.,1./3.,2./3.)));}
float roundRect(vec2 uv){vec2 q=abs((uv-.5)*vec2(1.,1.4))-vec2(.5,.7)+.045;return length(max(q,0.))+min(max(q.x,q.y),0.)-.045;}
float inBox(vec2 p,vec4 b){return step(b.x,p.x)*step(p.x,b.z)*step(b.y,p.y)*step(p.y,b.w);}
void main(){
  float d=roundRect(vUv);
  float alpha=1.-smoothstep(-uPx,uPx,d);
  if(alpha<=0.){gl_FragColor=vec4(0.);return;}
  bool front=gl_FrontFacing;
  vec2 uv=front?vUv:vec2(1.-vUv.x,vUv.y);
  vec2 tuv=vec2(uv.x,1.-uv.y);
  vec3 base=front?texture2D(uFront,tuv).rgb:texture2D(uBack,tuv).rgb;
  vec4 mask=front?texture2D(uFrontMask,tuv):texture2D(uBackMask,tuv);
  vec3 N=normalize(front?vN:-vN);
  // laminate crinkle on the foil
  vec2 cq=uv*vec2(9.,12.6)+2.7;
  float w0=noise(cq);
  vec2 slope=vec2(noise(cq+vec2(.09,0.))-w0,noise(cq+vec2(0.,.09))-w0)/.09;
  vec3 n=normalize(N+vec3(slope,0.)*.012*mask.r);
  // a point light in front of the card: its glare spot moves with the pointer
  vec3 V=normalize(vec3(0.,0.,4.)-vPos);
  vec3 L=normalize(uLight-vPos);
  vec3 Hv=normalize(L+V);
  float ndl=clamp(dot(n,L)*.5+.5,0.,1.), ndh=clamp(dot(n,Hv),0.,1.);
  // diffraction hue: blotches + a ramp + the card's real tilt + time
  float drift=uTime*.06;
  float blotch=noise(uv*3.3+drift)+.4*noise(uv*6.9+vec2(5.2,9.4)-drift*1.6);
  float tilt=n.x*1.6+n.y*1.1;
  float hue=blotch*.45+(uv.x*.5+uv.y*.7)*.8+tilt*1.4+uTime*.05+uHue;
  vec3 foilC=front?uFoil:vec3(.42,.95,.76);                       // the back is the same for every card: brand green
  vec3 tint=mix(foilC,rainbow(hue)*mix(vec3(1.),foilC,.35),(front?uSat:.22)*.85);
  float sheen=pow(ndh,7.)*.45, spec=pow(ndh,42.)*.95;
  vec3 foil=tint*(ndl*.5+.55)+tint*sheen+mix(tint,vec3(1.),.6)*spec;
  // glitter: sparse flakes, each catching the light at its own angle, so they flash as the card turns
  vec2 fc=uv*vec2(96.,134.4), fid=floor(fc);
  float fh=hash(fid), fr=length(fract(fc)-.5);
  float glint=pow(.5+.5*sin(uTime*2.2+fh*60.+tilt*9.),8.);
  float flake=step(.84,fh)*smoothstep(.42,.05,fr)*glint*uSparkle*smoothstep(.45,.9,mask.r)*(front?1.:0.);
  foil+=mix(rainbow(hue+fh),vec3(1.),.45)*flake*1.3;
  foil*=1.+(noise(uv*140.)-.5)*.05;
  vec3 print=base*(.62+.48*ndl)+vec3(spec*.35*mask.g);
  vec3 col=mix(print,foil,mask.r*uHolo*(front?1.:.45));       // the back is printed with less foil
  if(front&&inBox(tuv,uArt)>0.){
    // RepoCat floats above the holo art window: parallax with the tilt, and a soft shadow on the window
    vec2 cuv=(tuv-uCatBox.xy+vec2(-n.x,n.y)*.075)/uCatBox.zw;
    vec2 suv=cuv-vec2(.035,.05);
    float sh=texture2D(uCat,clamp(suv,0.,1.)).a*inBox(suv,vec4(0.,0.,1.,1.));
    col*=1.-.5*sh;
    vec4 cat=texture2D(uCat,clamp(cuv,0.,1.))*inBox(cuv,vec4(0.,0.,1.,1.));
    col=mix(col,cat.rgb*(.68+.42*ndl)+vec3(spec*.25),cat.a);
  }
  col+=vec3(pow(ndh,4.)*.16*(.4+mask.g));                       // a broad glare
  col+=uGlow*smoothstep(-.06,0.,d)*.28;                          // the rarity glows at the edge
  col+=vec3(1.)*smoothstep(-.012,0.,d)*.22*ndl;                  // the cut edge catches the light
  gl_FragColor=vec4(col*alpha,alpha);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'card shader');
  return s;
}
const surface = px => {
  const c = document.createElement('canvas'); c.width = c.height = px;
  const g = c.getContext('2d'); g.setTransform(px / W, 0, 0, px / H, 0, 0);
  return {c, g};
};
const rgb = ([r, g, b], a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;

// --- the printed faces -----------------------------------------------------------------------------------------------
function frontFaces({multiplier, rarityName, total, split, foot}, r) {
  const {c: color, g} = surface(COLOR_PX), {c: mask, g: m} = surface(MASK_PX);
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#141b18'); bg.addColorStop(.55, '#0b0f0d'); bg.addColorStop(1, '#151a1d');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W / 2, H * .38, 20, W / 2, H * .38, W * .62);
  glow.addColorStop(0, rgb(r.glow, .6)); glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  m.fillStyle = 'rgb(110,50,0)'; m.fillRect(0, 0, W, H);                       // the whole field is light foil
  for (const [ctx, style] of [[g, rgb(r.glow)], [m, 'rgb(255,200,0)']]) {       // the frame is heavy foil
    ctx.strokeStyle = style; ctx.lineWidth = 22; ctx.beginPath(); ctx.roundRect(11, 11, W - 22, H - 22, 30); ctx.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2; g.beginPath(); g.roundRect(34, 34, W - 68, H - 68, 18); g.stroke();
  // the art window: holo; RepoCat is drawn by the shader so it can float above it
  g.save(); g.beginPath(); g.roundRect(ART.x, ART.y, ART.w, ART.h, 18); g.clip();
  const art = g.createRadialGradient(W / 2, ART.y + ART.h * .55, 10, W / 2, ART.y + ART.h * .55, ART.w * .7);
  art.addColorStop(0, rgb(r.glow, .55)); art.addColorStop(1, 'rgba(0,0,0,.35)');
  g.fillStyle = art; g.fillRect(ART.x, ART.y, ART.w, ART.h); g.restore();
  m.save(); m.beginPath(); m.roundRect(ART.x, ART.y, ART.w, ART.h, 18); m.clip(); m.fillStyle = 'rgb(235,70,0)'; m.fillRect(ART.x, ART.y, ART.w, ART.h); m.restore();
  for (const [ctx, style] of [[g, rgb(r.glow)], [m, 'rgb(255,200,0)']]) {
    ctx.strokeStyle = style; ctx.lineWidth = 6; ctx.beginPath(); ctx.roundRect(ART.x, ART.y, ART.w, ART.h, 18); ctx.stroke();
  }
  // the text has no foil, so it stays crisp
  const text = (str, font, x, y, fill, align = 'center') => {
    for (const [ctx, style] of [[g, fill], [m, 'rgb(0,255,0)']]) { ctx.font = font; ctx.fillStyle = style; ctx.textAlign = align; ctx.fillText(str, x, y); }
  };
  text(rarityName.toUpperCase(), `600 26px ${fontsOf().mono}`, 60, 80, rgb(r.glow), 'left');
  text(multiplier, `400 44px ${fontsOf().display}`, W - 58, 86, rgb(r.glow), 'right');
  text(total, `400 76px ${fontsOf().display}`, W / 2, 628, '#ffffff');
  text('of AI credits', `500 26px ${fontsOf().sans}`, W / 2, 670, 'rgba(255,255,255,.72)');
  text(split, `500 24px ${fontsOf().mono}`, W / 2, 730, 'rgba(255,255,255,.9)');
  text(foot, `500 20px ${fontsOf().mono}`, W / 2, 824, 'rgba(255,255,255,.45)');
  return {color, mask};
}
// The back is the same for every card: the brand green with a foil sunburst, the repo.ing wordmark at the top (it is
// the first thing you see as the card rises out of the pack), and the cat mark in the middle inside foil rings. The
// logo is printed matt, not foiled, so the glare does not wash out the brand colours.
const MARK = {x: W / 2, y: 470, r: 150};
function silhouette(img, w, h, style) {
  const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h);
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
  g.globalCompositeOperation = 'source-in'; g.fillStyle = style; g.fillRect(0, 0, w, h);
  return c;
}
function backFaces({mark, wordmark}) {
  const {c: color, g} = surface(COLOR_PX), {c: mask, g: m} = surface(MASK_PX);
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#16261d'); bg.addColorStop(1, '#08100c');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  m.fillStyle = 'rgb(90,40,0)'; m.fillRect(0, 0, W, H);
  for (const ctx of [g, m]) { ctx.save(); ctx.translate(MARK.x, MARK.y); }
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    for (const [ctx, style] of [[g, i % 2 ? 'rgba(80,245,192,.10)' : 'rgba(80,245,192,.04)'], [m, i % 2 ? 'rgb(230,120,0)' : 'rgb(120,60,0)']]) {
      ctx.fillStyle = style; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 1000, a, a + Math.PI / 48); ctx.closePath(); ctx.fill();
    }
  }
  for (const rad of [166, 198, 232]) for (const [ctx, style] of [[g, 'rgba(150,248,212,.45)'], [m, 'rgb(255,200,0)']]) {
    ctx.strokeStyle = style; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.stroke();
  }
  for (const ctx of [g, m]) ctx.restore();
  if (mark) {
    g.save(); g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 28; g.shadowOffsetY = 10;
    g.drawImage(mark, MARK.x - MARK.r, MARK.y - MARK.r, MARK.r * 2, MARK.r * 2); g.restore();
    m.fillStyle = 'rgb(0,28,0)'; m.beginPath(); m.arc(MARK.x, MARK.y, MARK.r, 0, Math.PI * 2); m.fill();
  }
  if (wordmark) {
    const w = 380, h = w * wordmark.height / wordmark.width, x = W / 2 - w / 2, y = 150 - h / 2;
    g.save(); g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 14; g.shadowOffsetY = 4; g.drawImage(wordmark, x, y, w, h); g.restore();
    m.drawImage(silhouette(wordmark, w, h, 'rgb(0,28,0)'), x, y, w, h);
  }
  for (const [ctx, style] of [[g, '#2f6b4c'], [m, 'rgb(255,200,0)']]) { ctx.strokeStyle = style; ctx.lineWidth = 22; ctx.beginPath(); ctx.roundRect(11, 11, W - 22, H - 22, 30); ctx.stroke(); }
  g.font = `500 22px ${fontsOf().mono}`; g.fillStyle = 'rgba(230,246,236,.6)'; g.textAlign = 'center'; g.fillText('A I   C R E D I T S', W / 2, 800);
  return {color, mask};
}

// --- the card on the stage -------------------------------------------------------------------------------------------
const outBack = t => { const c = 1.25; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const easeOut = t => 1 - Math.pow(1 - t, 3);
const FLIP_MS = 950;

// The canvas must be 1.7 times the card in both directions, centred on it (the card fills 1/1.7 of the view).
// images: {cat, mark, wordmark} (any may be null if it failed to load)
export function createCard(canvas, {cat, mark, wordmark}, {onLost} = {}) {
  const gl = canvas.getContext('webgl', {alpha: true, premultipliedAlpha: true, antialias: true});
  if (!gl) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'card link');
  gl.useProgram(prog);
  // a 16 x 22 grid of triangle strips, so the card can bow
  const cols = 16, rows = 22, verts = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i <= cols; i++) verts.push(i / cols, j / rows, i / cols, (j + 1) / rows);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aUv'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.frontFace(gl.CW);                                    // the strips wind clockwise when the front faces the viewer
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const U = Object.fromEntries(['uProj', 'uRot', 'uScale', 'uBend', 'uFront', 'uFrontMask', 'uBack', 'uBackMask', 'uCat', 'uArt', 'uCatBox',
    'uFoil', 'uGlow', 'uLight', 'uSat', 'uHolo', 'uSparkle', 'uHue', 'uTime', 'uPx'].map(name => [name, gl.getUniformLocation(prog, name)]));
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const textures = ['uFront', 'uFrontMask', 'uBack', 'uBackMask', 'uCat'].map((name, unit) => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.uniform1i(U[name], unit);
    return t;
  });
  const upload = (unit, source) => {
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); gl.generateMipmap(gl.TEXTURE_2D);
  };
  const back = backFaces({mark, wordmark}); upload(2, back.color); upload(3, back.mask);
  if (cat) upload(4, cat);
  gl.uniform4f(U.uArt, ART.x / W, ART.y / H, (ART.x + ART.w) / W, (ART.y + ART.h) / H);
  gl.uniform4f(U.uCatBox, CAT.x / W, CAT.y / H, CAT.w / W, CAT.h / H);

  let rarity = RARITY.common;
  // angles in degrees; the card shows its back until it flips
  const st = {rot: [0, 180, 0], scale: 1, bend: 0, mode: 'back', tilt: [0, 0], target: [0, 0], flip: null, lastY: 180};
  const endFlip = () => { const done = st.flip?.resolve; st.flip = null; done?.(); };
  // if the browser drops the GPU context, finish any flip so the reveal never waits, and let the page use the CSS card
  canvas.addEventListener('webglcontextlost', () => { endFlip(); onLost?.(); }, {once: true});
  return {
    release() { gl.getExtension('WEBGL_lose_context')?.loseContext() },
    setFront(face, key) {
      endFlip();
      rarity = RARITY[key] ?? RARITY.common;
      const f = frontFaces(face, rarity); upload(0, f.color); upload(1, f.mask);
      Object.assign(st, {rot: [0, 180, 0], scale: 1, bend: 0, mode: 'back', flip: null, target: [0, 0], tilt: [0, 0], lastY: 180});
    },
    // the pointer relative to the card centre, -1..1 on each axis (y up); 0,0 lets the card drift on its own
    pointer(x, y) { st.target = [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))]; },
    settle() { endFlip(); st.mode = 'settled'; st.rot = [0, 0, 0]; st.lastY = 0; },
    flip() { return new Promise(resolve => { st.mode = 'flip'; st.flip = {start: performance.now(), resolve}; }); },
    draw(time, still) {
      const t = still ? 0 : time;
      if (st.mode === 'back') st.rot = [Math.sin(t * 1.7) * 3, 180 + Math.sin(t * 1.3) * 4, Math.sin(t * .9) * 1.2];
      if (st.mode === 'flip') {
        // a small wind-up, a fast turn that overshoots, then it settles
        const p = Math.min(1, (performance.now() - st.flip.start) / FLIP_MS), q = Math.max(0, (p - .14) / .86);
        const y = p < .14 ? 180 + 12 * easeOut(p / .14) : 192 * (1 - outBack(q));
        st.rot = [-10 * Math.sin(Math.PI * p), y, 3 * Math.sin(Math.PI * p)];
        st.scale = 1 + .12 * Math.sin(Math.PI * Math.min(1, q * 1.2));
        if (p >= 1) { st.mode = 'settled'; st.scale = 1; endFlip(); }
      }
      if (st.mode === 'settled') {
        st.tilt = st.tilt.map((v, i) => v + (st.target[i] - v) * .1);
        const idle = !still && st.target[0] === 0 && st.target[1] === 0;
        const goal = [-st.tilt[1] * 16 + (idle ? Math.sin(t * .6) * 4 : 0), st.tilt[0] * 22 + (idle ? Math.sin(t * .8) * 9 : 0), 0];
        st.rot = st.rot.map((v, i) => still ? goal[i] : v + (goal[i] - v) * .12);
      }
      const vel = st.rot[1] - st.lastY; st.lastY = st.rot[1];
      st.bend += (Math.max(-.12, Math.min(.12, vel * .012)) - st.bend) * .25;

      const dpr = Math.min(devicePixelRatio || 1, 2), w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (!w || !h) return;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const f = 4 / (0.7 * 1.7), aspect = w / h, near = .1, far = 20;
      gl.uniformMatrix4fv(U.uProj, false, new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]));
      gl.uniform3f(U.uRot, ...st.rot.map(a => a * Math.PI / 180));
      gl.uniform1f(U.uScale, st.scale); gl.uniform1f(U.uBend, st.bend);
      gl.uniform3fv(U.uFoil, rarity.foil); gl.uniform3fv(U.uGlow, rarity.glow);
      gl.uniform1f(U.uSat, rarity.sat); gl.uniform1f(U.uHolo, rarity.holo); gl.uniform1f(U.uSparkle, rarity.sparkle); gl.uniform1f(U.uHue, rarity.hue);
      gl.uniform1f(U.uTime, t); gl.uniform1f(U.uPx, 1.7 / w * 1.5);
      gl.uniform3f(U.uLight, st.tilt[0] * .9 + Math.sin(t * .5) * .3 - .2, st.tilt[1] * 1.1 + Math.cos(t * .4) * .2 + .35, 2.2);
      for (let j = 0; j < rows; j++) gl.drawArrays(gl.TRIANGLE_STRIP, j * (cols + 1) * 2, (cols + 1) * 2);
    },
  };
}
