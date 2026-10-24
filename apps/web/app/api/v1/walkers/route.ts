import type { NextRequest } from "next/server";
import { ownerCaller, walkerJson, walkerRoute, walkerService } from "@/server/walker";

/** GET /api/v1/walkers — the owner's walkers as status views. */
export async function GET(request: NextRequest) {
  return walkerRoute("walkers.list", null, async () => walkerJson(await walkerService().list(ownerCaller(request))));
}
