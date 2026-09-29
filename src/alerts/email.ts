const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_SENDER_NAME = "Wheat Temperature";

export interface EmailMessage {
  subject: string;
  html: string;
  text: string;
}

export function emailConfigured(env: Env): boolean {
  return Boolean(env.BREVO_API_KEY && env.ALERT_SENDER_EMAIL);
}

/**
 * Sends one Brevo request with a separate message version per recipient, so recipients
 * never see each other's addresses. Throws when Brevo does not accept the request.
 */
export async function sendAlertEmail(env: Env, recipients: string[], message: EmailMessage): Promise<void> {
  if (!emailConfigured(env)) {
    throw new Error("Email is not configured: set BREVO_API_KEY and ALERT_SENDER_EMAIL");
  }
  if (recipients.length === 0) {
    throw new Error("No email recipients are configured");
  }

  const response = await fetch(BREVO_SEND_URL, {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: env.ALERT_SENDER_EMAIL, name: env.ALERT_SENDER_NAME || DEFAULT_SENDER_NAME },
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
      messageVersions: recipients.map((email) => ({ to: [{ email }] })),
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Brevo returned ${response.status}: ${detail}`);
  }
}
