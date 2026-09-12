import { approvalBody } from "@/lib/contracts/review";
import { guarded, HttpError } from "@/lib/server/guard";
import { approvals } from "@/lib/server/render-approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** GET /api/approvals?filmId=&section= → ApprovalsView */
export const GET = guarded("read", async (g) => {
  const filmId = g.url.searchParams.get("filmId");
  const section = g.url.searchParams.get("section");
  if (!filmId || !section) throw new HttpError(400, "Say which film and section.");
  return g.reply(await approvals.view(g.session, filmId, section));
});

/** POST /api/approvals — propose_render (no render) · approve (renders + records) · deny */
export const POST = guarded("write", async (g) => {
  const body = await g.json(approvalBody);
  switch (body.operation) {
    case "propose_render":
      return g.reply({ proposal: await approvals.propose(g.session, body) });
    case "approve":
      return g.reply({ version: await approvals.approve(g.session, body.proposalId) });
    case "deny":
      await approvals.deny(g.session, body.proposalId);
      return g.reply({ status: "declined" });
  }
});
