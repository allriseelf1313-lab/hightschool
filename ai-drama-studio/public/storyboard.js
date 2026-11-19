// Storyboard engine: everything here is computed from the floor-plan geometry the AI wrote,
// so the sketches show what a real camera at that spot would see — and the checks catch
// shots that break the 180-degree rule, screen direction or the 30-degree rule.
// Plan units: 0-100, 1 unit = 10 cm, y grows downward. facing_deg: 0 up, 90 right, 180 down, 270 left.

const SB = (() => {
  const COLORS = ["#f472b6", "#38bdf8", "#facc15", "#4ade80", "#c084fc", "#fb923c"];
  const SENSOR_W = 20.25, SENSOR_H = 36; // vertical 9:16 frame on a full-frame sensor (mm)
  const CAM_H = { "eye-level": 15.5, low: 7, high: 24, overhead: 30 };

  const norm = (v) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const facingVec = (deg) => ({ x: Math.sin(deg * Math.PI / 180), y: -Math.cos(deg * Math.PI / 180) });
  const lensMM = (lens) => parseFloat(String(lens).match(/\d+(\.\d+)?/)?.[0]) || 35;
  const camHeight = (angle = "") => {
    const a = angle.toLowerCase();
    return a.includes("overhead") ? CAM_H.overhead : a.includes("low") ? CAM_H.low
      : a.includes("high") ? CAM_H.high : CAM_H["eye-level"];
  };

  function colorOf(bible, id) {
    const sig = bible.characters.find((c) => c.id === id)?.signature_color;
    if (/^#[0-9a-f]{6}$/i.test(sig || "")) return sig;
    const i = bible.characters.findIndex((c) => c.id === id);
    return COLORS[(i < 0 ? 0 : i) % COLORS.length];
  }

  // Where each character lands in the frame, seen from this shot's camera.
  function project(shot) {
    const cam = shot.camera;
    const a = norm({ x: cam.aim_x - cam.x, y: cam.aim_y - cam.y });
    const r = { x: -a.y, y: a.x }; // camera's right
    const f = lensMM(shot.lens);
    const halfW = SENSOR_W / 2 / f;
    return (shot.positions || []).map((p) => {
      const d = { x: p.x - cam.x, y: p.y - cam.y };
      const depth = dot(d, a), lateral = dot(d, r);
      const fx = 0.5 + (depth > 0 ? lateral / depth / (2 * halfW) : 0);
      const fv = facingVec(p.facing_deg);
      const fr = dot(fv, r), fa = dot(fv, a);
      const looking = fa < -0.7 ? "toward camera" : fa > 0.7 ? "away" : fr > 0 ? "right" : "left";
      const side = fx < 0.4 ? "left" : fx > 0.6 ? "right" : "center";
      return { ...p, depth, fx, side, looking, visible: depth > 1 && fx > -0.15 && fx < 1.15, scale: f / (depth * SENSOR_H) };
    });
  }

  // Which side of the line of action the camera is on: +1 / -1 / 0 (on the line).
  function axisSide(shot, axis) {
    if (!axis || axis.length !== 2) return null;
    const A = shot.positions?.find((p) => p.character === axis[0]);
    const B = shot.positions?.find((p) => p.character === axis[1]);
    if (!A || !B) return null;
    const cross = (B.x - A.x) * (shot.camera.y - A.y) - (B.y - A.y) * (shot.camera.x - A.x);
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    return Math.abs(cross / len) < 2 ? 0 : Math.sign(cross);
  }

  const SIZE_ORDER = ["extreme wide", "wide", "full", "medium wide", "medium", "medium close", "close", "extreme close"];
  const sizeRank = (t = "") => {
    const s = t.toLowerCase();
    for (let i = SIZE_ORDER.length - 1; i >= 0; i--) if (s.includes(SIZE_ORDER[i])) return i;
    return s.includes("establishing") ? 0 : s.includes("insert") ? 7 : 4;
  };
  const camDir = (s) => Math.atan2(s.camera.aim_y - s.camera.y, s.camera.aim_x - s.camera.x) * 180 / Math.PI;

  // Continuity checks for one scene. Returns { [shot_number]: [warning, ...] }
  function check(scene, nameOf, bible) {
    const out = {};
    const warn = (n, msg) => (out[n] ||= []).push(msg);
    const first = scene.shots[0]?.shot_number ?? 1;
    if ("what_changes" in scene && !String(scene.what_changes || "").trim())
      warn(first, "ฉากนี้ไม่ได้เปลี่ยนอะไรในเรื่อง (ไม่มีข้อมูลใหม่/ความสัมพันธ์/เดิมพัน) อาจทำให้เรื่องยืด");
    let side = null, prev = null;
    const outfitSeen = {};
    for (const shot of scene.shots) {
      // wardrobe: every character on set wears a known outfit, and it does not change mid-scene
      if (bible && shot.wardrobe) {
        for (const p of shot.positions || []) {
          const w = shot.wardrobe.find((x) => x.character === p.character);
          const ch = bible.characters.find((c) => c.id === p.character);
          if (!ch?.outfits) continue;
          if (!w || !ch.outfits.some((o) => o.id === w.outfit_id)) { warn(shot.shot_number, `${nameOf(p.character)} ไม่ได้ระบุชุด หรือระบุชุดที่ไม่มีอยู่`); continue; }
          if (outfitSeen[p.character] && outfitSeen[p.character] !== w.outfit_id)
            warn(shot.shot_number, `${nameOf(p.character)} เปลี่ยนชุดกลางฉาก`);
          outfitSeen[p.character] ||= w.outfit_id;
        }
      }
      if (!shot.camera || !shot.positions) continue;
      const s = axisSide(shot, scene.axis_characters);
      if (s) {
        if (side && s !== side && !shot.crosses_axis) warn(shot.shot_number, "กล้องข้ามเส้น 180° โดยไม่มีเหตุผล ภาพจะดูเหมือนตัวละครสลับข้าง");
        if (side && s !== side && shot.crosses_axis) side = s; // motivated cross: new side from now on
        side ||= s;
      }
      const proj = project(shot);
      for (const fp of shot.frame_positions || []) {
        const p = proj.find((q) => q.character === fp.character);
        if (!p) continue;
        if (!p.visible) { warn(shot.shot_number, `${nameOf(fp.character)} อยู่นอกเฟรมตามตำแหน่งกล้อง แต่บทบอกว่าอยู่ในภาพ`); continue; }
        const claimed = (fp.frame_side || "").toLowerCase();
        if (claimed && claimed !== p.side && !(claimed === "center" || p.side === "center"))
          warn(shot.shot_number, `${nameOf(fp.character)}: บทบอกว่าอยู่ "${fp.frame_side}" แต่จากตำแหน่งกล้องจริงจะอยู่ "${p.side}"`);
        // a visible face needs the locked description token in the start frame prompt
        if (bible && p.looking !== "away" && "wardrobe" in shot && !String(shot.start_frame_prompt || "").includes(`{${fp.character}}`))
          warn(shot.shot_number, `เห็นหน้า${nameOf(fp.character)} แต่พรอมต์ไม่มี {${fp.character}} จึงใส่หน้าตาที่ล็อกไว้ให้ไม่ได้`);
      }
      if (prev) {
        let diff = Math.abs(camDir(shot) - camDir(prev)) % 360; if (diff > 180) diff = 360 - diff;
        const same = (shot.characters || []).join() === (prev.characters || []).join();
        if (same && diff < 30 && Math.abs(sizeRank(shot.shot_type) - sizeRank(prev.shot_type)) < 2)
          warn(shot.shot_number, `มุมกล้องต่างจากช็อตก่อนแค่ ${Math.round(diff)}° และขนาดภาพใกล้กัน อาจเป็น jump cut (ควร ≥30° หรือเปลี่ยนขนาดภาพ 2 ระดับ)`);
      }
      prev = shot;
    }
    return out;
  }

  // Series-level checks: threads pay off inside the series, every episode has a colour script.
  function checkBible(b) {
    const out = [];
    const n = b.episodes?.length || 0;
    for (const t of b.threads || []) {
      if (t.payoff_episode > n || t.payoff_episode < 1) out.push(`ปม "${t.question}" เฉลยตอนที่ ${t.payoff_episode} ซึ่งไม่มีอยู่ในซีรีส์`);
      if (t.setup_episode > t.payoff_episode) out.push(`ปม "${t.question}" เฉลยก่อนจะเปิดปม`);
    }
    for (const e of b.episodes || [])
      if (b.color_script && !b.color_script.some((c) => c.episode === e.number)) out.push(`EP${e.number} ยังไม่มีโทนสี`);
    return out;
  }

  // Replace {c1} tokens with the locked face description + the outfit worn in this shot.
  // short = just the name: used in end frames, which edit a picture that already shows the face.
  function expand(text, bible, shot, short = false) {
    return String(text || "").replace(/\{(c\d+)\}/g, (m, id) => {
      const ch = bible.characters.find((c) => c.id === id);
      if (!ch) return m;
      if (short) return ch.flow_name || ch.name;
      const face = ch.face_prompt || ch.appearance_prompt || ch.name;
      const wid = shot?.wardrobe?.find((w) => w.character === id)?.outfit_id;
      const outfit = (ch.outfits || []).find((o) => o.id === wid) || (ch.outfits || [])[0];
      return outfit ? `${face}, wearing ${outfit.prompt}` : face;
    });
  }

  // A simple body silhouette for each posture. Heights are in plan units (10 cm) above the floor.
  function figure(p, cx, k, Y, col) {
    const posture = String(p.posture || "standing").toLowerCase();
    const dir = p.looking === "right" ? 1 : p.looking === "left" ? -1 : 0;
    const rect = (x1, y1, x2, y2, r, op) =>
      `<rect x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${Math.abs(x2 - x1)}" height="${Math.abs(y2 - y1)}" rx="${r}" fill="${col}" opacity="${op}"/>`;
    const limb = (x1, y1, x2, y2, wd) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-opacity=".55" stroke-width="${wd}" stroke-linecap="round"/>`;
    const head = (x, hh) => `<circle cx="${x}" cy="${Y(hh)}" r="${1.25 * k}" fill="${col}"/>`;
    const torso = (sh, hip) => rect(cx - 2.6 * k, Y(sh), cx + 2.6 * k, Y(hip), 1.4 * k, ".8");
    let svg, headX = cx, headH;
    if (posture.includes("lying")) {
      const s = dir || 1;
      headH = 1.3; headX = cx + s * 7.5 * k;
      svg = rect(cx - s * 8 * k, Y(2.4), cx + s * 6 * k, Y(0.2), k, ".75") + head(headX, headH);
    } else if (posture.includes("sit")) {
      headH = 12.3;
      svg = (dir ? limb(cx, Y(4.5), cx + dir * 4.5 * k, Y(4.5), 2.4 * k) + limb(cx + dir * 4.5 * k, Y(4.5), cx + dir * 4.5 * k, Y(0), 2 * k)
                 : rect(cx - 2.4 * k, Y(4.5), cx + 2.4 * k, Y(0), k, ".55"))
        + torso(10.5, 4.5) + head(cx, headH);
    } else if (posture.includes("kneel")) {
      headH = 12;
      svg = rect(cx - 2.4 * k, Y(4.8), cx + 2.4 * k, Y(0), k, ".55")
        + (dir ? limb(cx, Y(0.6), cx - dir * 3.5 * k, Y(0.6), 1.8 * k) : "")
        + torso(10.3, 4.8) + head(cx, headH);
    } else if (posture.includes("bend")) {
      headH = 12.2; headX = cx + (dir || 0) * 3 * k;
      svg = rect(cx - 2.4 * k, Y(8.5), cx + 2.4 * k, Y(0), k, ".55")
        + `<path d="M${cx - 2.6 * k} ${Y(8.5)} L${cx + 2.6 * k} ${Y(8.5)} L${headX + 2.6 * k} ${Y(11)} L${headX - 2.6 * k} ${Y(11)}Z" fill="${col}" opacity=".8"/>`
        + head(headX, headH);
    } else {
      headH = 16;
      const spread = posture.includes("run") ? 2.6 : posture.includes("walk") ? 1.5 : 0;
      svg = (spread ? limb(cx - 0.8 * k, Y(8.5), cx - spread * k, Y(0), 2 * k) + limb(cx + 0.8 * k, Y(8.5), cx + spread * k, Y(0), 2 * k)
                    : rect(cx - 2.6 * k, Y(8.5), cx + 2.6 * k, Y(0), k, ".55"))
        + torso(14.2, 8.5) + head(cx, headH);
    }
    return { svg, headX, headY: Y(headH) };
  }

  // ---------- SVG: what the camera sees (9:16 frame sketch) ----------
  function frameSVG(shot, bible, nameOf, w = 180) {
    const h = w * 16 / 9;
    const camH = camHeight(shot.camera_angle);
    const people = project(shot).filter((p) => p.visible).sort((a, b) => b.depth - a.depth);
    const f = lensMM(shot.lens), halfH = SENSOR_H / 2 / f;
    const c = shot.camera, aimDist = Math.hypot(c.aim_x - c.x, c.aim_y - c.y) || 1;
    const tilt = Math.atan2(13 - camH, aimDist); // camera tilts to frame the subject's chest
    const y = (hgt, p) => h * (0.5 - Math.tan(Math.atan2(hgt - camH, p.depth) - tilt) / (2 * halfH));
    const id = `clip${Math.random().toString(36).slice(2)}`;
    let g = "";
    for (const p of people) {
      const cx = p.fx * w, k = p.scale * h; // pixels per plan unit at that depth
      const col = colorOf(bible, p.character);
      const back = p.looking === "away";
      const fig = figure(p, cx, k, (hh) => y(hh, p), col);
      const headX = fig.headX, headY = fig.headY;
      g += `<g opacity="${back ? 0.9 : 1}" style="${back ? "filter:brightness(.6)" : ""}">${fig.svg}`;
      if (p.looking === "left" || p.looking === "right") {
        const s = p.looking === "right" ? 1 : -1;
        g += `<path d="M${headX + s * 1.1 * k} ${headY - 0.35 * k} L${headX + s * 1.9 * k} ${headY} L${headX + s * 1.1 * k} ${headY + 0.35 * k}Z" fill="#fff"/>`;
      } else if (p.looking === "toward camera") {
        g += `<circle cx="${headX - 0.45 * k}" cy="${headY - 0.1 * k}" r="${0.18 * k}" fill="#111"/><circle cx="${headX + 0.45 * k}" cy="${headY - 0.1 * k}" r="${0.18 * k}" fill="#111"/>`;
      }
      const ly = Math.min(Math.max(headY - 1.6 * k, 12), h - 6);
      g += `<text x="${Math.min(Math.max(headX, 24), w - 24)}" y="${ly}" text-anchor="middle" class="sb-name">${nameOf(p.character)}</text></g>`;
    }
    return `<svg class="sb-frame" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="ภาพร่างเฟรม">
      <defs><clipPath id="${id}"><rect width="${w}" height="${h}" rx="6"/></clipPath></defs>
      <g clip-path="url(#${id})">
        <rect width="${w}" height="${h}" fill="#0b0a1c"/>
        <rect y="${h / 2}" width="${w}" height="${h / 2}" fill="#16142f"/>
        <line x1="${w / 3}" y1="0" x2="${w / 3}" y2="${h}" class="sb-third"/><line x1="${2 * w / 3}" y1="0" x2="${2 * w / 3}" y2="${h}" class="sb-third"/>
        <line x1="0" y1="${h / 3}" x2="${w}" y2="${h / 3}" class="sb-third"/><line x1="0" y1="${2 * h / 3}" x2="${w}" y2="${2 * h / 3}" class="sb-third"/>
        ${g}
      </g></svg>`;
  }

  // ---------- SVG: top-down floor plan ----------
  function planSVG(scene, bible, nameOf, onlyShot, size = 220) {
    const shots = onlyShot ? [onlyShot] : scene.shots.filter((s) => s.camera);
    const ref = onlyShot || shots.reduce((m, x) => ((x.positions || []).length > (m.positions || []).length ? x : m), shots[0]);
    // zoom to where the action is
    const pts = shots.flatMap((s) => [[s.camera.x, s.camera.y], ...(s.positions || []).map((p) => [p.x, p.y])]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 24) + 20;
    const cx0 = (Math.max(...xs) + Math.min(...xs)) / 2 - span / 2, cy0 = (Math.max(...ys) + Math.min(...ys)) / 2 - span / 2;
    const S = size / span, X = (v) => (v - cx0) * S, Y = (v) => (v - cy0) * S;
    let g = "";
    const ax = scene.axis_characters;
    if (ref && ax?.length === 2) {
      const A = ref.positions?.find((p) => p.character === ax[0]);
      const B = ref.positions?.find((p) => p.character === ax[1]);
      if (A && B) {
        const d = norm({ x: B.x - A.x, y: B.y - A.y });
        g += `<line x1="${X(A.x - d.x * 300)}" y1="${Y(A.y - d.y * 300)}" x2="${X(A.x + d.x * 300)}" y2="${Y(A.y + d.y * 300)}" class="sb-axis"/>`;
      }
    }
    for (const shot of shots) {
      const c = shot.camera, f = lensMM(shot.lens);
      const a = Math.atan2(c.aim_y - c.y, c.aim_x - c.x), half = Math.atan(SENSOR_W / 2 / f), L = span * 0.3;
      g += `<path d="M${X(c.x)} ${Y(c.y)} L${X(c.x + Math.cos(a - half) * L)} ${Y(c.y + Math.sin(a - half) * L)} L${X(c.x + Math.cos(a + half) * L)} ${Y(c.y + Math.sin(a + half) * L)}Z" class="sb-cone"/>`;
    }
    for (const shot of shots) {
      const c = shot.camera;
      g += `<circle cx="${X(c.x)}" cy="${Y(c.y)}" r="7" class="sb-cam"/><text x="${X(c.x)}" y="${Y(c.y) + 3}" text-anchor="middle" class="sb-camnum">${shot.shot_number}</text>`;
    }
    for (const p of ref?.positions || []) {
      const v = facingVec(p.facing_deg), col = colorOf(bible, p.character), r = Math.max(4, 2.2 * S);
      g += `<line x1="${X(p.x)}" y1="${Y(p.y)}" x2="${X(p.x + v.x * 6)}" y2="${Y(p.y + v.y * 6)}" stroke="${col}" stroke-width="2"/>
        <circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${r}" fill="${col}"/>
        <text x="${X(p.x)}" y="${Y(p.y) - r - 4}" text-anchor="middle" class="sb-name">${nameOf(p.character)}</text>`;
    }
    return `<svg class="sb-plan" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="ผังมุมกล้องจากด้านบน">
      <rect x="1" y="1" width="${size - 2}" height="${size - 2}" rx="6" class="sb-room"/>
      <svg x="0" y="0" width="${size}" height="${size}" overflow="hidden">${g}</svg></svg>`;
  }

  // Free, automatic fixes applied when prompts are shown or copied (old episodes included):
  // the end frame becomes an edit of the start frame so the clip does not jump to another place,
  // and the video prompt asks for one continuous shot at real-time speed with visible acting.
  const EDIT_PREFIX = "Edit the start frame image. Keep everything the same: same location, same background, same props in the same places, same clothes, same camera angle and framing. Only change the pose and expression as follows: ";
  function flowEnd(text) {
    const t = String(text || "").trim();
    return /^edit the start frame/i.test(t) ? t : EDIT_PREFIX + t;
  }
  function flowVideo(text, shot) {
    let t = String(text || "")
      .replace(/\bvery slow(ly)?\b,?\s*/gi, "")
      .replace(/\bno lip movement\b,?\s*/gi, "")
      .replace(/,?\s*\bsingle simple motion\b/gi, "")
      .replace(/\s{2,}/g, " ").replace(/^[,\s]+/, "").trim();
    t = t.replace(/[,\s]+$/, "");
    if (t) t = t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".");
    const add = [];
    if (!/continuous shot/i.test(t)) add.push("One continuous shot, no scene change, same location the whole time.");
    if (!/real-time/i.test(t)) add.push("Natural real-time speed, not slow motion.");
    if (!/acting:/i.test(t)) add.push(shot?.acting ? `Acting: ${shot.acting}`
      : "Acting: clear, visible emotion that fits the moment: expressive eyes and brows, visible breathing, blinking, micro-expressions, natural hand gestures.");
    return [t, ...add].join(" ");
  }

  return { project, check, checkBible, expand, flowEnd, flowVideo, frameSVG, planSVG };
})();
