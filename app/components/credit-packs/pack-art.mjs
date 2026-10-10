// The foil packs of AI credit packs (/credits), drawn live in WebGL: a metallised wrapper with crimped seals, a pillowed
// body, wrinkles and creases, lit by a moving studio light, with the printed front (a 2D canvas) on top; and the top strip
// as a mesh that tears off. Ported from repo-inference's pack page (web/packs.js). The strip's curl shading follows the
// PagePeel effect of Shaders (MIT; see NOTICE.md here). Browser only: imported from client components.
import { PACK_NAMES } from './packs-model.mjs'

// The page passes its brand fonts (app/home-fonts.js); the canvas waits for them before it prints.
const FALLBACK = { display: '"Archivo Black", Arial Black, sans-serif', mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif' }
let chosen = FALLBACK
export const fontsOf = () => chosen
export function setFonts({ display, mono }) { chosen = { ...FALLBACK, ...display ? { display } : {}, ...mono ? { mono } : {} } }
export const fontsReady = () => Promise.all([`400 92px ${chosen.display}`, `500 16px ${chosen.mono}`].map(font => document.fonts?.load(font).catch(() => {})))

export const STYLE = {
  10: {foil: [0.80, 0.83, 0.87], holo: 0.36, ink: '#0f1316', accent: '#e4ebf2', glow: '#cfd8e2'},
  25: {foil: [0.34, 0.86, 0.57], holo: 0.10, ink: '#08140e', accent: '#a4f3c8', glow: '#81e6ad'},
  50: {foil: [0.60, 0.47, 0.96], holo: 0.28, ink: '#110b20', accent: '#ddd0ff', glow: '#b392ff'},
  100: {foil: [0.97, 0.75, 0.31], holo: 0.08, ink: '#1a1205', accent: '#ffe6a6', glow: '#ffc94d'},
};

export const VERT = 'attribute vec2 p;varying vec2 vUv;varying vec3 vBend;void main(){vUv=p*.5+.5;vBend=vec3(0.,0.,1.);gl_Position=vec4(p,0.,1.);}';
// The torn strip as a mesh: the part past the tear front bends up around the front (a curl of fixed length, then
// straight), lifts, and once free is thrown up and to the left, turning as it falls. World units: the pack is 3 x 5.
// The canvas spans x -6..6 and y 0..6 (the top half of the pack and the space above it); z comes toward the viewer.
const VERT_STRIP = `
attribute vec2 aUv;
uniform float uFront, uCurl, uLift, uFly;
varying vec2 vUv; varying vec3 vBend;
void main(){
  vUv=aUv;
  vec2 P=(aUv-.5)*vec2(3.,5.);
  float xf=(uFront-.5)*3., s=max(P.x-xf,0.), L=.5, th=max(uCurl,.001), r=L/th, a=th*min(s/L,1.);
  vec3 pos=s<=0.?vec3(P,0.):s<L?vec3(xf+r*sin(a),P.y,r*(1.-cos(a))):vec3(xf+r*sin(th)+(s-L)*cos(th),P.y,r*(1.-cos(th))+(s-L)*sin(th));
  pos.y+=s*uLift+pos.z*.2;                              // pulled up as well as toward you
  vec3 n=vec3(-sin(a),0.,cos(a));
  if(uFly>0.){
    // free: it tumbles end over end, turns, and is thrown up and left before it falls
    vec3 c=vec3(-1.6,2.4,.8), q=pos-c;
    float tb=uFly*3.4, ct=cos(tb), st=sin(tb), g=-1.1*uFly, cs=cos(g), sn=sin(g);
    q=vec3(q.x,q.y*ct-q.z*st,q.y*st+q.z*ct); n=vec3(n.x,n.y*ct-n.z*st,n.y*st+n.z*ct);
    q=vec3(q.x*cs-q.y*sn,q.x*sn+q.y*cs,q.z); n=vec3(n.x*cs-n.y*sn,n.x*sn+n.y*cs,n.z);
    pos=c+q+vec3(-1.4*uFly,2.*uFly-4.4*uFly*uFly,.5*uFly);
  }
  vBend=n;
  vec2 sp=pos.xy*(7./(7.-min(pos.z,5.)));               // perspective from 7 units: what comes toward you grows
  gl_Position=vec4(sp.x/6.,(sp.y-3.)/3.,0.,1.);
}`;
const FRAG = `
precision highp float;
varying vec2 vUv;
varying vec3 vBend;
uniform sampler2D uLabel;
uniform vec3 uFoil;
uniform float uHolo, uTime, uSeed, uPart, uTear, uFront, uCurl, uAlpha;
uniform vec2 uLight, uPx;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
float ridged(vec2 p){float v=0.,a=.55;for(int i=0;i<4;i++){float n=1.-abs(noise(p)*2.-1.);v+=a*n*n;p=p*2.11+vec2(3.1,1.3);a*=.5;}return v;}
const float X0=.07,X1=.93,Y0=.03,Y1=.97,SEAL=.085;
float teeth(float x){return abs(fract(x*30.)-.5)*.014;}
float outline(vec2 uv){
  float lo=Y0+SEAL,hi=Y1-SEAL;
  float inBody=step(lo,uv.y)*step(uv.y,hi);
  float nearSeal=max(1.-smoothstep(0.,.08,uv.y-lo),1.-smoothstep(0.,.08,hi-uv.y));
  float pinch=.014*nearSeal*inBody;
  float dx=min(uv.x-(X0+pinch),(X1-pinch)-uv.x);
  float dy=min(uv.y-(Y0+teeth(uv.x+.021)),(Y1-teeth(uv.x))-uv.y);
  return min(dx,dy);
}
float sealMask(vec2 uv){return 1.-step(Y0+SEAL,uv.y)*step(uv.y,Y1-SEAL);}
float height(vec2 uv){
  vec2 q=vec2((uv.x-X0)/(X1-X0),clamp((uv.y-(Y0+SEAL))/((Y1-SEAL)-(Y0+SEAL)),0.,1.));
  float body=1.-sealMask(uv);
  float px=1.-pow(abs(q.x*2.-1.),2.4);
  float py=1.-pow(abs(q.y*2.-1.),5.);
  float edge=clamp(1.-min(px*1.5,py*1.3),0.,1.);
  float wrinkle=ridged(uv*vec2(5.5,3.4)+uSeed)*(.3+.7*edge);
  float crease=smoothstep(.9,1.,ridged(vec2(uv.x*1.3+uv.y*2.2,uv.y*.7-uv.x)*3.+uSeed*1.7));
  float hb=px*py+wrinkle*.055+crease*.035;
  float crimp=.5+.5*sin(uv.x*300.);
  float hs=.02+crimp*.0025+noise(uv*vec2(40.,8.)+uSeed)*.004;
  return mix(hs,hb,body);
}
void main(){
  vec2 uv=vUv;
  float d=outline(uv);
  float tearLine=uTear+(noise(vec2(uv.x*28.,uSeed*3.))-.5)*.014+(noise(vec2(uv.x*90.,1.+uSeed))-.5)*.005;
  float torn=step(uFront,uv.x);                          // 1 where the tear has already passed
  float keep=1.;
  if(uPart>.5&&uPart<1.5)keep=max(step(uv.y,tearLine),1.-torn);
  if(uPart>1.5)keep=step(tearLine,uv.y);
  float alpha=smoothstep(0.,uPx.y*1.4,d)*keep;
  if(alpha<=0.){gl_FragColor=vec4(0.);return;}
  bool inside=uPart>1.5&&!gl_FrontFacing;               // the curled strip shows the silver inside of the wrapper
  vec2 e=uPx*1.5;
  float hx=height(uv+vec2(e.x,0.))-height(uv-vec2(e.x,0.));
  float hy=height(uv+vec2(0.,e.y))-height(uv-vec2(0.,e.y));
  vec3 N=normalize(vec3(-hx/(2.*e.x)*.16,-hy/(2.*e.y)*.16,1.));
  N=inside?normalize(-vBend+(N-vec3(0.,0.,1.))*.4):normalize(N+vBend-vec3(0.,0.,1.));
  vec3 V=vec3(0.,0.,1.);
  vec3 L=normalize(vec3(uLight*.9,1.));
  vec3 R=reflect(-V,N);
  float boxA=exp(-pow((R.x-uLight.x*.55)/.16,2.))*smoothstep(-.6,.4,R.y);
  float boxB=exp(-pow((R.y-.25-uLight.y*.35)/.1,2.))*.55;
  float rim=pow(1.-clamp(N.z,0.,1.),1.5);
  float fill=smoothstep(-.3,.7,R.y)*.28+smoothstep(-.5,.5,-R.x)*.12;
  float env=.34+fill+boxA*1.05+boxB*.8+rim*.3;
  float brushed=fbm(vec2(uv.x*220.,uv.y*3.+uSeed));
  vec3 foil=uFoil*env*(.9+.2*brushed);
  float rl=max(dot(R,L),0.);
  float spec=pow(rl,90.)*1.6+pow(rl,10.)*.18;
  float film=dot(N.xy,uLight)*1.6+uv.y*.9-uv.x*.4+fbm(uv*5.+uSeed)*.7+uTime*.025;
  vec3 rainbow=.55+.45*cos(6.2831*(film+vec3(0.,.33,.67)));
  foil=mix(foil,foil*rainbow*1.5+rainbow*.06,uHolo*smoothstep(.05,.7,env));
  float sealM=sealMask(uv);
  spec*=1.-.55*sealM;
  vec3 col=foil*(1.-.18*sealM)+vec3(spec);
  vec4 lab=texture2D(uLabel,vec2(uv.x,1.-uv.y));
  float diff=.5+.5*max(dot(N,L),0.);
  vec3 ink=lab.rgb*diff+vec3(spec*.3);
  col=inside?vec3(.84,.86,.9)*env*(.9+.3*brushed)+vec3(spec*1.2):mix(col,ink,lab.a);
  float seal=sealMask(uv);
  float crimp=.5+.5*sin(uv.x*300.);
  col*=mix(1.,.88+.18*crimp,seal);
  col*=.72+.28*smoothstep(0.,.025,d);
  if(uPart>.5){
    // the torn edge: the laminate whitens where it is stretched, in an uneven band
    float w=.003+.006*noise(vec2(uv.x*55.,uSeed*7.));
    col=mix(col,vec3(.93,.94,.96),(1.-smoothstep(0.,w,abs(uv.y-tearLine)))*torn*.88);
    // the lifted flap shades the strip that still holds, near the front
    if(uPart>1.5&&!inside)col*=1.-(1.-smoothstep(0.,.04+.08*min(uCurl,1.5),uFront-uv.x))*(1.-torn)*min(uCurl,1.)*.42;
  }
  gl_FragColor=vec4(col*alpha,alpha)*uAlpha;
}`;


// --- the printed front of each pack (2D canvas, 600x1000; y down) ----------------------------------------------------
const labels = new Map();
const images = new Map();
export function loadImage(src) {
  if (!images.has(src)) images.set(src, new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  }));
  return images.get(src);
}
export const loadCat = () => loadImage('/credits/repocat-512.png')
export async function labelFor(price) {
  if (labels.has(price)) return labels.get(price);
  const promise = (async () => {
    await fontsReady()
    const cat = await loadCat();
    const s = STYLE[price], W = 600, H = 1000, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    // microprint on the bare foil
    g.save(); g.globalAlpha = .13; g.fillStyle = s.ink; g.font = `600 15px ${fontsOf().sans}`;
    for (let y = 150; y < 860; y += 30) for (let x = (y / 30) % 2 ? 38 : 70; x < 580; x += 92) g.fillText('repo.ing', x, y);
    g.restore();
    // logo printed straight on the foil
    g.textAlign = 'center'; g.fillStyle = s.ink;
    g.font = `700 46px ${fontsOf().sans}`; g.fillText('repo.ing', W / 2, 205);
    g.font = `500 16px ${fontsOf().mono}`; g.globalAlpha = .85; g.fillText('A I   C R E D I T   P A C K', W / 2, 236); g.globalAlpha = 1;
    // a holo window ring with RepoCat in it (the foil shows through)
    g.strokeStyle = s.ink; g.lineWidth = 6; g.beginPath(); g.arc(W / 2, 415, 142, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = s.accent; g.globalAlpha = .7; g.lineWidth = 2; g.beginPath(); g.arc(W / 2, 415, 132, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    if (cat) g.drawImage(cat, W / 2 - 140, 275, 280, 280);
    // the label band at the bottom
    const bx = 74, by = 590, bw = W - 148, bh = 236;
    g.fillStyle = s.ink; g.globalAlpha = .93; g.beginPath(); g.roundRect(bx, by, bw, bh, 22); g.fill(); g.globalAlpha = 1;
    g.strokeStyle = s.accent; g.globalAlpha = .5; g.lineWidth = 2; g.beginPath(); g.roundRect(bx + 10, by + 10, bw - 20, bh - 20, 15); g.stroke(); g.globalAlpha = 1;
    g.fillStyle = '#ffffff'; g.font = `400 40px ${fontsOf().display}`; g.fillText(PACK_NAMES[price].toUpperCase(), W / 2, by + 66);
    g.fillStyle = s.accent; g.font = `400 92px ${fontsOf().display}`; g.fillText(`$${price}`, W / 2, by + 162);
    g.fillStyle = '#ffffff'; g.globalAlpha = .82; g.font = `600 17px ${fontsOf().sans}`; g.fillText(`AT LEAST $${price} IN AI CREDITS`, W / 2, by + 204); g.globalAlpha = 1;
    // tear notch on the top seal line
    g.fillStyle = s.ink; g.globalAlpha = .75; g.textAlign = 'right'; g.font = `600 15px ${fontsOf().mono}`;
    g.fillText('◂ TEAR HERE', W - 58, 144); g.globalAlpha = 1;
    return c;
  })();
  labels.set(price, promise);
  return promise;
}

// --- WebGL renderer for one canvas: the whole pack as one quad, or (strip) the top strip as a mesh that can tear off ---
const STRIP_COLS = 64, STRIP_ROWS = 3, STRIP_V0 = 0.8;
export function renderer(canvas, strip = false) {
  const gl = canvas.getContext('webgl', {alpha: true, premultipliedAlpha: true, antialias: true});
  if (!gl) return null;
  const shader = (type, source) => {
    const sh = gl.createShader(type); gl.shaderSource(sh, source); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, strip ? VERT_STRIP : VERT)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  gl.useProgram(prog);
  const verts = [];
  if (strip) {
    for (let j = 0; j < STRIP_ROWS; j++) for (let i = 0; i <= STRIP_COLS; i++) {
      const v = k => STRIP_V0 + (1 - STRIP_V0) * k / STRIP_ROWS;
      verts.push(i / STRIP_COLS, v(j), i / STRIP_COLS, v(j + 1));
    }
    gl.frontFace(gl.CW);                                  // the strips wind clockwise when the printed side faces you
  } else verts.push(-1, -1, 1, -1, -1, 1, 1, 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, strip ? 'aUv' : 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = Object.fromEntries(['uLabel', 'uFoil', 'uHolo', 'uTime', 'uSeed', 'uPart', 'uTear', 'uFront', 'uCurl', 'uLift', 'uFly', 'uAlpha', 'uLight', 'uPx']
    .map(name => [name, gl.getUniformLocation(prog, name)]));
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  return {
    release() { gl.getExtension('WEBGL_lose_context')?.loseContext() },
    setLabel(source) { gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); },
    draw({price, time, light, seed, part = 0, tear = 0.86, front = 1, curl = 0, lift = 0, fly = 0, alpha = 1}) {
      const dpr = Math.min(devicePixelRatio || 1, 2), w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (!w || !h) return;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const s = STYLE[price];
      gl.uniform1i(U.uLabel, 0); gl.uniform3fv(U.uFoil, s.foil); gl.uniform1f(U.uHolo, s.holo);
      gl.uniform1f(U.uTime, time); gl.uniform1f(U.uSeed, seed); gl.uniform1f(U.uPart, part); gl.uniform1f(U.uTear, tear);
      gl.uniform1f(U.uFront, front); gl.uniform1f(U.uCurl, curl); gl.uniform1f(U.uLift, lift); gl.uniform1f(U.uFly, fly); gl.uniform1f(U.uAlpha, alpha);
      gl.uniform2f(U.uLight, light[0], light[1]);
      // one pixel in pack units: the strip canvas spans four pack widths and 1.2 pack heights
      gl.uniform2f(U.uPx, strip ? 4 / w : 1 / w, strip ? 1.2 / h : 1 / h);
      if (!strip) { gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); return; }
      for (let j = 0; j < STRIP_ROWS; j++) gl.drawArrays(gl.TRIANGLE_STRIP, j * (STRIP_COLS + 1) * 2, (STRIP_COLS + 1) * 2);
    },
  };
}

