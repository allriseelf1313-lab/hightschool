// AI Drama Studio — browser side
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = Object.assign({ bible: null, episodes: {}, reviews: {}, spent: 0 }, load());
let editing = null; // "scene-shot" being edited by hand

// Saved twice: in the browser, and as a file on this computer (./data) with dated backups.
let serverSaveTimer = null;
function save(major = false) {
  try { localStorage.setItem("aiDramaStudio", JSON.stringify(state)); } catch {}
  $("spent").textContent = `$${(state.spent || 0).toFixed(2)}`;
  if (!state.bible) return;
  clearTimeout(serverSaveTimer);
  const send = () => fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: state, major }) }).catch(() => {});
  if (major) send(); else serverSaveTimer = setTimeout(send, 1500);
}
function load() {
  try { return JSON.parse(localStorage.getItem("aiDramaStudio")) || {}; } catch { return {}; }
}

function toast(msg, ms = 2500) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), ms);
}
function loading(on, text = "กำลังเขียน...") {
  $("loading").hidden = !on; $("loadingText").textContent = text;
}

async function api(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
// ---------- settings ----------
const SETTINGS_KEY = "aiDramaSettings";
const settings = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })();
function saveSettings() {
  settings.model = $("model").value; settings.eco = $("eco").checked;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
$("model").onchange = saveSettings; $("eco").onchange = saveSettings;
fetch("/api/models").then((r) => r.json()).then((m) => {
  $("model").value = settings.model && m.models.includes(settings.model) ? settings.model : m.default;
}).catch(() => {});
$("eco").checked = !!settings.eco;

// ---------- background jobs ----------
// The server does the AI work in the background. The page only polls, so closing or refreshing the
// page does not lose the result: the pending job is remembered and picked up again on the next visit.
const PENDING_KEY = "aiDramaPending";
const APPLY = {}; // type -> (result, meta) => void, filled in below

async function runJob(type, body, meta = {}) {
  let id;
  loading(true, "เริ่มงาน…"); $("loadingSub").textContent = "";
  try { ({ id } = await api(`/api/job/${type}`, { ...body, model: $("model").value, eco: $("eco").checked })); }
  catch (err) { loading(false); toast(err.message, 5000); return; }
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ id, type, meta })); } catch {}
  return waitJob(id, type, meta);
}

async function waitJob(id, type, meta) {
  loading(true, "เริ่มงาน…");
  try {
    for (;;) {
      const res = await fetch(`/api/job/${id}`);
      const job = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(job.error || "ติดต่อโปรแกรมไม่ได้ — หน้าต่าง PowerShell ยังเปิดอยู่ไหม");
      $("loadingText").textContent = job.progress || "กำลังทำงาน…";
      const mm = Math.floor(job.elapsed / 60), ss = String(job.elapsed % 60).padStart(2, "0");
      $("loadingSub").textContent = `ผ่านไป ${mm}:${ss} นาที · ค่าใช้จ่ายงานนี้ ≈ $${(job.cost || 0).toFixed(3)}`;
      if (job.status === "done") {
        state.spent = (state.spent || 0) + (job.cost || 0);
        APPLY[type](job.result, meta);
        toast(`เสร็จแล้ว ✓ ใช้ไป ≈ $${(job.cost || 0).toFixed(3)}`, 4000);
        return job.result;
      }
      if (job.status === "error") throw new Error(job.error);
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err) {
    toast(err.message, 6000);
  } finally {
    try { localStorage.removeItem(PENDING_KEY); } catch {}
    loading(false);
  }
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast("คัดลอกแล้ว ✓"), () => toast("คัดลอกไม่ได้"));
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy]");
  if (btn) copy(btn.closest(".prompt-wrap").querySelector(".prompt-text").textContent);
});

function promptBlock(label, text) {
  return `<div class="prompt-wrap"><div class="prompt"><b>${esc(label)}</b>
<span class="prompt-text">${esc(text)}</span></div>
<button class="ghost" data-copy>📋 คัดลอก ${esc(label)}</button></div>`;
}
const swatches = (palette = []) => `<span class="swatches">${palette.map((c) =>
  `<span class="sw" style="background:${/^#[0-9a-f]{3,8}$/i.test(c) ? c : "#555"}" title="${esc(c)}"></span>`).join("")}</span>`;

