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

const EPISODE_SCHEMA = obj({
  episode_number: { type: "integer" },
  title: str,
  scenes: arr(
    obj({
      scene_number: { type: "integer" },
      location_id: str,
      time_of_day: str,
      summary: str,
      shots: arr(
        obj({
          shot_number: { type: "integer" },
          shot_type: str,
          camera_move: str,
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
Never put real celebrities or real people into the story or prompts.`;

async function generate(userPrompt, schema, maxTokens) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
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

Write episode ${ep.number} "${ep.title}" as a shooting script: ${s} scenes, 3-6 shots per scene.
Episode synopsis: ${ep.synopsis}
End on this cliffhanger: ${ep.cliffhanger}
Use the character ids and location ids from the bible.`;
  try {
    res.json(await generate(prompt, EPISODE_SCHEMA, 64000));
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
