/* Back Rehab — realistic anatomy figure (three.js SkinnedMesh posed from exercise keypoints).
   Model: "Male Full Body Ecorche" by Diego Luján García, CC-BY-4.0
   https://sketchfab.com/3d-models/male-full-body-ecorche-ab11ebff89224f03bd75efede1164cf6 */
import * as THREE from './three.module.min.js';

const S2 = 0.68;            // 2D pose units -> model units
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

let renderer, scene, camera, mesh, skeleton, bones = {}, meta, restPos = {}, mats = [], groupsInfo = [];
let floor, keyLight, propGroup, nerveMesh = null, canvas, ready = false, cur = null, hint = null;
const view = { yaw: 0.5, pitch: 0.2, touched: false };
let cycleSide = 1, cycleU = null; const plantCache = {};
const savedView = id => { try { const v = JSON.parse(localStorage.getItem('br_view_' + id) || 'null'); return v && typeof v.yaw === 'number' ? v : null; } catch (_) { return null; } };
const saveView = (id, v) => { try { if (v) localStorage.setItem('br_view_' + id, JSON.stringify(v)); else localStorage.removeItem('br_view_' + id); } catch (_) { } };
const defaultView = id => ({ yaw: (EX[id] && EX[id].yaw) ?? 0.5, pitch: 0.2 });
const startView = id => { const v = savedView(id) || defaultView(id); view.yaw = v.yaw; view.pitch = v.pitch; };
const sampleIdx = [], bodySample = [];
const frameCache = {};

