import { NextResponse, type NextRequest } from "next/server";
import { ownerCaller, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** GET /api/v1/walkers/{id} — one walker's status view. */
export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  return walkerRoute("walkers.get", id, async () => walkerJson(await walkerService().get(ownerCaller(request), id)));
}

/** DELETE /api/v1/walkers/{id} — forget the walker: it, its history and its credential are gone at once. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const { id } = await params;
  return walkerRoute("walkers.forget", id, async () => {
    await walkerService().forget(ownerCaller(request), id);
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  });
}
