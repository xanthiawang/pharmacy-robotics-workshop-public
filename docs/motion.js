import { armPoints, exportProject, hz, interpolate, maxPoints, moveWrist, openProject, poseFrames, validateProject, wrist } from "./motion-model.js";

const starterUrl = "./downloads/pharmacy-pick-place.botlab.zip";
const exampleLabels = ["起始姿势", "靠近药盒", "合拢抓取", "抬起药盒", "稳住药盒",
  "移动到周转箱", "降低手腕", "张开松手", "抬起手腕", "等待药盒落稳"];
const stations = {
  dispensing: { file: starterUrl, task: "从中央桌夹起药盒，越过箱沿后松手。", labels: exampleLabels },
  returns: { file: "./downloads/pharmacy-returns.botlab.zip", task: "提起退回的药盒，停稳供观察，再放回桌面。右侧台面已为练习腾空。",
    labels: ["起始姿势","靠近药盒","合拢抓取","提起药盒","停稳供观察","放回桌面","张开松手","撤回手腕"] },
  dispatch: { file: "./downloads/pharmacy-dispatch.botlab.zip", task: "从备货桌抓起药盒，放到待取架中层。练习架移去上方一层隔板，留出手腕空间。",
    labels: ["起始姿势","靠近备货桌","合拢抓取","提起药盒","稳住药盒","移入待取架","降低到层板","张开松手","退出货架","等待药盒落稳"] }
};
const templates = new Map();
let station = "dispensing", loadId = 0, timedPoint = null;
const names = ["关节 1", "关节 2", "关节 3", "关节 4", "关节 5", "关节 6", "关节 7",
  "拇指转动", "拇指弯曲", "食指", "中指", "无名指", "小指"];
const modeLabels = { hold: "保持手势", grasp: "合拢抓取", release: "张开松手", custom: "自定义手势" };
const $ = id => document.getElementById(id);
const xyz = ["x", "y", "z"].map($);
const canvas = $("path");
const context = canvas.getContext("2d");
const toDegrees = angle => angle * 180 / Math.PI;
const toRadians = degrees => degrees * Math.PI / 180;
const closeEnough = (a, b) => a.every((value, i) => Math.abs(value - b[i]) < 1e-9);
let baseline, archive, points, selected, presets, trajectory, totalTicks, trace;
let clock = 0;
let view = "3d";
let workcell, projectVersion = 0;
let animation = 0;
let projection;
let jointInputs = [];
let teaching = false, heightOnly = false, drag = null;
let waypointPositions = [], pins = [];
const dragHint = () => heightOnly ? "上下拖动选中的编号，调整手腕高度。" : "拖动选中的编号，在桌面上方平移手腕。点空白处拖动可以转动视角。";

function showNotice(message = "", error = false) {
  const element = $("notice");
  element.hidden = !message;
  element.toggleAttribute("data-error", error);
  element.textContent = message;
}

function useProject(project, filename) {
  stopPlayback();
  if (teaching) setTeaching(false);
  $("teach").disabled = true;
  archive = project;
  timedPoint = null;
  $("station").value = station;
  $("station").disabled = false;
  const url = new URL(location.href);
  if (station === "dispensing") url.searchParams.delete("station");
  else url.searchParams.set("station", station);
  history.replaceState(null, "", url);
  $("station-task").textContent = stations[station].task;
  setupWorkcell(project, ++projectVersion);
  presets = { release: baseline.targets[0].slice(7), grasp: baseline.targets[2].slice(7) };
  const example = project.targets.length === baseline.targets.length &&
    project.targets.every((pose, i) => closeEnough(pose, baseline.targets[i]));
  points = project.targets.map((pose, i) => {
    const hand = pose.slice(7);
    const previous = (project.targets[i - 1] ?? pose).slice(7);
    let mode = "custom";
    if (closeEnough(hand, previous)) mode = "hold";
    else if (closeEnough(hand, presets.grasp)) mode = "grasp";
    else if (closeEnough(hand, presets.release)) mode = "release";
    return {
      label: i === 0 ? "起始姿势" : example ? stations[station].labels[i] : "动作点",
      arm: pose.slice(0, 7), hand, mode, ticks: project.steps[i]
    };
  });
  selected = 0;
  $("project-name").textContent = filename;
  $("load-status").textContent = "Marvin M6S · Handle-L1";
  $("use-demo").textContent = "恢复示例";
  $("use-demo").hidden = false;
  $("use-demo").disabled = false;
  $("download").disabled = false;
  $("workspace").hidden = false;
  showNotice();
  buildSliders();
  refresh();
}