/* ---------- loading ---------- */
async function load(base = './') {
  const [metaJ, bin] = await Promise.all([
    fetch(base + 'body.json').then(r => r.json()),
    fetch(base + 'body.bin').then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); })
      .catch(() => fetch(base + 'bodydata.json').then(r => r.json()).then(j => { const s = atob(j.b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; }))
  ]);
  meta = metaJ;
  const L = meta.layout;
  const arr = (k, T) => new T(bin, L[k].off, L[k].len);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr('pos', Float32Array), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(arr('nor', Int8Array), 3, true));
  g.setAttribute('uv', new THREE.BufferAttribute(arr('uv', Float32Array), 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(arr('ski', Uint8Array), 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(arr('skw', Uint8Array), 4, true));
  g.setIndex(new THREE.BufferAttribute(arr('idx', L.idx.type === 'u32' ? Uint32Array : Uint16Array), 1));

  // materials: two per part (clay / highlighted)
  const tl = new THREE.TextureLoader();
  const texCache = {};
  const one = meta.mapTex ? { map: tl.load(base + 'tex/' + meta.mapTex), nm: tl.load(base + 'tex/' + meta.normTex) } : null;
  if (one) { one.map.flipY = false; one.nm.flipY = false; one.map.colorSpace = THREE.SRGBColorSpace; one.map.anisotropy = 4; }
  for (let p = 0; p < 16; p++) {
    if (one) {     // single textured model (colour + normal map shared by every part)
      mats.push(new THREE.MeshStandardMaterial({ map: one.map, normalMap: one.nm, roughness: 0.55, metalness: 0.05 }),
                new THREE.MeshStandardMaterial({ map: one.map, normalMap: one.nm, color: 0xffc0a0, roughness: 0.45, emissive: 0xc8440f, emissiveIntensity: 0.42 }));
      continue;
    }
    const tex = meta.partTex[p];
    let nm = null;
    if (tex) { nm = texCache[tex] || (texCache[tex] = tl.load(base + 'tex/' + tex)); nm.flipY = false; }
    const smooth = (p === 13 || p === 4);
    let cm = null; const ct = meta.partMap && meta.partMap[p];
    if (ct) { cm = texCache[ct] || (texCache[ct] = tl.load(base + 'tex/' + ct)); cm.flipY = false; cm.colorSpace = THREE.SRGBColorSpace; cm.anisotropy = 4; }
    if (nm) nm.anisotropy = 4;
    const clay = new THREE.MeshStandardMaterial({ color: smooth ? 0xf2f2f4 : (cm ? 0xf4f4f6 : 0xe7e8ec), map: cm, roughness: 0.5, metalness: 0, normalMap: nm });
    const hot = new THREE.MeshStandardMaterial({ color: 0xec5f2a, map: cm, roughness: 0.45, metalness: 0, normalMap: nm, emissive: 0x5a1a06, emissiveIntensity: 0.35 });
    if (nm) { clay.normalScale.set(1, 1); hot.normalScale.set(1, 1); }
    mats.push(clay, hot);
  }
  meta.groups.forEach((gr, i) => { g.addGroup(gr.start, gr.count, gr.part * 2); groupsInfo.push(gr); });

  // skeleton
  const J = meta.joints;
  const list = [];
  meta.bones.forEach(([name, parent, head]) => {
    const b = new THREE.Bone(); b.name = name;
    const hp = V(J[head]);
    if (parent >= 0) { const ph = V(J[meta.bones[parent][2]]); b.position.copy(hp.sub(ph)); list[parent].add(b); }
    else b.position.copy(hp);
    list.push(b); bones[name] = b; restPos[name] = b.position.clone();
  });
  skeleton = new THREE.Skeleton(list);
  mesh = new THREE.SkinnedMesh(g, mats);
  mesh.add(list[0]); mesh.bind(skeleton);
  mesh.castShadow = true; mesh.receiveShadow = false; mesh.frustumCulled = false;

  // sample vertices for grounding / framing
  const nv = g.attributes.position.count, si = g.attributes.skinIndex, sw8 = g.attributes.skinWeight;
  const armB = new Set(['uaL','faL','hL','uaR','faR','hR'].map(n => meta.bones.findIndex(b => b[0] === n)));
  for (let i = 0; i < nv; i += 97) { sampleIdx.push(i); let bi = 0, bw = -1; for (let k = 0; k < 4; k++) { const w = sw8.getX(i) && [sw8.getX(i), sw8.getY(i), sw8.getZ(i), sw8.getW(i)][k]; if (w > bw) { bw = w; bi = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)][k]; } } if (!armB.has(bi)) bodySample.push(i); }

  // scene
  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x5a4f3c, 1.15));
  keyLight = new THREE.DirectionalLight(0xfff1e2, 2.7); keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048); keyLight.shadow.bias = -0.0008; keyLight.shadow.normalBias = 0.04;
  Object.assign(keyLight.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 1, far: 300 });
  scene.add(keyLight); scene.add(keyLight.target);
  const rim = new THREE.DirectionalLight(0xffffff, 1.1); rim.position.set(30, 25, -40); scene.add(rim);
  floor = new THREE.Mesh(new THREE.CircleGeometry(160, 48), new THREE.ShadowMaterial({ opacity: 0.32 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  propGroup = new THREE.Group(); scene.add(propGroup);
  scene.add(mesh);
  camera = new THREE.PerspectiveCamera(30, 4 / 3, 1, 2000);

  canvas = document.createElement('canvas'); canvas.className = 'fig3d';
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  bindDrag();
  ready = true;
}

/* ---------- maths helpers ---------- */
const A = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], S = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], K = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const D = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], Ln = a => Math.hypot(a[0], a[1], a[2]), N = a => { const l = Ln(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const Lr = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const X = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const perp = (v, axis) => { const ax = N(axis); return S(v, K(ax, D(v, ax))); };
const orth = (v, axis, fb) => { let p = perp(v, axis); if (Ln(p) < 1e-3) p = perp(fb, axis); return N(p); };

function frameQuat(dir, fwd) {          // rotation whose Y = dir, Z = fwd (orthogonalised)
  const y = N(dir), z = orth(fwd, y, [0, 0, 1]), x = X(y, z);
  const m = new THREE.Matrix4().makeBasis(V(x), V(y), V(z));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
const restQ = {};
function restFrame(name, fwd) {
  if (restQ[name]) return restQ[name];
  const b = meta.bones.find(x => x[0] === name), J = meta.joints;
  return restQ[name] = frameQuat(S(J[b[3]], J[b[2]]), fwd);
}

/* ---------- pose from 2D keypoints ---------- */
const footAng = {};
function footRestAngle(side) {
  if (footAng[side] != null) return footAng[side];
  const J = meta.joints, sd = N(S(J['ankle' + side], J['knee' + side])), fd = N(S(J['toe' + side], J['ankle' + side]));
  return footAng[side] = Math.acos(Math.max(-1, Math.min(1, D(sd, fd))));
}
function solve(pose, id) {
  if (EX[id] && EX[id].hipArc) {                     // hips travel in an arc (stay high mid-move so the knees can pass under the body)
    const a = EX[id].A.hip, b = EX[id].B.hip, fr = Math.max(0, Math.min(1, (a[0] - pose.hip[0]) / ((a[0] - b[0]) || 1)));
    const L = EX[id].hipArc * 4 * fr * (1 - fr), q = Object.assign({}, pose);
    q.hip = [pose.hip[0], pose.hip[1] - L]; if (q.mid) q.mid = [q.mid[0], q.mid[1] - L * 0.6];
    pose = q;
  }
  // on hands and knees the model's arms are longer than its thighs: lift the shoulders so planted arms can stay nearly straight
  {
    const kDown = (pose.kn && pose.kn[1] >= 97) || (pose.knF && pose.knF[1] >= 97);
    const hDown = (pose.hd && pose.hd[1] >= 99) || (pose.hdF && pose.hdF[1] >= 99);
    if (kDown && hDown && pose.hip[1] < 80 && pose.sh[1] < 80 && pose.sh[1] > 50) {
      const sag = pose.mid ? pose.mid[1] - (pose.sh[1] + pose.hip[1]) / 2 : 0;   // cow (sagging back) drops the shoulders
      const L = EX[id].quadLift || (21 + (sag > 0 ? 1.25 * sag : 0.2 * sag)), q = Object.assign({}, pose), up = (p, k) => p && [p[0], p[1] - k];
      for (const key of ['sh', 'head', 'el', 'elF']) if (q[key]) q[key] = up(q[key], L);
      for (const key of ['hd', 'hdF']) if (q[key] && q[key][1] < 99) q[key] = up(q[key], L);
      if (q.mid) q.mid = up(q.mid, L * 0.45);
      pose = q;
    }
  }
  const ex = EX[id], T = TARGETS[id] || { t: [], f: -1 }, front = ex.view === 'front';
  const to3 = (p, z = 0) => [p[0] * S2, (105 - p[1]) * S2, z * S2];
  const n2 = nrm(pose.sh, pose.hip);
  const sidelying = ex.view3d === 'sidelying';
  const F = (front || sidelying) ? [0, 0, 1] : N([n2[0] * T.f, -n2[1] * T.f, 0]);
  const Lv = front ? [1, 0, 0] : sidelying ? [0, -1, 0] : [0, 0, 1];
  const lim = (p, s, w) => front ? to3(p) : A(to3(p), K(Lv, s * w * S2));
  const sw = meta.joints.shoulderL[0] / S2 * 0.96, hw = meta.joints.hipL[0] / S2 * 0.87, zl = (s, w) => front ? 0 : s * w;
  const far = { kn: pose.knF || pose.kn, ft: pose.ftF || pose.ft, el: pose.elF || pose.el, hd: pose.hdF || pose.hd };
  const sh3 = to3(pose.sh), hip3 = to3(pose.hip), head3 = to3(pose.head), mid3 = pose.mid ? to3(pose.mid) : Lr(sh3, hip3, .5);
  const c = ctrlThrough(hip3, mid3, sh3);
  const Q = t => [(1 - t) * (1 - t) * hip3[0] + 2 * (1 - t) * t * c[0] + t * t * sh3[0], (1 - t) * (1 - t) * hip3[1] + 2 * (1 - t) * t * c[1] + t * t * sh3[1], 0];
  const world = {}, ik = {};
  world.pelvis = frameQuat(S(Q(.36), Q(0)), F);
  world.spine = frameQuat(S(Q(.7), Q(.36)), F);
  world.chest = frameQuat(S(Q(1), Q(.7)), F);
  let swingQ = null;
  if (ex.legs3d === 'hipswing') {                     // hips roll side to side over the ball, legs swing with them
    const u = cycleU == null ? 0.25 : cycleU, ang = 0.75 * Math.sin(2 * Math.PI * u);
    const ax = N(S(sh3, hip3)); swingQ = new THREE.Quaternion().setFromAxisAngle(V(ax), ang);
    world.pelvis = swingQ.clone().multiply(world.pelvis);
    world.spine = new THREE.Quaternion().slerp(swingQ, 0.4).multiply(world.spine);
  }
  const up = N(S(head3, sh3));
  world.neck = frameQuat(up, F);
  world.head = frameQuat(up, F);
  // which model side faces the "near" (+Lv) side?
  const leftW = new THREE.Vector3(1, 0, 0).applyQuaternion(world.chest);
  const nearIsL = (leftW.x * Lv[0] + leftW.y * Lv[1] + leftW.z * Lv[2]) >= 0;
  const sides = nearIsL ? { L: 1, R: -1 } : { L: -1, R: 1 };
  const pick = (s) => s > 0 ? { kn: pose.kn, ft: pose.ft, el: pose.el, hd: pose.hd } : far;
  // lying figure-4: crossed ankle rests on the other thigh above the knee, hands clasp behind that thigh
  let f4 = null;
  if (ex.pose3d === 'fig4') {
    const J = meta.joints, L1 = Ln(S(J.kneeL, J.hipL)), L2 = Ln(S(J.ankleL, J.kneeL)), UA = Ln(S(J.elbowL, J.shoulderL)), FA = Ln(S(J.wristL, J.elbowL));
    const fr0 = Math.max(0, Math.min(1, (101 - far.ft[1]) / (101 - 72))), fr = fr0 * fr0 * (3 - 2 * fr0);
    const upV = [0, 1, 0], H = N([hip3[0] - sh3[0], 0, hip3[2] - sh3[2]]);
    const hPf = A(hip3, K(Lv, -hw * S2)), hPn = A(hip3, K(Lv, hw * S2));
    const tA = N(A(K(H, 0.62), K(upV, 0.78))), tB = N(A(K(H, -0.32), K(upV, 0.95)));
    const t = N(Lr(tA, tB, fr)), kf = A(hPf, K(t, L1));
    const footA = A(A(hPf, K(H, 24)), [0, 1.6 - hPf[1], 0]), sA = N(S(footA, kf)), sB = N(A(H, [0, -0.12, 0]));
    const ff = A(kf, K(N(Lr(sA, sB, fr)), L2));
    let front = A(upV, K(t, -t[1])); front = Ln(front) > 1e-3 ? N(front) : K(H, -1);
    const ac = A(A(A(hPf, K(t, 0.86 * L1)), K(front, 2.6)), K(Lv, 1.2));                 // crossed ankle on the thigh, just above the knee
    // crossed knee: two-bone solve from the near hip to the ankle, knee opening out to the side
    let dv = S(ac, hPn), d = Math.max(Math.abs(L1 - L2) + 0.2, Math.min(L1 + L2 - 0.1, Ln(dv))); const dir = N(dv);
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), hh = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const pole = orth(A(Lv, K(upV, 0.35)), dir, Lv);
    const kc = A(A(hPn, K(dir, a)), K(pole, hh));
    // hands: clasp behind the supporting thigh (near hand threads through the triangle, far hand goes round the outside)
    const C = A(A(hPf, K(t, 0.68 * L1)), K(front, -3.4));
    f4 = { fr, kf, ff, kc, ac: A(hPn, K(dir, d)), hN: A(C, K(Lv, 1.7)), hF: A(C, K(Lv, -1.9)), UA, FA };
  }
  for (const side of ['L', 'R']) {
    const s = sides[side], P = pick(s);
    // arm
    const sP = A(sh3, K(Lv, s * sw * S2)); let e = lim(P.el, s, sw - 0.6), h = lim(P.hd, s, sw - 0.8);
    if (ex.reachAcross && P.hd[1] < 99) {           // reaching arm sweeps up and across the body toward the other side
      const y0 = 102, y1 = Math.min(ex.B.hd[1], ex.A.hd[1]);
      const fr = Math.max(0, Math.min(1, (y0 - P.hd[1]) / (y0 - y1)));
      const w = fr * fr * (3 - 2 * fr), acr = ex.reachAcross;
      h = A(h, K(Lv, -s * acr * w)); e = A(e, K(Lv, -s * acr * 0.45 * w));
      // keep the arm length: pull the hand back toward the shoulder a little as it crosses
      const J = meta.joints, L1 = Ln(S(J.elbowL, J.shoulderL)), L2 = Ln(S(J.wristL, J.elbowL));
      e = A(sP, K(N(S(e, sP)), L1)); h = A(e, K(N(S(h, e)), L2));
    }
    if (f4 && f4.fr > 0.01) {
      const tgt = Lr(h, s > 0 ? f4.hN : f4.hF, f4.fr);
      let dv = S(tgt, sP), d = Math.max(Math.abs(f4.UA - f4.FA) + 0.2, Math.min(f4.UA + f4.FA - 0.05, Ln(dv))); const dir = N(dv);
      const a = (f4.UA * f4.UA - f4.FA * f4.FA + d * d) / (2 * d), hh = Math.sqrt(Math.max(0, f4.UA * f4.UA - a * a));
      const pole = orth(A(K(Lv, s), [0, -0.6, 0]), dir, K(Lv, s));
      const e2 = A(A(sP, K(dir, a)), K(pole, hh)), h2 = A(sP, K(dir, d));
      e = Lr(e, e2, Math.min(1, f4.fr * 1.5)); h = Lr(h, h2, Math.min(1, f4.fr * 1.5));
      e = A(sP, K(N(S(e, sP)), f4.UA)); h = A(e, K(N(S(h, e)), f4.FA));
    }
    const ua = N(S(e, sP)), fa = N(S(h, e));
    let bd = perp(S(h, e), ua); bd = Ln(bd) > 0.8 * S2 ? N(bd) : orth(F, ua, up);
    world['ua' + side] = frameQuat(K(ua, -1), bd);       // bone points shoulder->elbow; rest dir is head->tail as well
    world['ua' + side] = frameQuat(ua, bd);
    world['fa' + side] = frameQuat(fa, orth(bd, fa, F));
    world['h' + side] = frameQuat(fa, orth(bd, fa, F));
    const eOff = perp(S(e, sP), S(h, sP));
    ik['ua' + side] = { onFloor: P.hd[1] >= 99 && !(f4 && f4.fr > 0.01), dx: (P.hd[0] - pose.sh[0]) * S2, bd, pole: Ln(eOff) > 1.0 ? N(eOff) : null };
    if (ex.arms3d === 'wallslide') {                 // arms out to the sides, against the wall behind
      const J = meta.joints, l1 = Ln(S(J.elbowL, J.shoulderL)), l2 = Ln(S(J.wristL, J.elbowL));
      const out = K(Lv, s), upV = [0, 1, 0], back = K(F, -1);
      const fr = Math.max(0, Math.min(1, (8 - P.hd[1]) / 20));          // 0 = goalpost, 1 = arms slid overhead
      const eDir = N(A(A(K(out, 1 - 0.45 * fr), K(upV, 0.85 * fr)), K(back, 0.12)));
      const e3 = A(sP, K(eDir, l1));
      const hDir = N(A(A(K(upV, 1), K(out, 0.15 + 0.25 * fr)), K(back, 0.1)));
      const h3 = A(e3, K(hDir, l2));
      world['ua' + side] = frameQuat(S(e3, sP), F);
      world['fa' + side] = frameQuat(S(h3, e3), orth(F, hDir, out));
      world['h' + side] = world['fa' + side];
      ik['ua' + side].onFloor = false;
    }
    if (ex.arms3d === 'sideplank' && s > 0) {        // bottom arm: elbow under the shoulder, forearm flat on the floor pointing forward (90 degrees)
      const J = meta.joints, l1 = Ln(S(J.elbowL, J.shoulderL)), l2 = Ln(S(J.wristL, J.elbowL));
      const fwdH = N([F[0], 0, F[2]]);
      const e3 = A(sP, [0, -l1, 0]);
      const h3 = A(e3, K(fwdH, l2));
      world['ua' + side] = frameQuat(S(e3, sP), fwdH);
      world['fa' + side] = frameQuat(S(h3, e3), [0, 1, 0]);
      world['h' + side] = frameQuat(fwdH, [0, 1, 0]);
      ik['ua' + side].onFloor = false;
      ik.forearmPlank = { side, e3, l1 };
    }
    // leg
    let hP = A(hip3, K(Lv, s * hw * S2));
    let k = lim(P.kn, s, hw + 0.3), f = lim(P.ft, s, hw + 0.3);
    if (ex.kneeOut) { k = A(k, K(Lv, s * ex.kneeOut)); k[1] -= ex.kneeDrop || 0; }
    if (ex.legs3d === '9090') {                        // feet planted wide; both knees drop to one side (alternating)
      const fr = Math.max(0, Math.min(1, (P.kn[1] - 74) / 19)), d = cycleSide;
      const base = [hip3[0], 0, hip3[2]];
      f = A(A(base, K(F, 17)), K(Lv, s * 10)); f[1] = 2.2;
      const up = A(A(base, K(F, 10)), K(Lv, s * 7.5)); up[1] = 16;
      const lead = s === d;
      const down = lead ? A(A(base, K(F, 7)), K(Lv, s * 17)) : A(A(base, K(F, 13)), K(Lv, s * 1.5));
      down[1] = lead ? 3.2 : 4.2;
      k = Lr(up, down, fr);
    }
    if (ex.legs3d === 'hydrant' && s > 0) {          // working knee circles the roller: in front, over the top, behind, home (reverses each rep)
      let u = cycleU;
      if (u == null) u = Math.max(0, Math.min(1, (ex.A.kn[0] - P.kn[0]) / (ex.A.kn[0] - ex.B.kn[0]))) * 0.5;
      u = u < 0.08 ? 0 : u > 0.92 ? 1 : (u - 0.08) / 0.84;
      u = u * u * (3 - 2 * u);
      if (cycleSide < 0) u = 1 - u;
      const hy = hP[1], c0 = [hip3[0], 0, hip3[2]], Hd = N([sh3[0] - hip3[0], 0, sh3[2] - hip3[2]]);
      const at = (fw, lat, y) => { const p = A(A(c0, K(Hd, fw)), K(Lv, lat)); p[1] = y; return p; };
      const home = k, pts = [home, at(9, 9, hy * 0.55), at(3, 16, hy * 0.95), at(-8, 16, hy * 0.95), at(-13, 9, hy * 0.6), home];
      // Catmull-Rom through the loop
      const nSeg = pts.length - 1, x = u * nSeg, i = Math.min(nSeg - 1, Math.floor(x)), tt = x - i;
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(nSeg, i + 2)];
      const cr = j => 0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * tt + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * tt * tt + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * tt * tt * tt);
      const kk = [cr(0), cr(1), cr(2)];
      const lift = Math.max(0, Math.min(1, (kk[1] - home[1]) / (hy * 0.4)));
      k = kk;
      // shin trails back from the knee, roughly level when the knee is up (90/90 hip)
      f = lift > 0 ? Lr(f, A(A(k, K(Hd, -13)), [0, -2, 0]), Math.min(1, lift * 2.5)) : f;
    }
    if (ex.feetIn != null) f = A(to3(P.ft), K(Lv, s * ex.feetIn));
    if (swingQ) { const rot = p => A(hip3, V(S(p, hip3)).applyQuaternion(swingQ).toArray()); hP = rot(hP); k = rot(k); f = rot(f); }
    if (f4) { if (s < 0) { k = f4.kf; f = f4.ff; } else { k = f4.kc; f = f4.ac; } }
    if (ex.legs3d === 'pigeon' && s > 0) {             // front leg: knee forward, shin across under the torso at 90 degrees
      const J = meta.joints, L2 = Ln(S(J.ankleL, J.kneeL)), bf = to3(far.ft);
      const fw = N([hip3[0] - bf[0], 0, hip3[2] - bf[2]]);
      k = A(hP, K(fw, 15.5)); k[1] = 2.2;
      f = A(A(k, K(Lv, -s * L2 * 0.96)), K(fw, -1.2)); f[1] = 1.8;
    }
    const th = N(S(k, hP)), shn = N(S(f, k));
    let bk = perp(S(f, k), th); let kneeFront = Ln(bk) > 1.2 * S2 ? K(N(bk), -1) : orth(F, th, [0, 0, 1]);
    let cs = perp(S(hP, k), shn); let shinFront = Ln(cs) > 1.2 * S2 ? K(N(cs), -1) : orth(F, shn, [0, 0, 1]);
    if (ex.kneesDown || ex.kneesToHead) {             // kneecaps face the floor / toward the head (no leg rotation)
      const V = ex.kneesToHead ? N([sh3[0] - hip3[0], 0, sh3[2] - hip3[2]]) : N(A(N([sh3[0] - hip3[0], 0, sh3[2] - hip3[2]]), [0, -0.7, 0]));
      kneeFront = orth(V, th, F); shinFront = orth(V, shn, F);
    }
    world['th' + side] = frameQuat(th, kneeFront);
    ik['leg' + side] = { onFloor: !front && pose.hip[1] >= 90 && P.kn[1] >= 97.5 && P.ft[1] >= 97.5, kneeFront, shinFront };
    world['sh' + side] = frameQuat(shn, shinFront);
    const shinDown = shinFront[1] < -0.55 && Math.abs(shn[1]) < 0.55;          // shin flat on the floor, front facing down
    if (shinDown) {
      const toe = N(A(shn, K(shinFront, -0.12)));                                   // foot continues behind the ankle
      world['ft' + side] = frameQuat(toe, orth(shinFront, toe, [0, -1, 0]));      // top of foot faces the floor
    } else {
      const ra = footRestAngle(side); let toe = N(A(K(shn, Math.cos(ra)), K(shinFront, Math.sin(ra))));
      if (P.ft[1] >= 99) { const hz = [toe[0], 0, toe[2]], hz2 = [shinFront[0], 0, shinFront[2]]; toe = Ln(hz) > 0.25 ? N(A(hz, [0, -0.12, 0])) : (Ln(hz2) > 0.2 ? N(hz2) : toe); }
      world['ft' + side] = frameQuat(toe, orth(K(shn, -1), toe, [0, 1, 0]));
    }
  }
  return { world, ik, hip3, F, Lv, nearIsL, front, id };
}

