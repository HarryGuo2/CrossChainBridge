use anchor_lang::prelude::*;

/// Fixed-width 147-byte canonical bridge message payload.
/// Field order and encoding must stay byte-compatible with the relayer's encoder.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct BridgePayload {
    pub version: u8,
    pub source_chain_id: u16,
    pub source_bridge: [u8; 20],
    pub source_token: [u8; 20],
    pub nonce: u64,
    pub amount: u64,
    pub sender_eth: [u8; 20],
    pub recipient_sol: [u8; 32],
    pub source_tx_hash: [u8; 32],
    pub source_log_index: u32,
}

impl BridgePayload {
    pub const SERIALIZED_SIZE: usize = 147;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> BridgePayload {
        BridgePayload {
            version: 1,
            source_chain_id: 1,
            source_bridge: [0xAB; 20],
            source_token: [0xCD; 20],
            nonce: 42,
            amount: 1_000_000,
            sender_eth: [0xEF; 20],
            recipient_sol: [0x11; 32],
            source_tx_hash: [0x22; 32],
            source_log_index: 7,
        }
    }

    #[test]
    fn serialized_size_is_147() {
        let mut buf = Vec::new();
        sample().serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), BridgePayload::SERIALIZED_SIZE);
    }

    #[test]
    fn round_trip() {
        let original = sample();
        let mut buf = Vec::new();
        original.serialize(&mut buf).unwrap();
        let decoded = BridgePayload::deserialize(&mut buf.as_slice()).unwrap();
        assert_eq!(original, decoded);
    }
}