async function setupWorkcell(project, version) {
  try {
    const { createWorkcell } = await import("./workcell.js");
    if (version !== projectVersion) return;
    workcell ??= createWorkcell($("workcell"), $("simulation-status"), projectPins, () => { $("teach").disabled = false; });
    workcell.project(project.files, station);
    workcell.route(trajectory, points.map(p => p.ticks));
    workcell.seek(clock);
  } catch (error) {
    console.error(error);
    document.querySelector('[data-view="xy"]').click();
    showNotice("三维视图加载失败，已打开俯视编辑。", true);
    $("simulation-status").textContent = "三维视图暂时不可用，可切换到俯视或侧视编辑。";
  }
}

$("overview").onclick = () => workcell?.viewpoint(false);
$("hand-camera").onclick = () => workcell?.viewpoint(true);

function canInsert() {
  if (points.length < maxPoints && totalTicks + hz <= 180 * hz) return true;
  showNotice("路线最多 40 步、180 秒。请先删去一步或缩短用时。", true);
  return false;
}

function handStep(index) {
  if (index < 1 || index >= points.length) return false;
  return ["grasp", "release"].includes(points[index].mode) &&
    closeEnough(points[index].arm, points[index - 1].arm);
}

function editArm(angles) {
  workcell.editPose(poseFrames(archive.model, [...angles, ...trajectory[selected].slice(7)]));
}

function setTeaching(enable) {
  cancelDrag();
  teaching = enable;
  $("route-layer").hidden = $("teach-tools").hidden = !enable;
  $("teach").setAttribute("aria-pressed", String(enable));
  $("teach").textContent = enable ? "完成编辑" : "编辑路线";
  $("view-help").hidden = enable;
  $("hand-camera").disabled = enable;
  if (enable) {
    stopPlayback();
    if (selected === 0) selected = 1;
    workcell.viewpoint(false);
    refresh();
  } else {
    workcell?.editPose(null);
  }
}
$("teach").onclick = () => setTeaching(!teaching);

function syncTeach() {
  if (!teaching) return;
  if (pins.length !== points.length) {
    pins = points.map((_, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "route-pin";
      button.textContent = i + 1;
      button.setAttribute("aria-label", "途经点 " + (i + 1));
      button.addEventListener("pointerdown", event => beginDrag(event, i));
      button.addEventListener("click", event => {
        if (event.detail === 0) { selected = i; refresh(); }
      });
      return button;
    });
    $("route-pins").replaceChildren(...pins);
  }
  pins.forEach((pin, i) => pin.setAttribute("aria-pressed", String(i === selected)));
  $("teach-step").textContent = "第 " + (selected + 1) + " 步";
  $("mark-grasp").disabled = $("mark-release").disabled = selected === 0;
  for (const mode of ["grasp", "release"]) {
    $("mark-" + mode).setAttribute("aria-pressed", String((handStep(selected) || points[selected] === timedPoint) && points[selected].mode === mode));
  }
  $("add-waypoint").disabled = points.length >= maxPoints;
  $("drag-tip").textContent = selected === 0 ? "起始姿势固定。点「＋ 途经点」开始安排下一步。" : dragHint();
  editArm(points[selected].arm);
}

