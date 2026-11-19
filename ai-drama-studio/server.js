// AI Drama Studio — server
// Idea -> series bible -> shooting script with blocking, storyboard and prompts for
// image/video generators such as Google Flow / Veo. Every episode is checked for
// camera continuity and the AI fixes the scenes that fail.
// Long AI work runs as background jobs, so closing the page does not lose the result,
// and the project is backed up to ./data on this computer.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = process.env.DRAMA_MODEL || "claude-opus-5-5";
const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(here, "data");
for (const d of ["jobs", "backups"]) fs.mkdirSync(path.join(DATA, d), { recursive: true });

// USD per million tokens. Cache writes cost 1.25x input; cache reads are listed.
const MODELS = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, fallbacks: true },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, fallbacks: true },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, fallbacks: false },
};
const modelOf = (m) => (MODELS[m] ? m : MODELS[DEFAULT_MODEL] ? DEFAULT_MODEL : "claude-opus-5-5");

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// The browser's storyboard engine also runs here, so the server checks the same rules the page shows.
const SB = new Function(fs.readFileSync(path.join(here, "public", "storyboard.js"), "utf8") + "\nreturn SB;")();

// ---------- JSON schemas for structured output ----------
const str = { type: "string" };
const num = { type: "number" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items) => ({ type: "array", items });

const CHARACTER = obj({
  id: str, name: str, role: str, age: int, gender: str,
  personality: str, backstory: str,
  want: str, need: str, secret: str, flaw: str, arc: str,
  signature_color: str, // hex
  face_prompt: str, // English: face, hair, body — never changes
  outfits: arr(obj({ id: str, name: str, prompt: str })), // English: clothing only
});

const BIBLE_SCHEMA = obj({
  title: str, title_en: str, logline: str, genre: str, tone: str, setting: str,
  rating: str,
  visual_style: str,
  negative_prompt: str,
  characters: arr(CHARACTER),
  locations: arr(obj({ id: str, name: str, description_prompt: str })),
  threads: arr(obj({
    id: str, question: str, setup_episode: int,
    clues: arr(obj({ episode: int, clue: str })),
    payoff_episode: int, payoff: str,
  })),
  color_script: arr(obj({ episode: int, mood: str, palette: arr(str) })),
  episodes: arr(obj({
    number: int, title: str, hook_open: str, synopsis: str, cliffhanger: str,
    pov_character: str, threads: arr(str),
  })),
});

const SHOT = obj({
  shot_number: int,
  shot_type: str, lens: str, camera_angle: str, camera_move: str,
  // top-down floor plan, 0-100 on both axes (1 unit = 10 cm), y grows toward the bottom
  camera: obj({ x: num, y: num, aim_x: num, aim_y: num }),
  positions: arr(obj({ character: str, x: num, y: num, facing_deg: num, posture: str })),
  frame_positions: arr(obj({ character: str, frame_side: str, looking: str })),
  wardrobe: arr(obj({ character: str, outfit_id: str })),
  depth_layers: obj({ foreground: str, midground: str, background: str }),
  crosses_axis: bool, cross_reason: str,
  cut_motivation: str, continuity_notes: str,
  characters: arr(str),
  action: str,
  dialogue: arr(obj({ character: str, line: str, emotion: str, subtext: str })),
  acting: str, // English: 2-3 emotional beats with visible expressions and body language
  start_frame_prompt: str, end_frame_prompt: str, video_prompt: str,
  duration_seconds: int, sound: str,
});

const SCENE = obj({
  scene_number: int, location_id: str, time_of_day: str, summary: str,
  change_type: str, // info | relationship | stakes
  what_changes: str,
  dramatic_irony: str,
  threads_touched: arr(str),
  lighting: str, music_cue: str,
  axis_characters: arr(str), camera_side_note: str,
  shots: arr(SHOT),
});

const EPISODE_SCHEMA = obj({
  episode_number: int, title: str, pov_character: str, cold_open: str,
  scenes: arr(SCENE),
});


