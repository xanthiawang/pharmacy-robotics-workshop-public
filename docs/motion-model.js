const xmlPath = "assets/pharmacy/pharmacy.xml";
const controllerPath = "controller.py";
const maxBytes = 32 * 1024 * 1024;
export const maxPoints = 40;
export const hz = 50;
const maxStepTicks = 30 * hz;
const minStepTicks = 5;
const maxTotalTicks = 180 * hz;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function controllerData(source) {
  const targets = source.match(/^TARGETS=(\[[^\r\n]*\])$/m);
  const steps = source.match(/^STEPS=(\[[^\r\n]*\])$/m);
  check(targets && steps, "工程中没有可编辑的抓取轨迹。");
  return {
    targets: JSON.parse(targets[1]),
    steps: JSON.parse(steps[1]),
    skeleton: source.replace(targets[0], "TARGETS=[]").replace(steps[0], "STEPS=[]")
  };
}

function parseArchive(bytes) {
  check(bytes.length <= maxBytes, "工程文件太大。请选择工作坊的 BotLab 工程。");
  let size = 0;
  const seen = new Set();
  const files = fflate.unzipSync(bytes, { filter: entry => {
    size += entry.originalSize;
    check(size <= 64 * 1024 * 1024 && seen.size < 100 && !seen.has(entry.name),
      "工程的文件列表无效。");
    seen.add(entry.name);
    return !entry.name.endsWith("/");
  }});
  check(files[controllerPath] && files[xmlPath] && files["botlab.project.json"],
    "请打开工作坊的抓取工程，或用「布局转BotLab」生成的工程。");
  const xml = new DOMParser().parseFromString(fflate.strFromU8(files[xmlPath]), "application/xml");
  check(xml.documentElement.localName === "mujoco", "工程里的药房模型无法读取。");
  return { files, xml, ...controllerData(fflate.strFromU8(files[controllerPath])) };
}

const furniture = /^(?:(?:back|right)_cabinet_\d+|central_table_\d+|.*chair.*)$/;
function compatibleLayout(xml, baseline) {
  if (normalizedLayout(xml) !== normalizedLayout(baseline)) return false;
  const original = new Map([...baseline.querySelectorAll("worldbody > body")].map(
    node => [node.getAttribute("name"), node]));
  return [...xml.querySelectorAll("worldbody > body")].every(node => {
    const name = node.getAttribute("name");
    if (!furniture.test(name)) return true;
    const before = original.get(name);
    const position = vector(node, "pos", [0, 0, 0]);
    const rotation = vector(node, "quat", [1, 0, 0, 0]);
    return position.length === 3 && position.every(Number.isFinite) &&
      position[0] >= 0 && position[0] <= 3.6 && position[1] >= 0 && position[1] <= 6.4 &&
      Math.abs(position[2] - vector(before, "pos", [0, 0, 0])[2]) < 1e-6 &&
      rotation.length === 4 && rotation.every(Number.isFinite) &&
      Math.abs(Math.hypot(...rotation) - 1) < 1e-6 &&
      Math.abs(rotation[1]) <= 1e-6 && Math.abs(rotation[2]) <= 1e-6;
  });
}

function normalizedLayout(xml) {
  const copy = xml.cloneNode(true);
  for (const node of copy.querySelectorAll("worldbody > body")) {
    if (furniture.test(node.getAttribute("name"))) {
      node.removeAttribute("pos");
      node.removeAttribute("quat");
    }
  }
  return new XMLSerializer().serializeToString(copy);
}

const vector = (node, key, fallback) => node.hasAttribute(key)
  ? node.getAttribute(key).trim().split(/\s+/).map(Number) : fallback;

function normalized(v) {
  const length = Math.hypot(...v);
  return v.map(value => value / length);
}

function transformNode(node) {
  const joint = node.querySelector(":scope > joint");
  return {
    name: node.getAttribute("name"),
    position: vector(node, "pos", [0, 0, 0]),
    rotation: normalized(vector(node, "quat", [1, 0, 0, 0])),
    axis: joint ? normalized(vector(joint, "axis", [0, 0, 1])) : null
  };
}