function projectPins() {
  if (!teaching || !workcell || pins.length !== waypointPositions.length) return;
  const positions = waypointPositions.map((p, i) => drag && i === selected && drag.position ? drag.position : p);
  const seen = new Set();
  for (const i of [selected, ...positions.keys()]) {
    if (seen.has(i)) continue;
    seen.add(i);
    const screen = workcell.screen(positions[i]);
    const pin = pins[i];
    const key = Math.round(screen.x / 3) + "," + Math.round(screen.y / 3);
    pin.hidden = !screen.visible || seen.has(key);
    seen.add(key);
    pin.style.left = screen.x + "px";
    pin.style.top = screen.y + "px";
  }
  const path = (drag ? positions : trace).map(p => workcell.screen(p));
  $("route-line").setAttribute("points", path.every(p => p.visible) ? path.map(p => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ") : "");
}

function beginDrag(event, index) {
  if (!teaching || drag || !event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  if (index !== selected) { selected = index; refresh(); }
  if (index === 0) return;
  const anchor = waypointPositions[index];
  const start = workcell.pickPlane(event.clientX, event.clientY, anchor, heightOnly);
  if (!start) { $("drag-tip").textContent = "请先转动一下视角，再拖动手腕。"; return; }
  const pin = pins[index];
  pin.setPointerCapture(event.pointerId);
  workcell.lockCamera(true);
  pin.classList.add("dragging");
  drag = { pin, pointer: event.pointerId, anchor, start, point: points[index], angles: points[index].arm, valid: true };
  $("download").disabled = true;
}

function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointer) return;
  const hit = workcell.pickPlane(event.clientX, event.clientY, drag.anchor, heightOnly);
  const goal = hit?.map((v, i) => drag.anchor[i] + ((i === 2) === heightOnly ? v - drag.start[i] : 0));
  const angles = goal && moveWrist(archive.model, drag.angles, goal);
  drag.valid = !!angles;
  if (!angles) { $("drag-tip").textContent = "手腕够不到这里。往回拖，或松开还原。"; return; }
  drag.angles = angles;
  drag.position = wrist(archive.model, angles);
  $("drag-tip").textContent = "松开保存这个位置。";
  editArm(angles);
}

function cancelDrag() {
  if (!drag) return;
  const { pin, pointer } = drag;
  drag = null;
  workcell.lockCamera(false);
  if (pin.hasPointerCapture(pointer)) pin.releasePointerCapture(pointer);
  pin.classList.remove("dragging");
  $("download").disabled = false;
  if (teaching) {
    $("drag-tip").textContent = dragHint();
    editArm(points[selected].arm);
  }
}

function finishDrag(event) {
  if (!drag || drag.pointer !== event.pointerId) return;
  moveDrag(event);
  const { angles, valid, point } = drag;
  cancelDrag();
  if (valid && point === points[selected]) {
    let first = selected, last = selected;
    if (points[selected] !== timedPoint) {
      while (first > 1 && handStep(first)) first--;
      while (handStep(last + 1)) last++;
    }
    for (let i = first; i <= last; i++) points[i].arm = angles.slice();
    refresh();
  } else $("drag-tip").textContent = "手腕够不到这里，已恢复原位。";
}
$("route-pins").addEventListener("pointermove", moveDrag);
$("route-pins").addEventListener("pointerup", finishDrag);
for (const event of ["pointercancel", "lostpointercapture"]) {
  $("route-pins").addEventListener(event, e => { if (drag?.pointer === e.pointerId) cancelDrag(); });
}
window.addEventListener("blur", cancelDrag);
window.addEventListener("keydown", e => { if (e.key === "Escape") cancelDrag(); });
for (const id of ["drag-plane", "drag-height"]) {
  $(id).onclick = () => {
    cancelDrag();
    heightOnly = id === "drag-height";
    $("drag-plane").setAttribute("aria-pressed", String(!heightOnly));
    $("drag-height").setAttribute("aria-pressed", String(heightOnly));
    syncTeach();
  };
}
$("add-waypoint").onclick = () => insertAfter(handStep(selected + 1) ? selected + 1 : selected);
$("new-route").onclick = () => {
  if (!window.confirm("用一条从起始姿势出发的新路线替换当前动作？")) return;
  cancelDrag();
  points.splice(1);
  selected = 0;
  updateTrajectory();
  insertAfter(0);
};
function preserveNextHandTarget() {
  const next = points[selected + 1];
  if (points[selected] !== timedPoint || next?.mode !== "hold") return;
  next.hand = trajectory[selected + 1].slice(7);
  next.mode = "custom";
}

function markHand(mode) {
  if (!selected || !teaching) return;
  if (points[selected] === timedPoint) {
    preserveNextHandTarget();
    points[selected].mode = mode;
    refresh();
    return;
  }
  if (!handStep(selected)) {
    if (handStep(selected + 1)) selected++;
    else {
      if (!canInsert()) return;
      const arm = points[selected].arm.slice(), hand = trajectory[selected].slice(7);
      selected++;
      points.splice(selected, 0, { arm, hand,
        ticks: hz, mode, label: "原地手指动作" });
    }
  }
  points[selected].mode = mode;
  refresh();
  $("drag-tip").textContent = mode === "grasp" ? "手腕到位后在这里合拢手指。" : "手腕到位后在这里张开手指。";
}
$("mark-grasp").onclick = () => markHand("grasp");
$("mark-release").onclick = () => markHand("release");

function buildSliders() {
  jointInputs = archive.model.limits.map(([low, high], i) => {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = names[i];
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = toDegrees(low);
    slider.max = toDegrees(high);
    slider.step = "any";
    const number = document.createElement("output");
    label.append(caption, slider, number);
    slider.addEventListener("input", () => {
      stopPlayback();
      const point = points[selected];
      const value = Math.max(low, Math.min(high, toRadians(Number(slider.value))));
      if (i < 7) point.arm[i] = value;
      else { preserveNextHandTarget(); point.hand[i - 7] = value; }
      updateTrajectory();
      updatePositionInputs();
      number.textContent = toDegrees(value).toFixed(1) + "°";
      seekSelected();
      syncTeach();
    });
    return { slider, number, label };
  });
  $("joint-controls").replaceChildren(...jointInputs.map(input => input.label));
}

function updateTrajectory() {
  let hand = points[0].hand;
  totalTicks = 0;
  trajectory = points.map(point => {
    hand = point.mode === "hold" ? hand : presets[point.mode] ?? point.hand;
    totalTicks += point.ticks;
    return [...point.arm, ...hand];
  });
  trace = [wrist(archive.model, trajectory[0])];
  for (let i = 1; i < trajectory.length; i++) {
    for (let sample = 1; sample <= 14; sample++) {
      const pose = interpolate(trajectory[i - 1], trajectory[i], sample / 14);
      trace.push(wrist(archive.model, pose));
    }
  }
  waypointPositions = trajectory.map(pose => wrist(archive.model, pose));
  $("edit-time").max = $("scrub").max = totalTicks / hz;
  workcell?.route(trajectory, points.map(p => p.ticks));
}

function updatePositionInputs() {
  const position = wrist(archive.model, points[selected].arm);
  xyz.forEach((input, i) => { input.value = position[i].toFixed(4); });
}

function refresh() {
  cancelDrag();
  updateTrajectory();
  const list = $("sequence");
  const scroll = list.scrollTop;
  let elapsed = 0;
  const rows = points.map((point, index) => {
    elapsed += point.ticks / hz;
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(index === selected));
    const indexText = document.createElement("span");
    indexText.textContent = index + 1;
    const name = document.createElement("span");
    const moving = index > 0 && !closeEnough(point.arm, points[index - 1].arm);
    name.textContent = point.mode === "hold" ? point.label : (moving ? "移臂 · " : "") + modeLabels[point.mode];
    const end = document.createElement("small");
    end.textContent = elapsed.toFixed(2).replace(/0$/, "") + " 秒";
    button.append(indexText, name, end);
    button.addEventListener("click", () => {
      selected = index;
      stopPlayback();
      showNotice();
      refresh();
      list.children[index].firstChild.focus({ preventScroll: true });
    });
    li.append(button);
    return li;
  });
  list.replaceChildren(...rows);
  list.scrollTop = scroll;
  const bounds = list.getBoundingClientRect();
  const active = rows[selected].getBoundingClientRect();
  if (active.bottom > bounds.bottom) list.scrollTop += active.bottom - bounds.bottom;
  if (active.top < bounds.top) list.scrollTop += active.top - bounds.top;
  const point = points[selected];
  $("selected-label").textContent = selected === 0 ? "起始姿势" : "第 " + (selected + 1) + " 个动作点";
  $("selected-label").textContent += " · 第 " + Number(elapsedAt(selected).toFixed(2)) + " 秒";
  $("keep-arm").disabled = $("edit-wrist").disabled = selected === 0;
  $("duration").value = point.ticks / hz;
  $("hand-mode").value = point.mode;
  $("hand-mode").disabled = selected === 0;
  $("apply-position").disabled = selected === 0;
  xyz.forEach(input => { input.disabled = selected === 0; });
  $("position-help").textContent = point === timedPoint ? "在此时刻设置目标，系统会从上一动作点平滑过渡。后续动作点的时间保留。"
    : selected === 0
    ? "从这个姿势出发。选择后面的动作点，或插入一个新动作点。"
    : "要先到位再抓，可在同一位置插入一个动作点，再选「合拢抓取」。移动手腕时，朝向可能跟着改变。";
  $("earlier").disabled = selected < 2;
  $("later").disabled = selected === 0 || selected === points.length - 1;
  $("remove").disabled = selected === 0 || points.length <= 2;
  $("insert").disabled = points.length >= maxPoints;
  updatePositionInputs();
  jointInputs.forEach(({ slider, number, label }, i) => {
    const value = toDegrees(trajectory[selected][i]);
    slider.value = value;
    number.textContent = value.toFixed(1) + "°";
    label.hidden = i >= 7 && point.mode !== "custom";
    slider.disabled = selected === 0;
  });
  seekSelected();
  syncTeach();
}

