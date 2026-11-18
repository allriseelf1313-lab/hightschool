// AI Drama Studio — browser side
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = load() || { bible: null, episodes: {} };

function save() {
  try { localStorage.setItem("aiDramaStudio", JSON.stringify(state)); } catch {}
}
function load() {
  try { return JSON.parse(localStorage.getItem("aiDramaStudio")); } catch { return null; }
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 2000);
}
function loading(on, text = "กำลังเขียน...") {
  $("loading").hidden = !on; $("loadingText").textContent = text;
}

async function api(url, body) {
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast("คัดลอกแล้ว ✓"), () => toast("คัดลอกไม่ได้"));
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy]");
  if (btn) copy(btn.closest(".prompt-wrap").querySelector(".prompt-text").textContent);
});

function promptBlock(label, text) {
  return `<div class="prompt-wrap"><div class="prompt"><b>${label}</b>
<span class="prompt-text">${esc(text)}</span></div>
<button class="ghost" data-copy>📋 คัดลอก ${label}</button></div>`;
}

function download(name, text, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

// ---------- step 1: bible ----------
$("btnBible").onclick = async () => {
  const idea = $("idea").value.trim();
  if (!idea) return toast("ใส่ไอเดียเรื่องก่อนนะ");
  loading(true, "กำลังสร้างตัวละคร ฉาก และโครงเรื่องทุกตอน... (1-3 นาที)");
  try {
    state.bible = await api("/api/bible", {
      idea, genre: $("genre").value, episodes: $("episodes").value, style: $("style").value,
    });
    state.episodes = {};
    save(); renderBible(); $("episodeView").hidden = true;
  } catch (err) { toast(err.message); }
  finally { loading(false); }
};

$("btnSample").onclick = async () => {
  try {
    const data = await (await fetch("sample.json")).json();
    Object.assign(state, data); save(); renderBible(); renderEpisode(1);
    $("bibleView").scrollIntoView({ behavior: "smooth" });
  } catch { toast("โหลดตัวอย่างไม่ได้"); }
};

function renderBible() {
  const b = state.bible;
  if (!b) return;
  const v = $("bibleView");
  v.hidden = false;
  v.innerHTML = `<div class="card">
    <h2>2. ไบเบิลซีรีส์: ${esc(b.title)} <span class="muted">(${esc(b.title_en)})</span></h2>
    <p><b>Logline:</b> ${esc(b.logline)}</p>
    <p class="muted">แนว: ${esc(b.genre)} · โทน: ${esc(b.tone)} · ฉากหลัง: ${esc(b.setting)}</p>
    ${promptBlock("Visual style", b.visual_style)}
    ${b.negative_prompt ? promptBlock("Negative prompt", b.negative_prompt) : ""}

    <h3>👥 ตัวละคร (ใช้ appearance prompt สร้างภาพอ้างอิงก่อน เพื่อให้หน้าเหมือนกันทุกช็อต)</h3>
    <div class="grid">${b.characters.map((c) => `<div class="mini">
      <h4>${esc(c.name)} <span class="muted">· ${esc(c.role)} · ${esc(c.age)}</span></h4>
      <p class="muted">${esc(c.personality)}</p>
      <p>${esc(c.backstory)}</p>
      ${promptBlock("Character sheet", `${c.appearance_prompt}, character reference sheet, front view and side view, neutral background, ${b.visual_style}`)}
    </div>`).join("")}</div>

    <h3>📍 สถานที่</h3>
    <div class="grid">${b.locations.map((l) => `<div class="mini">
      <h4>${esc(l.name)}</h4>${promptBlock("Location", `${l.description_prompt}, ${b.visual_style}`)}
    </div>`).join("")}</div>

    <h3>📺 ตอนทั้งหมด</h3>
    <div class="toolbar"><label style="margin:0">จำนวนฉากต่อตอน
      <input id="scenes" type="number" min="1" max="10" value="4" style="width:90px"></label></div>
    ${b.episodes.map((e) => `<div class="ep"><div>
      <b>EP${e.number}: ${esc(e.title)}</b><br>${esc(e.synopsis)}
      <div class="muted">🪝 ${esc(e.cliffhanger)}</div></div>
      <button data-ep="${e.number}">${state.episodes[e.number] ? "📄 ดูบท" : "🎥 สร้างบทถ่ายทำ"}</button>
    </div>`).join("")}

    <div class="toolbar" style="margin-top:16px">
      <button class="ghost" id="dlJson">⬇️ ดาวน์โหลดโปรเจกต์ (JSON)</button>
      <button class="ghost" id="dlMd">⬇️ ดาวน์โหลดบททั้งหมด (Markdown)</button>
      <label class="ghost" style="margin:0;cursor:pointer">📂 เปิดโปรเจกต์
        <input type="file" id="openJson" accept=".json" hidden></label>
    </div>
  </div>`;

  v.querySelectorAll("[data-ep]").forEach((btn) => (btn.onclick = () => openEpisode(+btn.dataset.ep, btn)));
  $("dlJson").onclick = () => download(`${b.title_en || "drama"}.json`, JSON.stringify(state, null, 2), "application/json");
  $("dlMd").onclick = () => download(`${b.title_en || "drama"}.md`, toMarkdown());
  $("openJson").onchange = openProject;
}

// ---------- step 2: episode script ----------
async function openEpisode(n, btn) {
  if (state.episodes[n]) return renderEpisode(n);
  btn.disabled = true;
  loading(true, `กำลังเขียนบทถ่ายทำ EP${n} พร้อมพรอมต์ทุกช็อต... (2-5 นาที)`);
  try {
    state.episodes[n] = await api("/api/episode", {
      bible: state.bible, episodeNumber: n, scenes: $("scenes").value,
    });
    save(); renderBible(); renderEpisode(n);
  } catch (err) { toast(err.message); }
  finally { loading(false); btn.disabled = false; }
}

function charName(id) {
  return state.bible.characters.find((c) => c.id === id)?.name || id;
}
function locName(id) {
  return state.bible.locations.find((l) => l.id === id)?.name || id;
}

function renderEpisode(n) {
  const ep = state.episodes[n];
  const v = $("episodeView");
  v.hidden = false;
  const b = state.bible;
  const shots = ep.scenes.flatMap((s) => s.shots);
  const totalSec = shots.reduce((t, s) => t + (s.duration_seconds || 0), 0);
  const hasGeo = shots.some((sh) => sh.camera && sh.positions);
  const checks = Object.fromEntries(ep.scenes.map((s) => [s.scene_number, hasGeo ? SB.check(s, charName) : {}]));
  const warnCount = Object.values(checks).reduce((t, c) => t + Object.values(c).flat().length, 0);
  const neg = b.negative_prompt ? `, avoid: ${b.negative_prompt}` : "";

  v.innerHTML = `<div class="card">
    <h2>3. บทถ่ายทำ EP${ep.episode_number}: ${esc(ep.title)}</h2>
    <p class="muted">${ep.scenes.length} ฉาก · ${shots.length} ช็อต (= ${shots.length} คลิปวิดีโอ) · ยาวประมาณ ${Math.round(totalSec / 60 * 10) / 10} นาที</p>
    ${hasGeo ? `<div class="check ${warnCount ? "bad" : "good"}">${warnCount
      ? `⚠️ ตรวจพบ ${warnCount} จุดที่มุมกล้องอาจไม่ต่อเนื่อง (ดูกรอบสีส้มในช็อต) — แก้เองหรือกด 🔄 เขียนใหม่`
      : "✅ ตรวจมุมกล้องแล้ว: กล้องอยู่ฝั่งเดียวของเส้น 180° · ตำแหน่งตัวละครในเฟรมตรงกับผัง · ไม่มี jump cut"}</div>` : ""}
    <div class="toolbar">
      <button class="ghost" id="copyAllVideo">📋 คัดลอกพรอมต์วิดีโอทั้งตอน</button>
      <button class="ghost" id="regen">🔄 เขียนตอนนี้ใหม่</button>
    </div>
    ${ep.scenes.map((s) => `<h3>ฉาก ${s.scene_number} — ${esc(locName(s.location_id))} (${esc(s.time_of_day)})</h3>
      <p>${esc(s.summary)}</p>
      ${s.lighting ? `<p class="muted">💡 แสง: ${esc(s.lighting)}</p>` : ""}
      ${hasGeo ? `<div class="scene-board">
        <div><div class="sb-cap">ผังมุมกล้อง (มองจากด้านบน) — เส้นประ = เส้น 180°</div>${SB.planSVG(s, b, charName)}</div>
        <div class="strip-wrap"><div class="sb-cap">สตอรี่บอร์ด — เรียงตามลำดับการตัดต่อ</div><div class="strip">${s.shots.map((sh) => `<div class="strip-item ${checks[s.scene_number][sh.shot_number] ? "warn" : ""}">
          ${sh.camera ? SB.frameSVG(sh, b, charName, 96) : ""}<div>${s.scene_number}.${sh.shot_number}</div><div class="muted small">${esc(sh.shot_type)}</div></div>`).join("")}</div></div>
      </div>
      ${s.camera_side_note ? `<p class="muted small">🎥 ${esc(s.camera_side_note)}</p>` : ""}` : ""}
      ${s.shots.map((sh) => {
        const w = checks[s.scene_number][sh.shot_number];
        return `<div class="shot ${w ? "warn" : ""}">
        <div class="shot-head"><b>ช็อต ${s.scene_number}.${sh.shot_number}</b>
        <span class="muted">· ${esc(sh.shot_type)}${sh.lens ? ` · ${esc(sh.lens)}` : ""}${sh.camera_angle ? ` · ${esc(sh.camera_angle)}` : ""} · ${esc(sh.camera_move)} · ${sh.duration_seconds}s · ${sh.characters.map(charName).map(esc).join(", ")}</span></div>
        <div class="shot-body">
          ${sh.camera ? `<div class="shot-visual">${SB.frameSVG(sh, b, charName, 150)}${SB.planSVG(s, b, charName, sh, 150)}</div>` : ""}
          <div class="shot-text">
            ${w ? w.map((x) => `<div class="warnline">⚠️ ${esc(x)}</div>`).join("") : ""}
            <p>${esc(sh.action)}</p>
            ${sh.dialogue.map((d) => `<div class="dialogue">🗣️ <b>${esc(charName(d.character))}</b> <span class="muted">(${esc(d.emotion)})</span>: “${esc(d.line)}”</div>`).join("")}
            ${sh.cut_motivation ? `<div class="muted">✂️ เหตุผลที่ตัดมาช็อตนี้: ${esc(sh.cut_motivation)}</div>` : ""}
            ${sh.crosses_axis ? `<div class="muted">↔️ ข้ามเส้นอย่างตั้งใจ: ${esc(sh.cross_reason)}</div>` : ""}
            ${sh.continuity_notes ? `<div class="muted">🔗 ความต่อเนื่อง: ${esc(sh.continuity_notes)}</div>` : ""}
            ${sh.sound ? `<div class="muted">🔊 ${esc(sh.sound)}</div>` : ""}
            ${promptBlock("Start frame", sh.start_frame_prompt + neg)}
            ${promptBlock("End frame", sh.end_frame_prompt + neg)}
            ${promptBlock("Video", sh.video_prompt)}
          </div>
        </div>
      </div>`;}).join("")}`).join("")}
  </div>`;

  $("copyAllVideo").onclick = () => copy(ep.scenes.flatMap((s) => s.shots.map((sh) =>
    `[${s.scene_number}.${sh.shot_number}] ${sh.video_prompt}`)).join("\n\n"));
  $("regen").onclick = () => { delete state.episodes[n]; save(); openEpisode(n, $("regen")); };
  v.scrollIntoView({ behavior: "smooth" });
}

// ---------- export / import ----------
function toMarkdown() {
  const b = state.bible;
  let md = `# ${b.title} (${b.title_en})\n\n${b.logline}\n\n**Visual style:** ${b.visual_style}\n\n## ตัวละคร\n`;
  for (const c of b.characters) md += `\n### ${c.name} — ${c.role}\n${c.personality}\n\n\`${c.appearance_prompt}\`\n`;
  md += `\n## ตอนทั้งหมด\n`;
  for (const e of b.episodes) {
    md += `\n### EP${e.number}: ${e.title}\n${e.synopsis}\n`;
    const ep = state.episodes[e.number];
    if (!ep) continue;
    for (const s of ep.scenes) {
      md += `\n#### ฉาก ${s.scene_number} — ${locName(s.location_id)} (${s.time_of_day})\n${s.summary}\n`;
      for (const sh of s.shots) {
        md += `\n**ช็อต ${s.scene_number}.${sh.shot_number}** (${sh.shot_type}, ${sh.camera_move}, ${sh.duration_seconds}s)\n${sh.action}\n`;
        for (const d of sh.dialogue) md += `- ${charName(d.character)} (${d.emotion}): "${d.line}"\n`;
        md += `\n- Start: \`${sh.start_frame_prompt}\`\n- End: \`${sh.end_frame_prompt}\`\n- Video: \`${sh.video_prompt}\`\n`;
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
    Object.assign(state, data); save(); renderBible(); $("episodeView").hidden = true;
    toast("เปิดโปรเจกต์แล้ว");
  } catch { toast("ไฟล์ไม่ถูกต้อง"); }
}

renderBible();
