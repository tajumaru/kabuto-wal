module prediction_commitment::prediction_commitment;

use sui::clock::{Self, Clock};
use sui::table::{Self, Table};

const EOwner: u64 = 0;
const EHash: u64 = 1;
const EDuplicate: u64 = 2;

public struct OwnerRegistry has key {
    id: UID,
    owner: address,
    prediction_ids: Table<vector<u8>, bool>,
}

// key without store: external modules cannot transfer or mutate receipts.
public struct PredictionReceipt has key {
    id: UID,
    owner: address,
    prediction_id: vector<u8>,
    commitment_hash: vector<u8>,
    generated_at: u64,
    anchored_at: u64,
    target_session_date: vector<u8>,
    schema_version: u64,
}

public fun create_registry(ctx: &mut TxContext) {
    let owner = ctx.sender();
    let registry = OwnerRegistry { id: object::new(ctx), owner, prediction_ids: table::new(ctx) };
    transfer::transfer(registry, owner);
}

fun check(owner: address, sender: address, hash: &vector<u8>) {
    assert!(owner == sender, EOwner);
    assert!(hash.length() == 32, EHash);
}

public fun commit(
    registry: &mut OwnerRegistry,
    prediction_id: vector<u8>,
    commitment_hash: vector<u8>,
    generated_at: u64,
    target_session_date: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    check(registry.owner, ctx.sender(), &commitment_hash);
    assert!(!registry.prediction_ids.contains(prediction_id), EDuplicate);
    registry.prediction_ids.add(prediction_id, true);
    let receipt = PredictionReceipt {
        id: object::new(ctx), owner: ctx.sender(), prediction_id, commitment_hash,
        generated_at, anchored_at: clock::timestamp_ms(clock), target_session_date, schema_version: 1,
    };
    transfer::freeze_object(receipt);
}

#[test]
fun valid_hash() {
    check(@0x1, @0x1, &vector[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
}

#[test, expected_failure(abort_code = EOwner)]
fun wrong_owner() { check(@0x1, @0x2, &vector[]); }

#[test, expected_failure(abort_code = EHash)]
fun invalid_hash() { check(@0x1, @0x1, &vector[0]); }

#[test, expected_failure(abort_code = EDuplicate)]
fun duplicate_prediction() {
    let mut scenario = sui::test_scenario::begin(@0x1);
    create_registry(scenario.ctx());
    scenario.next_tx(@0x1);
    let mut registry = scenario.take_from_sender<OwnerRegistry>();
    let clock = clock::create_for_testing(scenario.ctx());
    let hash = vector[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
    commit(&mut registry, b"same-id", hash, 0, b"2026-10-12", &clock, scenario.ctx());
    commit(&mut registry, b"same-id", hash, 0, b"2026-10-12", &clock, scenario.ctx());
    scenario.return_to_sender(registry);
    clock::destroy_for_testing(clock);
    scenario.end();
}