function stopPlayback() {
  if (animation) cancelAnimationFrame(animation);
  animation = 0;
  $("play").textContent = "播放预览";
}

function elapsedAt(index) {
  return points.slice(0, index + 1).reduce((sum, p) => sum + p.ticks, 0) / hz;
}

function teachCurrent() {
  if ($("teach").disabled) return;
  if (view !== "3d") document.querySelector('[data-view="3d"]').click();
  if (!teaching && !$("teach").disabled) setTeaching(true);
}

$("edit-wrist").onclick = teachCurrent;
$("keep-arm").onclick = () => {
  if (!selected) return;
  stopPlayback();
  points[selected].arm = points[selected - 1].arm.slice();
  refresh();
};

$("time-form").onsubmit = event => {
  event.preventDefault();
  stopPlayback();
  const tick = Math.round($("edit-time").valueAsNumber * hz);
  if (!Number.isInteger(tick) || tick < 0 || tick > totalTicks) return;
  let start = 0, i = 0;
  while (i < points.length - 1 && start + points[i].ticks < tick) start += points[i++].ticks;
  const left = tick - start, right = points[i].ticks - left;
  if (right === 0 && i > 0) selected = i;
  else {
    const additions = i === 0 && right > 0 ? 2 : 1;
    if (points.length + additions > maxPoints || left < (i === 0 ? 10 : 5) || (right > 0 && right < 5)) {
      showNotice("起始姿势需要保留。请选已有动作点，或选一个与相邻点至少相隔 0.1 秒的时刻（首段从 0.2 秒起）。路线最多 40 步。", true);
      return;
    }
    const pose = poseAt(tick / hz);
    const point = { label: "协同姿势", arm: pose.slice(0, 7), hand: pose.slice(7),
      mode: closeEnough(pose.slice(7), trajectory[Math.max(0, i-1)].slice(7)) ? "hold" : "custom", ticks: left };
    if (i === 0) {
      points[0].ticks = 5;
      point.ticks -= 5;
      points.splice(1, 0, point);
      if (right) points.splice(2, 0, { ...points[0], arm: point.arm.slice(), hand: point.hand.slice(), ticks: right, label: "起始段末" });
      selected = 1;
    } else {
      points[i].ticks = right;
      points.splice(i, 0, point);
      selected = i;
    }
  }
  timedPoint = points[selected];
  teachCurrent();
  refresh();
  const note = "正在编辑第 " + tick / hz + " 秒的目标姿势。拖手腕、调手指，然后回放检查。";
  $("drag-tip").textContent = note;
  showNotice(note);
};

