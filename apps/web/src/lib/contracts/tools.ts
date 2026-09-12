/**
 * THE ONE tool registry. Chat (useFrontendTool), LIVE (Live delegation functions /
 * RealtimeAgent tool()) and the Director all use these names, descriptions and
 * schemas, and call the SAME routes. Browser-safe (zod only).
 *
 * Section-scoped tools default to the open section when `section` is omitted.
 * Shot refs accept "S3", "3", an EDL entry id, or a card id "sec04/S3".
 */
import { z } from "zod";

const section = z
  .string()
  .max(40)
  .optional()
  .describe('Section id, code ("§04") or name ("THE JOURNEY"). Omit for the open section.');
const shot = z.string().min(1).max(100).describe('Shot reference: "S3", "3", or an edit-list entry id.');

export const VETTU_TOOLS = {
  rename_film: {
    description: "Rename the open film. Film names are shown in capitals.",
    parameters: z.object({ name: z.string().trim().min(1).max(80) }),
  },
  add_section: {
    description: "Add a new section to the film. Optional target length in seconds and position (0-based index).",
    parameters: z.object({
      name: z.string().trim().min(1).max(60),
      targetSecs: z.number().min(0).max(36000).optional(),
      index: z.number().int().min(0).optional(),
    }),
  },
  rename_section: {
    description: 'Rename a section, e.g. "rename §02 to THE BRIDGE".',
    parameters: z.object({ section: z.string().min(1).max(40), name: z.string().trim().min(1).max(60) }),
  },
  move_section: {
    description: "Move a section to a new 0-based position. Codes (§NN) are recomputed.",
    parameters: z.object({ section: z.string().min(1).max(40), index: z.number().int().min(0) }),
  },
  park_section: {
    description: "Park (parked=true) or un-park a section. Parked sections are dimmed, marked LATER and left out of every sum.",
    parameters: z.object({ section: z.string().min(1).max(40), parked: z.boolean() }),
  },
  remove_section: {
    description: "Remove a section. Refused while it holds cards unless withCards is true. Ask the user first.",
    parameters: z.object({ section: z.string().min(1).max(40), withCards: z.boolean().optional() }),
  },
  select_section: {
    description: "Open a section on the board and make it the one being edited.",
    parameters: z.object({ section: z.string().min(1).max(40) }),
  },
  find_shot: {
    description: "Find shots in the open section's edit whose description, caption or tags match the query.",
    parameters: z.object({ query: z.string().trim().min(1).max(200), section }),
  },
  move_shot: {
    description: "Move a shot to a new 0-based position in the section's edit, then render a preview.",
    parameters: z.object({ shot, index: z.number().int().min(0), section }),
  },
  trim_shot: {
    description:
      'Trim or hold a shot, then render a preview. Use delta (+0.5 = hold half a second longer, −0.5 = shorter) on the out edge, or set in/out seconds directly.',
    parameters: z.object({
      shot,
      delta: z.number().min(-30).max(30).optional(),
      edge: z.enum(["in", "out"]).optional(),
      in: z.number().min(0).optional(),
      out: z.number().positive().optional(),
      section,
    }),
  },
  remove_shot: {
    description: "Remove a shot from the section's edit (the film of record is never touched), then render a preview.",
    parameters: z.object({ shot, section }),
  },
  set_transition: {
    description:
      "Set the transition INTO edit entry `index`: a 0-based edit-list index ≥ 1 (1 = the join between the first and second shots, same base as move_shot): cut, fade or slideleft, with a duration in seconds.",
    parameters: z.object({
      index: z.number().int().min(1),
      type: z.enum(["cut", "fade", "slideleft"]),
      dur: z.number().min(0).max(2),
      section,
    }),
  },
  set_words: {
    description: "Put words on screen from start to end seconds (drawn as a PNG, never by a model). SAAKSHE is written in capitals.",
    parameters: z.object({
      text: z.string().trim().min(1).max(80),
      start: z.number().min(0),
      end: z.number().positive(),
      section,
    }),
  },
  render_preview: {
    description: "Render the 540p preview of the open section's current edit (about 1–3 s).",
    parameters: z.object({ section }),
  },
  propose_render: {
    description:
      "Prepare the final 1080p render for approval. This only proposes: the user's Approve click renders, records it in Ambiguous and queues it for Slack. Never claim it rendered.",
    parameters: z.object({ summary: z.string().trim().min(1).max(500), section }),
  },
  draw_insert: {
    description:
      "OFF in this build: VETTU has no image model. Do not use it for real work — tell the user drawing is off and offer animate_insert from an existing shot instead.",
    parameters: z.object({
      prompt: z.string().trim().min(3).max(1000),
      refShots: z.array(z.string().max(100)).max(16).optional(),
      afterShot: z.string().max(100).optional(),
      secs: z.number().min(1).max(10).optional(),
      section,
    }),
  },
  animate_insert: {
    description:
      "Make a new shot with Kling image→video from an existing still or a frame of a shot (fromShot, plus `at` seconds into it), placed after afterShot. A push-in placeholder lands at once and the Kling clip swaps in when it arrives. Or re-animate an existing insert with insertId. Slow; returns a job id — never wait for it.",
    parameters: z.object({
      fromShot: shot.optional(),
      at: z.number().min(0).optional(),
      insertId: z.string().min(1).max(100).optional(),
      prompt: z.string().trim().max(1000).optional(),
      afterShot: z.string().max(100).optional(),
      secs: z.number().min(1).max(10).optional(),
      section,
    }),
  },
  add_sound: {
    description:
      'Generate a sound effect (ElevenLabs) and lay it on a shot, placed by its loudness peak. Describe the mic position and detail ("close · clear · crisp"). Slow; returns a job id.',
    parameters: z.object({
      target: shot,
      prompt: z.string().trim().min(3).max(450),
      duration: z.number().min(0.5).max(30),
      section,
    }),
  },
  first_assembly: {
    description: "Hand a brief to the Director agent, which plans and queues draw → animate → sound jobs in the background. Returns a job id.",
    parameters: z.object({ brief: z.string().trim().min(3).max(2000), section }),
  },
  refresh_change_orders: {
    description:
      "List change orders filed from the Slack review thread, for a section, as cards; each carries its Ambiguous task. Omit section for every section.",
    parameters: z.object({ section }),
  },
} as const satisfies Record<string, { description: string; parameters: z.ZodObject }>;

export type VettuToolName = keyof typeof VETTU_TOOLS;
export type VettuToolArgs<N extends VettuToolName> = z.infer<(typeof VETTU_TOOLS)[N]["parameters"]>;
export const VETTU_TOOL_NAMES = Object.keys(VETTU_TOOLS) as VettuToolName[];

/** Tool results go back to the model: raw data or a short sentence; errors never throw. */
export type ToolResult =
  | { status: "ok"; message: string; data?: unknown }
  | { status: "error"; message: string };
