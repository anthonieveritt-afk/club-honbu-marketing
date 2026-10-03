import { NextRequest, NextResponse } from "next/server";
import { adminConfigured, isAdminAuthorized } from "@/lib/admin-auth";

export const config = { matcher: ["/admin", "/admin/:path*"] };

export function middleware(req: NextRequest) {
  // Admin area is switched off entirely unless ADMIN_PASSWORD (12+ chars) is set.
  if (!adminConfigured()) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (!isAdminAuthorized(req.headers.get("authorization"))) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Club Honbu admin", charset="UTF-8"',
        "Cache-Control": "no-store",
      },
    });
  }
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}