function download(name, text, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

// The server never needs the reference images or the lock flags; they stay in the browser.
function serverBible() {
  const b = structuredClone(state.bible);
  for (const c of b.characters) { delete c.ref_image; delete c.locked; }
  return b;
}
const lockedIds = () => state.bible.characters.filter((c) => c.locked).map((c) => c.id);
function reattachLocal(newBible) {
  for (const c of newBible.characters) {
    const old = state.bible?.characters.find((o) => o.id === c.id);
    if (old) { c.ref_image = old.ref_image; c.locked = old.locked; }
  }
  return newBible;
}

const charName = (id) => state.bible?.characters.find((c) => c.id === id)?.name || id;
const locName = (id) => state.bible?.locations.find((l) => l.id === id)?.name || id;
const threadQ = (id) => state.bible?.threads?.find((t) => t.id === id)?.question || id;
const neg = () => (state.bible.negative_prompt ? `, avoid: ${state.bible.negative_prompt}` : "");

// ---------- step 1 ----------
const RATING_HINT = {
  "ทั่วไป": "เหมาะกับทุกวัย ไม่มีฉากรักเกินจับมือ/กอด",
  "13+": "ฉากรักถึงจูบได้ ความรุนแรงเล็กน้อย",
  "18+": "ธีมผู้ใหญ่ได้ ฉากรักเฉพาะตัวละครอายุ 20+ แบบสื่อนัยแล้วตัดภาพ (ไม่โจ่งแจ้ง) · ตัวละครอายุต่ำกว่า 18 ไม่มีฉากทางเพศในทุกเรต",
};
$("rating").onchange = () => ($("ratingHint").textContent = RATING_HINT[$("rating").value]);
$("rating").onchange();

$("btnBible").onclick = () => {
  const idea = $("idea").value.trim();
  if (!idea) return toast("ใส่ไอเดียเรื่องก่อนนะ");
  if (state.bible && !confirm(`สร้างเรื่องใหม่จะแทนที่เรื่อง "${state.bible.title}"\n(เรื่องเดิมถูกสำรองไว้ กู้คืนได้ที่ปุ่ม 🕘 งานที่บันทึกไว้)\n\nสร้างต่อไหม?`)) return;
  if (state.bible) save(true);
  runJob("bible", { idea, genre: $("genre").value, episodes: $("episodes").value, style: $("style").value, rating: $("rating").value });
};
APPLY.bible = (bible) => {
  state.bible = bible; state.episodes = {}; state.reviews = {}; state.spent = state.spent || 0;
  save(true); renderBible(); $("episodeView").hidden = true;
};

$("btnSample").onclick = async () => {
  if (state.bible && !confirm(`ดูตัวอย่างจะแทนที่เรื่อง "${state.bible.title}" ที่เปิดอยู่\n(เรื่องเดิมถูกสำรองไว้ กู้คืนได้ที่ปุ่ม 🕘 งานที่บันทึกไว้)\n\nทำต่อไหม?`)) return;
  if (state.bible) save(true);
  try {
    const data = await (await fetch("sample.json")).json();
    Object.assign(state, { reviews: {}, spent: 0 }, data); save(true); renderBible(); renderEpisode(1);
    $("bibleView").scrollIntoView({ behavior: "smooth" });
  } catch { toast("โหลดตัวอย่างไม่ได้"); }
};

// ---------- step 2: bible ----------
function renderBible() {
  const b = state.bible;
  if (!b) return;
  const v = $("bibleView");
  v.hidden = false;
  const issues = SB.checkBible(b);
  const n = b.episodes.length;
  v.innerHTML = `<div class="card">
    <h2>2. ไบเบิลซีรีส์: ${esc(b.title)} <span class="muted">(${esc(b.title_en)})</span> <span class="badge">${esc(b.rating || "")}</span></h2>
    <p><b>Logline:</b> ${esc(b.logline)}</p>
    <p class="muted">แนว: ${esc(b.genre)} · โทน: ${esc(b.tone)} · ฉากหลัง: ${esc(b.setting)}</p>
    ${issues.length ? `<div class="check bad">${issues.map((x) => `⚠️ ${esc(x)}`).join("<br>")}</div>` : ""}
    <div class="revise"><input id="bibleInstr" placeholder="✍️ สั่งแก้ไบเบิล เช่น ให้ตัวร้ายมีเหตุผลน่าสงสารขึ้น, เพิ่มเป็น 8 ตอน"><button id="btnReviseBible">สั่งแก้</button></div>
    ${promptBlock("Visual style", b.visual_style)}
    ${b.negative_prompt ? promptBlock("Negative prompt", b.negative_prompt) : ""}

    <h3>👥 ตัวละคร</h3>
    <p class="muted small">ขั้นตอนคงหน้าตา: ① คัดลอก Character sheet ไปสร้างภาพใน Flow → ② เลือกภาพที่ชอบ อัปโหลดกลับมา → ③ กด "อ่านหน้าตาจากภาพ" → ④ ล็อก 🔒 · ทุกพรอมต์จะใช้คำบรรยายหน้าตาเดียวกันเป๊ะ</p>
    <div class="grid">${b.characters.map((c) => charCard(c, b)).join("")}</div>

    <h3>📍 สถานที่</h3>
    <div class="grid">${b.locations.map((l) => `<div class="mini">
      <h4>${esc(l.name)}</h4><details><summary>พรอมต์สถานที่</summary>${promptBlock("Location", `${l.description_prompt}, ${b.visual_style}${neg()}`)}</details>
    </div>`).join("")}</div>

    ${b.threads?.length ? `<h3>🧩 ปมเรื่องและการเฉลย</h3>
    <div class="table-wrap"><table class="threads"><tr><th>ปม</th><th>เปิดปม</th><th>เบาะแส</th><th>เฉลย</th></tr>
    ${b.threads.map((t) => `<tr><td><b>${esc(t.question)}</b></td><td>EP${t.setup_episode}</td>
      <td>${t.clues.map((c) => `EP${c.episode}: ${esc(c.clue)}`).join("<br>")}</td>
      <td>EP${t.payoff_episode}: ${esc(t.payoff)}</td></tr>`).join("")}</table></div>` : ""}

    <h3>📺 ตอนทั้งหมด</h3>
    <div class="toolbar"><label style="margin:0">จำนวนฉากต่อตอน
      <input id="scenes" type="number" min="1" max="10" value="4" style="width:90px"></label></div>
    ${b.episodes.map((e) => {
      const cs = b.color_script?.find((x) => x.episode === e.number);
      return `<div class="ep"><div>
      <b>EP${e.number}: ${esc(e.title)}</b> ${cs ? swatches(cs.palette) + ` <span class="muted small">${esc(cs.mood)}</span>` : ""}<br>
      ${e.hook_open ? `<span class="muted">⚡ 3 วิแรก: ${esc(e.hook_open)}</span><br>` : ""}
      ${esc(e.synopsis)}
      <div class="muted">🪝 ${esc(e.cliffhanger)}</div>
      <div class="muted small">${e.pov_character ? `👁️ มุมมอง: ${esc(charName(e.pov_character))}` : ""}
        ${(e.threads || []).map((t) => `<span class="chip">🧩 ${esc(threadQ(t))}</span>`).join("")}</div></div>
      <button data-ep="${e.number}">${state.episodes[e.number] ? "📄 ดูบท" : "🎥 สร้างบทถ่ายทำ"}</button>
    </div>`; }).join("")}

    <div class="toolbar" style="margin-top:16px">
      <button class="ghost" id="dlJson">⬇️ ดาวน์โหลดโปรเจกต์ (JSON)</button>
      <button class="ghost" id="dlMd">⬇️ ดาวน์โหลดบททั้งหมด (Markdown)</button>
      <label class="ghost filebtn">📂 เปิดโปรเจกต์<input type="file" id="openJson" accept=".json" hidden></label>
    </div>
  </div>`;

  v.querySelectorAll("[data-ep]").forEach((btn) => (btn.onclick = () => openEpisode(+btn.dataset.ep, btn)));
  v.querySelectorAll("[data-lock]").forEach((btn) => (btn.onclick = () => {
    const c = b.characters.find((x) => x.id === btn.dataset.lock); c.locked = !c.locked; save(); // ---------- backups ----------
function modal(html) { $("modalBody").innerHTML = html; $("modal").hidden = false; }
$("modalClose").onclick = () => ($("modal").hidden = true);
const fmtTime = (t) => new Date(t).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });

$("btnBackups").onclick = async () => {
  try {
    const { backups } = await (await fetch("/api/backups")).json();
    modal(`<h3>🕘 งานที่บันทึกไว้ในคอมนี้</h3>
      <p class="muted small">บันทึกอัตโนมัติทุกครั้งที่มีการเปลี่ยนแปลงใหญ่ เก็บไว้ 10 ครั้งล่าสุด (โฟลเดอร์ ai-drama-studio/data)</p>
      ${backups.length ? backups.map((b) => `<div class="ep"><div><b>${esc(b.title || "ไม่มีชื่อ")}</b><br>
        <span class="muted small">${fmtTime(b.time)} · บทถ่ายทำ ${b.episodes} ตอน</span></div>
        <button class="ghost" data-restore="${esc(b.file)}">กู้คืน</button></div>`).join("") : "<p>ยังไม่มีงานที่บันทึกไว้</p>"}`);
    document.querySelectorAll("[data-restore]").forEach((btn) => (btn.onclick = () => restore(btn.dataset.restore)));
  } catch { toast("เปิดรายการไม่ได้"); }
};

async function restore(file) {
  if (state.bible && !confirm("กู้คืนงานนี้แทนเรื่องที่เปิดอยู่? (เรื่องที่เปิดอยู่จะถูกสำรองไว้ก่อน)")) return;
  if (state.bible) save(true);
  try {
    const data = await (await fetch(`/api/backup/${file}`)).json();
    if (!data.bible) throw new Error();
    Object.assign(state, { episodes: {}, reviews: {}, spent: 0 }, data);
    try { localStorage.setItem("aiDramaStudio", JSON.stringify(state)); } catch {}
    $("modal").hidden = true; renderBible(); $("episodeView").hidden = true; save();
    toast("กู้คืนแล้ว ✓");
  } catch { toast("กู้คืนไม่ได้"); }
}

// ---------- start ----------
renderBible();
save();
(async () => {
  // pick up a job that was still running when the page was closed
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY)); } catch {}
  if (pending?.id) return waitJob(pending.id, pending.type, pending.meta || {});
  // browser storage empty but a saved project exists on this computer: offer it
  if (!state.bible) {
    try {
      const { current } = await (await fetch("/api/backups")).json();
      if (current?.title && confirm(`พบงานที่บันทึกไว้: "${current.title}" (บทถ่ายทำ ${current.episodes} ตอน)\nเปิดงานนี้ต่อไหม?`)) restore("current");
    } catch {}
  }
})();
  }));
  v.querySelectorAll("[data-upload]").forEach((inp) => (inp.onchange = () => uploadRef(inp.dataset.upload, inp.files[0])));
  v.querySelectorAll("[data-describe]").forEach((btn) => (btn.onclick = () => describeChar(btn.dataset.describe)));
  $("btnReviseBible").onclick = reviseBible;
  $("dlJson").onclick = () => download(`${b.title_en || "drama"}.json`, JSON.stringify(state, null, 1), "application/json");
  $("dlMd").onclick = () => download(`${b.title_en || "drama"}.md`, toMarkdown());
  $("openJson").onchange = openProject;
}

