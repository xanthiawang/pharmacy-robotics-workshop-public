import * as T from "./vendor/three-workcell.js";

const align = (object, p, q) => {
  object.position.fromArray(p);
  object.quaternion.set(q[1], q[2], q[3], q[0]);
};

export function createWorkcell(canvas, status, onRender, onReady) {
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  const scene = new T.Scene();
  scene.background = new T.Color(0xe8eeec);
  scene.add(new T.HemisphereLight(0xffffff, 0xb6c2c3, 2));
  const key = new T.DirectionalLight(0xfff7e6, 2.4);
  key.position.set(.5, 1.8, 4);
  key.target.position.set(2.45, 3.25, .8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -1.8, right: 1.8, bottom: -1.8, top: 1.8, near: .1, far: 9 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.normalBias = .001;
  key.shadow.bias = -.00015;
  scene.add(key, key.target);
  const floor = new T.Mesh(new T.BoxGeometry(20, 20, .04), new T.MeshStandardMaterial({ color: 0xcbd6d2 }));
  floor.position.z = -.02;
  floor.receiveShadow = true;
  scene.add(floor);
  const camera = new T.PerspectiveCamera(34, 1, .01, 50);
  camera.up.set(0, 0, 1);
  const orbit = new T.OrbitControls(camera, canvas);
  orbit.minDistance = .15;
  orbit.maxDistance = 4;
  orbit.maxPolarAngle = Math.PI * .49;
  let worker, groups = [], assembly, frames = [], revision = 0, signature, time = 0, palm;
  let failed = false, routeTimer;
  let close = false, following = new T.Vector3();
  let editingFrames;
  const render = () => {
    if (!canvas.clientWidth) return;
    renderer.render(scene, camera);
    onRender();
  };
  orbit.addEventListener("change", render);
  function size() {
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    render();
  }
  new ResizeObserver(size).observe(canvas);
  function viewpoint(detail = false) {
    close = detail && !!palm;
    const focus = close ? palm.position.clone() : groups.find(g => g.name === "robot_station")?.position.clone() || new T.Vector3(2.85, 3.25, 0);
    if (!close) focus.add(new T.Vector3(-.31, .02, 1.035));
    if (close) focus.z -= .045;
    orbit.target.copy(focus);
    camera.position.copy(focus).add(close ? new T.Vector3(-.34, -.41, .18) : new T.Vector3(-.78, -1.3, .52));
    if (palm) following.copy(palm.position);
    orbit.update();
    render();
  }
  function display(pose) {
    if (!pose) return;
    groups.forEach((body, i) => {
      const k = i * 7;
      body.position.fromArray(pose, k);
      body.quaternion.set(pose[k + 4], pose[k + 5], pose[k + 6], pose[k + 3]);
    });
    applyEditPose();
    if (close && palm) {
      const delta = palm.position.clone().sub(following);
      orbit.target.add(delta);
      camera.position.add(delta);
      following.copy(palm.position);
    }
    render();
  }
  function seek(seconds) {
    time = seconds;
    display(frames[Math.min(Math.round(time * 25), frames.length - 1)]);
  }
  function clear() {
    if (!assembly) return;
    const geometries = new Set();
    assembly.traverse(o => {
      if (o.geometry) geometries.add(o.geometry);
      o.material?.dispose();
    });
    geometries.forEach(g => g.dispose());
    scene.remove(assembly);
    assembly = null;
    groups = [];
    palm = null;
  }
  function build(msg) {
    assembly = new T.Group();
    groups = msg.bodies.map(({ name }) => {
      const g = new T.Group();
      g.name = name;
      assembly.add(g);
      return g;
    });
    const meshes = new Map();
    for (const item of msg.geoms) {
      const body = groups[item.body], s = item.size;
      let geometry, color = new T.Color().setRGB(...item.rgba.slice(0, 3), T.SRGBColorSpace);
      let opacity = item.rgba[3];
      if (item.type === 7) {
        if (!meshes.has(item.mesh)) {
          const source = msg.meshes[item.mesh], geo = new T.BufferGeometry();
          geo.setAttribute("position", new T.BufferAttribute(source.vertices, 3));
          geo.setIndex(new T.BufferAttribute(source.faces, 1));
          geo.computeVertexNormals();
          meshes.set(item.mesh, geo);
        }
        geometry = meshes.get(item.mesh);
        if (body.name.startsWith("arm/")) color.set(/Base|Link[246]/.test(body.name) ? 0x406d78 : 0xe2e7e6);
        else color.set(/palm|dip/.test(body.name) ? 0x344755 : 0xc5cdd1);
      } else if (item.type === 6) geometry = new T.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2);
      else if (item.type === 5) {
        geometry = new T.CylinderGeometry(s[0], s[0], s[1] * 2, 36);
        geometry.rotateX(Math.PI / 2);
      } else continue;
      if (body.name === "destination_bin") { color.set(0x249eae); opacity = .46; }
      if (body.name.startsWith("test_medicine_box")) {
        color.set(/lid|stripe|label|tab/.test(item.name) ? 0xe87632 : 0xffda94);
      }
      if (item.name.endsWith("__top")) color.set(0xc9ae87);
      const material = new T.MeshStandardMaterial({ color, roughness: .58, metalness: item.type === 7 ? .19 : .02,
        transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
      const object = new T.Mesh(geometry, material);
      object.receiveShadow = true;
      object.castShadow = opacity >= 1;
      align(object, item.pos, item.quat);
      body.add(object);
    }
    scene.add(assembly);
    palm = groups.find(g => g.name === "hand/palm");
    close = false;
    display(msg.initial);
    viewpoint();
    size();
    onReady();
  }
  function project(files) {
    clearTimeout(routeTimer);
    worker?.terminate();
    failed = false;
    clear();
    signature = null;
    frames = [];
    status.textContent = "正在加载机械臂和灵巧手…";
    worker = new Worker(new URL("./workcell-physics.js", import.meta.url), { type: "module" });
    worker.onerror = () => { failed = true; status.textContent = "三维仿真加载失败，可切换到俯视或侧视编辑。"; };
    worker.onmessage = ({ data: msg }) => {
      if (msg.kind === "scene") { build(msg); return; }
      if (msg.kind === "error") { console.error(msg.text); worker.onerror(); return; }
      if (msg.id !== revision) return;
      if (msg.kind === "done") { status.textContent = ""; return; }
      const stride = groups.length * 7;
      for (let offset = 0; offset < msg.packed.length; offset += stride) {
        frames[msg.start + offset / stride] = msg.packed.subarray(offset, offset + stride);
      }
      seek(time);
    };
    const config = new TextDecoder().decode(files["controller.py"]).match(/'initialQpos':\s*(\[[^\]]+\])/);
    if (!config) throw new Error("工程缺少初始关节位置。");
    worker.postMessage({ kind: "init", files: Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith("assets/pharmacy/"))),
      initialQpos: JSON.parse(config[1]) });
  }
  function route(targets, steps) {
    const key = JSON.stringify([targets, steps]);
    if (key === signature || failed) return;
    signature = key;
    frames = [];
    status.textContent = "正在计算动作与药盒碰撞…";
    clearTimeout(routeTimer);
    const id = ++revision;
    routeTimer = setTimeout(() => worker.postMessage({ kind: "route", id, targets, steps }), 90);
  }
  function applyEditPose() {
    if (!editingFrames || !palm) return;
    const target = editingFrames.at(-1);
    const rotation = palm.quaternion.clone().set(target.q[1], target.q[2], target.q[3], target.q[0]);
    const change = rotation.multiply(palm.quaternion.clone().invert());
    const origin = new T.Vector3(...target.p);
    for (const g of groups) {
      if (g !== palm && g.name.startsWith("hand/")) {
        g.position.sub(palm.position).applyQuaternion(change).add(origin);
        g.quaternion.premultiply(change);
      }
    }
    for (const frame of editingFrames) {
      const g = groups.find(body => body.name === frame.name);
      if (g) align(g, frame.p, frame.q);
    }
  }
  function editPose(frames) {
    editingFrames = frames;
    if (frames) { applyEditPose(); render(); }
    else seek(time);
  }
  function screen(point) {
    const p = new T.Vector3(...point).project(camera);
    return { x: (p.x + 1) * canvas.clientWidth / 2, y: (1 - p.y) * canvas.clientHeight / 2,
      visible: p.z >= -1 && p.z <= 1 };
  }
  function pickPlane(clientX, clientY, anchor, vertical) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width * 2 - 1;
    const y = 1 - (clientY - rect.top) / rect.height * 2;
    const ray = new T.Vector3(x, y, .5).unproject(camera).sub(camera.position).normalize();
    const normal = new T.Vector3(0, 0, 1);
    if (vertical) {
      camera.getWorldDirection(normal);
      normal.z = 0;
      if (normal.length() < .05) return null;
      normal.normalize();
    }
    const slope = normal.dot(ray);
    if (Math.abs(slope) < .025) return null;
    const depth = normal.dot(new T.Vector3(...anchor).sub(camera.position)) / slope;
    if (depth <= 0) return null;
    return ray.multiplyScalar(depth).add(camera.position).toArray();
  }
  const canPlay = seconds => Math.round(seconds * 25) < frames.length;
  const lockCamera = locked => { orbit.enabled = !locked; };
  return { project, route, seek, viewpoint, size, canPlay, editPose, screen, pickPlane, lockCamera, failed: () => failed };
}
