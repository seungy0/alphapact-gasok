import { parseAbi, type Address } from "viem";
import manifest from "./spot-deployment.json";
export const spotCheckpointDeployment = manifest as { ready: boolean; chainId: number; contract: Address; publisher: Address };
export const spotCheckpointAbi = parseAbi([
  "function publish(bytes32 streamId,uint64 sequence,bytes32 previousCheckpoint,bytes32 evidenceHead,bytes32 policyHash) returns(bytes32)",
  "function checkpoints(bytes32 streamId) view returns(uint64 sequence,bytes32 evidenceHead,bytes32 checkpointHash)",
  "function publisher() view returns(address)",
  "event CheckpointPublished(bytes32 indexed streamId,uint64 indexed sequence,bytes32 previousCheckpoint,bytes32 evidenceHead,bytes32 policyHash,bytes32 checkpointHash,bytes32 modeHash)",
]);
