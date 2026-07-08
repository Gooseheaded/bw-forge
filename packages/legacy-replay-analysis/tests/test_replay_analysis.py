import base64
import hashlib
import io
import json
import re
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import replay_analysis


def pack_msgpack(value):
    if value is None:
        return b"\xc0"
    if isinstance(value, bool):
        return b"\xc3" if value else b"\xc2"
    if isinstance(value, int):
        if 0 <= value <= 0x7F:
            return bytes([value])
        if -32 <= value < 0:
            return struct.pack("b", value)
        if 0 <= value <= 0xFF:
            return b"\xcc" + struct.pack(">B", value)
        if 0 <= value <= 0xFFFF:
            return b"\xcd" + struct.pack(">H", value)
        if 0 <= value <= 0xFFFFFFFF:
            return b"\xce" + struct.pack(">I", value)
        if -128 <= value <= 127:
            return b"\xd0" + struct.pack(">b", value)
        if -32768 <= value <= 32767:
            return b"\xd1" + struct.pack(">h", value)
        if -2147483648 <= value <= 2147483647:
            return b"\xd2" + struct.pack(">i", value)
        raise ValueError(f"int out of range: {value}")
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        length = len(encoded)
        if length <= 31:
            return bytes([0xA0 | length]) + encoded
        if length <= 0xFF:
            return b"\xd9" + struct.pack(">B", length) + encoded
        if length <= 0xFFFF:
            return b"\xda" + struct.pack(">H", length) + encoded
        return b"\xdb" + struct.pack(">I", length) + encoded
    if isinstance(value, list):
        length = len(value)
        if length <= 15:
            prefix = bytes([0x90 | length])
        elif length <= 0xFFFF:
            prefix = b"\xdc" + struct.pack(">H", length)
        else:
            prefix = b"\xdd" + struct.pack(">I", length)
        return prefix + b"".join(pack_msgpack(item) for item in value)
    raise TypeError(f"unsupported msgpack test value: {type(value)!r}")