// Episode plan: the cheap first step. Scenes are then written in parallel from it.
const EPISODE_PLAN = obj({
  episode_number: int, title: str, pov_character: str, cold_open: str,
  scenes: arr(obj({
    scene_number: int, location_id: str, time_of_day: str, summary: str,
    change_type: str, what_changes: str, dramatic_irony: str, threads_touched: arr(str),
    lighting: str, music_cue: str, axis_characters: arr(str), camera_side_note: str,
    wardrobe: arr(obj({ character: str, outfit_id: str })),
    shot_count: int,
  })),
});



const ACTING_SCHEMA = obj({
  shots: arr(obj({ scene_number: int, shot_number: int, acting: str, end_frame_prompt: str, video_prompt: str })),
});
const SCHEMA_NAMES = new Map([[BIBLE_SCHEMA, "series bible"], [EPISODE_SCHEMA, "episode"], [EPISODE_PLAN, "episode plan"], [SCENE, "scene"], [SHOT, "shot"], [ACTING_SCHEMA, "acting"]]);
const schemaName = (schema) => SCHEMA_NAMES.get(schema) || "object";

// ---------- prompts ----------
const RATING_RULES = {
  "ทั่วไป": "General audience: no sexual content, romance up to holding hands and hugs, no graphic violence.",
  "13+": "13+: romance up to a kiss, mild violence and scary moments, no sexual content.",
  "18+": `18+: mature themes, stronger emotions and violence allowed. Romantic intimacy only between adult
characters aged 20 or older, and always implied, never explicit: kissing, embraces, suggestive tension,
then cut away (fade out, cut to the next morning). No nudity or sexual detail in any prompt.`,
};

const SYSTEM = `You are a showrunner, screenwriter and director of photography who makes short vertical
drama series generated with AI image and video tools (Google Flow / Veo, Kling, Runway).
Write story text, names and dialogue in the language the user writes in (usually Thai).
Write every *_prompt field in English, because image and video models follow English best.

Safety, always: never sexual or sexualized content involving anyone under 18, in any rating and in any
field. If characters are under 18, any romance stays innocent. Never use real celebrities or real people.

Storytelling — gripping, never padded:
1. Hook: every episode opens with a 3-second hook (hook_open / cold_open, the first shot) that raises a
   question, and ends on a cliffhanger that forces the next episode.
2. Every scene must change something — new information, a shifted relationship, or higher stakes —
   stated in change_type and what_changes. If a scene changes nothing, cut it or merge it.
3. Mystery threads are planned: each thread has a setup episode, clues spread over episodes, and a payoff
   episode within the series. Episodes list the threads they advance; scenes list threads_touched.
4. Characters have depth: want (external goal), need (inner truth), secret, flaw and an arc. Antagonists
   have understandable reasons. Dialogue carries subtext — people rarely say exactly what they mean;
   write the hidden meaning in subtext.
5. Point of view: each episode has a pov_character. Use dramatic irony (the audience knows something a
   character does not) to build suspense, written in dramatic_irony when used.
6. Pacing for vertical drama: short scenes, enter late and leave early, 1-3 minutes per episode.

Character consistency:
- face_prompt fixes face, hair, body and distinguishing marks and never mentions clothing.
- Each character has outfits (clothing only). Each shot's wardrobe says which outfit each visible
  character wears; outfits change only when the story moves to a new day or place that motivates it.
- In frame prompts, write a character as the token {c1}, {c2}... wherever you want the full locked
  description; the program replaces the token with face_prompt + outfit. Never re-describe the face in
  your own words. For partial views (back of head, shoulder) describe only what is visible.

Cinematography — shoot like a real film crew, never random angles or random cuts:
1. Block every scene before writing shots. Place each character on a top-down floor plan
   (0-100 on x and y, 1 unit = 10 cm, y grows toward the bottom; facing_deg 0 = up, 90 = right,
   180 = down, 270 = left) with a posture (standing, sitting, kneeling, lying, walking, running,
   bending). Give the camera a real position and aim point on the same plan. Keep distances real:
   medium shot with 50mm ~20-30 units from the subject, close-up with 85mm ~12-18 units,
   establishing with 24mm ~35-60 units.
2. 180-degree rule: the line between the two axis_characters is the line of action. Keep every camera
   of the scene on one side. Cross only with visible motivation, then set crosses_axis and cross_reason.
3. Screen direction & eyelines: a character on frame-left stays frame-left during an exchange; in
   shot/reverse-shot A looks frame-right and B looks frame-left; movement keeps its direction across cuts.
   frame_positions must be what the plan geometry actually shows from that camera and lens, and the
   frame prompts must say the same ("on the left of frame, looking right").
4. 30-degree rule: consecutive shots of the same subject change angle by at least 30 degrees or change
   shot size by two steps. No jump cuts.
5. Open each scene with an establishing or wide shot, move closer as emotion rises.
6. Every cut has a reason (match on action, eyeline match, reaction, reveal, dialogue turn).
7. Continuity: props, which hand holds them, hair, positions and light direction carry over; note them.
8. Lenses: 24-35mm establishing, 50mm mediums, 85-100mm close-ups; eye level by default.

Visual depth & colour:
- Compose in three layers (depth_layers): foreground element, subject in the midground, readable
  background; shallow depth of field; motivated directional light. Put the layers in the frame prompts.
- Follow the series color_script: each episode has a mood and a 3-4 colour palette (hex); each
  character has a signature colour that shows up in their wardrobe or surroundings. Name the palette
  colours in plain words inside the frame prompts.

Photorealism:
- Name a real camera and lens ("shot on ARRI Alexa Mini, 50mm prime, f/2"), practical light, natural
  skin texture with pores, real fabric wrinkles, believable hands.
- No whip pans, no crowds doing complex actions, no long on-screen text, no fast hand manipulation.
  Camera moves must be physically possible.

Acting & motion — alive, never slow and empty:
- People move at natural real-time human speed. Use slow motion only for a single deliberate dramatic
  beat, and say so; never write "very slow" or "no lip movement" as a default.
- Every shot has acting: 2-3 emotional beats inside the 8 seconds (e.g. freezes -> flinches -> forces a
  calm face), shown through eyes, brows, mouth, breathing, blinking, hands, shoulders and posture. Write
  them in acting, and put the same beats in the video_prompt.
- Match the camera's energy to the emotion: subtle handheld for tension, steady slow push for sadness.

Start and end frames must belong to one continuous shot:
- end_frame_prompt is written as an edit of the start frame: begin with "Edit the start frame image.
  Keep everything the same (same location, background, props in the same places, clothes, camera angle
  and framing). Only change:" and then describe only the new pose and expression.
- video_prompt describes one continuous shot with no scene change from the start frame to the end frame.
- negative_prompt lists what to avoid: plastic skin, extra fingers, warped faces, morphing, changing
  clothes, cartoon look, text artifacts, oversaturated colours.`;

