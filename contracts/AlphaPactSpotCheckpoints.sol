// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Append-only checkpoints of private Upbit spot pilot records.
/// @dev Post-observation integrity/chronology only. No exchange-order enforcement,
///      pre-trade commitment, truthful-source attestation, custody or fund recovery.
contract AlphaPactSpotCheckpoints {
    address public immutable publisher;
    bytes32 public constant VENUE_HASH = keccak256("UPBIT_KR");
    bytes32 public constant MODE_HASH = keccak256("READ_AND_ORDER_VALIDATION_ONLY");
    struct Checkpoint { uint64 sequence; bytes32 evidenceHead; bytes32 checkpointHash; }
    mapping(bytes32 streamId => Checkpoint) public checkpoints;
    event CheckpointPublished(bytes32 indexed streamId, uint64 indexed sequence,
        bytes32 previousCheckpoint, bytes32 evidenceHead, bytes32 policyHash,
        bytes32 checkpointHash, bytes32 modeHash);
    error InvalidCheckpoint();
    error NotPublisher();
    constructor(address publisher_) {
        require(block.chainid == 91342 || block.chainid == 31337, "TESTNET_ONLY");
        require(publisher_ != address(0), "INVALID_PUBLISHER");
        publisher = publisher_;
    }
    function publish(bytes32 streamId, uint64 sequence, bytes32 previousCheckpoint,
        bytes32 evidenceHead, bytes32 policyHash) external returns (bytes32 checkpointHash) {
        if (msg.sender != publisher) revert NotPublisher();
        Checkpoint memory previous = checkpoints[streamId];
        if (streamId == bytes32(0) || evidenceHead == bytes32(0) || policyHash == bytes32(0) ||
            sequence <= previous.sequence || previousCheckpoint != previous.checkpointHash) revert InvalidCheckpoint();
        checkpointHash = keccak256(abi.encode(block.chainid, address(this), streamId, sequence,
            previousCheckpoint, evidenceHead, policyHash, MODE_HASH));
        checkpoints[streamId] = Checkpoint(sequence, evidenceHead, checkpointHash);
        emit CheckpointPublished(streamId, sequence, previousCheckpoint, evidenceHead, policyHash, checkpointHash, MODE_HASH);
    }
}