const FWD = { pelvis: [0, 0, 1], spine: [0, 0, 1], chest: [0, 0, 1], neck: [0, 0, 1], head: [0, 0, 1], uaL: [0, 0, 1], faL: [0, 0, 1], hL: [0, 0, 1], uaR: [0, 0, 1], faR: [0, 0, 1], hR: [0, 0, 1], thL: [0, 0, 1], shL: [0, 0, 1], thR: [0, 0, 1], shR: [0, 0, 1], ftL: [0, 1, 0], ftR: [0, 1, 0] };
function applyPose(sol) {
  const wq = {};
  meta.bones.forEach(([name, parent]) => {
    const target = sol.world[name] || new THREE.Quaternion();
    const w = target.clone().multiply(restFrame(name, FWD[name]).clone().invert());   // world rotation = target * rest^-1
    wq[name] = w;
    const pq = parent >= 0 ? wq[meta.bones[parent][0]] : new THREE.Quaternion();
    bones[name].quaternion.copy(pq.clone().invert().multiply(w));
  });
  if (!meta.mapTex) for (const sd of ['L', 'R']) { bones['h' + sd].scale.set(0.94, 0.84, 0.94); bones['ft' + sd].scale.set(0.95, 0.95, 0.86); }
  bones.pelvis.position.set(sol.hip3[0], sol.hip3[1], sol.hip3[2]);
  mesh.updateMatrixWorld(true);
  // ground on torso/legs (never on the hands)
  const v = new THREE.Vector3(); let minY = 1e9;
  for (const i of bodySample) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); if (v.y < minY) minY = v.y; }
  bones.pelvis.position.y -= minY - 0.05;
  mesh.updateMatrixWorld(true);
  // legs that lie on the floor: lower knee and ankle until they rest on it
  const setWorld = (nm, q) => { const w = q.clone().multiply(restFrame(nm, FWD[nm]).clone().invert()); const par = meta.bones[meta.bones.findIndex(b => b[0] === nm)][1]; const pq = new THREE.Quaternion(); bones[meta.bones[par][0]].getWorldQuaternion(pq); bones[nm].quaternion.copy(pq.invert().multiply(w)); bones[nm].updateMatrixWorld(true); };
  let legMoved = false;
  for (const sd of ['L', 'R']) {
    const info = sol.ik && sol.ik['leg' + sd]; if (!info || !info.onFloor) continue;
    const Jt = meta.joints, l1 = Ln(S(Jt['knee' + sd], Jt['hip' + sd])), l2 = Ln(S(Jt['ankle' + sd], Jt['knee' + sd]));
    const H = bonePos('th' + sd).toArray(), Kn0 = bonePos('sh' + sd).toArray(), An0 = bonePos('ft' + sd).toArray();
    const yk = 2.9, ya = 2.1;
    const hz1 = [Kn0[0] - H[0], 0, Kn0[2] - H[2]], dy1 = Math.max(-l1 * 0.98, Math.min(l1 * 0.98, yk - H[1]));
    const t1 = A(K(N(hz1), Math.sqrt(Math.max(0, l1 * l1 - dy1 * dy1))), [0, dy1, 0]);
    const Kn = A(H, t1);
    const hz2 = [An0[0] - Kn0[0], 0, An0[2] - Kn0[2]], dy2 = Math.max(-l2 * 0.98, Math.min(l2 * 0.98, ya - Kn[1]));
    const t2 = A(K(N(hz2), Math.sqrt(Math.max(0, l2 * l2 - dy2 * dy2))), [0, dy2, 0]);
    setWorld('th' + sd, frameQuat(t1, info.kneeFront));
    setWorld('sh' + sd, frameQuat(t2, info.shinFront));
    legMoved = true;
  }
  if (legMoved) {
    mesh.updateMatrixWorld(true);
    let m2 = 1e9; for (const i of bodySample) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); if (v.y < m2) m2 = v.y; }
    if (m2 < 0.05) { bones.pelvis.position.y += 0.05 - m2; mesh.updateMatrixWorld(true); }
  }
  // planted feet: keep each foot exactly where it is in the start pose (knees adjust)
  const pf = sol.id && EX[sol.id].plantFeet && plantCache[sol.id];
  if (pf) {
    const J = meta.joints;
    for (const sd of ['L', 'R']) {
      const c = pf[sd]; if (!c) continue;
      const Hp = bonePos('th' + sd).toArray();
      const l1 = Ln(S(J['knee' + sd], J['hip' + sd])), l2 = Ln(S(J['ankle' + sd], J['knee' + sd]));
      let dv = S(c.ank, Hp), d = Ln(dv); const dir = N(dv);
      d = Math.max(Math.abs(l1 - l2) + 0.1, Math.min(l1 + l2 - 0.02, d));
      const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
      const curK = bonePos('sh' + sd).toArray();
      const pole = orth(S(curK, A(Hp, K(dir, a))), dir, [0, 1, 0]);
      const Kn = A(A(Hp, K(dir, a)), K(pole, h)), An = A(Hp, K(dir, d));
      const thQ = new THREE.Quaternion(); bones['th' + sd].getWorldQuaternion(thQ);
      const thF = new THREE.Vector3(0, 0, 1).applyQuaternion(thQ.clone().multiply(restFrame('th' + sd, FWD['th' + sd]))).toArray();
      setWorld('th' + sd, frameQuat(S(Kn, Hp), orth(thF, N(S(Kn, Hp)), [0, 0, 1])));
      const shQ = new THREE.Quaternion(); bones['sh' + sd].getWorldQuaternion(shQ);
      const shF = new THREE.Vector3(0, 0, 1).applyQuaternion(shQ.clone().multiply(restFrame('sh' + sd, FWD['sh' + sd]))).toArray();
      setWorld('sh' + sd, frameQuat(S(An, Kn), orth(shF, N(S(An, Kn)), [0, 0, 1])));
      const par = new THREE.Quaternion(); bones['sh' + sd].getWorldQuaternion(par);
      bones['ft' + sd].quaternion.copy(par.invert().multiply(c.fq)); bones['ft' + sd].updateMatrixWorld(true);
    }
  }
  // hands grip the feet (happy baby)
  if (sol.id && EX[sol.id].handsToFeet) {
    const J = meta.joints;
    for (const sd of ['L', 'R']) {
      const Sp = bonePos('ua' + sd).toArray();
      const l1 = Ln(S(J['elbow' + sd], J['shoulder' + sd])), l2 = Ln(S(J['wrist' + sd], J['elbow' + sd]));
      const ank = bonePos('ft' + sd), toe = tailWorld('ft' + sd);
      const T = ank.clone().lerp(toe, 0.35).toArray(); T[1] -= 1.2;
      let dv = S(T, Sp), d = Ln(dv); const dir = N(dv);
      d = Math.max(Math.abs(l1 - l2) + 0.1, Math.min(l1 + l2 - 0.05, d));
      const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
      const outV = S(Sp, bonePos('chest').toArray()); outV[1] = 0;
      const pole = orth(A(N(outV), [0, -0.5, 0]), dir, [0, -1, 0]);
      const El = A(A(Sp, K(dir, a)), K(pole, h)), Wr = A(Sp, K(dir, d));
      const bd = orth(K(pole, -1), N(S(El, Sp)), sol.F);
      setWorld('ua' + sd, frameQuat(S(El, Sp), bd));
      setWorld('fa' + sd, frameQuat(S(Wr, El), orth(bd, N(S(Wr, El)), sol.F)));
      const fdir = S(toe.toArray(), ank.toArray());
      setWorld('h' + sd, frameQuat(N(A(N(S(Wr, El)), K(N(fdir), 0.6))), orth(bd, N(S(Wr, El)), sol.F)));
    }
  }
  // planted hands: two-bone IK so the hand meets the floor
  const J = meta.joints;
  for (const sd of ['L', 'R']) {
    const info = sol.ik && sol.ik['ua' + sd]; if (!info || !info.onFloor) continue;
    const Sp = bonePos('ua' + sd).toArray();
    const l1 = Ln(S(J['elbow' + sd], J['shoulder' + sd])), l2 = Ln(S(J['wrist' + sd], J['elbow' + sd]));
    const T = [Sp[0] + info.dx, 2.4, Sp[2]];
    let dv = S(T, Sp), d = Ln(dv); const dir = N(dv);
    d = Math.max(Math.abs(l1 - l2) + 0.1, Math.min(l1 + l2 - 0.05, d));
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    // default: elbow points back toward the hips (and slightly out), so the crease faces forward like a real arm
    let defPole = S(bonePos('pelvis').toArray(), Sp); defPole[1] = 0; defPole = A(K(N(defPole), sol.F[1] > 0.2 ? -1 : 1), K(N(S(Sp, bonePos('chest').toArray()).map((x, i) => i === 1 ? 0 : x)), 0.35));
    const pole = orth(info.pole || defPole, dir, sol.F);
    const El = A(A(Sp, K(dir, a)), K(pole, h)), Wr = A(Sp, K(dir, d));
    const bd = orth(K(pole, -1), N(S(El, Sp)), sol.F);                 // biceps side faces away from the elbow point, so the arm bends on its hinge
    const tgt = { ['ua' + sd]: frameQuat(S(El, Sp), bd), ['fa' + sd]: frameQuat(S(Wr, El), orth(bd, N(S(Wr, El)), sol.F)) };
    // flat palm on the floor: hand lies horizontal, fingers pointing along the forearm's ground direction (or toward the head)
    let hdir = S(Wr, El); hdir[1] = 0;
    if (Ln(hdir) < 0.35 * Ln(S(Wr, El))) { hdir = S(bonePos('neck').toArray(), bonePos('pelvis').toArray()); hdir[1] = 0; }
    if (EX[sol.id] && EX[sol.id].handsOut) {        // fingers turned outward, away from the body
      const out = S(Sp, bonePos('chest').toArray()); out[1] = 0;
      hdir = A(K(N(out), 0.9), K(N(hdir), 0.35));
    }
    { const sideV = N(X([0, 1, 0], N(hdir))), o = (globalThis.HANDO || [0, 1, 0]); tgt['h' + sd] = frameQuat(N(hdir), A(A(K([0, 1, 0], o[1]), K(sideV, o[0] * (sd === 'L' ? 1 : -1))), [0, 0, 0])); }
    for (const nm of ['ua' + sd, 'fa' + sd, 'h' + sd]) {
      const w = tgt[nm].clone().multiply(restFrame(nm, FWD[nm]).clone().invert());
      const parent = meta.bones[meta.bones.findIndex(b => b[0] === nm)][1];
      const pq = new THREE.Quaternion(); bones[meta.bones[parent][0]].getWorldQuaternion(pq);
      bones[nm].quaternion.copy(pq.invert().multiply(w));
      bones[nm].updateMatrixWorld(true);
    }
  }
  // gaze: head (and part of the neck) turns to follow the rising hand
  if (EX[sol.id] && EX[sol.id].lookHand) {
    mesh.updateMatrixWorld(true);
    const hL = tailWorld('hL'), hR = tailWorld('hR'), hand = hL.y > hR.y ? hL : hR;
    const hp = bonePos('head'), shY = Math.max(bonePos('uaL').y, bonePos('uaR').y);
    const w = Math.max(0, Math.min(1, (hand.y - shY) / 12));
    if (w > 0) {
      let look = N(hand.clone().sub(hp).toArray());
      { const hz = Math.hypot(look[0], look[2]), maxUp = Math.tan(48 * Math.PI / 180); if (look[1] > hz * maxUp) { const h2 = hz > 1e-3 ? hz : 1e-3; const dirH = hz > 1e-3 ? [look[0] / hz, 0, look[2] / hz] : [0, 0, 1]; look = N([dirH[0], maxUp, dirH[2]]); } }
      for (const [nm, amt] of [['neck', 0.45], ['head', 1]]) {
        const cur = new THREE.Quaternion(); bones[nm].getWorldQuaternion(cur);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cur).toArray(), face = new THREE.Vector3(0, 0, 1).applyQuaternion(cur).toArray();
        // world rotation = frame * rest^-1; we recompute the frame with the face turned toward the hand
        const restQ = restFrame(nm, FWD[nm]);
        const curFrame = cur.clone().multiply(restQ);
        const fUp = new THREE.Vector3(0, 1, 0).applyQuaternion(curFrame).toArray(), fFace = new THREE.Vector3(0, 0, 1).applyQuaternion(curFrame).toArray();
        const rot = new THREE.Quaternion().setFromUnitVectors(V(N(fFace)), V(look));
        const part = new THREE.Quaternion().slerp(rot, w * amt * 0.92);
        const tgt = part.multiply(curFrame);
        const wq = tgt.clone().multiply(restQ.clone().invert());
        const parent = meta.bones[meta.bones.findIndex(b => b[0] === nm)][1];
        const pq = new THREE.Quaternion(); bones[meta.bones[parent][0]].getWorldQuaternion(pq);
        bones[nm].quaternion.copy(pq.invert().multiply(wq)); bones[nm].updateMatrixWorld(true);
      }
    }
  }
  mesh.updateMatrixWorld(true);
}

