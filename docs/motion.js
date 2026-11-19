import { armPoints, exportProject, hz, interpolate, maxPoints, moveWrist, openProject, wrist } from "./motion-model.js";

const starterUrl = "https://raw.githubusercontent.com/xanthiawang/pharmacy-robotics-workshop/57692cdaca232402f7645c9124c9ae591c893d98/01_%E7%BD%91%E9%A1%B5%E6%93%8D%E4%BD%9C/02_%E6%8A%93%E8%8D%AF%E7%9B%92%E5%85%A5%E7%AE%B1.botlab.zip";
const exampleLabels = ["起始姿势", "靠近药盒", "合拢抓取", "抬起药盒", "稳住药盒",
  "移动到周转箱", "降低手腕", "张开松手", "抬起手腕", "等待药盒落稳"];
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
let view = "xy";
let animation = 0;
let projection;
let jointInputs = [];

function showNotice(message = "", error = false) {
  const element = $("notice");
  element.hidden = !message;
  element.toggleAttribute("data-error", error);
  element.textContent = message;
}

function useProject(project, filename) {
  stopPlayback();
  archive = project;
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
      label: i === 0 ? "起始姿势" : example ? exampleLabels[i] : "动作点",
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
      else point.hand[i - 7] = value;
      updateTrajectory();
      updatePositionInputs();
      number.textContent = toDegrees(value).toFixed(1) + "°";
      seekSelected();
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
  $("scrub").max = totalTicks / hz;
}

function updatePositionInputs() {
  const position = wrist(archive.model, points[selected].arm);
  xyz.forEach((input, i) => { input.value = position[i].toFixed(4); });
}

function refresh() {
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
    name.textContent = point.mode === "hold" ? point.label : modeLabels[point.mode];
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
  $("duration").value = point.ticks / hz;
  $("hand-mode").value = point.mode;
  $("hand-mode").disabled = selected === 0;
  $("apply-position").disabled = selected === 0;
  xyz.forEach(input => { input.disabled = selected === 0; });
  $("position-help").textContent = selected === 0
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
}

function stopPlayback() {
  if (animation) cancelAnimationFrame(animation);
  animation = 0;
  $("play").textContent = "播放预览";
}

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
  center[0] -= .29;
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
  $("clock").textContent = clock.toFixed(1) + " / " + (totalTicks / hz).toFixed(1) + " 秒";
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
  points[selected].ticks = Math.round(element.valueAsNumber * hz);
  stopPlayback();
  showNotice();
  refresh();
});

$("hand-mode").addEventListener("change", event => {
  const point = points[selected];
  point.hand = trajectory[selected].slice(7);
  point.mode = event.target.value;
  if (point.mode === "custom") $("joints").open = true;
  stopPlayback();
  refresh();
});

$("insert").addEventListener("click", () => {
  stopPlayback();
  const arm = points[selected].arm.slice();
  const hand = trajectory[selected].slice(7);
  points.splice(++selected, 0, { arm, hand, mode: "hold", ticks: hz, label: "新增动作点" });
  showNotice();
  refresh();
});

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
  stopPlayback();
  clock = Number(event.target.value);
  updatePreview();
});

$("play").addEventListener("click", () => {
  if (animation) {
    stopPlayback();
    return;
  }
  clock = 0;
  const start = performance.now();
  $("play").textContent = "暂停";
  function frame(now) {
    clock = Math.min(totalTicks / hz, (now - start) / 1000);
    updatePreview();
    if (clock < totalTicks / hz) animation = requestAnimationFrame(frame);
    else stopPlayback();
  }
  animation = requestAnimationFrame(frame);
});

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    view = button.dataset.view;
    for (const choice of document.querySelectorAll("[data-view]")) {
      choice.setAttribute("aria-pressed", String(choice === button));
    }
    updatePreview();
  });
}

async function loadDemo() {
  try {
    const response = await fetch(starterUrl);
    if (!response.ok) throw new Error("示例下载失败。");
    baseline = openProject(new Uint8Array(await response.arrayBuffer()));
    useProject(baseline, "药房示例");
  } catch {
    $("load-status").textContent = "未能加载示例工程。";
    $("use-demo").textContent = "重试";
    $("use-demo").hidden = false;
    $("use-demo").disabled = false;
    showNotice("请检查网络后重试。", true);
  }
}

$("use-demo").addEventListener("click", () => {
  if (baseline) {
    if (window.confirm("恢复示例会替换当前动作顺序，继续吗？")) useProject(baseline, "药房示例");
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
    useProject(openProject(new Uint8Array(await file.arrayBuffer()), baseline), file.name);
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

loadDemo();
