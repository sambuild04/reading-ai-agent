import { useCallback, useEffect, useState } from "react";
import {
  type PluginProposal,
  registerPluginProposalChange,
  clearPluginProposal,
  sendTextAndRespond,
} from "../lib/session-bridge";

export function PluginApproval() {
  const [proposal, setProposal] = useState<PluginProposal | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    registerPluginProposalChange((p) => {
      setExiting(false);
      setProposal(p);
    });
    return () => registerPluginProposalChange(null);
  }, []);

  const dismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      setProposal(null);
      setExiting(false);
      clearPluginProposal();
    }, 300);
  }, []);

  const handleApprove = useCallback(() => {
    if (!proposal) return;
    const name = proposal.name;
    dismiss();
    sendTextAndRespond(
      `[System: User APPROVED plugin "${name}". Proceed — call write_plugin now.]`,
    );
  }, [proposal, dismiss]);

  const handleReject = useCallback(() => {
    if (!proposal) return;
    const name = proposal.name;
    dismiss();
    sendTextAndRespond(
      `[System: User REJECTED plugin "${name}". Do not create it. Acknowledge briefly.]`,
    );
  }, [proposal, dismiss]);

  if (!proposal) return null;

  return (
    <div className={`plugin-approval ${exiting ? "plugin-approval-exit" : ""}`}>
      <div className="plugin-approval-header">
        New tool: <span className="plugin-approval-name">{proposal.name}</span>
      </div>
      <p className="plugin-approval-summary">{proposal.summary}</p>
      <div className="plugin-approval-actions">
        <button onClick={handleApprove} className="plugin-approval-btn plugin-approval-btn-yes">
          Approve
        </button>
        <button onClick={handleReject} className="plugin-approval-btn plugin-approval-btn-no">
          Reject
        </button>
      </div>
    </div>
  );
}