/* ---------- highlights ---------- */
function setHighlights(id, sol) {
  const T = TARGETS[id] || { t: [] }, tg = T.t, label = (T.label || '').toLowerCase();
  const uni = !(DEF[id] && DEF[id].sides) || tg.includes('glutes');
  const nearSide = sol.nearIsL ? 'L' : 'R', farSide = sol.nearIsL ? 'R' : 'L';
  const hot = new Set();
  const add = (part, sides, region) => groupsInfo.forEach((g, i) => { if (g.part === part && (!sides || sides.includes(g.side) || g.side === 'C') && (!region || g.region === region)) hot.add(i); });
  const legSides = uni ? ['L', 'R'] : [nearSide];
  if (tg.includes('glutes')) add(0);
  if (tg.includes('hams')) add(3, legSides);
  if (tg.includes('quads')) { add(7, legSides); if (/adductor|inner|groin/.test(label)) add(12, legSides); }
  if (tg.includes('farleg')) { add(7, [farSide]); if (/adductor|inner/.test(label)) add(12, [farSide]); }
  if (tg.includes('abs')) add(10, null, 'abs');
  if (tg.includes('obliques')) { add(10, null, 'abs'); add(5, null, 'lower'); }
  if (tg.includes('back')) add(5);
  if (tg.includes('arm')) { const s = uni ? ['L', 'R'] : [nearSide]; add(15, s); add(14, s); add(1, s); }
  mesh.geometry.groups.forEach((g, i) => { g.materialIndex = groupsInfo[i].part * 2 + (hot.has(i) ? 1 : 0); });
}

