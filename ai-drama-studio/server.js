// AI Drama Studio — server
// Idea -> series bible -> shooting script with blocking, storyboard and prompts for
// image/video generators such as Google Flow / Veo. Every episode is checked for
// camera continuity and the AI fixes the scenes that fail, up to two rounds.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.DRAMA_MODEL || "claude-opus-5-5";
const PORT = Number(process.env.PORT || 3000);
const REVIEW_ROUNDS = 2;

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
- One clear action per 8-second clip, slow-to-moderate motion, no whip pans, no crowds doing complex
  actions, no long on-screen text, no fast hand manipulation. Camera moves must be physically possible.
- negative_prompt lists what to avoid: plastic skin, extra fingers, warped faces, morphing, changing
  clothes, cartoon look, text artifacts, oversaturated colours.`;

async function generate(content, schema, maxTokens, effort = "medium") {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    output_config: { effort, format: { type: "json_schema", schema } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // re-runs on another model if a safety classifier declines
    messages: [{ role: "user", content }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("โมเดลปฏิเสธคำขอนี้ ลองปรับเนื้อเรื่องแล้วลองใหม่");
  if (message.stop_reason === "max_tokens") throw new Error("ผลลัพธ์ยาวเกินไป ลองลดจำนวนตอน/ฉากลง");
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
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

const bibleText = (bible) => `Series bible (JSON):\n${JSON.stringify(bible)}\n
Content rating: ${bible.rating} — ${RATING_RULES[ratingOf(bible.rating)]}`;

// Run the storyboard checks and let the AI repair failing scenes, up to REVIEW_ROUNDS each.
async function reviewEpisode(bible, episode) {
  const log = [];
  episode.scenes = await Promise.all(episode.scenes.map(async (scene) => {
    for (let round = 1; round <= REVIEW_ROUNDS; round++) {
      const problems = Object.entries(SB.check(scene, nameOf(bible), bible))
        .flatMap(([shot, list]) => list.map((p) => `shot ${shot}: ${p}`));
      if (!problems.length) {
        if (round > 1) log.push({ scene: scene.scene_number, round: round - 1, fixed: true });
        return scene;
      }
      log.push({ scene: scene.scene_number, round, problems });
      const outline = episode.scenes.map((s) => `${s.scene_number}. ${s.summary}`).join("\n");
      scene = await generate(`${bibleText(bible)}

Episode ${episode.episode_number} "${episode.title}" scene outline:
${outline}

This scene (JSON):
${JSON.stringify(scene)}

The storyboard check found these problems (messages are in Thai):
${problems.join("\n")}

Return the corrected scene with the same scene_number and story. Fix camera positions, lenses,
frame_positions and the matching frame prompts so every problem is solved; keep everything else.`,
        SCENE, 48000, "high");
    }
    const left = Object.values(SB.check(scene, nameOf(bible), bible)).flat().length;
    log.push({ scene: scene.scene_number, round: REVIEW_ROUNDS, fixed: left === 0, remaining: left });
    return scene;
  }));
  return log;
}

// ---------- routes ----------
const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(here, "public")));

const route = (fn) => async (req, res) => {
  try { res.json(await fn(req.body || {})); } catch (err) { handleError(res, err); }
};
class BadRequest extends Error {}

app.post("/api/bible", route(async ({ idea, genre = "", episodes = 6, style = "", rating = "13+" }) => {
  if (!idea || typeof idea !== "string") throw new BadRequest("กรุณาใส่ไอเดียเรื่อง");
  const n = clamp(episodes, 1, 20, 6);
  const r = ratingOf(rating);
  return generate(`Create a series bible for a short AI vertical drama series.
Story idea: ${idea}
Genre: ${genre || "choose the best fit"}
Number of episodes: ${n}
Preferred visual style: ${style || "cinematic, photorealistic, vertical 9:16"}
Content rating: ${r} — ${RATING_RULES[r]} (put "${r}" in the rating field)

Give 3-6 main characters with ids c1, c2..., each with 2-3 outfits (ids o1, o2...) and a distinct
signature colour; 3-6 locations (l1, l2...); 2-4 mystery threads (t1, t2...) whose payoffs land
within ${n} episodes; a color_script entry for every episode; and exactly ${n} episodes.`, BIBLE_SCHEMA, 48000);
}));

app.post("/api/revise-bible", route(async ({ bible, instruction, locked = [] }) => {
  if (!bible || !instruction) throw new BadRequest("ไม่มีคำสั่งแก้");
  const out = await generate(`${bibleText(bible)}

