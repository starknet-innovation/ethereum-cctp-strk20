use starknet::ContractAddress;

/// ABI-compatible with the privacy pool's invoke return type. This exit returns an empty span.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

#[starknet::interface]
pub trait IERC20<TContractState> {
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
}

#[starknet::interface]
pub trait ITokenMessengerMinterV2<TContractState> {
    fn deposit_for_burn_with_hook(
        ref self: TContractState,
        amount: u256,
        destination_domain: u32,
        mint_recipient: u256,
        burn_token: ContractAddress,
        destination_caller: u256,
        max_fee: u256,
        min_finality_threshold: u32,
        hook_data: ByteArray,
    );
}

#[starknet::interface]
pub trait ICctpExitAnonymizer<TContractState> {
    /// Burns this contract's full USDC balance through CCTP for an Ethereum settlement contract.
    /// The privacy pool invokes this in the same proven transaction that withdraws USDC here.
    fn privacy_invoke(
        ref self: TContractState,
        l1_mint_recipient: u256,
        max_fee: u256,
        min_finality_threshold: u32,
        forwarding_hook: ByteArray,
    ) -> Span<OpenNoteDeposit>;

    fn get_route(self: @TContractState) -> (ContractAddress, ContractAddress, ContractAddress);
}

#[starknet::contract]
pub mod CctpExitAnonymizer {
    use core::num::traits::Zero;
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use super::{
        ICctpExitAnonymizer, IERC20Dispatcher, IERC20DispatcherTrait,
        ITokenMessengerMinterV2Dispatcher, ITokenMessengerMinterV2DispatcherTrait, OpenNoteDeposit,
    };

    const ETHEREUM_CCTP_DOMAIN: u32 = 0;

    pub mod errors {
        pub const UNAUTHORIZED_CALLER: felt252 = 'UNAUTHORIZED';
        pub const ZERO_ADDRESS: felt252 = 'ZERO_ADDRESS';
        pub const ZERO_BALANCE: felt252 = 'ZERO_BALANCE';
        pub const INVALID_FEE: felt252 = 'INVALID_FEE';
        pub const INVALID_FINALITY: felt252 = 'BAD_FINALITY';
        pub const EMPTY_HOOK: felt252 = 'EMPTY_HOOK';
        pub const APPROVE_FAILED: felt252 = 'APPROVE_FAILED';
    }

    #[storage]
    struct Storage {
        privacy_pool: ContractAddress,
        usdc: ContractAddress,
        token_messenger: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        ExitInitiated: ExitInitiated,
    }

    #[derive(Drop, starknet::Event)]
    struct ExitInitiated {
        #[key]
        l1_mint_recipient: u256,
        amount: u256,
        max_fee: u256,
        min_finality_threshold: u32,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        privacy_pool: ContractAddress,
        usdc: ContractAddress,
        token_messenger: ContractAddress,
    ) {
        assert(privacy_pool.is_non_zero(), errors::ZERO_ADDRESS);
        assert(usdc.is_non_zero(), errors::ZERO_ADDRESS);
        assert(token_messenger.is_non_zero(), errors::ZERO_ADDRESS);
        self.privacy_pool.write(privacy_pool);
        self.usdc.write(usdc);
        self.token_messenger.write(token_messenger);
    }

    #[abi(embed_v0)]
    impl CctpExitAnonymizerImpl of ICctpExitAnonymizer<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            l1_mint_recipient: u256,
            max_fee: u256,
            min_finality_threshold: u32,
            forwarding_hook: ByteArray,
        ) -> Span<OpenNoteDeposit> {
            assert(get_caller_address() == self.privacy_pool.read(), errors::UNAUTHORIZED_CALLER);
            assert(!l1_mint_recipient.is_zero(), errors::ZERO_ADDRESS);
            assert(
                min_finality_threshold == 1000 || min_finality_threshold == 2000,
                errors::INVALID_FINALITY,
            );
            assert(forwarding_hook.len() > 0, errors::EMPTY_HOOK);

            let self_address = get_contract_address();
            let usdc_address = self.usdc.read();
            let messenger_address = self.token_messenger.read();
            let token = IERC20Dispatcher { contract_address: usdc_address };
            let amount = token.balance_of(self_address);
            assert(!amount.is_zero(), errors::ZERO_BALANCE);
            assert(!max_fee.is_zero() && max_fee < amount, errors::INVALID_FEE);

            assert(token.approve(messenger_address, amount), errors::APPROVE_FAILED);
            ITokenMessengerMinterV2Dispatcher { contract_address: messenger_address }
                .deposit_for_burn_with_hook(
                    amount,
                    ETHEREUM_CCTP_DOMAIN,
                    l1_mint_recipient,
                    usdc_address,
                    0,
                    max_fee,
                    min_finality_threshold,
                    forwarding_hook,
                );
            assert(token.approve(messenger_address, 0), errors::APPROVE_FAILED);

            self.emit(
                ExitInitiated {
                    l1_mint_recipient,
                    amount,
                    max_fee,
                    min_finality_threshold,
                },
            );

            let deposits: Array<OpenNoteDeposit> = array![];
            deposits.span()
        }

        fn get_route(self: @ContractState) -> (ContractAddress, ContractAddress, ContractAddress) {
            (self.privacy_pool.read(), self.usdc.read(), self.token_messenger.read())
        }
    }
}
