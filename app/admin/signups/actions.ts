"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isAdminAuthorized } from "@/lib/admin-auth";
import { approveSignup, rejectSignup, retryJob, type ActionResult } from "@/lib/signups";

// Server actions POST to /admin/signups, so middleware's Basic auth applies; re-checked here anyway.
function requireAdmin() {
  if (!isAdminAuthorized(headers().get("authorization"))) throw new Error("Not authorised");
}

function done(result: ActionResult): never {
  revalidatePath("/admin/signups");
  const qs = result.ok ? `ok=${encodeURIComponent(result.message)}` : `err=${encodeURIComponent(result.error)}`;
  redirect(`/admin/signups?${qs}`);
}

async function run(fn: () => Promise<ActionResult>): Promise<never> {
  requireAdmin();
  let result: ActionResult;
  try {
    result = await fn();
  } catch (err) {
    console.error("[admin/signups] action failed:", err);
    result = { ok: false, error: "Database error; nothing was changed." };
  }
  done(result);
}

export async function approveAction(formData: FormData) {
  await run(() => approveSignup(String(formData.get("id") || ""), String(formData.get("slug") || "")));
}

export async function rejectAction(formData: FormData) {
  await run(() => rejectSignup(String(formData.get("id") || ""), String(formData.get("reason") || "")));
}

export async function retryAction(formData: FormData) {
  await run(() => retryJob(String(formData.get("id") || "")));
}