export function buildModel(xml) {
  const arm = [];
  let node = xml.querySelector('body[name="hand/palm"]');
  while (node && node.localName !== "worldbody") {
    arm.unshift(transformNode(node));
    node = node.parentElement;
  }
  const limits = [...xml.querySelectorAll("actuator > [ctrlrange]")].map(
    actuator => vector(actuator, "ctrlrange", null));
  check(arm.filter(part => part.axis).length === 7 && limits.length === 13,
    "工程需要使用工作坊的 Marvin M6S 和 Handle-L1。");
  const landmarks = [
    ["药盒", "test_medicine_box", "#cb7027"],
    ["周转箱", "destination_bin", "#2d689a"],
    ...(xml.documentElement.getAttribute("model") === "dispatch" ? [["待取架中层", "dispatch_rack__shelf2", "#2d689a"]] : [])
  ].flatMap(([label, name, color]) => {
    let node = xml.querySelector('body[name="' + name + '"]');
    if (!node) return [];
    let position = [0, 0, 0];
    while (node?.localName === "body") {
      position = add(vector(node, "pos", [0, 0, 0]), rotate(vector(node, "quat", [1, 0, 0, 0]), position));
      node = node.parentElement;
    }
    return [{ label, color, position }];
  });
  const actuators = [...xml.querySelectorAll("actuator > [joint]")].map(a => a.getAttribute("joint"));
  const coupling = new Map([...xml.querySelectorAll("equality > joint")].map(e =>
    [e.getAttribute("joint1"), { driver: actuators.indexOf(e.getAttribute("joint2")), coefficients: vector(e, "polycoef", []) }]));
  const fingers = [...xml.querySelectorAll('body[name="hand/palm"] body')].map(body => {
    const joint = body.querySelector(":scope > joint")?.getAttribute("name");
    return { ...transformNode(body), parent: body.parentElement.getAttribute("name"),
      driver: actuators.indexOf(joint), coupling: coupling.get(joint) };
  });
  return { arm, fingers, limits, landmarks };
}

export function openProject(bytes, baseline) {
  const archive = parseArchive(bytes);
  archive.model = buildModel(archive.xml);
  validateRoute(archive.targets, archive.steps, archive.model.limits);
  if (baseline) validateProject(archive, baseline);
  return archive;
}

export function validateProject(archive, baseline) {
  const entries = Object.keys(archive.files);
  const identicalAssets = entries.length === Object.keys(baseline.files).length &&
    entries.every(name => {
      const before = baseline.files[name];
      if (!before) return false;
      if (name === controllerPath || name === xmlPath) return true;
      const after = archive.files[name];
      return after.length === before.length && after.every((value, index) => value === before[index]);
    });
  check(identicalAssets && archive.skeleton === baseline.skeleton &&
    compatibleLayout(archive.xml, baseline.xml),
    "请选择本工作坊的抓取工程、动作编辑器导出的工程，或「布局转BotLab」生成的工程。");
  check(archive.targets[0].every((angle, joint) => angle === baseline.targets[0][joint]),
    "请保留工作坊的起始姿势。");
  return archive;
}

function validateRoute(targets, steps, limits) {
  const valid = Array.isArray(targets) && Array.isArray(steps) &&
    targets.length >= 2 && targets.length <= maxPoints && targets.length === steps.length &&
    steps.every(value => Number.isInteger(value) && value >= minStepTicks && value <= maxStepTicks) &&
    steps.reduce((sum, value) => sum + value, 0) <= maxTotalTicks &&
    targets.every(pose => Array.isArray(pose) && pose.length === limits.length &&
      pose.every((value, i) => Number.isFinite(value) && value >= limits[i][0] && value <= limits[i][1]));
  check(valid, "请检查关节范围。每步用时为 0.1–30 秒，整条路线最多 180 秒、40 个动作点。");
}

export function exportProject(archive, targets, steps) {
  validateRoute(targets, steps, archive.model.limits);
  const source = archive.skeleton.replace(/^TARGETS=\[\]$/m, "TARGETS=" + JSON.stringify(targets))
    .replace(/^STEPS=\[\]$/m, "STEPS=" + JSON.stringify(steps));
  const files = { ...archive.files, [controllerPath]: fflate.strToU8(source) };
  return new Promise((resolve, reject) => {
    fflate.zip(files, { level: 1 }, (error, result) => error ? reject(error) : resolve(result));
  });
}

