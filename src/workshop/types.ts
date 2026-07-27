export const WORKSHOP_SCHEMA_VERSION = "0.1.0";

export type ProposalType =
  | "memory"
  | "verification_check"
  | "instruction_edit"
  | "skill";

export type DurabilityCategory =
  | "ground_truth"
  | "actuation"
  | "measurement"
  | "persistence";

export type ProposalStatus =
  | "draft"
  | "pending"
  | "approved"
  | "rejected"
  | "installed";

export interface ProposalEvidence {
  sessionIds: string[];
  eventIds: string[];
  clusterSignature: string;
}