// ---------- calling the model ----------
// ctx = { model, eco, job }: which model, economy mode, and the job that pays for the call.
// Structured outputs guarantee the JSON shape, but the API refuses schemas that compile to a grammar
// that is too large. For those, ask for plain JSON with the schema in the prompt, validate it here,
// and send any problems back for one correction pass.
const looseSchemas = new Set();
const SYSTEM_BLOCKS = [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }];

function effortFor(ctx, effort) {
  if (!ctx.eco) return effort;
  return effort === "high" ? "medium" : effort === "medium" ? "low" : effort;
}

function addCost(ctx, usage) {
  if (!ctx.job || !usage) return;
  const p = MODELS[ctx.model];
  const cost = ((usage.input_tokens || 0) * p.input + (usage.cache_creation_input_tokens || 0) * p.input * 1.25
    + (usage.cache_read_input_tokens || 0) * p.cacheRead + (usage.output_tokens || 0) * p.output) / 1e6;
  ctx.job.cost += cost;
  ctx.job.tokens.cached += usage.cache_read_input_tokens || 0;
}

async function callModel(ctx, content, maxTokens, effort, format) {
  const fb = MODELS[ctx.model].fallbacks;
  const stream = client.beta.messages.stream({
    model: ctx.model,
    max_tokens: maxTokens,
    system: SYSTEM_BLOCKS,
    thinking: { type: "adaptive" },
    output_config: format ? { effort: effortFor(ctx, effort), format } : { effort: effortFor(ctx, effort) },
    // server-side fallback re-runs the request on another model if a safety classifier declines
    ...(fb ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    messages: [{ role: "user", content }],
  });
  const message = await stream.finalMessage();
  addCost(ctx, message.usage);
  if (message.stop_reason === "refusal") throw new Error("โมเดลปฏิเสธคำขอนี้ ลองปรับเนื้อเรื่องแล้วลองใหม่");
  if (message.stop_reason === "max_tokens") throw new Error("ผลลัพธ์ยาวเกินไป ลองลดจำนวนตอน/ฉากลง");
  return message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

const isGrammarTooLarge = (err) =>
  err instanceof Anthropic.BadRequestError && /grammar|schema.*(large|complex)|too (large|complex)/i.test(err.message);

async function generate(ctx, content, schema, maxTokens, effort = "medium") {
  const key = `${ctx.model}:${schemaName(schema)}`;
  if (!looseSchemas.has(key)) {
    try {
      return JSON.parse(await callModel(ctx, content, maxTokens, effort, { type: "json_schema", schema }));
    } catch (err) {
      if (!isGrammarTooLarge(err)) throw err;
      console.log(`Schema "${schemaName(schema)}" too large for structured outputs; using validated JSON mode.`);
      looseSchemas.add(key);
    }
  }
  return generateLoose(ctx, content, schema, maxTokens, effort);
}

function withInstruction(content, text) {
  return typeof content === "string" ? `${content}\n\n${text}` : [...content, { type: "text", text }];
}

async function generateLoose(ctx, content, schema, maxTokens, effort) {
  const instruction = `Schema name: ${schemaName(schema)}
Reply with one JSON object only — no markdown fences, no commentary — that matches this JSON Schema
exactly (every listed property present, no extra properties):
${JSON.stringify(schema)}`;
  let text = await callModel(ctx, withInstruction(content, instruction), maxTokens, effort);
  for (let attempt = 0; ; attempt++) {
    let value, errors;
    try {
      value = coerce(extractJSON(text), schema);
      errors = validate(value, schema);
    } catch (err) {
      errors = [`invalid JSON: ${err.message}`];
    }
    if (!errors.length) return value;
    if (attempt >= 1) throw new Error(`AI ตอบรูปแบบไม่ครบ (${errors.length} จุด) ลองกดใหม่อีกครั้ง`);
    text = await callModel(ctx, withInstruction(content, `${instruction}

Your previous reply had these problems:
${errors.slice(0, 40).join("\n")}

Previous reply:
${text}

Return the corrected JSON object only.`), maxTokens, effort);
  }
}

function extractJSON(text) {
  const t = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const a = t.indexOf("{"), z = t.lastIndexOf("}");
  if (a < 0 || z < a) throw new Error("no JSON object found");
  return JSON.parse(t.slice(a, z + 1));
}

// Fix harmless type slips (numbers sent as strings and the like) before validating.
function coerce(v, s) {
  if (s.type === "object" && v && typeof v === "object" && !Array.isArray(v)) {
    const out = {};
    for (const [k, ps] of Object.entries(s.properties)) {
      if (k in v) out[k] = coerce(v[k], ps);
      // a missing text, list or flag is not worth failing a whole episode over
      else if (ps.type === "string") out[k] = "";
      else if (ps.type === "array") out[k] = [];
      else if (ps.type === "boolean") out[k] = false;
    }
    return out; // extra properties dropped
  }
  if (s.type === "array" && Array.isArray(v)) return v.map((x) => coerce(x, s.items));
  if ((s.type === "number" || s.type === "integer") && typeof v === "string" && v.trim() !== "" && !isNaN(+v))
    return s.type === "integer" ? Math.round(+v) : +v;
  if (s.type === "integer" && typeof v === "number") return Math.round(v);
  if (s.type === "string" && (typeof v === "number" || typeof v === "boolean")) return String(v);
  if (s.type === "string" && v == null) return "";
  if (s.type === "boolean" && typeof v === "string") return v === "true";
  return v;
}

function validate(v, s, at = "$") {
  const errs = [];
  const t = s.type;
  if (t === "object") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return [`${at}: expected object`];
    for (const k of s.required) {
      if (!(k in v)) errs.push(`${at}.${k}: missing`);
      else errs.push(...validate(v[k], s.properties[k], `${at}.${k}`));
    }
  } else if (t === "array") {
    if (!Array.isArray(v)) return [`${at}: expected array`];
    v.forEach((x, i) => errs.push(...validate(x, s.items, `${at}[${i}]`)));
  } else if (t === "integer") {
    if (!Number.isInteger(v)) errs.push(`${at}: expected integer`);
  } else if (t === "number") {
    if (typeof v !== "number" || !isFinite(v)) errs.push(`${at}: expected number`);
  } else if (typeof v !== t) errs.push(`${at}: expected ${t}`);
  return errs;
}

// ---------- helpers ----------
const clamp = (v, lo, hi, d) => Math.min(Math.max(parseInt(v, 10) || d, lo), hi);
const ratingOf = (r) => (RATING_RULES[r] ? r : "13+");
const nameOf = (bible) => (id) => bible.characters.find((c) => c.id === id)?.name || id;

// Locked characters are restored exactly as they were, whatever the model returned.
function keepLocked(bible, original, lockedIds = []) {
  for (const id of lockedIds) {
    const old = original.characters.find((c) => c.id === id);
    if (!old) continue;
    const i = bible.characters.findIndex((c) => c.id === id);
    if (i >= 0) bible.characters[i] = old; else bible.characters.push(old);
  }
  return bible;
}

// The bible goes first and is marked for caching: every later call about the same series
// re-reads it at about a twentieth of the normal input price.
const bibleBlock = (bible) => ({
  type: "text",
  cache_control: { type: "ephemeral" },
  text: `Series bible (JSON):\n${JSON.stringify(bible)}\n
Content rating: ${bible.rating} — ${RATING_RULES[ratingOf(bible.rating)]}`,
});
const withBible = (bible, text) => [bibleBlock(bible), { type: "text", text }];

// Run the storyboard checks and let the AI repair failing scenes.
async function reviewEpisode(ctx, bible, episode) {
  const rounds = ctx.eco ? 1 : 2;
  const log = [];
  const outline = episode.scenes.map((s) => `${s.scene_number}. ${s.summary}`).join("\n");
  episode.scenes = await Promise.all(episode.scenes.map(async (scene) => {
    for (let round = 1; round <= rounds; round++) {
      const problems = Object.entries(SB.check(scene, nameOf(bible), bible))
        .flatMap(([shot, list]) => list.map((p) => `shot ${shot}: ${p}`));
      if (!problems.length) {
        if (round > 1) log.push({ scene: scene.scene_number, round: round - 1, fixed: true });
        return scene;
      }
      log.push({ scene: scene.scene_number, round, problems });
      progress(ctx, `แก้มุมกล้องฉาก ${scene.scene_number} (รอบ ${round})…`);
      scene = await generate(ctx, withBible(bible, `Episode ${episode.episode_number} "${episode.title}" scene outline:
${outline}

This scene (JSON):
${JSON.stringify(scene)}

The storyboard check found these problems (messages are in Thai):
${problems.join("\n")}

Return the corrected scene with the same scene_number and story. Fix camera positions, lenses,
frame_positions and the matching frame prompts so every problem is solved; keep everything else.`),
      SCENE, 48000, "high");
    }
    const left = Object.values(SB.check(scene, nameOf(bible), bible)).flat().length;
    log.push({ scene: scene.scene_number, round: rounds, fixed: left === 0, remaining: left });
    return scene;
  }));
  return log;
}

// ---------- background jobs ----------
const jobs = new Map();
const progress = (ctx, text) => { if (ctx.job) ctx.job.progress = text; };
const jobFile = (id) => path.join(DATA, "jobs", `${id.replace(/[^a-z0-9-]/gi, "")}.json`);

function startJob(type, body, work) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = { id, type, status: "running", progress: "เริ่มงาน…", started: Date.now(), cost: 0, tokens: { cached: 0 } };
  jobs.set(id, job);
  const ctx = { model: modelOf(body.model), eco: !!body.eco, job };
  job.model = ctx.model;
  work(ctx, body)
    .then((result) => Object.assign(job, { status: "done", result, progress: "เสร็จแล้ว" }))
    .catch((err) => { console.error(err); Object.assign(job, { status: "error", error: friendlyError(err) }); })
    .finally(() => {
      job.finished = Date.now();
      try { fs.writeFileSync(jobFile(id), JSON.stringify(job)); } catch (e) { console.error(e); }
      setTimeout(() => jobs.delete(id), 60 * 60 * 1000);
    });
  return job;
}

