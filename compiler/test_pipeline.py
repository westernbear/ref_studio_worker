from __future__ import annotations

import unittest

from compiler.pipeline import scene_input, track_surfaces, track_text


def candidate(frame: int, text: str, x: int, confidence: float = 0.8) -> dict:
    return {
        "frame": frame,
        "text": text,
        "confidence": confidence,
        "bounds": [x, 100, 180, 48],
    }


class TrackTextTest(unittest.TestCase):
    def test_merges_ocr_variants_without_merging_distinct_owners(self) -> None:
        tracks = track_text(
            [
                candidate(0, "' YouMotion", 100),
                candidate(1, "1 YouMotion", 102),
                candidate(2, "YouMotion", 800),
                candidate(3, "~YouMotion", 802),
                candidate(4, "A Cool Template", 100),
                candidate(5, "ACool Template", 101),
                candidate(6, "A Coo", 102, 0.95),
                candidate(7, "noise", 500),
            ]
        )

        self.assertEqual(3, len(tracks))
        self.assertEqual([2, 2, 3], sorted(map(len, tracks)))

    def test_tracks_moving_surfaces_without_merging_shape_changes(self) -> None:
        tracks = track_surfaces(
            [
                {"frame": 0, "bounds": [100, 100, 400, 700]},
                {"frame": 1, "bounds": [102, 104, 405, 696]},
                {"frame": 2, "bounds": [105, 110, 410, 690]},
                {"frame": 10, "bounds": [150, 300, 300, 80]},
                {"frame": 11, "bounds": [154, 302, 300, 80]},
                {"frame": 12, "bounds": [158, 305, 300, 80]},
            ]
        )

        self.assertEqual([3, 3], sorted(map(len, tracks)))

    def test_scene_maps_measured_owners_to_all_runtime_passes(self) -> None:
        def owner(frame: int, text: str) -> dict:
            return {
                "frame": frame,
                "text": text,
                "confidence": 0.9,
                "bounds": [100 + frame, 200, 400, 80],
                "canvasWidth": 1080,
                "canvasHeight": 1920,
                "ownerEffects": {"bloom": 0.2, "defocus": 0.3, "rim": 0.4},
            }

        scene = scene_input(
            {"tenantId": "ten_a"},
            120,
            30,
            [[owner(0, "Title"), owner(119, "Title")]],
            [[owner(0, ""), owner(119, "")]],
            [],
            ["#101820", "#f0f8ff"],
        )
        shaders = {
            render_pass["shader"]
            for render_pass in scene["passes"]
            if render_pass["shader"] is not None
        }
        self.assertEqual(set(scene["allowedShaders"]), shaders)
        self.assertEqual(
            ["lower-light-behind-ui", "lower-light-over-ui"],
            [
                render_pass["passId"]
                for render_pass in scene["passes"]
                if render_pass["shader"] == "lower-light-field-13tap"
            ],
        )
        self.assertEqual(
            [0, 119],
            [
                sample["frame"]
                for sample in scene["effects"]["text-00"]["bloom"]["samples"]
            ],
        )


if __name__ == "__main__":
    unittest.main()