function charCard(c, b) {
  const minorIn18 = b.rating === "18+" && c.age < 20;
  return `<div class="mini">
    <div class="char-head">
      ${c.ref_image ? `<img class="ref" src="${c.ref_image}" alt="ภาพอ้างอิง ${esc(c.name)}">` : `<div class="ref empty">ไม่มีภาพ</div>`}
      <div><h4><span class="sw" style="background:${esc(c.signature_color || "#555")}"></span> ${esc(c.name)} ${c.locked ? "🔒" : ""}</h4>
      <div class="muted small">${esc(c.role)} · ${esc(c.age)} ปี${c.gender ? ` · ${esc(c.gender)}` : ""}</div>
      ${minorIn18 ? `<div class="small warnline">อายุต่ำกว่า 20: ไม่มีฉากรักแบบผู้ใหญ่</div>` : ""}</div>
    </div>
    <p class="muted">${esc(c.personality)}</p>
    <details><summary>มิติตัวละคร</summary>
      <p>${esc(c.backstory)}</p>
      ${c.want ? `<p>🎯 <b>อยากได้:</b> ${esc(c.want)}</p><p>💡 <b>สิ่งที่ต้องเรียนรู้:</b> ${esc(c.need)}</p>
      <p>🤫 <b>ความลับ:</b> ${esc(c.secret)}</p><p>⚡ <b>จุดอ่อน:</b> ${esc(c.flaw)}</p><p>📈 <b>การเปลี่ยนแปลง:</b> ${esc(c.arc)}</p>` : ""}
    </details>
    <div class="toolbar small-gap">
      <label class="ghost filebtn">📷 ${c.ref_image ? "เปลี่ยนภาพ" : "อัปโหลดภาพอ้างอิง"}<input type="file" accept="image/*" data-upload="${c.id}" hidden></label>
      ${c.ref_image ? `<button class="ghost" data-describe="${c.id}">🔍 อ่านหน้าตาจากภาพ</button>` : ""}
      <button class="ghost" data-lock="${c.id}">${c.locked ? "🔓 ปลดล็อก" : "🔒 ล็อกหน้าตา"}</button>
    </div>
    ${promptBlock("หน้าตา (ล็อก)", c.face_prompt || c.appearance_prompt || "")}
    ${(c.outfits || []).length ? `<details><summary>👗 Character sheet (${c.outfits.length} ชุด) — ใช้สร้างภาพอ้างอิง</summary>
      ${c.outfits.map((o) => promptBlock(`Character sheet: ${o.name}`,
      `${c.face_prompt}, wearing ${o.prompt}, character reference sheet, full body front view and side view and close-up face, neutral grey background, ${b.visual_style}${neg()}`)).join("")}</details>` : ""}
  </div>`;
}

