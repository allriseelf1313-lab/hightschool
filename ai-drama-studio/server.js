// AI Drama Studio — server
// Turns a story idea into a drama series bible, then each episode into a
// shot list with image prompts (start/end frame) and video prompts that can be
// pasted into an image/video generator such as Google Flow / Veo.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.DRAMA_MODEL || "claude-opus-5-5";
const PORT = Number(process.env.PORT || 3000);

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// ---------- JSON schemas for structured output ----------
const str = { type: "string" };
const obj = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const arr = (items) => ({ type: "array", items });

const BIBLE_SCHEMA = obj({
  title: str,
  title_en: str,
  logline: str,
  genre: str,
  tone: str,
  setting: str,
  visual_style: str, // English, appended to every image prompt
  negative_prompt: str, // English, what the generator must avoid
  characters: arr(
    obj({
      id: str,
      name: str,
      role: str,
      age: str,
      personality: str,
      backstory: str,
      appearance_prompt: str, // English, fixed "character sheet" for consistency
    })
  ),
  locations: arr(obj({ id: str, name: str, description_prompt: str })),
  episodes: arr(obj({ number: { type: "integer" }, title: str, synopsis: str, cliffhanger: str })),
});

const num = { type: "number" };
const EPISODE_SCHEMA = obj({
  episode_number: { type: "integer" },
  title: str,
  scenes: arr(
    obj({
      scene_number: { type: "integer" },
      location_id: str,
      time_of_day: str,
      summary: str,
      lighting: str, // key light direction & quality, identical for every shot of the scene
      axis_characters: arr(str), // the two characters that define the 180-degree line, or []
      camera_side_note: str, // which side of the line the camera stays on, and why
      shots: arr(
        obj({
          shot_number: { type: "integer" },
          shot_type: str,
          lens: str, // e.g. "35mm"
          camera_angle: str, // eye-level | low | high | overhead
          camera_move: str,
          // top-down floor plan, 0-100 on both axes (1 unit = 10 cm), y grows toward the bottom
          camera: obj({ x: num, y: num, aim_x: num, aim_y: num }),
          // facing_deg: 0 = toward top of the plan, 90 = right, 180 = bottom, 270 = left
          positions: arr(obj({ character: str, x: num, y: num, facing_deg: num })),
          // what the frame shows: left | center | right, and looking: left | right | toward camera | away
          frame_positions: arr(obj({ character: str, frame_side: str, looking: str })),
          crosses_axis: { type: "boolean" },
          cross_reason: str,
          cut_motivation: str,
          continuity_notes: str,
          characters: arr(str),
          action: str,
          dialogue: arr(obj({ character: str, line: str, emotion: str })),
          start_frame_prompt: str,
          end_frame_prompt: str,
          video_prompt: str,
          duration_seconds: { type: "integer" },
          sound: str,
        })
      ),
    })
  ),
});

// ---------- prompts ----------
const SYSTEM = `You are a showrunner and AI-film director who makes short vertical drama series
generated with AI image and video tools (e.g. Google Flow / Veo, Kling, Runway).
Write story text, names and dialogue in the language the user writes in (usually Thai).
Write every *_prompt field in English, because image and video models follow English best.

Rules for prompts:
- Every character keeps one fixed appearance_prompt (face, hair, body, outfit, distinguishing
  details). Paste the relevant appearance_prompt text into every frame prompt that shows the
  character, so the generator draws the same person in every shot.
- Frame prompts describe a single still image: subject, pose, expression, location, lighting,
  lens/framing, and the series visual_style. No camera motion in frame prompts.
- end_frame_prompt is the same shot a few seconds later (for start->end frame video generation).
- video_prompt describes motion only: what moves, camera movement, pacing, mood, ambient sound.
  Keep each shot generatable as one clip of about 8 seconds.
- Dialogue is short and natural, suitable for lip-sync or voice-over.
Never put real celebrities or real people into the story or prompts.

Cinematography — shoot like a real film crew, never random angles or random cuts:
1. Block every scene before writing shots. Place each character on a top-down floor plan
   (0-100 on x and y, 1 unit = 10 cm, y grows toward the bottom of the plan; facing_deg 0 = up,
   90 = right, 180 = down, 270 = left). Give the camera a real position and aim point on the same plan.
   Keep distances physically real: a medium shot with a 50mm lens is ~20-30 units from the subject,
   a close-up with 85mm ~12-18 units, an establishing shot with 24mm ~35-60 units.
2. 180-degree rule: the line between the two axis_characters is the line of action. Choose one side
   and keep every camera of the scene on that side. Cross only with a visible motivation (the camera
   dollies across inside the shot, a character walks across, or a neutral shot on the line); then set
   crosses_axis true and explain in cross_reason.
3. Screen direction & eyelines: a character on frame-left stays on frame-left for the whole exchange;
   in shot/reverse-shot A looks frame-right and B looks frame-left. A character walking left-to-right
   keeps moving left-to-right in the next shot. frame_positions must be what the plan geometry
   actually shows from that camera position and lens, and the frame prompts must state the same
   (e.g. "girl on the left of frame, looking right").
4. 30-degree rule: consecutive shots of the same subject change camera angle by at least 30 degrees
   or change shot size by at least two steps. No jump cuts.
5. Shot progression: open each scene with an establishing or wide shot that shows the geography,
   move closer as the emotion rises, and go wide again when the geography changes.
6. Every cut has a reason — match on action, eyeline match, reaction, reveal, dialogue turn — written
   in cut_motivation.
7. Continuity: props, which hand holds them, wardrobe, hair, positions and light direction carry over
   from shot to shot; note them in continuity_notes. Write the scene's lighting into every frame prompt.
8. Lens & angle language: 24-35mm for establishing, 50mm for mediums, 85-100mm for close-ups;
   eye level by default, low angle only for power, high angle only for vulnerability.

Photorealism in prompts:
- Name a real camera and lens (e.g. "shot on ARRI Alexa Mini, 50mm prime, f/2"), motivated practical
  light, natural skin texture with pores and small imperfections, real fabric wrinkles, believable hands.
- Keep each clip to one clear action that video models can render: slow-to-moderate motion, no whip
  pans, no crowds doing complex actions, no long text on screen, no fast hand manipulation.
- The camera move in video_prompt must be physically possible from the stated camera position.
- negative_prompt lists what to avoid: plastic or airbrushed skin, extra fingers, warped faces,
  morphing, inconsistent clothing, cartoon look, text artifacts, oversaturated colors.`;