const add = (a, b) => a.map((item, i) => item + b[i]);
const subtract = (a, b) => a.map((item, i) => item - b[i]);
const dot = (a, b) => a.reduce((sum, item, i) => sum + item * b[i], 0);
const cross = ([x, y, z], [a, b, c]) => [y*c-z*b, z*a-x*c, x*b-y*a];
const scaled = (v, scale) => v.map(value => value * scale);

function multiply([w, ...v], [s, ...u]) {
  return [w*s - dot(v, u), ...add(add(scaled(u, w), scaled(v, s)), cross(v, u))];
}

function rotate([w, ...v], point) {
  const t = scaled(cross(v, point), 2);
  return add(add(point, scaled(t, w)), cross(v, t));
}

export function armPoints(model, angles, frames) {
  let p = [0, 0, 0];
  let q = [1, 0, 0, 0];
  let index = 0;
  const points = [];
  for (const part of model.arm) {
    p = add(p, rotate(q, part.position));
    q = multiply(q, part.rotation);
    if (part.axis) {
      const half = angles[index++] / 2;
      q = multiply(q, [Math.cos(half), ...scaled(part.axis, Math.sin(half))]);
    }
    points.push(p);
    if (frames) frames.push({ name: part.name, p, q });
  }
  return points.slice(1);
}

export function poseFrames(model, angles) {
  const frames = [];
  armPoints(model, angles, frames);
  const byName = new Map(frames.map(f => [f.name, f]));
  for (const part of model.fingers) {
    const parent = byName.get(part.parent);
    let angle = angles[part.driver] ?? 0;
    if (part.coupling) {
      const { driver, coefficients } = part.coupling;
      angle = coefficients.reduceRight((v, c) => v * angles[driver] + c, 0);
    }
    const p = add(parent.p, rotate(parent.q, part.position));
    let q = multiply(parent.q, part.rotation);
    if (part.axis) q = multiply(q, [Math.cos(angle / 2), ...scaled(part.axis, Math.sin(angle / 2))]);
    const frame = { name: part.name, p, q };
    byName.set(frame.name, frame);
    frames.push(frame);
  }
  return frames;
}

export function wrist(model, angles) {
  return armPoints(model, angles).at(-1);
}

function solve3(matrix, target) {
  const rows = matrix.map((row, i) => [...row, target[i]]);
  for (let i = 0; i < 3; i++) {
    const diagonal = rows[i][i];
    rows[i] = scaled(rows[i], 1 / diagonal);
    for (let j = 0; j < 3; j++) {
      if (j !== i) rows[j] = subtract(rows[j], scaled(rows[i], rows[j][i]));
    }
  }
  return rows.map(row => row[3]);
}

export function moveWrist(model, initial, goal) {
  const angles = initial.slice();
  const derivativeStep = 1e-4;
  if (!goal.every(Number.isFinite)) return null;
  for (let iteration = 0; iteration < 85; iteration++) {
    const p = wrist(model, angles);
    const delta = subtract(goal, p);
    if (Math.hypot(...delta) < .0015) return angles;
    const columns = angles.map((_, i) => {
      angles[i] += derivativeStep;
      const after = wrist(model, angles);
      angles[i] -= derivativeStep;
      return scaled(subtract(after, p), 1 / derivativeStep);
    });
    const matrix = delta.map((_, row) => delta.map((_, col) =>
      columns.reduce((sum, column) => sum + column[row] * column[col], row === col ? .0025 : 0)));
    const correction = solve3(matrix, delta);
    angles.forEach((angle, i) => {
      const [min, max] = model.limits[i];
      const step = Math.max(-.15, Math.min(.15, dot(columns[i], correction)));
      angles[i] = Math.max(min, Math.min(max, angle + step));
    });
  }
  return null;
}

export function interpolate(start, end, progress) {
  const u = Math.max(0, Math.min(1, progress));
  const blend = u * u * (3 - 2*u);
  return start.map((value, joint) => value + (end[joint] - value) * blend);
}