function seekSelected() {
  clock = points.slice(0, selected + 1).reduce((sum, point) => sum + point.ticks, 0) / hz;
  updatePreview();
}

function poseAt(time) {
  let ticks = time * hz;
  for (let i = 0; i < points.length; i++) {
    if (ticks <= points[i].ticks) {
      return interpolate(trajectory[Math.max(0, i - 1)], trajectory[i], ticks / points[i].ticks);
    }
    ticks -= points[i].ticks;
  }
  return trajectory.at(-1);
}

function makeProjection() {
  const center = archive.model.arm[1].position.map(
    (value, i) => value + archive.model.arm[0].position[i]);
  const axis = view === "xy" ? 1 : 2;
  const scale = Math.min(canvas.width, canvas.height) / 1.55;
  center[0] = (center[0] + archive.model.landmarks[0].position[0]) / 2;
  const middle = view === "xy" ? center[1] : center[2];
  return {
    axis,
    screen: p => [canvas.width / 2 + (p[0] - center[0]) * scale,
      canvas.height / 2 - (p[axis] - middle) * scale],
    world: (x, y) => [center[0] + (x - canvas.width / 2) / scale,
      middle - (y - canvas.height / 2) / scale]
  };
}

function line(pointsToDraw, color, width) {
  context.beginPath();
  pointsToDraw.forEach((point, i) => {
    const [x, y] = projection.screen(point);
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();
}

function dot(point, color, radius) {
  context.beginPath();
  context.arc(...projection.screen(point), radius, 0, 2 * Math.PI);
  context.fillStyle = color;
  context.fill();
}

function updatePreview() {
  $("scrub").value = clock;
  if (document.activeElement !== $("edit-time")) $("edit-time").value = Number((Math.round(clock * hz) / hz).toFixed(2));
  $("clock").textContent = clock.toFixed(1) + " / " + (totalTicks / hz).toFixed(1) + " 秒";
  if (view === "3d") { workcell?.seek(clock); return; }
  projection = makeProjection();
  context.clearRect(0, 0, canvas.width, canvas.height);
  const [left, top] = projection.world(0, 0);
  const [right, bottom] = projection.world(canvas.width, canvas.height);
  const axis = projection.axis;
  const p = (x, other) => axis === 1 ? [x, other, 0] : [x, 0, other];
  for (let x = Math.ceil(left * 4) / 4; x < right; x += .25) {
    line([p(x, top), p(x, bottom)], "#d9e7e3", 1);
  }
  for (let y = Math.ceil(bottom * 4) / 4; y < top; y += .25) {
    line([p(left, y), p(right, y)], "#d9e7e3", 1);
  }
  const arm = armPoints(archive.model, poseAt(clock));
  line(trace, "#169383", 3);
  line(arm, "#253f54", 6);
  arm.forEach(point => dot(point, "#253f54", 5));
  for (const item of archive.model.landmarks) {
    const [x, y] = projection.screen(item.position);
    context.fillStyle = item.color;
    context.fillRect(x - 5, y - 5, 10, 10);
    context.font = "bold 15px system-ui";
    context.fillText(item.label, x + 10, y + 5);
  }
  for (let i = 0; i < points.length; i++) {
    dot(wrist(archive.model, points[i].arm), "#169383", 4);
  }
  const active = wrist(archive.model, points[selected].arm);
  dot(active, "#fff", 8);
  dot(active, "#067164", 5);
  context.fillStyle = "#3a5760";
  context.font = "14px system-ui";
  context.fillText(view === "xy" ? "X →    Y ↑" : "X →    Z ↑", 16, 24);
}

function setWrist(goal) {
  if (selected === 0) {
    showNotice("先选择一个可编辑的动作点。", true);
    return;
  }
  stopPlayback();
  const point = points[selected];
  const angles = moveWrist(archive.model, point.arm, goal);
  if (!angles) {
    showNotice("这个位置从当前姿势够不到。请把位置移近一些，或先微调关节角度。", true);
    return;
  }
  point.arm = angles;
  showNotice();
  refresh();
}

$("position-form").addEventListener("submit", event => {
  event.preventDefault();
  setWrist(xyz.map(input => input.valueAsNumber));
});

canvas.addEventListener("click", event => {
  const rect = canvas.getBoundingClientRect();
  const [x, other] = projection.world((event.clientX - rect.left) * canvas.width / rect.width,
    (event.clientY - rect.top) * canvas.height / rect.height);
  const goal = wrist(archive.model, points[selected].arm);
  goal[0] = x;
  goal[projection.axis] = other;
  setWrist(goal);
});

$("duration").addEventListener("change", event => {
  const element = event.target;
  if (!Number.isFinite(element.valueAsNumber) || element.valueAsNumber < .1 || element.valueAsNumber > 30) {
    showNotice("每一步用时为 0.1–30 秒。", true);
    element.value = points[selected].ticks / hz;
    return;
  }
  const ticks = Math.round(element.valueAsNumber * hz);
  if (totalTicks - points[selected].ticks + ticks > 180 * hz) {
    showNotice("整条路线最多 180 秒。", true);
    element.value = points[selected].ticks / hz;
    return;
  }
  points[selected].ticks = ticks;
  stopPlayback();
  showNotice();
  refresh();
});

$("hand-mode").addEventListener("change", event => {
  const point = points[selected];
  preserveNextHandTarget();
  point.hand = trajectory[selected].slice(7);
  point.mode = event.target.value;
  if (point.mode === "custom") $("joints").open = true;
  stopPlayback();
  refresh();
});

function insertAfter(index) {
  if (!canInsert()) return;
  selected = index;
  stopPlayback();
  const arm = points[selected].arm.slice();
  const hand = trajectory[selected].slice(7);
  points.splice(++selected, 0, { arm, hand, mode: "hold", ticks: hz, label: "新增动作点" });
  showNotice();
  refresh();
}
$("insert").onclick = () => insertAfter(selected);

for (const [button, delta] of [["earlier", -1], ["later", 1]]) {
  $(button).addEventListener("click", () => {
    stopPlayback();
    const next = selected + delta;
    [points[next], points[selected]] = [points[selected], points[next]];
    selected = next;
    refresh();
  });
}

$("remove").addEventListener("click", () => {
  stopPlayback();
  points.splice(selected, 1);
  selected = Math.min(selected, points.length - 1);
  refresh();
});

$("scrub").addEventListener("input", event => {
  if (teaching) setTeaching(false);
  stopPlayback();
  clock = Number(event.target.value);
  updatePreview();
});

$("play").addEventListener("click", () => {
  if (teaching) { setTeaching(false); clock = 0; }
  if (animation) {
    stopPlayback();
    return;
  }
  if (clock >= totalTicks / hz || (selected === 0 && clock === points[0].ticks / hz)) clock = 0;
  let previous = performance.now();
  $("play").textContent = "暂停";
  function frame(now) {
    const next = Math.min(totalTicks / hz, clock + (now - previous) / 1000);
    previous = now;
    if (view === "3d" && workcell?.failed()) { stopPlayback(); return; }
    if (view !== "3d" || workcell?.canPlay(next)) clock = next;
    updatePreview();
    if (clock < totalTicks / hz) animation = requestAnimationFrame(frame);
    else stopPlayback();
  }
  animation = requestAnimationFrame(frame);
});

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    if (teaching) setTeaching(false);
    view = button.dataset.view;
    $("stage").hidden = view !== "3d";
    canvas.hidden = view === "3d";
    $("view-help").textContent = view === "3d" ? "拖动旋转视角，滚轮或双指缩放。点「手部特写」跟着手指看抓取和松开。" : "先选右侧的动作点，再点图设置手腕位置。";
    if (view === "3d") workcell?.size();
    for (const choice of document.querySelectorAll("[data-view]")) {
      choice.setAttribute("aria-pressed", String(choice === button));
    }
    updatePreview();
  });
}