/* ---------- props ---------- */
const propMat = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 });
function cyl(a, b, r, mat) { const d = S(b, a), l = Ln(d); const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, l, 14), mat); m.position.set(...Lr(a, b, .5)); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), V(N(d))); m.castShadow = true; return m; }
function boxM(c, h, mat) { const m = new THREE.Mesh(new THREE.BoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2), mat); m.position.set(...c); m.castShadow = true; m.receiveShadow = true; return m; }
function buildProps(id) {
  propGroup.clear();
  const props = EX[id].props || [], s = S2, Y = y => (105 - y) * s;
  const grey = propMat(0x6c6c70), dark = propMat(0x3a3a3d), wood = propMat(0xb48a55);
  if (props.includes('door')) propGroup.add(boxM([85.5 * s, 68 * s, -14 * s], [2.2 * s, 68 * s, 2.2 * s], wood));
  if (props.includes('rollerup')) { const m = new THREE.Mesh(new THREE.CylinderGeometry(6 * s, 6 * s, EX[id].legs3d === 'hydrant' ? 14 : 25 * s, 24), dark); m.position.set(EX[id].legs3d === 'hydrant' ? 89 * s : 72 * s, EX[id].legs3d === 'hydrant' ? 7 : 12.5 * s, EX[id].legs3d === 'hydrant' ? 17 : 10 * s); m.castShadow = true; propGroup.add(m); }
  if (props.includes('ladder')) { const y = propMat(0xe7c94a); propGroup.add(cyl([-60 * s, 0.5, -13 * s], [260 * s, 0.5, -13 * s], 0.45, y)); propGroup.add(cyl([-60 * s, 0.5, 13 * s], [260 * s, 0.5, 13 * s], 0.45, y)); for (let x = -46; x <= 250; x += 24) propGroup.add(cyl([x * s, 0.4, -13 * s], [x * s, 0.4, 13 * s], 0.35, y)); }
}
function boneTail(name) { const b = meta.bones.find(x => x[0] === name), J = meta.joints; const local = V(S(J[b[3]], J[b[2]])); return local.applyMatrix4(bones[name].matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(bones[name].matrixWorld)).add(new THREE.Vector3().setFromMatrixPosition(bones[name].matrixWorld)); }
function bonePos(name) { return new THREE.Vector3().setFromMatrixPosition(bones[name].matrixWorld); }
function tailWorld(name) { const b = meta.bones.find(x => x[0] === name), J = meta.joints; const off = V(S(J[b[3]], J[b[2]])); const q = new THREE.Quaternion(); bones[name].getWorldQuaternion(q); return bonePos(name).add(off.applyQuaternion(q)); }
let dyn = [];
function dynamicProps(id, sol, pose) {
  dyn.forEach(m => { propGroup.remove(m); m.geometry.dispose(); }); dyn = [];
  const props = EX[id].props || [], tg = (TARGETS[id] || { t: [] }).t, s = S2;
  const near = sol.nearIsL ? 'L' : 'R', far = sol.nearIsL ? 'R' : 'L';
  const addD = m => { dyn.push(m); propGroup.add(m); };
  if (props.includes('strap')) { const fL = bonePos('ftL'), fR = bonePos('ftR'), up = fL.y > fR.y ? 'L' : 'R'; const hand = bonePos('h' + near).lerp(tailWorld('h' + near), 0.45), foot = bonePos('ft' + up).lerp(tailWorld('ft' + up), 0.55); addD(cyl(hand.toArray(), foot.toArray(), 0.35, propMat(0x6fc8b0))); }
  if (props.includes('stick')) addD(cyl(tailWorld('h' + near).toArray(), tailWorld('h' + far).toArray(), 0.6, propMat(0xb48a55)));
  if (props.includes('dowel')) { const q = new THREE.Quaternion(); bones.chest.getWorldQuaternion(q); const back = new THREE.Vector3(0, 0, -1).applyQuaternion(q).multiplyScalar(6); const a = bonePos('head').add(back), b = bonePos('pelvis').add(back.clone().multiplyScalar(1.15)); const d = a.clone().sub(b); addD(cyl(b.clone().sub(d.clone().multiplyScalar(.12)).toArray(), a.clone().add(d.multiplyScalar(.2)).toArray(), 0.6, propMat(0xb48a55))); }
  if (props.includes('roller')) { const m = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.6, 22, 24), propMat(0x3f6d8a)); const p = Lr(bonePos('chest').toArray(), bonePos('spine').toArray(), .3); m.position.set(p[0], 4.6, p[2]); m.rotation.x = Math.PI / 2; m.castShadow = true; addD(m); }
  if (props.includes('rope') && pose.r1) { const a = tailWorld('h' + near), b = tailWorld('h' + far); const top = Math.max(0.4, (105 - pose.r1[1]) * s); const mid = a.clone().lerp(b, .5); const curve = new THREE.CatmullRomCurve3([a, new THREE.Vector3(mid.x, (top + a.y) / 2, a.z + (a.z - b.z) * .6), new THREE.Vector3(mid.x, top, mid.z), new THREE.Vector3(mid.x, (top + b.y) / 2, b.z + (b.z - a.z) * .6), b]); addD(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.28, 6), propMat(0x73bfff))); }
  // furniture fitted to the posed body
  const Fw = (() => { const q = new THREE.Quaternion(); bones.pelvis.getWorldQuaternion(q); const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q); f.y = 0; return f.lengthSq() > 1e-4 ? f.normalize() : new THREE.Vector3(1, 0, 0); })();
  const side = new THREE.Vector3(0, 1, 0).cross(Fw).normalize();
  const along = (p, f, sd, y) => new THREE.Vector3(p.x + Fw.x * f + side.x * sd, y, p.z + Fw.z * f + side.z * sd);
  const blk = (c, hf, hy, hs, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); m.scale.set(1, 1, 1); const g = new THREE.BoxGeometry(hs * 2, hy * 2, hf * 2); m.geometry.dispose(); m.geometry = g; m.position.copy(c); m.lookAt(c.clone().add(Fw)); m.castShadow = true; m.receiveShadow = true; addD(m); };
  const samples = (filter) => { const v = new THREE.Vector3(), out = []; for (const i of bodySample) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); if (!filter || filter(v)) out.push(v.clone()); } return out; };
  if (props.includes('chair')) {
    const pel = bonePos('pelvis'), seatTop = pel.y - 4.6, dark = propMat(0x3a3a3d);
    const back = samples(v => v.y > seatTop && v.y < pel.y + 18).reduce((m, v) => Math.min(m, (v.x - pel.x) * Fw.x + (v.z - pel.z) * Fw.z), 0);
    blk(along(pel, back + 7.5, 0, seatTop - 0.8), 9, 0.8, 9, dark);
    for (const f of [back + 0.8, back + 14]) for (const sd of [-8, 8]) blk(along(pel, f, sd, (seatTop - 1.6) / 2), 0.6, (seatTop - 1.6) / 2, 0.6, dark);
    blk(along(pel, back - 0.9, 0, seatTop + 9), 0.7, 10, 9, dark);
  }
  if (props.includes('wallback')) { const pel = bonePos('pelvis'); const back = samples().reduce((m, v) => Math.min(m, (v.x - pel.x) * Fw.x + (v.z - pel.z) * Fw.z), 0); blk(along(pel, back - 2.3, 0, 48), 2, 48, 26, propMat(0x6c6c70)); }
  if (props.includes('wall')) { const fl = bonePos('ft' + near).add(bonePos('ft' + far)).multiplyScalar(0.5); const pel = bonePos('pelvis'); const toWall = new THREE.Vector3(fl.x - pel.x, 0, fl.z - pel.z); const dx = Math.sign(toWall.x || 1); const maxX = samples(v => v.y > 12).reduce((m, v) => dx > 0 ? Math.max(m, v.x) : Math.min(m, v.x), fl.x); const w = new THREE.Mesh(new THREE.BoxGeometry(4, 96, 52), propMat(0x6c6c70)); w.position.set(maxX + dx * 2.4, 48, fl.z); w.castShadow = true; w.receiveShadow = true; addD(w); }
  if (props.includes('couch')) {
    const ft = bonePos('ft' + far), kn = bonePos('sh' + far), tl = tailWorld('ft' + far), dark = propMat(0x3a3a3d);
    const pel = bonePos('pelvis'); const rel = p => (p.x - pel.x) * Fw.x + (p.z - pel.z) * Fw.z;
    const front = Math.min(rel(kn), rel(ft), rel(tl)) - 2.2, top = Math.max(ft.y, tl.y) + 1.0;
    blk(along(pel, front - 15, 0, top / 2), 15, top / 2, 16, dark); blk(along(pel, front - 27, 0, top + 9), 3, 9 + top / 2, 16, dark);
  }
  if (props.includes('ball')) { const sp = bonePos('spine'), pel = bonePos('pelvis'); const c = sp.clone().lerp(pel, 0.5); const bottom = Math.min(...samples(v => v.distanceTo(c) < 12).map(v => v.y), c.y - 5); const r = Math.max(7, bottom / 2); const m = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 28), propMat(0x8d97a3)); m.position.set(c.x, r, c.z); m.castShadow = true; m.receiveShadow = true; addD(m); }
  if (tg.includes('nerve')) {
    const thq = new THREE.Quaternion(); bones['th' + near].getWorldQuaternion(thq);
    const shq = new THREE.Quaternion(); bones['sh' + near].getWorldQuaternion(shq);
    const backT = new THREE.Vector3(0, 0, -1).applyQuaternion(thq), backS = new THREE.Vector3(0, 0, -1).applyQuaternion(shq);
    const hipP = bonePos('th' + near), kn = bonePos('sh' + near), an = bonePos('ft' + near);
    const pts = [hipP.clone().add(backT.clone().multiplyScalar(4.4)).add(new THREE.Vector3(0, 1.5, 0)), hipP.clone().lerp(kn, .5).add(backT.clone().multiplyScalar(3.6)), kn.clone().add(backT.clone().multiplyScalar(2.6)), kn.clone().lerp(an, .45).add(backS.clone().multiplyScalar(3.0)), kn.clone().lerp(an, .85).add(backS.clone().multiplyScalar(1.8))];
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.42, 8), new THREE.MeshStandardMaterial({ color: 0xffd23a, emissive: 0x8a6a00, emissiveIntensity: 0.6, roughness: 0.4 }));
    addD(m);
  }
}

