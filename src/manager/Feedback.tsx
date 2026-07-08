// Feedback section — opens a prefilled GitHub issue in the system browser.
// No backend: public-repo issues are free, searchable, and agent-readable.

import { openExternalUrl } from "./openExternalUrl";

const REPO = "isaachansen/trailbrake";

function feedbackIssueUrl(): string {
  const params = new URLSearchParams({
    template: "feedback.yml",
    title: `[Feedback] Trailbrake v${__APP_VERSION__}`,
    version: __APP_VERSION__,
  });
  return `https://github.com/${REPO}/issues/new?${params}`;
}

export function Feedback() {
  return (
    <button
      type="button"
      className="btn btn-primary"
      onClick={() => void openExternalUrl(feedbackIssueUrl())}
    >
      Send feedback
    </button>
  );
}