async function uploadRef(id, file) {
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode().catch(() => null);
  if (!img.width) return toast("เปิดไฟล์ภาพไม่ได้");
  const s = Math.min(1, 512 / Math.max(img.width, img.height));
  const cv = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * s), height: Math.round(img.height * s) });
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  state.bible.characters.find((c) => c.id === id).ref_image = cv.toDataURL("image/jpeg", 0.85);
  save(); renderBible(); toast("อัปโหลดแล้ว — กด 🔍 อ่านหน้าตาจากภาพ ต่อได้เลย");
}

function describeChar(id) {
  const c = state.bible.characters.find((x) => x.id === id);
  runJob("describe-character", { image: c.ref_image, name: c.name, face_prompt: c.face_prompt }, { id });
}
APPLY["describe-character"] = (r, { id }) => {
  const c = state.bible.characters.find((x) => x.id === id);
  if (!c) return;
  c.face_prompt = r.face_prompt; c.locked = true;
  save(true); renderBible(); if (!$("episodeView").hidden && currentEp) renderEpisode(currentEp);
};

function reviseBible() {
  const instruction = $("bibleInstr").value.trim();
  if (!instruction) return toast("พิมพ์สิ่งที่อยากแก้ก่อน");
  save(true);
  runJob("revise-bible", { bible: serverBible(), instruction, locked: lockedIds() });
}
APPLY["revise-bible"] = (nb) => {
  state.bible = reattachLocal(nb);
  save(true); // ---------- backups ----------
function modal(html) { $("modalBody").innerHTML = html; $("modal").hidden = false; }
$("modalClose").onclick = () => ($("modal").hidden = true);
const fmtTime = (t) => new Date(t).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });

$("btnBackups").onclick = async () => {
  try {
    const { backups } = await (await fetch("/api/backups")).json();
    modal(`<h3>🕘 งานที่บันทึกไว้ในคอมนี้</h3>
      <p class="muted small">บันทึกอัตโนมัติทุกครั้งที่มีการเปลี่ยนแปลงใหญ่ เก็บไว้ 10 ครั้งล่าสุด (โฟลเดอร์ ai-drama-studio/data)</p>
      ${backups.length ? backups.map((b) => `<div class="ep"><div><b>${esc(b.title || "ไม่มีชื่อ")}</b><br>
        <span class="muted small">${fmtTime(b.time)} · บทถ่ายทำ ${b.episodes} ตอน</span></div>
        <button class="ghost" data-restore="${esc(b.file)}">กู้คืน</button></div>`).join("") : "<p>ยังไม่มีงานที่บันทึกไว้</p>"}`);
    document.querySelectorAll("[data-restore]").forEach((btn) => (btn.onclick = () => restore(btn.dataset.restore)));
  } catch { toast("เปิดรายการไม่ได้"); }
};

async function restore(file) {
  if (state.bible && !confirm("กู้คืนงานนี้แทนเรื่องที่เปิดอยู่? (เรื่องที่เปิดอยู่จะถูกสำรองไว้ก่อน)")) return;
  if (state.bible) save(true);
  try {
    const data = await (await fetch(`/api/backup/${file}`)).json();
    if (!data.bible) throw new Error();
    Object.assign(state, { episodes: {}, reviews: {}, spent: 0 }, data);
    try { localStorage.setItem("aiDramaStudio", JSON.stringify(state)); } catch {}
    $("modal").hidden = true; renderBible(); $("episodeView").hidden = true; save();
    toast("กู้คืนแล้ว ✓");
  } catch { toast("กู้คืนไม่ได้"); }
}