/* ---------- framing ---------- */
function framing(id) {
  if (frameCache[id]) return frameCache[id];
  const box = new THREE.Box3(), v = new THREE.Vector3();
  for (const t of [0, 0.5, 1]) {
    const pose = interp(EX[id].A, EX[id].B, t); applyPose(solve(pose, id));
    for (const i of sampleIdx) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); box.expandByPoint(v); }
  }
  return frameCache[id] = { c: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
}

/* ---------- render ---------- */
let curId = null;
function render(id, pose) {
  const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
  const pr = renderer.getPixelRatio();
  if (canvas.width !== Math.round(w * pr) || canvas.height !== Math.round(h * pr)) renderer.setSize(w, h, false);
  if (curId !== id) { curId = id; buildProps(id); }
  if (EX[id].plantFeet && !plantCache[id]) {
    applyPose(solve(EX[id].A, id)); mesh.updateMatrixWorld(true);
    const c = {}; for (const sd of ['L', 'R']) { const q = new THREE.Quaternion(); bones['ft' + sd].getWorldQuaternion(q); c[sd] = { ank: bonePos('ft' + sd).toArray(), fq: q }; }
    plantCache[id] = c;
  }
  const sol = solve(pose, id);
  const fr = framing(id);
  applyPose(sol);
  setHighlights(id, sol);
  dynamicProps(id, sol, pose);
  const aspect = w / h; camera.aspect = aspect;
  const fov = camera.fov * Math.PI / 180;
  const radius = Math.max(fr.size.y * 0.5 + 4, (Math.max(fr.size.x, fr.size.z) * 0.5 + 4) / aspect);
  const dist = radius / Math.tan(fov / 2) * 0.98;
  const cp = Math.cos(view.pitch);
  camera.position.set(fr.c.x + Math.sin(view.yaw) * cp * dist, fr.c.y + Math.sin(view.pitch) * dist, fr.c.z + Math.cos(view.yaw) * cp * dist);
  camera.lookAt(fr.c); camera.updateProjectionMatrix();
  const ly = view.yaw - 1.0;
  keyLight.position.set(fr.c.x + Math.sin(ly) * 60, fr.c.y + 90, fr.c.z + Math.cos(ly) * 60); keyLight.target.position.copy(fr.c);
  floor.position.set(fr.c.x, 0, fr.c.z);
  renderer.render(scene, camera);
}