async function generate(userPrompt, schema, maxTokens, effort = "medium") {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    output_config: { effort, format: { type: "json_schema", schema } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // re-runs on another model if a safety classifier declines
    messages: [{ role: "user", content: userPrompt }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("โมเดลปฏิเสธคำขอนี้ ลองปรับเนื้อเรื่องแล้วลองใหม่");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("ผลลัพธ์ยาวเกินไป ลองลดจำนวนตอน/ฉากลง");
  }
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return JSON.parse(text);
}

// ---------- routes ----------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "public")));

app.post("/api/bible", async (req, res) => {
  const { idea, genre = "", episodes = 6, style = "" } = req.body || {};
  if (!idea || typeof idea !== "string") {
    return res.status(400).json({ error: "กรุณาใส่ไอเดียเรื่อง" });
  }
  const n = Math.min(Math.max(parseInt(episodes, 10) || 6, 1), 20);
  const prompt = `Create a series bible for a short AI drama series.
Story idea: ${idea}
Genre: ${genre || "choose the best fit"}
Number of episodes: ${n}
Preferred visual style: ${style || "cinematic, photorealistic, vertical 9:16"}

Give 3-6 main characters with unique ids (c1, c2...), 3-6 locations (l1, l2...),
and exactly ${n} episode outlines that each end on a hook.`;
  try {
    res.json(await generate(prompt, BIBLE_SCHEMA, 32000));
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/episode", async (req, res) => {
  const { bible, episodeNumber, scenes = 4 } = req.body || {};
  const ep = bible?.episodes?.find((e) => e.number === Number(episodeNumber));
  if (!ep) return res.status(400).json({ error: "ไม่พบตอนที่เลือก" });
  const s = Math.min(Math.max(parseInt(scenes, 10) || 4, 1), 10);
  const prompt = `Here is the series bible (JSON):
${JSON.stringify(bible)}

Write episode ${ep.number} "${ep.title}" as a shooting script with full blocking and camera
positions: ${s} scenes, 3-6 shots per scene. Follow every cinematography rule.
Episode synopsis: ${ep.synopsis}
End on this cliffhanger: ${ep.cliffhanger}
Use the character ids and location ids from the bible.`;
  try {
    res.json(await generate(prompt, EPISODE_SCHEMA, 64000, "high"));
  } catch (err) {
    handleError(res, err);
  }
});

function handleError(res, err) {
  console.error(err);
  if (err instanceof Anthropic.AuthenticationError) {
    return res.status(401).json({ error: "API key ไม่ถูกต้อง ตรวจสอบ ANTHROPIC_API_KEY" });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return res.status(429).json({ error: "เรียกใช้บ่อยเกินไป รอสักครู่แล้วลองใหม่" });
  }
  if (err instanceof Anthropic.APIError) {
    return res.status(502).json({ error: `API error: ${err.message}` });
  }
  if (/authentication method/i.test(err.message || "")) {
    return res.status(401).json({ error: "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์" });
  }
  res.status(500).json({ error: err.message || "เกิดข้อผิดพลาด" });
}

app.listen(PORT, () => {
  console.log(`🎬 AI Drama Studio: http://localhost:${PORT}`);
});
