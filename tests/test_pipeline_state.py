from scripts.pipeline.state import (
    deserialize_index_keys,
    pipeline_state_path,
    read_pipeline_state,
    serialize_index_keys,
    write_pipeline_state,
)


def test_serialize_and_deserialize_index_keys_round_trip():
    keys = {("730", "2020"), ("570", "2021")}
    serialized = serialize_index_keys(keys)
    assert deserialize_index_keys(serialized) == keys


def test_write_and_read_pipeline_state_round_trip(tmp_path):
    index_keys = {("730", "2020"), ("570", "2021")}
    backfilled_keys = {("2561580", "2025")}

    write_pipeline_state(tmp_path, 123, index_keys, backfilled_keys)

    state = read_pipeline_state(tmp_path)
    assert pipeline_state_path(tmp_path).exists()
    assert state["parsed_count"] == 123
    assert state["index_keys"] == index_keys
    assert state["backfilled_keys"] == backfilled_keys