async function templateFor(id) {
  if (!templates.has(id)) {
    const response = await fetch(stations[id].file);
    if (!response.ok) throw new Error("工位工程下载失败，请重试。");
    templates.set(id, openProject(new Uint8Array(await response.arrayBuffer())));
  }
  return templates.get(id);
}

async function loadDemo(id = station) {
  const request = ++loadId;
  $("station").disabled = true;
  $("load-status").textContent = "正在加载工位…";
  try {
    const template = await templateFor(id);
    if (request !== loadId) return;
    baseline = template;
    station = id;
    useProject(template, "工作坊示例");
  } catch {
    if (request !== loadId) return;
    $("station").value = station;
    $("station").disabled = false;
    $("load-status").textContent = "工位加载失败。";
    $("use-demo").hidden = false;
    $("use-demo").disabled = false;
    showNotice("工位下载失败，请检查网络后重试。", true);
  }
}

$("station").onchange = () => {
  const id = $("station").value;
  const modified = archive && (JSON.stringify(trajectory) !== JSON.stringify(archive.targets) ||
    points.some((p,i) => p.ticks !== archive.steps[i]));
  if (modified && !window.confirm("切换工位会替换当前动作。已下载要保留的工程吗？")) {
    $("station").value = station;
    return;
  }
  loadDemo(id);
};

