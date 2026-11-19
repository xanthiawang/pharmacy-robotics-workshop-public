import loadMuJoCo from "./vendor/mujoco/mujoco.js";

let mj, model, data, initial, bodies, ready;
let revision = 0;
const part = (array, index, size) => array.slice(index * size, (index + 1) * size);

function poses() {
  const result = new Float32Array(bodies.length * 7);
  const xyz = data.xpos, rotation = data.xquat;
  bodies.forEach(({ id }, i) => {
    result.set(xyz.subarray(id * 3, id * 3 + 3), i * 7);
    result.set(rotation.subarray(id * 4, id * 4 + 4), i * 7 + 3);
  });
  return result;
}

function reset() {
  mj.mj_resetData(model, data);
  data.qpos.set(initial);
  mj.mj_forward(model, data);
}

async function build({ files, initialQpos }) {
  mj = await loadMuJoCo();
  mj.FS.mkdir("/meshes");
  for (const [path, bytes] of Object.entries(files)) {
    if (path.startsWith("assets/pharmacy/")) mj.FS.writeFile("/" + path.slice(16), bytes);
  }
  model = mj.MjModel.from_xml_path("/pharmacy.xml");
  data = new mj.MjData(model);
  initial = initialQpos;
  reset();
  bodies = [];
  const meshes = {}, geoms = [];
  for (let id = 0; id < model.nbody; id++) {
    const name = mj.mj_id2name(model, 1, id) || "";
    const robot = /^(arm|hand)\//.test(name);
    if (!robot && !/^(central_table_\d+$|destination_bin$|robot_station$|test_medicine_box($|__flap$))/.test(name)) continue;
    const body = bodies.length;
    bodies.push({ id, name });
    const start = model.body_geomadr[id], end = start + model.body_geomnum[id];
    for (let g = start; g < end; g++) {
      const rgba = part(model.geom_rgba, g, 4);
      if (!rgba[3] || (robot && model.geom_group[g] !== 1)) continue;
      const type = model.geom_type[g], mesh = model.geom_dataid[g];
      if (type === 7 && !meshes[mesh]) {
        const v = model.mesh_vertadr[mesh] * 3, f = model.mesh_faceadr[mesh] * 3;
        meshes[mesh] = {
          vertices: model.mesh_vert.slice(v, v + model.mesh_vertnum[mesh] * 3),
          faces: new Uint32Array(model.mesh_face.slice(f, f + model.mesh_facenum[mesh] * 3))
        };
      }
      geoms.push({ body, name: mj.mj_id2name(model, 5, g) || "", type, mesh, rgba,
        size: part(model.geom_size, g, 3), pos: part(model.geom_pos, g, 3), quat: part(model.geom_quat, g, 4) });
    }
  }
  postMessage({ kind: "scene", bodies, meshes, geoms, initial: poses() });
}

async function simulate({ id, targets, steps }) {
  await ready;
  if (id !== revision) return;
  reset();
  const ctrl = data.ctrl;
  let frame = 0, tick = 0, batch = [];
  const flush = () => {
    if (!batch.length) return;
    const packed = new Float32Array(batch.length * bodies.length * 7);
    batch.forEach((pose, i) => packed.set(pose, i * pose.length));
    postMessage({ kind: "frames", id, start: frame, packed }, [packed.buffer]);
    frame += batch.length;
    batch = [];
  };
  batch.push(poses());
  for (let i = 0; i < steps.length; i++) {
    const a = targets[Math.max(0, i - 1)], b = targets[i];
    for (let j = 1; j <= steps[i]; j++) {
      const t = j / steps[i], blend = t * t * (3 - 2 * t);
      for (let k = 0; k < ctrl.length; k++) ctrl[k] = a[k] + (b[k] - a[k]) * blend;
      for (let sub = 0; sub < 10; sub++) mj.mj_step(model, data);
      tick++;
      if (tick % 2 === 0) batch.push(poses());
      if (tick % 40 === 0) {
        flush();
        await new Promise(resolve => setTimeout(resolve, 0));
        if (id !== revision) return;
      }
    }
  }
  if (tick % 2) batch.push(poses());
  flush();
  postMessage({ kind: "done", id });
}

const fail = error => postMessage({ kind: "error", text: String(error?.message || error) });
self.onmessage = ({ data: msg }) => {
  if (msg.kind === "init") {
    ready = build(msg);
    ready.catch(fail);
  } else {
    revision = msg.id;
    simulate(msg).catch(fail);
  }
};
