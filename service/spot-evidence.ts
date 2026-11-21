import { createPublicClient, http, parseEventLogs, type Hex } from "viem";
import { chain } from "./protocol";
import { spotCheckpointAbi, spotCheckpointDeployment } from "./spot-chain";
import { verifySpotRecords, type SpotAnchor, type SpotRecord } from "./spot-domain";

export function readSpotEvidence(input: unknown) {
  const archive = input as {
    schema: string;
    execution: string;
    records: SpotRecord[];
    streamId: Hex | null;
    anchor: SpotAnchor | null;
  } | null;
  if (archive?.schema !== "ALPHAPACT_UPBIT_SPOT_V1" ||
      archive.execution !== "READ_AND_ORDER_VALIDATION_ONLY" || !Array.isArray(archive.records)) {
    throw new Error("지원하는 현물 연결 점검 기록이 아닙니다.");
  }

  const verified = verifySpotRecords(archive.records);
  const { anchor, streamId } = archive;
  if (anchor && archive.records[anchor.sequence - 1]?.hash !== anchor.evidenceHead) {
    throw new Error("게시된 해시와 원본 기록이 다릅니다.");
  }
  return { verified, anchor, streamId };
}

export async function verifySpotCheckpoint({ anchor, streamId }: ReturnType<typeof readSpotEvidence>) {
  if (!anchor || !streamId || !spotCheckpointDeployment.ready) {
    throw new Error("확인할 GIWA 게시 기록이 없습니다.");
  }

  const client = createPublicClient({ chain, transport: http(undefined, { timeout: 8_000, retryCount: 1 }) });
  const [chainId, receipt] = await Promise.all([
    client.getChainId(),
    client.getTransactionReceipt({ hash: anchor.transactionHash }),
  ]).catch(() => {
    throw new Error("GIWA에서 거래 영수증을 읽지 못했습니다. 잠시 후 다시 확인해 주세요.");
  });
  if (chainId !== chain.id) throw new Error("GIWA Sepolia 네트워크가 아닙니다.");
  if (receipt.status !== "success" || String(receipt.blockNumber) !== anchor.block) {
    throw new Error("기록에 적힌 블록에서 성공한 게시 거래를 확인하지 못했습니다.");
  }

  const logs = receipt.logs.filter(log => log.address.toLowerCase() === spotCheckpointDeployment.contract.toLowerCase());
  const events = parseEventLogs({ abi: spotCheckpointAbi, eventName: "CheckpointPublished", logs });
  const match = events.find(({ args }) =>
    args.streamId === streamId && args.sequence === BigInt(anchor.sequence) &&
    args.evidenceHead === anchor.evidenceHead && args.checkpointHash === anchor.checkpointHash);
  if (!match) throw new Error("지정된 GIWA 계약에서 일치하는 기록을 찾지 못했습니다.");

  return anchor;
}