// ---------- start ----------
renderBible();
save();
(async () => {
  // pick up a job that was still running when the page was closed
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY)); } catch {}
  if (pending?.id) return waitJob(pending.id, pending.type, pending.meta || {});
  // browser storage empty but a saved project exists on this computer: offer it
  if (!state.bible) {
    try {
      const { current } = await (await fetch("/api/backups")).json();
      if (current?.title && confirm(`พบงานที่บันทึกไว้: "${current.title}" (บทถ่ายทำ ${current.episodes} ตอน)\nเปิดงานนี้ต่อไหม?`)) restore("current");
    } catch {}
  }
})();
  if (Object.keys(state.episodes).length) setTimeout(() => toast("แก้ไบเบิลแล้ว — บทตอนที่เขียนไว้ก่อนหน้าไม่ได้เปลี่ยนตาม ถ้าต้องการให้กด 🔄 เขียนตอนนั้นใหม่", 6000), 4100);
};

// ---------- step 3: episode ----------
let currentEp = null;
function openEpisode(n, btn) {
  if (state.episodes[n]) return renderEpisode(n);
  btn.disabled = true;
  runJob("episode", { bible: serverBible(), episodeNumber: n, scenes: $("scenes").value }, { n }).finally(() => (btn.disabled = false));
}
APPLY.episode = (r, { n }) => {
  state.episodes[n] = r.episode; state.reviews[n] = r.review;
  save(true); renderBible(); renderEpisode(n);
};

function reviewSummary(review) {
  if (!review?.length) return "";
  const byScene = {};
  for (const r of review) (byScene[r.scene] ||= []).push(r);
  const lines = Object.entries(byScene).map(([s, rs]) => {
    const last = rs[rs.length - 1];
    const rounds = Math.max(...rs.map((r) => r.round));
    return last.fixed ? `ฉาก ${s}: พบ ${rs[0].problems?.length || 0} จุด แก้เรียบร้อย (${rounds} รอบ)`
      : `ฉาก ${s}: แก้แล้ว ${rounds} รอบ ยังเหลือ ${last.remaining ?? "?"} จุด`;
  });
  return `<div class="check info">🤖 AI ตรวจและแก้มุมกล้องเองก่อนส่ง<br>${lines.map(esc).join("<br>")}</div>`;
}

function renderEpisode(n) {
  currentEp = n;
  const ep = state.episodes[n];
  const b = state.bible;
  const v = $("episodeView");
  v.hidden = false;
  const shots = ep.scenes.flatMap((s) => s.shots);
  const totalSec = shots.reduce((t, s) => t + (s.duration_seconds || 0), 0);
  const hasGeo = shots.some((sh) => sh.camera && sh.positions);
  const checks = Object.fromEntries(ep.scenes.map((s) => [s.scene_number, hasGeo ? SB.check(s, charName, b) : {}]));
  const warnCount = Object.values(checks).reduce((t, c) => t + Object.values(c).flat().length, 0);
  const cs = b.color_script?.find((x) => x.episode === ep.episode_number);

  v.innerHTML = `<div class="card">
    <h2>3. บทถ่ายทำ EP${ep.episode_number}: ${esc(ep.title)}</h2>
    <p class="muted">${ep.scenes.length} ฉาก · ${shots.length} ช็อต (= ${shots.length} คลิปวิดีโอ) · ยาวประมาณ ${Math.round(totalSec / 60 * 10) / 10} นาที
      ${ep.pov_character ? ` · 👁️ เล่าผ่าน${esc(charName(ep.pov_character))}` : ""}</p>
    ${cs ? `<p>🎨 โทนสีตอนนี้: ${swatches(cs.palette)} <span class="muted">${esc(cs.mood)}</span></p>` : ""}
    ${ep.cold_open ? `<p>⚡ <b>3 วินาทีแรก:</b> ${esc(ep.cold_open)}</p>` : ""}
    ${reviewSummary(state.reviews?.[n])}
    ${hasGeo ? `<div class="check ${warnCount ? "bad" : "good"}">${warnCount
      ? `⚠️ ยังมี ${warnCount} จุดที่ควรแก้ (กรอบสีส้ม) — กด 🔄 เขียนช็อตนั้นใหม่ หรือ ✏️ แก้เอง`
      : "✅ ผ่านการตรวจ: กล้องอยู่ฝั่งเดียวของเส้น 180° · ตำแหน่งในเฟรมตรงกับผัง · ไม่มี jump cut · ชุดไม่เปลี่ยนกลางฉาก · ทุกฉากขับเคลื่อนเรื่อง"}</div>` : ""}
    <div class="revise"><input id="epInstr" placeholder="✍️ สั่งแก้ทั้งตอน เช่น ให้ไทม์พูดน้อยลง, เพิ่มฉากฝนตกตอนจบ"><button id="btnReviseEp">สั่งแก้</button></div>
    <div class="toolbar">
      <button class="ghost" id="copyAllVideo">📋 คัดลอกพรอมต์วิดีโอทั้งตอน</button>
      <button class="ghost" id="dlSrt">⬇️ ซับไทย (.srt)</button>
      <button class="ghost" id="regen">🔄 เขียนตอนนี้ใหม่ทั้งหมด</button>
    </div>
    ${ep.scenes.map((s) => sceneHTML(s, checks[s.scene_number], hasGeo)).join("")}
  </div>`;

  $("copyAllVideo").onclick = () => copy(ep.scenes.flatMap((s) => s.shots.map((sh) =>
    `[${s.scene_number}.${sh.shot_number}] ${sh.video_prompt}`)).join("\n\n"));
  $("dlSrt").onclick = () => download(`EP${ep.episode_number}.srt`, toSRT(ep));
  $("regen").onclick = () => {
    if (!confirm(`เขียน EP${n} ใหม่ทั้งตอน? บทปัจจุบันจะถูกแทนที่ (มีสำรองไว้) และเสียค่าใช้จ่ายเท่าการเขียนตอนใหม่`)) return;
    save(true); delete state.episodes[n]; openEpisode(n, $("regen"));
  };
  $("btnReviseEp").onclick = () => reviseEpisode(n);
  v.querySelectorAll("[data-reshot]").forEach((btn) => (btn.onclick = () => reshoot(n, btn.dataset.reshot)));
  v.querySelectorAll("[data-edit]").forEach((btn) => (btn.onclick = () => { editing = btn.dataset.edit; renderEpisode(n); }));
  v.querySelectorAll("[data-save]").forEach((btn) => (btn.onclick = () => saveEdit(n, btn.dataset.save)));
  v.querySelectorAll("[data-cancel]").forEach((btn) => (btn.onclick = () => { editing = null; renderEpisode(n); }));
}