$("use-demo").addEventListener("click", () => {
  if (baseline) {
    if (window.confirm("恢复示例会替换当前动作顺序，继续吗？")) useProject(baseline, "工作坊示例");
    return;
  }
  $("use-demo").disabled = true;
  $("load-status").textContent = "正在加载示例工程…";
  loadDemo();
});

$("project-file").addEventListener("change", async event => {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  input.value = "";
  if (!baseline) {
    showNotice("请先加载示例工程。", true);
    return;
  }
  if (!window.confirm("打开工程会替换当前动作顺序，继续吗？")) return;
  input.disabled = true;
  try {
    if (!/\.zip$/i.test(file.name) || file.size > 32 * 1024 * 1024) {
      throw new Error("请选择工作坊的 .botlab.zip 工程。");
    }
    const request = ++loadId;
    const imported = openProject(new Uint8Array(await file.arrayBuffer()));
    const tag = imported.xml.documentElement.getAttribute("model");
    const id = ["dispatch", "returns"].includes(tag) ? tag : "dispensing";
    const template = await templateFor(id);
    validateProject(imported, template);
    if (request !== loadId) return;
    baseline = template;
    station = id;
    useProject(imported, file.name);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "无法打开这个工程。", true);
  } finally {
    input.disabled = false;
  }
});

$("download").addEventListener("click", async event => {
  const button = event.target;
  button.disabled = true;
  try {
    const bytes = await exportProject(archive, trajectory, points.map(point => point.ticks));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "药房抓取_我的路线.botlab.zip";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showNotice("已下载。到 BotLab 导入工程，点击 Run。");
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "下载失败，请重试。", true);
  } finally {
    button.disabled = false;
  }
});

const requestedStation = new URL(location.href).searchParams.get("station");
loadDemo(Object.hasOwn(stations, requestedStation) ? requestedStation : "dispensing");