Revise the series bible following this instruction from the creator:
"${instruction}"

Change only what the instruction needs and keep ids stable. These characters are locked and must stay
exactly as they are: ${locked.join(", ") || "none"}.`, BIBLE_SCHEMA, 48000);
  return keepLocked(out, bible, locked);
}));

app.post("/api/episode", route(async ({ bible, episodeNumber, scenes = 4 }) => {
  const ep = bible?.episodes?.find((e) => e.number === Number(episodeNumber));
  if (!ep) throw new BadRequest("ไม่พบตอนที่เลือก");
  const s = clamp(scenes, 1, 10, 4);
  const episode = await generate(`${bibleText(bible)}

Write episode ${ep.number} "${ep.title}" as a shooting script with full blocking and camera positions:
${s} scenes, 3-6 shots per scene. Follow every rule.
Hook (first shot): ${ep.hook_open}
Synopsis: ${ep.synopsis}
End on this cliffhanger: ${ep.cliffhanger}
POV character: ${ep.pov_character}
Threads to advance: ${ep.threads.join(", ")}
Use the character, outfit, location and thread ids from the bible.`, EPISODE_SCHEMA, 100000, "high");
  const review = await reviewEpisode(bible, episode);
  return { episode, review };
}));

app.post("/api/revise-episode", route(async ({ bible, episode, instruction }) => {
  if (!bible || !episode || !instruction) throw new BadRequest("ไม่มีคำสั่งแก้");
  const out = await generate(`${bibleText(bible)}

Current shooting script of episode ${episode.episode_number} (JSON):
${JSON.stringify(episode)}

Revise it following this instruction from the creator:
"${instruction}"

Change only what the instruction needs; keep everything else, including blocking that already works.`,
  EPISODE_SCHEMA, 100000, "high");
  const review = await reviewEpisode(bible, out);
  return { episode: out, review };
}));

app.post("/api/shot", route(async ({ bible, scene, shotNumber, instruction = "" }) => {
  const idx = scene?.shots?.findIndex((s) => s.shot_number === Number(shotNumber));
  if (idx == null || idx < 0) throw new BadRequest("ไม่พบช็อตที่เลือก");
  let problems = [];
  let shot;
  for (let round = 0; round <= 1; round++) {
    shot = await generate(`${bibleText(bible)}

Scene (JSON):
${JSON.stringify(scene)}

Rewrite only shot ${shotNumber}. ${instruction ? `Creator's instruction: "${instruction}".` : "Make it better."}
It must cut smoothly from the shot before and into the shot after: keep the same side of the line of
action, screen direction, wardrobe, props and light. Keep shot_number ${shotNumber}.
${problems.length ? `Your previous attempt had these problems, fix them:\n${problems.join("\n")}` : ""}`,
    SHOT, 24000, "high");
    const trial = { ...scene, shots: scene.shots.map((s, i) => (i === idx ? shot : s)) };
    problems = (SB.check(trial, nameOf(bible), bible)[shotNumber] || []);
    if (!problems.length) break;
  }
  return { shot, warnings: problems };
}));

app.post("/api/describe-character", route(async ({ image, name, face_prompt = "" }) => {
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(image || "");
  if (!m) throw new BadRequest("ไฟล์ภาพไม่ถูกต้อง");
  return generate([
    { type: "image", source: { type: "base64", media_type: m[1], data: m[3] } },
    { type: "text", text: `This is the chosen reference image for the character "${name}".
Current description: ${face_prompt || "(none)"}
Write a new face_prompt in English that matches this exact person so an image generator draws the same
face every time: apparent age, face shape, eyes, eyebrows, nose, lips, skin tone, hair colour, length,
texture and style, build, and distinguishing marks. Do not mention clothing, background or pose.` },
  ], obj({ face_prompt: str }), 4000, "medium");
}));

function handleError(res, err) {
  if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
  console.error(err);
  if (err instanceof Anthropic.AuthenticationError) return res.status(401).json({ error: "API key ไม่ถูกต้อง ตรวจสอบ ANTHROPIC_API_KEY" });
  if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "เรียกใช้บ่อยเกินไป รอสักครู่แล้วลองใหม่" });
  if (err instanceof Anthropic.APIError) return res.status(502).json({ error: `API error: ${err.message}` });
  if (/authentication method/i.test(err.message || "")) return res.status(401).json({ error: "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์" });
  res.status(500).json({ error: err.message || "เกิดข้อผิดพลาด" });
}

app.listen(PORT, () => console.log(`🎬 AI Drama Studio: http://localhost:${PORT}`));