const CHANGE_LABEL = { info: "ข้อมูลใหม่", relationship: "ความสัมพันธ์", stakes: "เดิมพันสูงขึ้น" };
function sceneHTML(s, check, hasGeo) {
  const b = state.bible;
  return `<h3>ฉาก ${s.scene_number} — ${esc(locName(s.location_id))} (${esc(s.time_of_day)})</h3>
    <p>${esc(s.summary)}</p>
    ${s.what_changes ? `<p>🔄 <b>ฉากนี้เปลี่ยน${esc(CHANGE_LABEL[s.change_type] || s.change_type)}:</b> ${esc(s.what_changes)}</p>` : ""}
    ${s.dramatic_irony ? `<p>👁️ <b>คนดูรู้แต่ตัวละครไม่รู้:</b> ${esc(s.dramatic_irony)}</p>` : ""}
    ${(s.threads_touched || []).length ? `<p>${s.threads_touched.map((t) => `<span class="chip">🧩 ${esc(threadQ(t))}</span>`).join("")}</p>` : ""}
    ${s.lighting ? `<p class="muted">💡 แสง: ${esc(s.lighting)}</p>` : ""}
    ${s.music_cue ? `<p class="muted">🎵 ดนตรี: ${esc(s.music_cue)}</p>` : ""}
    ${hasGeo ? `<div class="scene-board">
      <div><div class="sb-cap">ผังมุมกล้อง (มองจากด้านบน) — เส้นประ = เส้น 180°</div>${SB.planSVG(s, b, charName)}</div>
      <div class="strip-wrap"><div class="sb-cap">สตอรี่บอร์ด — เรียงตามลำดับการตัดต่อ</div><div class="strip">${s.shots.map((sh) => `<div class="strip-item ${check[sh.shot_number] ? "warn" : ""}">
        ${sh.camera ? SB.frameSVG(sh, b, charName, 96) : ""}<div>${s.scene_number}.${sh.shot_number}</div><div class="muted small">${esc(sh.shot_type)}</div></div>`).join("")}</div></div>
    </div>
    ${s.camera_side_note ? `<p class="muted small">🎥 ${esc(s.camera_side_note)}</p>` : ""}` : ""}
    ${s.shots.map((sh) => shotHTML(s, sh, check[sh.shot_number])).join("")}`;
}

function refsFor(sh) {
  const ids = [...new Set([...(sh.frame_positions || []).filter((f) => f.looking !== "away").map((f) => f.character),
    ...(sh.wardrobe || []).map((w) => w.character)])].filter((id) => (sh.characters || []).includes(id));
  return ids.map((id) => {
    const c = state.bible.characters.find((x) => x.id === id);
    if (!c) return "";
    const oid = sh.wardrobe?.find((w) => w.character === id)?.outfit_id;
    const outfit = c.outfits?.find((o) => o.id === oid);
    return `<span class="refchip">${c.ref_image ? `<img src="${c.ref_image}" alt="">` : "👤"} ${esc(c.name)}${outfit ? ` <span class="muted">(${esc(outfit.name)})</span>` : ""}</span>`;
  }).join("");
}

