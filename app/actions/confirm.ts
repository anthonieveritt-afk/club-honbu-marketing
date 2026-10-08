"use server";

import { redirect } from "next/navigation";
import { autoApproveEnabled, autoApproveSignup, confirmSignupEmail } from "@/lib/signups";

/**
 * "Confirm my email" button on /get-started/confirm. A POST, never a GET, so mail scanners that
 * prefetch links cannot confirm on someone's behalf. Only a confirmed sign-up is auto-approved.
 */
export async function confirmEmailAction(formData: FormData): Promise<never> {
  const token = String(formData.get("t") || "");
  let outcome = "error";
  try {
    const r = await confirmSignupEmail(token);
    if (r.ok) {
      outcome = r.already ? "already" : "confirmed";
      if (!r.already && autoApproveEnabled()) {
        try {
          const a = await autoApproveSignup(r.signupId, r.clubName);
          if (!a.ok) console.warn(`[confirm] auto-approve skipped for #${r.signupId}: ${a.error}`);
        } catch (err) {
          console.error(`[confirm] auto-approve failed for #${r.signupId}:`, err);
        }
      }
    } else {
      outcome = r.reason;
    }
  } catch (err) {
    console.error("[confirm] failed:", err);
  }
  redirect(`/get-started/confirm?t=${encodeURIComponent(token)}&r=${outcome}`);
}