class ReplayAnalysisTest(unittest.TestCase):
    def test_per_owner_exports(self):
        snapshots = [
            {
                "frame": 0,
                "owners": {
                    "3": {
                        "minerals": 50,
                        "gas": 0,
                        "workers_alive": 4,
                        "unit_counts": {"hatchery": 1, "drone": 4, "overlord": 1},
                        "name": "MysteriousZerg",
                        "supply_current": 4,
                        "supply_max": 9,
                        "units": [
                            {
                                "id": 1,
                                "unit_type": "hatchery",
                                "unit_type_id": 131,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            }
                        ]
                    },
                    "5": {
                        "minerals": 50,
                        "gas": 0,
                        "workers_alive": 4,
                        "unit_counts": {"command_center": 1, "scv": 4},
                        "name": "BigTerran",
                        "supply_current": 4,
                        "supply_max": 10,
                        "units": [
                            {
                                "id": 10,
                                "unit_type": "command_center",
                                "unit_type_id": 106,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            }
                        ]
                    }
                },
                "deaths": [],
            },
            {
                "frame": 48,
                "owners": {
                    "3": {
                        "minerals": 75,
                        "gas": 0,
                        "name": "MysteriousZerg",
                        "supply_current": 5,
                        "supply_max": 9,
                        "units": [
                            {
                                "id": 1,
                                "unit_type": "hatchery",
                                "unit_type_id": 131,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            },
                            {
                                "id": 2,
                                "unit_type": "egg",
                                "unit_type_id": 36,
                                "category": "unit",
                                "build_queue_unit_ids": [41],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            },
                        ]
                    },
                    "5": {
                        "minerals": 62,
                        "gas": 0,
                        "name": "BigTerran",
                        "supply_current": 5,
                        "supply_max": 10,
                        "units": [
                            {
                                "id": 10,
                                "unit_type": "command_center",
                                "unit_type_id": 106,
                                "category": "building",
                                "build_queue_unit_ids": [7],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            }
                        ]
                    }
                },
                "deaths": [
                    {
                        "id": 99,
                        "owner": 5,
                        "unit_type": "scv",
                        "unit_type_id": 7,
                        "category": "worker",
                        "pos_x": 100,
                        "pos_y": 100,
                        "hp_raw": 1234,
                    }
                ],
            },
            {
                "frame": 600,
                "owners": {
                    "3": {
                        "minerals": 126,
                        "gas": 42,
                        "name": "MysteriousZerg",
                        "supply_current": 5,
                        "supply_max": 17,
                        "units": [
                            {
                                "id": 1,
                                "unit_type": "hatchery",
                                "unit_type_id": 131,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "upgrade_in_progress": 27,
                                "tech_in_progress": None,
                            },
                            {
                                "id": 3,
                                "unit_type": "spawning_pool",
                                "unit_type_id": 142,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            },
                        ]
                    },
                    "5": {
                        "minerals": 78,
                        "gas": 0,
                        "name": "BigTerran",
                        "supply_current": 5,
                        "supply_max": 18,
                        "units": [
                            {
                                "id": 10,
                                "unit_type": "command_center",
                                "unit_type_id": 106,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            },
                            {
                                "id": 11,
                                "unit_type": "supply_depot",
                                "unit_type_id": 109,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            },
                        ]
                    }
                },
                "deaths": [],
            },
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            out_dir = Path(temp_dir) / "out"
            path.write_text("\n".join(json.dumps(x) for x in snapshots), encoding="utf-8")
            analyzer = replay_analysis.Analyzer(
                owners=None,
                include_initial=False,
                include_tech=False,
                include_unit_appearances=False,
            )
            events = replay_analysis.load_events(path, analyzer)
            races = replay_analysis.load_owner_races(path, None)
            names = replay_analysis.load_owner_names(path, None)
            economy = replay_analysis.load_economy(path, None)
            supply = replay_analysis.load_supply(path, None)
            unit_counts = replay_analysis.load_unit_counts(path, None)
            deaths = replay_analysis.load_deaths(path, None)
            owners = set(economy) | set(supply) | set(names) | {event.owner for event in events}

            replay_analysis.write_player_bundles(out_dir, owners, races, names, economy, supply, unit_counts, deaths, events)

            outputs = sorted(path.name for path in out_dir.iterdir())
            with zipfile.ZipFile(out_dir / "player_3.zip") as bundle:
                zerg_names = sorted(bundle.namelist())
                zerg_build = bundle.read("build_order.txt").decode("utf-8")
                zerg_economy = json.loads(bundle.read("economy.json").decode("utf-8"))
                zerg_supply = json.loads(bundle.read("supply.json").decode("utf-8"))
                zerg_unit_counts = json.loads(bundle.read("unit_counts.json").decode("utf-8"))
                zerg_deaths = json.loads(bundle.read("deaths.json").decode("utf-8"))
                zerg_player = json.loads(bundle.read("player.json").decode("utf-8"))
            with zipfile.ZipFile(out_dir / "player_5.zip") as bundle:
                terran_deaths = json.loads(bundle.read("deaths.json").decode("utf-8"))

        self.assertEqual(outputs, ["BigTerran.zip", "MysteriousZerg.zip", "player_3.zip", "player_5.zip"])
        self.assertEqual(zerg_names, ["build_order.txt", "deaths.json", "economy.json", "player.json", "supply.json", "unit_counts.json"])
        self.assertEqual(zerg_deaths["samples"], [])
        self.assertEqual(
            terran_deaths["samples"][0]["death"],
            {
                "id": 99,
                "owner": 5,
                "unit_type": "scv",
                "unit_type_id": 7,
                "category": "worker",
                "pos_x": 100,
                "pos_y": 100,
            },
        )
        self.assertEqual(zerg_player["files"]["deaths"], "deaths.json")

    def test_write_replay_manifest(self):
        analysis = replay_analysis.AnalysisResult(
            sampling=replay_analysis.SamplingInfo(max_frame_delta=1),
            events=[],
            economy={},
            supply={},
            unit_counts={},
            deaths={},
            race_by_owner={3: "zerg", 5: "terran"},
            name_by_owner={3: "MysteriousZerg", 5: "BigTerran"},
            output_owners={3, 5},
            last_frame=100,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            output_dir = temp_path / "out"
            replay_path = temp_path / "game.rep"
            replay_path.write_bytes(b"replay-binary")

            replay_analysis.write_replay_manifest(output_dir, analysis, replay_path, replay_path)
            manifest = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))

        self.assertEqual(manifest["schema_version"], "replay-analysis-manifest-v1")
        self.assertEqual(manifest["replay_id"], hashlib.sha256(b"replay-binary").hexdigest())
        self.assertEqual(manifest["source"]["filename"], "game.rep")
        self.assertTrue(manifest["source"]["path"].endswith("game.rep"))
        self.assertEqual(manifest["matchup"], "ZvT")
        self.assertIsNone(manifest["map"])
        self.assertEqual(manifest["duration_seconds"], replay_analysis.frame_to_seconds(100))
        self.assertEqual(
            manifest["players"],
            [
                {"owner": 3, "name": "MysteriousZerg", "race": "zerg", "zip_filename": "player_3.zip"},
                {"owner": 5, "name": "BigTerran", "race": "terran", "zip_filename": "player_5.zip"},
            ],
        )

    def test_manifest_from_existing_output_dir_prefers_existing_legacy_zip_names(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            output_dir = temp_path / "out"
            output_dir.mkdir()

            replay_analysis.write_zip_file(
                output_dir / "MysteriousZerg.zip",
                {
                    "player.json": json.dumps({"owner": 3, "name": "MysteriousZerg", "race": "zerg"}) + "\n",
                    "build_order.txt": "",
                    "economy.json": json.dumps({"samples": [{"frame": 100}]}) + "\n",
                    "supply.json": json.dumps({"samples": []}) + "\n",
                    "unit_counts.json": json.dumps({"samples": []}) + "\n",
                    "deaths.json": json.dumps({"samples": []}) + "\n",
                },
            )
            replay_analysis.write_zip_file(
                output_dir / "BigTerran.zip",
                {
                    "player.json": json.dumps({"owner": 5, "name": "BigTerran", "race": "terran"}) + "\n",
                    "build_order.txt": "",
                    "economy.json": json.dumps({"samples": [{"frame": 80}]}) + "\n",
                    "supply.json": json.dumps({"samples": []}) + "\n",
                    "unit_counts.json": json.dumps({"samples": []}) + "\n",
                    "deaths.json": json.dumps({"samples": []}) + "\n",
                },
            )

            html = replay_analysis.embed_datasets_into_build_order_html(
                "<html><body><div>app</div></body></html>",
                [("Player 1", {"player.json": "{}\n", "build_order.txt": "", "economy.json": "{}\n", "supply.json": "{}\n"})],
                replay_artifact=("game.rep", b"replay-binary"),
            )
            (output_dir / "report.html").write_text(html, encoding="utf-8")

            manifest = replay_analysis.manifest_from_existing_output_dir(output_dir)

        self.assertEqual(manifest["replay_id"], hashlib.sha256(b"replay-binary").hexdigest())
        self.assertEqual(manifest["source"]["filename"], "game.rep")
        self.assertIsNone(manifest["source"]["path"])
        self.assertEqual(manifest["matchup"], "ZvT")
        self.assertEqual(manifest["duration_seconds"], replay_analysis.frame_to_seconds(100))
        self.assertEqual(
            manifest["players"],
            [
                {"owner": 3, "name": "MysteriousZerg", "race": "zerg", "zip_filename": "MysteriousZerg.zip"},
                {"owner": 5, "name": "BigTerran", "race": "terran", "zip_filename": "BigTerran.zip"},
            ],
        )

    def test_economy_export(self):
        snapshots = [
            {
                "frame": 0,
                "owners": {
                    "3": {
                        "minerals": 50,
                        "gas": 0,
                        "gathered_minerals": 0,
                        "gathered_gas": 0,
                        "units": [{"id": 1, "unit_type": "drone", "unit_type_id": 41}],
                    }
                },
            },
            {
                "frame": 24,
                "owners": {
                    "3": {
                        "minerals": 58,
                        "gas": 4,
                        "gathered_minerals": 8,
                        "gathered_gas": 4,
                        "units": [{"id": 1, "unit_type": "drone", "unit_type_id": 41}],
                    }
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            out_dir = Path(temp_dir) / "out"
            path.write_text("\n".join(json.dumps(x) for x in snapshots), encoding="utf-8")

            payload = replay_analysis.economy_payload(3, replay_analysis.load_economy(path, {3})[3], replay_analysis.load_owner_races(path, {3}))

        self.assertEqual(payload["schema_version"], "replay-analysis-economy-v1")
        self.assertEqual(payload["owner"], 3)
        self.assertEqual(payload["race"], "zerg")
        self.assertEqual(
            payload["samples"],
            [
                {"frame": 0, "time_seconds": 0.0, "minerals": 50, "gas": 0, "gathered_minerals": 0, "gathered_gas": 0},
                {"frame": 24, "time_seconds": 1.008, "minerals": 58, "gas": 4, "gathered_minerals": 8, "gathered_gas": 4},
            ],
        )

    def test_supply_export(self):
        snapshots = [
            {
                "frame": 0,
                "owners": {
                    "3": {
                        "supply_current": 4,
                        "supply_max": 9,
                        "units": [{"id": 1, "unit_type": "drone", "unit_type_id": 41}],
                    }
                },
            },
            {
                "frame": 24,
                "owners": {
                    "3": {
                        "supply_current": 4,
                        "supply_max": 9,
                        "units": [{"id": 1, "unit_type": "drone", "unit_type_id": 41}],
                    }
                },
            },
            {
                "frame": 48,
                "owners": {
                    "3": {
                        "supply_current": 5,
                        "supply_max": 9,
                        "units": [{"id": 1, "unit_type": "drone", "unit_type_id": 41}],
                    }
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            out_dir = Path(temp_dir) / "out"
            path.write_text("\n".join(json.dumps(x) for x in snapshots), encoding="utf-8")

            payload = replay_analysis.supply_payload(3, replay_analysis.load_supply(path, {3})[3], replay_analysis.load_owner_races(path, {3}))

        self.assertEqual(payload["schema_version"], "replay-analysis-supply-v1")
        self.assertEqual(payload["owner"], 3)
        self.assertEqual(payload["race"], "zerg")
        self.assertEqual(
            payload["samples"],
            [
                {"frame": 0, "time_seconds": 0.0, "current": 4, "max": 9},
                {"frame": 48, "time_seconds": 2.016, "current": 5, "max": 9},
            ],
        )

    def test_unit_counts_export(self):
        snapshots = [
            {
                "frame": 0,
                "owners": {
                    "3": {
                        "unit_counts": {"drone": 4, "hatchery": 1, "siege_tank_tank": 1, "goliath_turret": 1},
                        "units": [{"id": 1, "unit_type": "drone", "unit_type_id": 41}],
                    }
                },
            },
            {
                "frame": 24,
                "owners": {
                    "3": {
                        "unit_counts": {"drone": 4, "hatchery": 1, "siege_tank_tank": 1, "goliath_turret": 1},
                        "units": [{"id": 1, "unit_type": "drone", "unit_type_id": 41}],
                    }
                },
            },
            {
                "frame": 48,
                "owners": {
                    "3": {
                        "unit_counts": {"drone": 5, "hatchery": 1, "siege_tank_tank": 1, "goliath_turret": 1},
                        "units": [{"id": 1, "unit_type": "drone", "unit_type_id": 41}],
                    }
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            out_dir = Path(temp_dir) / "out"
            path.write_text("\n".join(json.dumps(x) for x in snapshots), encoding="utf-8")

            payload = replay_analysis.unit_counts_payload(
                3, replay_analysis.load_unit_counts(path, {3})[3], replay_analysis.load_owner_races(path, {3})
            )

        self.assertEqual(payload["schema_version"], "replay-analysis-unit-counts-v1")
        self.assertEqual(payload["owner"], 3)
        self.assertEqual(payload["race"], "zerg")
        self.assertEqual(
            payload["samples"],
            [
                {"frame": 0, "time_seconds": 0.0, "counts": {"drone": 4, "hatchery": 1, "siege_tank": 1}},
                {"frame": 48, "time_seconds": 2.016, "counts": {"drone": 5, "hatchery": 1, "siege_tank": 1}},
            ],
        )

    def test_deaths_export(self):
        snapshots = [
            {
                "frame": 100,
                "deaths": [
                    {
                        "id": 1,
                        "owner": 3,
                        "unit_type": "marine",
                        "unit_type_id": 0,
                        "category": "unit",
                        "pos_x": 10,
                        "pos_y": 20,
                        "energy_raw": 999,
                    }
                ],
            },
            {
                "frame": 200,
                "deaths": [
                    {
                        "id": 2,
                        "owner": 3,
                        "unit_type": "scv",
                        "unit_type_id": 7,
                        "category": "worker",
                        "pos_x": 30,
                        "pos_y": 40,
                    }
                ],
            },
            {
                "frame": 300,
                "deaths": [
                    {
                        "id": 3,
                        "owner": 3,
                        "unit_type": "siege_tank_tank",
                        "unit_type_id": 5,
                        "category": "unit",
                        "pos_x": 50,
                        "pos_y": 60,
                    },
                    {
                        "id": 4,
                        "owner": 3,
                        "unit_type": "goliath_turret",
                        "unit_type_id": 4,
                        "category": "subunit",
                        "pos_x": 70,
                        "pos_y": 80,
                    }
                ],
            },
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            path.write_text("\n".join(json.dumps(x) for x in snapshots), encoding="utf-8")

            payload = replay_analysis.deaths_payload(
                3, replay_analysis.load_deaths(path, {3})[3], replay_analysis.load_owner_races(path, {3})
            )

        self.assertEqual(payload["schema_version"], "replay-analysis-deaths-v1")
        self.assertEqual(payload["owner"], 3)
        self.assertEqual(
            payload["samples"],
            [
                {
                    "frame": 100,
                    "time_seconds": 4.2,
                    "death": {
                        "id": 1,
                        "owner": 3,
                        "unit_type": "marine",
                        "unit_type_id": 0,
                        "category": "unit",
                        "pos_x": 10,
                        "pos_y": 20,
                    },
                },
                {
                    "frame": 200,
                    "time_seconds": 8.4,
                    "death": {
                        "id": 2,
                        "owner": 3,
                        "unit_type": "scv",
                        "unit_type_id": 7,
                        "category": "worker",
                        "pos_x": 30,
                        "pos_y": 40,
                    },
                },
                {
                    "frame": 300,
                    "time_seconds": 12.6,
                    "death": {
                        "id": 3,
                        "owner": 3,
                        "unit_type": "siege_tank",
                        "unit_type_id": 5,
                        "category": "unit",
                        "pos_x": 50,
                        "pos_y": 60,
                    },
                },
            ],
        )

    def test_normalize_filename(self):
        self.assertEqual(replay_analysis.normalize_filename("Gosu"), "Gosu")
        self.assertEqual(replay_analysis.normalize_filename("`Gosu`"), "Gosu")
        self.assertEqual(replay_analysis.normalize_filename("Gosu Player"), "Gosu_Player")
        self.assertEqual(replay_analysis.normalize_filename("한국어"), "")
        self.assertEqual(replay_analysis.normalize_filename("!@#$%^&*()"), "")

    def test_output_stem_fallbacks(self):
        races = {0: "terran", 1: "terran"}
        names = {0: "Gosu", 1: "!@#"}
        self.assertEqual(replay_analysis.output_stem(0, races, names), "Gosu")
        self.assertEqual(replay_analysis.output_stem(1, races, names), "terran_1")
        self.assertEqual(replay_analysis.output_stem(2, races, names), "unknown_2")

    def test_default_embedded_html_name_uses_sanitized_input_stem(self):
        self.assertEqual(
            replay_analysis.default_embedded_html_name(Path(r"C:\replays\My Replay (Z) vs P.rep")),
            "My_Replay_Z_vs_P.html",
        )
        self.assertEqual(
            replay_analysis.default_embedded_html_name(Path(r"C:\replays\!@#$%.rep")),
            replay_analysis.DEFAULT_EMBEDDED_BUILD_ORDER_NAME,
        )

    def test_collect_replay_files_recurses_and_ignores_non_replays(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "a.rep").write_text("", encoding="utf-8")
            (root / "note.txt").write_text("", encoding="utf-8")
            nested = root / "nested"
            nested.mkdir()
            (nested / "b.rep").write_text("", encoding="utf-8")

            replay_paths = replay_analysis.collect_replay_files(root)

        self.assertEqual([path.name for path in replay_paths], ["a.rep", "b.rep"])

    def test_unique_batch_output_dirs_adds_numeric_suffixes(self):
        replay_paths = [
            Path(r"C:\replays\A B.rep"),
            Path(r"C:\replays\A_B.rep"),
            Path(r"C:\replays\A-B.rep"),
        ]

        output_names = replay_analysis.unique_batch_output_dirs(replay_paths)

        self.assertEqual(output_names[replay_paths[0]], "A_B")
        self.assertEqual(output_names[replay_paths[1]], "A_B_2")
        self.assertEqual(output_names[replay_paths[2]], "A-B")

    def test_frame_time_uses_shieldbattery_42ms_clock(self):
        self.assertAlmostEqual(replay_analysis.frame_to_seconds(7047), 295.974)
        self.assertEqual(replay_analysis.format_timestamp(7047), "04:55")
        self.assertEqual(replay_analysis.format_timestamp(7048), "04:56")

    def test_backdates_partially_observed_building_start(self):
        snapshots = [
            {
                "frame": 0,
                "owners": {
                    "3": {
                        "units": [
                            {
                                "id": 1,
                                "unit_type": "hatchery",
                                "unit_type_id": 131,
                                "category": "building",
                                "build_queue_unit_ids": [],
                            }
                        ]
                    }
                },
            },
            {
                "frame": 200,
                "owners": {
                    "3": {
                        "units": [
                            {
                                "id": 1,
                                "unit_type": "hatchery",
                                "unit_type_id": 131,
                                "category": "building",
                                "build_queue_unit_ids": [],
                            },
                            {
                                "id": 2,
                                "unit_type": "spire",
                                "unit_type_id": 141,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "build_time": 120,
                                "remaining_build_time": 20,
                            },
                        ]
                    }
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            path.write_text("\n".join(json.dumps(x) for x in snapshots), encoding="utf-8")
            analyzer = replay_analysis.Analyzer(None, False, False, False)
            events = replay_analysis.load_events(path, analyzer)

        self.assertEqual([(event.frame, event.owner, event.name) for event in events], [(100, 3, "Spire")])

    def test_prefers_explicit_morph_target_for_lair_start(self):
        snapshots = [
            {
                "frame": 0,
                "owners": {
                    "3": {
                        "units": [
                            {
                                "id": 1,
                                "unit_type": "hatchery",
                                "unit_type_id": 131,
                                "category": "building",
                                "build_queue_unit_ids": [],
                            }
                        ]
                    }
                },
            },
            {
                "frame": 100,
                "owners": {
                    "3": {
                        "units": [
                            {
                                "id": 1,
                                "unit_type": "hatchery",
                                "unit_type_id": 131,
                                "category": "building",
                                "morphing_building": True,
                                "morph_target_unit_type_id": 132,
                                "build_queue_unit_ids": [132],
                                "build_time": 1800,
                                "remaining_build_time": 1800,
                            }
                        ]
                    }
                },
            },
            {
                "frame": 340,
                "owners": {
                    "3": {
                        "units": [
                            {
                                "id": 1,
                                "unit_type": "lair",
                                "unit_type_id": 132,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "build_time": 1800,
                                "remaining_build_time": 1560,
                            }
                        ]
                    }
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            path.write_text("\n".join(json.dumps(x) for x in snapshots), encoding="utf-8")
            analyzer = replay_analysis.Analyzer(None, False, False, False)
            events = replay_analysis.load_events(path, analyzer)

        self.assertEqual([(event.frame, event.owner, event.name) for event in events], [(100, 3, "Lair")])

    def test_detects_coarse_sampling(self):
        snapshots = [
            {"frame": 0, "owners": {}},
            {"frame": 24, "owners": {}},
            {"frame": 48, "owners": {}},
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            path.write_text("\n".join(json.dumps(x) for x in snapshots), encoding="utf-8")

            sampling = replay_analysis.inspect_sampling(path)

        self.assertEqual(sampling.max_frame_delta, 24)

    def test_load_owner_names_stops_after_requested_names_found(self):
        lines = [
            json.dumps(
                {
                    "frame": 0,
                    "owners": {
                        "3": {
                            "name": "MysteriousZerg",
                            "units": [{"id": 1, "unit_type": "drone", "unit_type_id": 41}],
                        }
                    },
                }
            ),
            "{not valid json",
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            path.write_text("\n".join(lines), encoding="utf-8")

            names = replay_analysis.load_owner_names(path, {3})

        self.assertEqual(names, {3: "MysteriousZerg"})

    def test_load_owner_races_stops_after_requested_races_found(self):
        lines = [
            json.dumps(
                {
                    "frame": 0,
                    "owners": {
                        "3": {
                            "units": [{"id": 1, "unit_type": "drone", "unit_type_id": 41}]
                        }
                    },
                }
            ),
            "{not valid json",
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            path.write_text("\n".join(lines), encoding="utf-8")

            races = replay_analysis.load_owner_races(path, {3})

        self.assertEqual(races, {3: "zerg"})

    def test_analyze_timeline_matches_loader_outputs(self):
        snapshots = [
            {
                "frame": 0,
                "owners": {
                    "3": {
                        "name": "MysteriousZerg",
                        "minerals": 50,
                        "gas": 0,
                        "workers_alive": 4,
                        "unit_counts": {"drone": 4, "hatchery": 1},
                        "supply_current": 4,
                        "supply_max": 9,
                        "units": [
                            {
                                "id": 1,
                                "unit_type": "hatchery",
                                "unit_type_id": 131,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            }
                        ],
                    }
                },
                "deaths": [],
            },
            {
                "frame": 24,
                "owners": {
                    "3": {
                        "name": "MysteriousZerg",
                        "minerals": 58,
                        "gas": 4,
                        "workers_alive": 4,
                        "unit_counts": {"drone": 5, "hatchery": 1},
                        "supply_current": 5,
                        "supply_max": 9,
                        "units": [
                            {
                                "id": 1,
                                "unit_type": "hatchery",
                                "unit_type_id": 131,
                                "category": "building",
                                "build_queue_unit_ids": [],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            },
                            {
                                "id": 2,
                                "unit_type": "egg",
                                "unit_type_id": 36,
                                "category": "unit",
                                "build_queue_unit_ids": [41],
                                "upgrade_in_progress": None,
                                "tech_in_progress": None,
                            },
                        ],
                    }
                },
                "deaths": [
                    {
                        "id": 9,
                        "owner": 3,
                        "unit_type": "drone",
                        "unit_type_id": 41,
                        "category": "worker",
                        "pos_x": 10,
                        "pos_y": 20,
                    }
                ],
            },
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.jsonl"
            path.write_text("\n".join(json.dumps(x) for x in snapshots), encoding="utf-8")

            analyzer = replay_analysis.Analyzer({3}, False, False, False)
            result = replay_analysis.analyze_timeline(path, analyzer, {3})

            expected_events = replay_analysis.load_events(path, replay_analysis.Analyzer({3}, False, False, False))
            expected_economy = replay_analysis.load_economy(path, {3})
            expected_supply = replay_analysis.load_supply(path, {3})
            expected_unit_counts = replay_analysis.load_unit_counts(path, {3})
            expected_deaths = replay_analysis.load_deaths(path, {3})
            expected_names = replay_analysis.load_owner_names(path, {3})
            expected_races = replay_analysis.load_owner_races(path, {3})
            expected_sampling = replay_analysis.inspect_sampling(path)

        self.assertEqual(result.events, expected_events)
        self.assertEqual(result.economy, expected_economy)
        self.assertEqual(result.supply, expected_supply)
        self.assertEqual(result.unit_counts, expected_unit_counts)
        self.assertEqual(result.deaths, expected_deaths)
        self.assertEqual(result.name_by_owner, expected_names)
        self.assertEqual(result.race_by_owner, expected_races)
        self.assertEqual(result.sampling, expected_sampling)
        self.assertEqual(result.output_owners, {3})

    def test_replay_export_command(self):
        replay_path = Path(r"C:\replays\game.rep")
        with (
            mock.patch(
                "replay_analysis.shutil.which",
                side_effect=[
                    r"C:\Program Files\nodejs\pnpm.cmd",
                    r"C:\Program Files\nodejs\node.exe",
                ],
            ),
            mock.patch("pathlib.Path.is_file", return_value=True),
        ):
            command = replay_analysis.replay_export_command(Path(r"C:\replays\game.rep"), 256)

        self.assertEqual(
            command,
            [
                r"C:\Program Files\nodejs\node.exe",
                r"C:\Program Files\nodejs\node_modules\corepack\dist\pnpm.js",
                "run",
                "replay-export",
                "--",
                str(replay_path.resolve()),
                "--replay-export-speed",
                "256",
            ],
        )

    def test_export_replay_timeline_sets_expected_env(self):
        replay_path = Path(r"C:\replays\game.rep")
        shieldbattery_dir = Path(r"C:\ShieldBattery")
        with tempfile.TemporaryDirectory() as temp_dir:
            timeline_path = Path(temp_dir) / "timeline.jsonl"
            expected_command = [
                r"C:\Program Files\nodejs\node.exe",
                r"C:\Program Files\nodejs\node_modules\corepack\dist\pnpm.js",
                "run",
                "replay-export",
                "--",
                str(replay_path.resolve()),
                "--replay-export-speed",
                "128",
            ]

            fake_process = mock.Mock()
            fake_process.args = expected_command
            fake_process.poll.side_effect = [None, 0]

            def fake_popen(command, cwd, env):
                self.assertEqual(command, expected_command)
                self.assertEqual(cwd, shieldbattery_dir)
                self.assertEqual(env["SB_UNIT_TIMELINE"], "1")
                self.assertEqual(env["SB_UNIT_TIMELINE_FORMAT"], "jsonl")
                self.assertEqual(env["SB_UNIT_TIMELINE_OUT"], str(timeline_path))
                self.assertEqual(env["SB_UNIT_TIMELINE_TIME_UNIT"], "frames")
                self.assertEqual(env["SB_UNIT_TIMELINE_STRIDE"], "1")
                timeline_path.write_text('{"frame": 0, "owners": {}, "deaths": []}\n', encoding="utf-8")
                return fake_process

            with (
                mock.patch(
                    "replay_analysis.shutil.which",
                    side_effect=[
                        r"C:\Program Files\nodejs\pnpm.cmd",
                        r"C:\Program Files\nodejs\node.exe",
                    ],
                ),
                mock.patch("pathlib.Path.is_file", return_value=True),
                mock.patch("replay_analysis.subprocess.Popen", side_effect=fake_popen),
                mock.patch("replay_analysis.time.sleep"),
            ):
                replay_analysis.export_replay_timeline(replay_path, timeline_path, shieldbattery_dir, 128, "jsonl")

    def test_parse_args_supports_replay_input(self):
        args = replay_analysis.parse_args([r"C:\replays\game.rep", "out"])

        self.assertEqual(args.input, Path(r"C:\replays\game.rep"))
        self.assertEqual(args.output_dir, Path("out"))
        self.assertEqual(args.shieldbattery_dir, replay_analysis.DEFAULT_SHIELDBATTERY_DIR)
        self.assertEqual(args.replay_export_speed, replay_analysis.DEFAULT_REPLAY_EXPORT_SPEED)
        self.assertEqual(args.timeline_format, replay_analysis.DEFAULT_TIMELINE_FORMAT)
        self.assertEqual(args.build_order_template, replay_analysis.DEFAULT_BUILD_ORDER_TEMPLATE)
        self.assertIsNone(args.embedded_html_output)
        self.assertIsNone(args.embedded_replay_input)
        self.assertIsNone(args.page_title)

    def test_unit_type_name_normalization_fixes_siege_tank_display_name(self):
        self.assertEqual(replay_analysis.get_unit_type_name({"unit_type": "siege_tank_tank"}), "siege_tank")
        self.assertEqual(replay_analysis.display_name(replay_analysis.get_unit_type_name({"unit_type": "siege_tank_tank"})), "Siege Tank")

    def test_iter_snapshots_reads_msgpack_binary_format(self):
        header = [
            0,
            "sbtl",
            2,
            ["building", "worker", "resource", "powerup", "subunit", "air", "unit"],
            ["marine", "goliath_turret", "siege_tank_tank", "command_center"],
        ]
        unit_record = [
            1, 3, 1, None, None, 4, 1, 15360, 0, 12800, 10, 20, 10, 20, 0, 0, 0, 0,
            3, 0, 0, 23, 0, 0, 0, 0, 0, [], [], None, None, None, None,
        ]
        snapshot = [
            1,
            24,
            [
                [
                    3,
                    "WorkerRush",
                    50,
                    0,
                    8,
                    4,
                    4,
                    10,
                    4,
                    [2, 1, 3, 1],
                    [unit_record],
                ]
            ],
            [unit_record],
        ]
        payload = pack_msgpack(header) + pack_msgpack(snapshot)

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timeline.sbtl"
            path.write_bytes(payload)

            snapshots = list(replay_analysis.iter_snapshots(path))

        self.assertEqual(len(snapshots), 1)
        snapshot = snapshots[0]
        self.assertEqual(snapshot["frame"], 24)
        self.assertEqual(snapshot["owners"]["3"]["name"], "WorkerRush")
        self.assertEqual(snapshot["owners"]["3"]["gathered_minerals"], 8)
        self.assertEqual(snapshot["owners"]["3"]["gathered_gas"], 4)
        self.assertEqual(snapshot["owners"]["3"]["unit_counts"], {"siege_tank": 1, "command_center": 1})
        self.assertEqual(snapshot["owners"]["3"]["units"][0]["unit_type"], "goliath_turret")
        self.assertEqual(snapshot["owners"]["3"]["units"][0]["category"], "subunit")
        self.assertEqual(snapshot["deaths"][0]["unit_type"], "goliath_turret")

    def test_render_embedded_dataset_scripts_emits_zip_base64_payload(self):
        html = replay_analysis.render_embedded_dataset_scripts(
            [("Player 1", {"player.json": "{}\n", "build_order.txt": "</script>\n", "economy.json": "{}\n", "supply.json": "{}\n"})]
        )

        self.assertIn('class="embedded-build-order-dataset"', html)
        self.assertIn('type="text/plain"', html)
        self.assertIn('data-format="zip-base64"', html)
        self.assertIn('data-name="Player 1"', html)
        payload = re.search(r'data-name="Player 1">\s*(.*?)\s*</script>', html, re.DOTALL).group(1)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(payload))) as bundle:
            self.assertEqual(bundle.read("build_order.txt").decode("utf-8"), "</script>\n")

    def test_embed_datasets_into_build_order_html_before_main_scripts(self):
        template = "<html><body><div>app</div>\n<script src='main.js'></script>\n</body></html>"
        result = replay_analysis.embed_datasets_into_build_order_html(
            template,
            [("Player 1", {"player.json": "{}\n", "build_order.txt": "", "economy.json": "{}\n", "supply.json": "{}\n"})],
            page_title="Report Title",
        )

        self.assertIn('class="embedded-build-order-page-meta"', result)
        self.assertIn('{"title":"Report Title"}', result)
        self.assertIn('class="embedded-build-order-dataset"', result)
        self.assertLess(result.index('class="embedded-build-order-dataset"'), result.index("<script src='main.js'>"))

    def test_write_embedded_build_order_html(self):
        events = [replay_analysis.Event(frame=24, owner=3, name="Drone")]
        race_by_owner = {3: "zerg"}
        name_by_owner = {3: "MysteriousZerg"}
        economy = {3: [{"frame": 0, "time_seconds": 0.0, "minerals": 50, "gas": 0}]}
        supply = {3: [{"frame": 0, "time_seconds": 0.0, "current": 4, "max": 9}]}
        unit_counts = {3: [{"frame": 0, "time_seconds": 0.0, "counts": {"drone": 4}}]}
        deaths = {3: [{"frame": 100, "time_seconds": 4.2, "death": {"id": 1}}]}

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            template_path = temp_path / "build-order.html"
            output_path = temp_path / "build-order.embedded.html"
            replay_path = temp_path / "game.rep"
            template_path.write_text("<html><body><div>app</div>\n<script src='main.js'></script>\n</body></html>", encoding="utf-8")
            replay_path.write_bytes(b"replay-binary")

            replay_analysis.write_embedded_build_order_html(
                output_path,
                template_path,
                {3},
                race_by_owner,
                name_by_owner,
                economy,
                supply,
                unit_counts,
                deaths,
                events,
                replay_path=replay_path,
                page_title="Custom Report",
            )

            html = output_path.read_text(encoding="utf-8")

        self.assertIn('class="embedded-build-order-page-meta"', html)
        self.assertIn('{"title":"Custom Report"}', html)
        self.assertIn('data-format="zip-base64"', html)
        payload = re.search(r'data-name="MysteriousZerg">\s*(.*?)\s*</script>', html, re.DOTALL).group(1)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(payload))) as bundle:
            self.assertEqual(
                sorted(bundle.namelist()),
                ["build_order.txt", "deaths.json", "economy.json", "player.json", "supply.json", "unit_counts.json"],
            )
            self.assertEqual(bundle.read("build_order.txt").decode("utf-8"), "00:01 Drone\n")
            self.assertEqual(json.loads(bundle.read("player.json").decode("utf-8"))["name"], "MysteriousZerg")
            self.assertEqual(
                json.loads(bundle.read("unit_counts.json").decode("utf-8"))["schema_version"],
                "replay-analysis-unit-counts-v1",
            )
            self.assertEqual(
                json.loads(bundle.read("deaths.json").decode("utf-8"))["schema_version"],
                "replay-analysis-deaths-v1",
            )
        replay_payload = re.search(r'data-filename="game.rep">\s*(.*?)\s*</script>', html, re.DOTALL).group(1)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(replay_payload))) as replay_bundle:
            self.assertEqual(replay_bundle.namelist(), ["game.rep"])
            self.assertEqual(replay_bundle.read("game.rep"), b"replay-binary")

    def test_extract_embedded_report_artifacts(self):
        html = """<html><body>
<script class="embedded-build-order-page-meta" type="application/json">
{"title":"Saved Title"}
</script>
<script class="embedded-build-order-dataset" type="text/plain" data-format="zip-base64" data-name="Player 1">
dataset-payload
</script>
<script class="embedded-build-order-replay" type="text/plain" data-format="zip-base64" data-filename="game.rep">
replay-payload
</script>
</body></html>"""

        artifacts = replay_analysis.extract_embedded_report_artifacts(html)

        self.assertEqual(artifacts.page_title, "Saved Title")
        self.assertEqual(len(artifacts.datasets), 1)
        self.assertEqual(artifacts.datasets[0].name, "Player 1")
        self.assertEqual(artifacts.datasets[0].payload, "dataset-payload")
        self.assertIsNotNone(artifacts.replay)
        self.assertEqual(artifacts.replay.filename, "game.rep")
        self.assertEqual(artifacts.replay.payload, "replay-payload")

    def test_embed_existing_artifacts_into_build_order_html_preserves_payloads(self):
        template = "<html><body><div>app</div>\n<script src='main.js'></script>\n</body></html>"
        artifacts = replay_analysis.EmbeddedReportArtifacts(
            datasets=[replay_analysis.EmbeddedDatasetBlock(name="Player 1", data_format="zip-base64", payload="dataset-payload")],
            replay=replay_analysis.EmbeddedReplayBlock(filename="game.rep", data_format="zip-base64", payload="replay-payload"),
            page_title="Saved Title",
        )

        result = replay_analysis.embed_existing_artifacts_into_build_order_html(template, artifacts)

        self.assertIn('{"title":"Saved Title"}', result)
        self.assertIn("dataset-payload", result)
        self.assertIn("replay-payload", result)
        self.assertLess(result.index('class="embedded-build-order-dataset"'), result.index("<script src='main.js'>"))

    def test_refresh_embedded_build_order_html_overwrites_with_new_template(self):
        old_html = """<html><body>
<div>old app</div>
<script class="embedded-build-order-page-meta" type="application/json">
{"title":"Saved Title"}
</script>
<script class="embedded-build-order-dataset" type="text/plain" data-format="zip-base64" data-name="Player 1">
dataset-payload
</script>
<script class="embedded-build-order-replay" type="text/plain" data-format="zip-base64" data-filename="game.rep">
replay-payload
</script>
<script src='old.js'></script>
</body></html>"""
        new_template = "<html><body><div>new app</div>\n<script src='main.js'></script>\n</body></html>"

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            input_path = root / "report.html"
            output_path = root / "report.html"
            template_path = root / "build-order.html"
            input_path.write_text(old_html, encoding="utf-8")
            template_path.write_text(new_template, encoding="utf-8")

            replay_analysis.refresh_embedded_build_order_html(input_path, output_path, template_path)

            refreshed = output_path.read_text(encoding="utf-8")

        self.assertIn("new app", refreshed)
        self.assertNotIn("old app", refreshed)
        self.assertIn("dataset-payload", refreshed)
        self.assertIn("replay-payload", refreshed)
        self.assertIn('{"title":"Saved Title"}', refreshed)

    def test_main_refresh_embedded_html_directory(self):
        old_html = """<html><body>
<script class="embedded-build-order-dataset" type="text/plain" data-format="zip-base64" data-name="Player 1">
dataset-payload
</script>
<script src='old.js'></script>
</body></html>"""
        template = "<html><body><div>new app</div>\n<script src='main.js'></script>\n</body></html>"

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            input_dir = root / "reports"
            nested_dir = input_dir / "nested"
            template_path = root / "build-order.html"
            ignored_path = input_dir / "plain.html"
            report_path = nested_dir / "report.html"
            nested_dir.mkdir(parents=True)
            ignored_path.write_text("<html><body>plain</body></html>", encoding="utf-8")
            report_path.write_text(old_html, encoding="utf-8")
            template_path.write_text(template, encoding="utf-8")

            with mock.patch("sys.stdout", new_callable=io.StringIO):
                result = replay_analysis.main(
                    [str(input_dir), "--refresh-embedded-html", "--build-order-template", str(template_path)]
                )

            refreshed = report_path.read_text(encoding="utf-8")
            ignored = ignored_path.read_text(encoding="utf-8")

        self.assertEqual(result, 0)
        self.assertIn("new app", refreshed)
        self.assertIn("dataset-payload", refreshed)
        self.assertEqual(ignored, "<html><body>plain</body></html>")

    def test_main_refresh_rejects_embedded_html_output_in_directory_mode(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            input_dir = root / "reports"
            input_dir.mkdir()

            with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
                result = replay_analysis.main(
                    [str(input_dir), "--refresh-embedded-html", "--embedded-html-output", str(root / "one.html")]
                )

        self.assertEqual(result, 1)
        self.assertIn("--embedded-html-output is not supported when refreshing a directory", stderr.getvalue())

    def test_main_refresh_rejects_output_dir_positional(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            input_path = root / "report.html"
            input_path.write_text("<html><body></body></html>", encoding="utf-8")

            with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
                result = replay_analysis.main([str(input_path), str(root / "out"), "--refresh-embedded-html"])

        self.assertEqual(result, 1)
        self.assertIn("refresh mode does not use output_dir", stderr.getvalue())

    def test_main_requires_output_dir_without_refresh_mode(self):
        with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            result = replay_analysis.main(["timeline.jsonl"])

        self.assertEqual(result, 1)
        self.assertIn("output_dir is required", stderr.getvalue())

    def test_main_rejects_embedded_html_output_in_batch_mode(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            input_dir = root / "replays"
            output_dir = root / "out"
            input_dir.mkdir()
            (input_dir / "game.rep").write_text("", encoding="utf-8")

            with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
                result = replay_analysis.main(
                    [str(input_dir), str(output_dir), "--embedded-html-output", str(output_dir / "one.html")]
                )

        self.assertEqual(result, 1)
        self.assertIn("--embedded-html-output is not supported", stderr.getvalue())

    def test_main_batch_continues_after_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            input_dir = root / "replays"
            output_dir = root / "out"
            input_dir.mkdir()
            replay_a = input_dir / "good.rep"
            replay_b = input_dir / "bad.rep"
            replay_a.write_text("", encoding="utf-8")
            replay_b.write_text("", encoding="utf-8")

            calls = []

            def fake_process_input(args, input_path, replay_output_dir, embedded_html_output, embedded_replay_input, page_title):
                calls.append((input_path.name, replay_output_dir.name, embedded_html_output.name, embedded_replay_input.name, page_title))
                if input_path.name == "bad.rep":
                    raise ValueError("boom")

            with (
                mock.patch("replay_analysis.process_input", side_effect=fake_process_input),
                mock.patch("sys.stdout", new_callable=io.StringIO),
                mock.patch("sys.stderr", new_callable=io.StringIO) as stderr,
            ):
                result = replay_analysis.main([str(input_dir), str(output_dir)])

        self.assertEqual(result, 1)
        self.assertEqual(
            calls,
            [
                ("bad.rep", "bad", "bad.html", "bad.rep", "bad"),
                ("good.rep", "good", "good.html", "good.rep", "good"),
            ],
        )
        self.assertIn("failed: bad.rep: boom", stderr.getvalue())

    def test_main_batch_skip_existing_output_dirs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            input_dir = root / "replays"
            output_dir = root / "out"
            input_dir.mkdir()
            output_dir.mkdir()
            replay_a = input_dir / "done.rep"
            replay_b = input_dir / "todo.rep"
            replay_a.write_text("", encoding="utf-8")
            replay_b.write_text("", encoding="utf-8")
            (output_dir / "done").mkdir()

            calls = []

            def fake_process_input(args, input_path, replay_output_dir, embedded_html_output, embedded_replay_input, page_title):
                calls.append((input_path.name, replay_output_dir.name, embedded_html_output.name, embedded_replay_input.name, page_title))

            with (
                mock.patch("replay_analysis.process_input", side_effect=fake_process_input),
                mock.patch("sys.stdout", new_callable=io.StringIO) as stdout,
            ):
                result = replay_analysis.main([str(input_dir), str(output_dir), "--skip-existing"])

        self.assertEqual(result, 0)
        self.assertEqual(
            calls,
            [
                ("todo.rep", "todo", "todo.html", "todo.rep", "todo"),
            ],
        )
        self.assertIn("skipped: done.rep: output dir already exists", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