function shotHTML(s, sh, warns) {
  const b = state.bible;
  const key = `${s.scene_number}-${sh.shot_number}`;
  const head = `<div class="shot-head"><b>ช็อต ${s.scene_number}.${sh.shot_number}</b>
    <span class="muted">· ${esc(sh.shot_type)}${sh.lens ? ` · ${esc(sh.lens)}` : ""}${sh.camera_angle ? ` · ${esc(sh.camera_angle)}` : ""} · ${esc(sh.camera_move)} · ${sh.duration_seconds}s · ${sh.characters.map(charName).map(esc).join(", ")}</span></div>`;
  const visual = sh.camera ? `<div class="shot-visual">${SB.frameSVG(sh, b, charName, 150)}${SB.planSVG(s, b, charName, sh, 150)}</div>` : "";
  if (editing === key) return `<div class="shot editing">${head}<div class="shot-body">${visual}<div class="shot-text">
    <label>สิ่งที่เกิดขึ้น<textarea data-f="action" rows="2">${esc(sh.action)}</textarea></label>
    ${sh.dialogue.map((d, i) => `<label>🗣️ ${esc(charName(d.character))}<input data-f="line-${i}" value="${esc(d.line)}"></label>
      <label class="muted small">ความหมายแฝง<input data-f="sub-${i}" value="${esc(d.subtext || "")}"></label>`).join("")}
    <label>Start frame <span class="muted small">(ใช้ {c1} แทนหน้าตาตัวละคร)</span><textarea data-f="start_frame_prompt" rows="4">${esc(sh.start_frame_prompt)}</textarea></label>
    <label>End frame<textarea data-f="end_frame_prompt" rows="3">${esc(sh.end_frame_prompt)}</textarea></label>
    <label>Video<textarea data-f="video_prompt" rows="3">${esc(sh.video_prompt)}</textarea></label>
    <div class="toolbar"><button data-save="${key}">💾 บันทึก</button><button class="ghost" data-cancel>ยกเลิก</button></div>
  </div></div></div>`;

  return `<div class="shot ${warns ? "warn" : ""}">${head}
    <div class="shot-body">${visual}
      <div class="shot-text">
        ${warns ? warns.map((x) => `<div class="warnline">⚠️ ${esc(x)}</div>`).join("") : ""}
        <p>${esc(sh.action)}</p>
        ${sh.dialogue.map((d) => `<div class="dialogue">🗣️ <b>${esc(charName(d.character))}</b> <span class="muted">(${esc(d.emotion)})</span>: “${esc(d.line)}”
          ${d.subtext ? `<div class="muted small">💭 ความหมายแฝง: ${esc(d.subtext)}</div>` : ""}</div>`).join("")}
        ${sh.depth_layers ? `<div class="muted small">🔭 มิติภาพ — หน้า: ${esc(sh.depth_layers.foreground)} · กลาง: ${esc(sh.depth_layers.midground)} · หลัง: ${esc(sh.depth_layers.background)}</div>` : ""}
        ${sh.cut_motivation ? `<div class="muted">✂️ เหตุผลที่ตัดมาช็อตนี้: ${esc(sh.cut_motivation)}</div>` : ""}
        ${sh.crosses_axis ? `<div class="muted">↔️ ข้ามเส้นอย่างตั้งใจ: ${esc(sh.cross_reason)}</div>` : ""}
        ${sh.continuity_notes ? `<div class="muted">🔗 ความต่อเนื่อง: ${esc(sh.continuity_notes)}</div>` : ""}
        ${sh.sound ? `<div class="muted">🔊 ${esc(sh.sound)}</div>` : ""}
        ${refsFor(sh) ? `<div class="refs">📎 แนบภาพอ้างอิงใน Flow: ${refsFor(sh)}</div>` : ""}
        ${promptBlock("Start frame", SB.expand(sh.start_frame_prompt, b, sh) + neg())}
        ${promptBlock("End frame", SB.expand(sh.end_frame_prompt, b, sh) + neg())}
        ${promptBlock("Video", sh.video_prompt)}
        <div class="revise small-gap"><input id="ins-${key}" placeholder="สั่งแก้ช็อตนี้ (ไม่ใส่ก็ได้) เช่น มุมต่ำกว่านี้">
          <button class="ghost" data-reshot="${key}">🔄 เขียนช็อตนี้ใหม่</button><button class="ghost" data-edit="${key}">✏️ แก้เอง</button></div>
      </div>
    </div>
  </div>`;
}

function findShot(n, key) {
  const [sn, shn] = key.split("-").map(Number);
  const scene = state.episodes[n].scenes.find((s) => s.scene_number === sn);
  return { scene, idx: scene.shots.findIndex((x) => x.shot_number === shn), shn };
}

function reshoot(n, key) {
  const { scene, idx, shn } = findShot(n, key);
  const instruction = $(`ins-${key}`).value.trim();
  runJob("shot", { bible: serverBible(), scene, shotNumber: shn, instruction }, { n, key });
}
APPLY.shot = (r, { n, key }) => {
  const { scene, idx } = findShot(n, key);
  scene.shots[idx] = r.shot; save(true); renderEpisode(n);
  if (r.warnings?.length) setTimeout(() => toast(`เขียนใหม่แล้ว แต่ยังเหลือ ${r.warnings.length} จุดที่ควรดู`, 5000), 4100);
};

function saveEdit(n, key) {
  const { scene, idx } = findShot(n, key);
  const sh = scene.shots[idx];
  document.querySelectorAll(".shot.editing [data-f]").forEach((el) => {
    const f = el.dataset.f;
    if (f.startsWith("line-")) sh.dialogue[+f.slice(5)].line = el.value;
    else if (f.startsWith("sub-")) sh.dialogue[+f.slice(4)].subtext = el.value;
    else sh[f] = el.value;
  });
  editing = null; save(); renderEpisode(n); toast("บันทึกแล้ว");
}

function reviseEpisode(n) {
  const instruction = $("epInstr").value.trim();
  if (!instruction) return toast("พิมพ์สิ่งที่อยากแก้ก่อน");
  save(true);
  runJob("revise-episode", { bible: serverBible(), episode: state.episodes[n], instruction }, { n });
}
APPLY["revise-episode"] = (r, { n }) => {
  state.episodes[n] = r.episode; state.reviews[n] = r.review; save(true); renderEpisode(n);
};

