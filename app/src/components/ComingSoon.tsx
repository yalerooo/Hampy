// Placeholder content for protocol tabs whose capability crate is scaffolded
// but not yet implemented (SSH/SFTP/RDP/… land in later roadmap phases).

import type { Protocol } from "../lib/types";
import "./ComingSoon.css";

const PHASE: Partial<Record<Protocol, number>> = {
  ssh: 2,
  sftp: 2,
  rdp: 3,
  vnc: 3,
  serial: 3,
  mosh: 3,
  docker: 4,
  kubernetes: 4,
};

export function ComingSoon({ protocol }: { protocol: Protocol }) {
  const phase = PHASE[protocol] ?? 2;
  return (
    <div className="coming">
      <div className="coming__card">
        <span className="coming__tag">Roadmap · Phase {phase}</span>
        <h2 className="coming__title">{protocol.toUpperCase()} is on the way</h2>
        <p className="coming__body">
          The <code>hampy-{protocol.replace("_", "-")}</code> crate is wired
          into the workspace and the IPC schema. The interactive client lands in
          Phase {phase} of the roadmap.
        </p>
      </div>
    </div>
  );
}