/* ---------- drag to rotate ---------- */
function bindDrag() {
  let st = null, lastTap = 0;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', e => { st = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch }; try { canvas.setPointerCapture(e.pointerId); } catch (_) { }
    const now = Date.now(); if (now - lastTap < 300 && cur) { saveView(cur.id, null); startView(cur.id); st = null; } lastTap = now; view.touched = true; if (hint) hint.style.opacity = '0'; });
  canvas.addEventListener('pointermove', e => { if (!st) return; view.yaw = st.yaw - (e.clientX - st.x) * 0.012; view.pitch = Math.max(-0.05, Math.min(1.2, st.pitch + (e.clientY - st.y) * 0.008)); });
  const end = () => { if (st && cur && (st.yaw !== view.yaw || st.pitch !== view.pitch)) saveView(cur.id, { yaw: view.yaw, pitch: view.pitch }); st = null; }; canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
}

/* ---------- mounting into the app's stages ---------- */
function pickStage() {
  const pl = document.querySelector('.player.on .stage'); if (pl) return pl;
  const vh = window.innerHeight; const list = [...document.querySelectorAll('.view.on details[open] .stage')].filter(s => { const r = s.getBoundingClientRect(); return r.bottom > 0 && r.top < vh; });
  return list[list.length - 1] || null;
}
function mount(stage) {
  if (cur && cur.stage === stage && stage.contains(canvas)) return cur;
  if (cur) { cur.svg.style.display = ''; delete cur.svg.dataset.r3; canvas.remove(); if (hint) hint.remove(); cur = null; }
  if (!stage) return null;
  const svg = stage.querySelector('svg.fig'); if (!svg) return null;
  stage.querySelectorAll('canvas.fig3d').forEach(c => { if (c !== canvas) c.remove(); });
  stage.querySelectorAll('.hint3d').forEach(c => c.remove());
  svg.style.display = 'none'; svg.dataset.r3 = '1';
  stage.style.position = 'relative'; stage.appendChild(canvas);
  if (!hint) { hint = document.createElement('div'); hint.className = 'hint3d'; hint.textContent = '↻ Drag to rotate · double-tap to reset'; }
  hint.style.opacity = view.touched ? '0' : '1'; stage.appendChild(hint);
  cur = { stage, svg, id: svg.dataset.ex };
  startView(cur.id);
  return cur;
}
function frame(ts) {
  if (!ready) return false;
  const stage = pickStage();
  if (!stage) { if (cur) mount(null); return true; }
  const c = mount(stage); if (!c) return true;
  const ex = EX[c.id], t = phaseT(ex, ts);
  cycleSide = Math.floor(ts / ex.period) % 2 ? -1 : 1; cycleU = (ts % ex.period) / ex.period;
  render(c.id, interp(ex.A, ex.B, t));
  return true;
}
function renderStill(id, pose, el) {
  if (!canvas.parentNode && el) el.appendChild(canvas);
  cycleU = globalThis.TESTU ?? null; if (globalThis.TESTD) cycleSide = globalThis.TESTD;
  render(id, pose);
}
window.F3 = { load, frame, renderStill, view, dbgFace: () => { const q = new THREE.Quaternion(); bones.head.getWorldQuaternion(q); return new THREE.Vector3(0, 0, 1).applyQuaternion(q.multiply(restFrame('head', FWD.head))).toArray().map(v => +v.toFixed(2)); }, dbgBones: () => Object.fromEntries(Object.keys(bones).map(k => [k, bonePos(k).toArray().map(v => +v.toFixed(1))])), get ready() { return ready; } };