class BadRequest extends Error {}

function friendlyError(err) {
  if (err instanceof BadRequest) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "API key ไม่ถูกต้อง ตรวจสอบ ANTHROPIC_API_KEY";
  if (err instanceof Anthropic.RateLimitError) return "เรียกใช้บ่อยเกินไป รอสักครู่แล้วลองใหม่";
  if (err instanceof Anthropic.APIError && /credit balance/i.test(err.message)) return "เครดิต Claude หมด — เติมเงินที่ console.anthropic.com → Billing";
  if (err instanceof Anthropic.APIError) return `API error: ${err.message}`;
  if (/authentication method/i.test(err.message || "")) return "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ในหน้าต่าง PowerShell";
  return err.message || "เกิดข้อผิดพลาด";
}

// ---------- the work each job does ----------
const WORK = {
  async bible(ctx, { idea, genre = "", episodes = 6, style = "", rating = "13+" }) {
    if (!idea || typeof idea !== "string") throw new BadRequest("กรุณาใส่ไอเดียเรื่อง");
    const n = clamp(episodes, 1, 20, 6);
    const r = ratingOf(rating);
    progress(ctx, "กำลังสร้างตัวละคร ปมเรื่อง โทนสี และโครงเรื่องทุกตอน…");
    return generate(ctx, `Create a series bible for a short AI vertical drama series.
Story idea: ${idea}
Genre: ${genre || "choose the best fit"}
Number of episodes: ${n}
Preferred visual style: ${style || "cinematic, photorealistic, vertical 9:16"}
Content rating: ${r} — ${RATING_RULES[r]} (put "${r}" in the rating field)

Give 3-6 main characters with ids c1, c2..., each with 2-3 outfits (ids o1, o2...) and a distinct
signature colour; 3-6 locations (l1, l2...); 2-4 mystery threads (t1, t2...) whose payoffs land
within ${n} episodes; a color_script entry for every episode; and exactly ${n} episodes.`, BIBLE_SCHEMA, 48000);
  },

  async "revise-bible"(ctx, { bible, instruction, locked = [] }) {
    if (!bible || !instruction) throw new BadRequest("ไม่มีคำสั่งแก้");
    progress(ctx, "กำลังแก้ไบเบิลตามคำสั่ง…");
    const out = await generate(ctx, withBible(bible, `Revise the series bible following this instruction from the creator:
"${instruction}"

Change only what the instruction needs and keep ids stable. These characters are locked and must stay
exactly as they are: ${locked.join(", ") || "none"}.`), BIBLE_SCHEMA, 48000);
    return keepLocked(out, bible, locked);
  },

  // Plan the episode first (small, fast), then write every scene in parallel from the plan.
  async episode(ctx, { bible, episodeNumber, scenes = 4 }) {
    const ep = bible?.episodes?.find((e) => e.number === Number(episodeNumber));
    if (!ep) throw new BadRequest("ไม่พบตอนที่เลือก");
    const s = clamp(scenes, 1, 10, 4);
    progress(ctx, "ขั้นที่ 1/3: วางโครงตอน…");
    const plan = await generate(ctx, withBible(bible, `Plan episode ${ep.number} "${ep.title}": exactly ${s} scenes with 3-6 shots each.
Hook (first shot): ${ep.hook_open}
Synopsis: ${ep.synopsis}
End on this cliffhanger: ${ep.cliffhanger}
POV character: ${ep.pov_character}
Threads to advance: ${ep.threads.join(", ")}
For every scene give its purpose, the two axis characters (or none), lighting, music and the outfit each
character wears. Use the ids from the bible.`), EPISODE_PLAN, 16000, "high");

    let done = 0;
    progress(ctx, `ขั้นที่ 2/3: เขียนทุกฉากพร้อมกัน (0/${plan.scenes.length})…`);
    const written = await Promise.all(plan.scenes.map(async (sp, i) => {
      const prev = plan.scenes[i - 1], next = plan.scenes[i + 1];
      const scene = await generate(ctx, withBible(bible, `Episode plan (JSON):
${JSON.stringify(plan)}

Write scene ${sp.scene_number} in full with ${sp.shot_count} shots, numbered from 1, with complete blocking,
camera positions and prompts. Copy the scene fields from the plan and follow every rule.
${i === 0 ? `The first shot is the episode hook: ${plan.cold_open}` : `It follows scene ${prev.scene_number}: ${prev.summary}`}
${next ? `It leads into scene ${next.scene_number}: ${next.summary}` : `It ends the episode on the cliffhanger: ${ep.cliffhanger}`}`),
      SCENE, 48000, "high");
      const { shot_count, ...fields } = sp;
      done++;
      progress(ctx, `ขั้นที่ 2/3: เขียนทุกฉากพร้อมกัน (${done}/${plan.scenes.length})…`);
      return { ...scene, ...fields, scene_number: sp.scene_number, shots: scene.shots };
    }));
    const { scenes: _plan, ...head } = plan;
    const episode = { ...head, scenes: written };
    progress(ctx, "ขั้นที่ 3/3: ตรวจมุมกล้อง…");
    const review = await reviewEpisode(ctx, bible, episode);
    return { episode, review };
  },

  async "revise-episode"(ctx, { bible, episode, instruction }) {
    if (!bible || !episode || !instruction) throw new BadRequest("ไม่มีคำสั่งแก้");
    progress(ctx, "กำลังแก้ทั้งตอนตามคำสั่ง…");
    const out = await generate(ctx, withBible(bible, `Current shooting script of episode ${episode.episode_number} (JSON):
${JSON.stringify(episode)}

Revise it following this instruction from the creator:
"${instruction}"

Change only what the instruction needs; keep everything else, including blocking that already works.`),
    EPISODE_SCHEMA, 100000, "high");
    progress(ctx, "ตรวจมุมกล้อง…");
    const review = await reviewEpisode(ctx, bible, out);
    return { episode: out, review };
  },

  async shot(ctx, { bible, scene, shotNumber, instruction = "" }) {
    const idx = scene?.shots?.findIndex((s) => s.shot_number === Number(shotNumber));
    if (idx == null || idx < 0) throw new BadRequest("ไม่พบช็อตที่เลือก");
    let problems = [];
    let shot;
    for (let round = 0; round <= 1; round++) {
      progress(ctx, round ? "แก้จุดที่ยังไม่ผ่าน…" : `กำลังเขียนช็อต ${shotNumber} ใหม่…`);
      shot = await generate(ctx, withBible(bible, `Scene (JSON):
${JSON.stringify(scene)}

Rewrite only shot ${shotNumber}. ${instruction ? `Creator's instruction: "${instruction}".` : "Make it better."}
It must cut smoothly from the shot before and into the shot after: keep the same side of the line of
action, screen direction, wardrobe, props and light. Keep shot_number ${shotNumber}.
${problems.length ? `Your previous attempt had these problems, fix them:\n${problems.join("\n")}` : ""}`),
      SHOT, 24000, "medium");
      const trial = { ...scene, shots: scene.shots.map((s, i) => (i === idx ? shot : s)) };
      problems = SB.check(trial, nameOf(bible), bible)[shotNumber] || [];
      if (!problems.length || ctx.eco) break;
    }
    return { shot, warnings: problems };
  },

  // Rewrites only the acting, end frames and video prompts of an existing episode: far cheaper than
  // writing the episode again, and blocking, dialogue and start frames stay exactly as they were.
  async acting(ctx, { bible, episode }) {
    if (!bible || !episode) throw new BadRequest("ไม่พบบทตอนนี้");
    progress(ctx, "กำลังเขียนการแสดงและพรอมต์วิดีโอใหม่ทุกช็อต…");
    const brief = episode.scenes.map((s) => ({
      scene_number: s.scene_number, summary: s.summary, lighting: s.lighting,
      shots: s.shots.map((sh) => ({ shot_number: sh.shot_number, shot_type: sh.shot_type, camera_move: sh.camera_move,
        characters: sh.characters, action: sh.action, dialogue: sh.dialogue,
        start_frame_prompt: sh.start_frame_prompt, end_frame_prompt: sh.end_frame_prompt, video_prompt: sh.video_prompt })),
    }));
    const out = await generate(ctx, withBible(bible, `Episode ${episode.episode_number} shots (JSON):
${JSON.stringify(brief)}

The finished clips feel too slow and emotionless, and some jump to a different place halfway because the
end frame differs too much from the start frame. For EVERY shot, rewrite:
- acting: 2-3 emotional beats with visible expressions and body language, true to the action and dialogue;
- end_frame_prompt: as an edit of the start frame, keeping location, background, props, clothes, camera
  angle and framing, changing only pose and expression; keep the {c1}-style tokens if present;
- video_prompt: one continuous shot, natural real-time speed, the acting beats, camera energy that fits.
Return every shot with its scene_number and shot_number.`), ACTING_SCHEMA, 32000, "medium");
    return out;
  },

  async "describe-character"(ctx, { image, name, face_prompt = "" }) {
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(image || "");
    if (!m) throw new BadRequest("ไฟล์ภาพไม่ถูกต้อง");
    progress(ctx, `AI กำลังดูภาพของ${name}…`);
    return generate(ctx, [
      { type: "image", source: { type: "base64", media_type: m[1], data: m[3] } },
      { type: "text", text: `This is the chosen reference image for the character "${name}".
Current description: ${face_prompt || "(none)"}
Write a new face_prompt in English that matches this exact person so an image generator draws the same
face every time: apparent age, face shape, eyes, eyebrows, nose, lips, skin tone, hair colour, length,
texture and style, build, and distinguishing marks. Do not mention clothing, background or pose.` },
    ], obj({ face_prompt: str }), 4000, "medium");
  },
};

// ---------- routes ----------
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(here, "public")));

app.get("/api/models", (req, res) => res.json({ default: modelOf(DEFAULT_MODEL), models: Object.keys(MODELS) }));

app.post("/api/job/:type", (req, res) => {
  const work = WORK[req.params.type];
  if (!work) return res.status(404).json({ error: "ไม่รู้จักงานนี้" });
  const job = startJob(req.params.type, req.body || {}, work);
  res.json({ id: job.id });
});

app.get("/api/job/:id", (req, res) => {
  let job = jobs.get(req.params.id);
  if (!job) { try { job = JSON.parse(fs.readFileSync(jobFile(req.params.id), "utf8")); } catch {} }
  if (!job) return res.status(404).json({ error: "ไม่พบงานนี้ (อาจปิดหน้าต่าง PowerShell ไประหว่างทำงาน)" });
  res.json({ ...job, elapsed: Math.round(((job.finished || Date.now()) - job.started) / 1000) });
});

// ---------- project backups on this computer ----------
const BACKUP_DIR = path.join(DATA, "backups");
const KEEP_BACKUPS = 10;
let lastSnapshot = 0;

app.post("/api/save", (req, res) => {
  const { project, major } = req.body || {};
  if (!project?.bible) return res.status(400).json({ error: "ไม่มีข้อมูล" });
  const text = JSON.stringify(project);
  fs.writeFileSync(path.join(DATA, "current.json"), text);
  // keep a dated copy at most every 2 minutes, or right away after a big change
  if (major || Date.now() - lastSnapshot > 2 * 60 * 1000) {
    lastSnapshot = Date.now();
    fs.writeFileSync(path.join(BACKUP_DIR, `${Date.now()}.json`), text);
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
  res.json({ ok: true });
});

app.get("/api/backups", (req, res) => {
  const list = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json")).sort().reverse().map((f) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), "utf8"));
      return { file: f, time: Number(f.replace(".json", "")), title: p.bible?.title, episodes: Object.keys(p.episodes || {}).length };
    } catch { return null; }
  }).filter(Boolean);
  let current = null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DATA, "current.json"), "utf8"));
    current = { title: p.bible?.title, episodes: Object.keys(p.episodes || {}).length };
  } catch {}
  res.json({ current, backups: list });
});

app.get("/api/backup/:file", (req, res) => {
  const f = req.params.file === "current" ? path.join(DATA, "current.json")
    : path.join(BACKUP_DIR, req.params.file.replace(/[^0-9.json]/g, ""));
  try { res.type("json").send(fs.readFileSync(f, "utf8")); } catch { res.status(404).json({ error: "ไม่พบไฟล์" }); }
});

app.listen(PORT, () => console.log(`🎬 AI Drama Studio: http://localhost:${PORT}`));