// ---------- export / import ----------
function srtTime(t) {
  const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
function toSRT(ep) {
  let t = 0, i = 1, out = "";
  for (const s of ep.scenes) for (const sh of s.shots) {
    const dur = sh.duration_seconds || 8, lines = sh.dialogue || [];
    lines.forEach((d, k) => {
      const a = t + (dur * k) / lines.length + 0.3, z = t + (dur * (k + 1)) / lines.length - 0.2;
      out += `${i++}\n${srtTime(a)} --> ${srtTime(z)}\n${d.line}\n\n`;
    });
    t += dur;
  }
  return out;
}

function toMarkdown() {
  const b = state.bible;
  let md = `# ${b.title} (${b.title_en}) — เรต ${b.rating || "-"}\n\n${b.logline}\n\n**Visual style:** ${b.visual_style}\n\n## ตัวละคร\n`;
  for (const c of b.characters) {
    md += `\n### ${c.name} — ${c.role} (${c.age})\n${c.personality}\n\n- อยากได้: ${c.want || "-"}\n- สิ่งที่ต้องเรียนรู้: ${c.need || "-"}\n- ความลับ: ${c.secret || "-"}\n- จุดอ่อน: ${c.flaw || "-"}\n\nหน้าตา: \`${c.face_prompt || c.appearance_prompt}\`\n`;
    for (const o of c.outfits || []) md += `- ชุด ${o.name}: \`${o.prompt}\`\n`;
  }
  if (b.threads?.length) {
    md += `\n## ปมเรื่อง\n`;
    for (const t of b.threads) md += `- **${t.question}** — เปิด EP${t.setup_episode}, เฉลย EP${t.payoff_episode}: ${t.payoff}\n`;
  }
  md += `\n## ตอนทั้งหมด\n`;
  for (const e of b.episodes) {
    md += `\n### EP${e.number}: ${e.title}\n${e.hook_open ? `⚡ ${e.hook_open}\n\n` : ""}${e.synopsis}\n\n🪝 ${e.cliffhanger}\n`;
    const ep = state.episodes[e.number];
    if (!ep) continue;
    for (const s of ep.scenes) {
      md += `\n#### ฉาก ${s.scene_number} — ${locName(s.location_id)} (${s.time_of_day})\n${s.summary}\n${s.what_changes ? `\n🔄 ${s.what_changes}\n` : ""}`;
      for (const sh of s.shots) {
        md += `\n**ช็อต ${s.scene_number}.${sh.shot_number}** (${sh.shot_type}, ${sh.lens || ""}, ${sh.camera_move}, ${sh.duration_seconds}s)\n${sh.action}\n`;
        for (const d of sh.dialogue) md += `- ${charName(d.character)} (${d.emotion}): "${d.line}"${d.subtext ? ` — 💭 ${d.subtext}` : ""}\n`;
        md += `\n- Start: \`${SB.expand(sh.start_frame_prompt, b, sh)}\`\n- End: \`${SB.expand(sh.end_frame_prompt, b, sh)}\`\n- Video: \`${sh.video_prompt}\`\n`;
      }
    }
  }
  return md;
}

async function openProject(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.bible) throw new Error();
    if (state.bible && !confirm(`เปิดไฟล์นี้จะแทนที่เรื่อง "${state.bible.title}" ที่เปิดอยู่ (มีสำรองไว้) ทำต่อไหม?`)) return;
    if (state.bible) save(true);
    Object.assign(state, { episodes: {}, reviews: {}, spent: 0 }, data); save(true); renderBible(); $("episodeView").hidden = true;
    toast("เปิดโปรเจกต์แล้ว");
  } catch { toast("ไฟล์ไม่ถูกต้อง"); }
}

// ---------- backups ----------
function modal(html) { $("modalBody").innerHTML = html; $("modal").hidden = false; }
$("modalClose").onclick = () => ($("modal").hidden = true);
const fmtTime = (t) => new Date(t).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });

$("btnBackups").onclick = async () => {
  try {
    const { backups } = await (await fetch("/api/backups")).json();
    modal(`<h3>🕘 งานที่บันทึกไว้ในคอมนี้</h3>
      <p class="muted small">บันทึกอัตโนมัติทุกครั้งที่มีการเปลี่ยนแปลงใหญ่ เก็บไว้ 10 ครั้งล่าสุด (โฟลเดอร์ ai-drama-studio/data)</p>
      ${backups.length ? backups.map((b) => `<div class="ep"><div><b>${esc(b.title || "ไม่มีชื่อ")}</b><br>
        <span class="muted small">${fmtTime(b.time)} · บทถ่ายทำ ${b.episodes} ตอน</span></div>
        <button class="ghost" data-restore="${esc(b.file)}">กู้คืน</button></div>`).join("") : "<p>ยังไม่มีงานที่บันทึกไว้</p>"}`);
    document.querySelectorAll("[data-restore]").forEach((btn) => (btn.onclick = () => restore(btn.dataset.restore)));
  } catch { toast("เปิดรายการไม่ได้"); }
};

async function restore(file) {
  if (state.bible && !confirm("กู้คืนงานนี้แทนเรื่องที่เปิดอยู่? (เรื่องที่เปิดอยู่จะถูกสำรองไว้ก่อน)")) return;
  if (state.bible) save(true);
  try {
    const data = await (await fetch(`/api/backup/${file}`)).json();
    if (!data.bible) throw new Error();
    Object.assign(state, { episodes: {}, reviews: {}, spent: 0 }, data);
    try { localStorage.setItem("aiDramaStudio", JSON.stringify(state)); } catch {}
    $("modal").hidden = true; renderBible(); $("episodeView").hidden = true; save();
    toast("กู้คืนแล้ว ✓");
  } catch { toast("กู้คืนไม่ได้"); }
}

// ---------- start ----------
renderBible();
save();
(async () => {
  // pick up a job that was still running when the page was closed
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY)); } catch {}
  if (pending?.id) return waitJob(pending.id, pending.type, pending.meta || {});
  // browser storage empty but a saved project exists on this computer: offer it
  if (!state.bible) {
    try {
      const { current } = await (await fetch("/api/backups")).json();
      if (current?.title && confirm(`พบงานที่บันทึกไว้: "${current.title}" (บทถ่ายทำ ${current.episodes} ตอน)\nเปิดงานนี้ต่อไหม?`)) restore("current");
    } catch {}
  }
})();
