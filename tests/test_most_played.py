import json

from scripts.pipeline.most_played import build_most_played


def _write_index(tmp_path, rows):
    (tmp_path / "search-index.json").write_text(json.dumps(rows), encoding="utf-8")


def test_keeps_rated_games_in_rank_order_and_skips_untracked(tmp_path):
    _write_index(tmp_path, [
        ["730", "Counter-Strike 2", "gold", 78, 0],
        ["570", "Dota 2", "platinum", 50, 0],
    ])
    ranks = [
        {"appid": 570, "peak_in_game": 600000},
        {"appid": 12345, "peak_in_game": 500000},  # not in our index -> skipped
        {"appid": 730, "peak_in_game": 1200000},
    ]
    out = build_most_played(tmp_path, ranks=ranks)

    assert [g["appId"] for g in out] == [570, 730]  # rank order preserved
    assert out[0]["appId"] == 570
    assert out[0]["title"] == "Dota 2"
    assert out[0]["peak"] == 600000
    assert out[0]["rating"] == "platinum"
    assert out[0]["protondbCount"] == 50
    # file on disk matches the returned rows
    assert json.loads((tmp_path / "most_played.json").read_text(encoding="utf-8")) == out


def test_skips_unknown_tier(tmp_path):
    _write_index(tmp_path, [["999", "Untested Game", "unknown", 0, 0]])
    out = build_most_played(tmp_path, ranks=[{"appid": 999, "peak_in_game": 100}])
    assert out == []


def test_includes_pending_tier_games(tmp_path):
    _write_index(tmp_path, [
        ["730", "CS2", "gold", 10, 0],
        ["1234", "Pending Game", "pending", 0, 0],
    ])
    ranks = [
        {"appid": 730, "peak_in_game": 500000},
        {"appid": 1234, "peak_in_game": 100000},
    ]
    out = build_most_played(tmp_path, ranks=ranks)
    app_ids = [g["appId"] for g in out]
    assert 730 in app_ids
    assert 1234 in app_ids
    pending = next(g for g in out if g["appId"] == 1234)
    assert pending["rating"] == "pending"


def test_rated_before_unrated_in_output(tmp_path):
    _write_index(tmp_path, [
        ["1", "Rated Game", "gold", 5, 0],
        ["2", "Pending Game", "pending", 0, 0],
    ])
    ranks = [
        {"appid": 2, "peak_in_game": 999999},  # pending ranks higher
        {"appid": 1, "peak_in_game": 1},
    ]
    out = build_most_played(tmp_path, ranks=ranks)
    # rated games always come before unrated regardless of steam rank
    assert out[0]["appId"] == 1
    assert out[1]["appId"] == 2


def test_respects_unrated_limit(tmp_path):
    rows = [[str(i), f"Game {i}", "pending", 0, 0] for i in range(20)]
    _write_index(tmp_path, rows)
    ranks = [{"appid": i, "peak_in_game": 1000 - i} for i in range(20)]
    out = build_most_played(tmp_path, unrated_limit=5, ranks=ranks)
    assert len(out) == 5
    assert all(g["rating"] == "pending" for g in out)


def test_respects_limit(tmp_path):
    _write_index(tmp_path, [[str(i), f"Game {i}", "gold", 1, 0] for i in range(20)])
    ranks = [{"appid": i, "peak_in_game": 1000 - i} for i in range(20)]
    out = build_most_played(tmp_path, limit=5, ranks=ranks)
    assert len(out) == 5


def test_handles_non_int_peak(tmp_path):
    _write_index(tmp_path, [["730", "CS2", "gold", 10, 0]])
    out = build_most_played(tmp_path, ranks=[{"appid": 730, "peak_in_game": None}])
    assert out[0]["appId"] == 730
    assert out[0]["title"] == "CS2"
    assert out[0]["peak"] is None
    assert out[0]["rating"] == "gold"
    assert out[0]["protondbCount"] == 10
